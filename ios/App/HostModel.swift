import Foundation
import SwiftUI
import UIKit
import LocalAuthentication
import UserNotifications
import Darwin
import MK8Core
import Network

@MainActor final class HostModel: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var hostAuthorized = false
    @Published private(set) var authorizingHost = false
    @Published private(set) var busy = false
    @Published private(set) var videos: [LibraryVideo] = []
    @Published private(set) var localURLs: [String] = []
    @Published var message = "Face ID authorization is required once before hosting starts."
    @Published var searchKey = Keychain.read("youtube-search")
    @Published var tunnelKey = Keychain.read("tunnel-key")
    @Published private(set) var phoneConnection = PhoneConnection()
    @Published private(set) var tunnelState = TunnelConnectionState.notConfigured
    @Published private(set) var tunnelMessage = "Save TV_SECRET from your original MK8 .env file in Settings."
    @Published private(set) var activeStreams = 0
    @Published private(set) var preparation: MediaPreparationProgress?
    @Published private(set) var preparingID: UUID?
    @Published private(set) var preparationStartedAt: Date?
    @Published private(set) var traffic: TransferSample
    @Published private(set) var trafficHistory: [TransferSample] = []
    @Published private(set) var backgroundTimeActive = false
    @Published var backgroundDownloads = (UserDefaults.standard.object(forKey: "backgroundDownloads") as? Bool) ?? true {
        didSet { UserDefaults.standard.set(backgroundDownloads, forKey: "backgroundDownloads") }
    }
    @Published var allowBackgroundTime = (UserDefaults.standard.object(forKey: "allowBackgroundTime") as? Bool) ?? true {
        didSet { UserDefaults.standard.set(allowBackgroundTime, forKey: "allowBackgroundTime") }
    }
    @Published var keepScreenAwake = (UserDefaults.standard.object(forKey: "keepScreenAwake") as? Bool) ?? true {
        didSet { UserDefaults.standard.set(keepScreenAwake, forKey: "keepScreenAwake"); updateIdleTimer() }
    }
    @Published var tunnelEnabled = (UserDefaults.standard.object(forKey: "tunnelEnabled") as? Bool) ?? true {
        didSet {
            UserDefaults.standard.set(tunnelEnabled, forKey: "tunnelEnabled")
            if tunnelEnabled { connectTunnel() } else { tunnel?.stop() }
        }
    }
    let publicURL = URL(string: "https://tv.jcruzhoovertesla.workers.dev")!
    @Published var mediaQuality = MediaQuality(rawValue: UserDefaults.standard.integer(forKey: "mediaQuality")) ?? .balanced {
        didSet { UserDefaults.standard.set(mediaQuality.rawValue, forKey: "mediaQuality") }
    }
    @Published var backgroundPreparation = (UserDefaults.standard.object(forKey: "backgroundPreparation") as? Bool) ?? true {
        didSet { UserDefaults.standard.set(backgroundPreparation, forKey: "backgroundPreparation") }
    }
    let version = "0.1.19"
    let build = "21"
    var preparingTitle: String { videos.first { $0.id == preparingID }?.title ?? "Your video" }
    var queuedCount: Int { videos.filter { $0.state == "preparing" && $0.id != preparingID }.count }
    private var library: Library?
    private var server: HTTPServer?
    private var tunnel: PhoneTunnel?
    private var localStreams = 0
    private var tunnelStreams = 0
    // Indexes are built once per prepared file and then reused by every
    // browser seek. Existing library items without a sidecar are migrated
    // lazily on their first seek so opening the app stays fast.
    private var seekIndexes: [UUID: MPEGTSIndex] = [:]
    private let networkMonitor = NWPathMonitor()
    private var meter: TransferMeter
    private var metricsTask: Task<Void, Never>?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var resumeHostingOnReturn = false
    private var backgroundGeneration: UUID?
    private var addressRefreshTicks = 0
    private var preparationTask: Task<Void, Never>?
    private var authenticationContext: LAContext?

    init() {
        let now = ProcessInfo.processInfo.systemUptime
        var meter = TransferMeter(startedAt: now)
        traffic = meter.sample(at: now)
        self.meter = meter
        do { library = try Library(); refresh() }
        catch { message = "Could not open the local library: \(error.localizedDescription)" }
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let state = PhoneConnection(path: path)
            Task { @MainActor in
                let changed = self?.phoneConnection.name != state.name || self?.phoneConnection.state != state.state
                self?.phoneConnection = state
                if self?.running == true { self?.refreshAddresses() }
                if changed, state.state == .online, self?.running == true, self?.tunnelEnabled == true,
                   self?.tunnelState != .notConfigured { self?.connectTunnel() }
            }
        }
        networkMonitor.start(queue: .global(qos: .utility))
        Task { @MainActor in
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        }
        metricsTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { break }
                self?.sampleTraffic()
            }
        }
        Task { [weak self] in await self?.restorePreparations() }
    }
    deinit { metricsTask?.cancel(); networkMonitor.cancel() }
    func start() {
        guard server == nil, library != nil, !authorizingHost else { return }
        guard hostAuthorized else { requestHostAuthorization(); return }
        startServer()
    }
    private func requestHostAuthorization() {
        guard !authorizingHost else { return }
        let context = LAContext()
        context.localizedCancelTitle = "Not now"
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            message = "Face ID is unavailable. Enable Face ID or a device passcode, then try again."
            return
        }
        authorizingHost = true
        authenticationContext = context
        message = "Confirm Face ID to authorize the Tesla host."
        context.evaluatePolicy(.deviceOwnerAuthentication,
                               localizedReason: "Authorize Video Pilot to host your Tesla browser.") { [weak self] success, error in
            Task { @MainActor in
                guard let self else { return }
                self.authenticationContext = nil
                self.authorizingHost = false
                guard success else {
                    self.message = error?.localizedDescription ?? "Face ID authorization was cancelled."
                    return
                }
                self.hostAuthorized = true
                self.message = "Face ID approved. Starting the Tesla host…"
                self.start()
            }
        }
    }
    private func startServer() {
        let server = HTTPServer { [weak self] request in
            guard let self else { return .json(["error": "Host stopped."], status: 503) }
            return await self.respond(to: request)
        }
        self.server = server
        server.received = { [weak self] in self?.meter.record(received: $0) }
        server.sent = { [weak self] in self?.meter.record(sent: $0) }
        server.streamsChanged = { [weak self] in self?.localStreams = $0; self?.updateStreams() }
        server.ready = { [weak self, weak server] in
            guard let self, let server, self.server === server else { return }
            self.running = true
            self.refreshAddresses()
            self.updateIdleTimer()
            self.message = "Host ready. Face ID authorized this app session; keep the public address private."
            self.connectTunnel()
        }
        server.failed = { [weak self, weak server] error in
            guard let self, let server, self.server === server else { return }
            self.stop(); self.message = error
        }
        do { try server.start() } catch { stop(); message = error.localizedDescription }
    }
    func stop() {
        resumeHostingOnReturn = false
        tunnel?.stop()
        server?.stop()
        server = nil
        running = false
        localURLs = []
        activeStreams = 0
        localStreams = 0
        tunnelStreams = 0
        updateIdleTimer()
    }
    func backgrounded() {
        resumeHostingOnReturn = server != nil
        if allowBackgroundTime, (server != nil || busy), backgroundTask == .invalid {
            let generation = UUID()
            backgroundGeneration = generation
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "MK8 active work") { [weak self] in
                Task { @MainActor in
                    guard self?.backgroundGeneration == generation else { return }
                    self?.expireBackgroundTime()
                }
            }
            backgroundTimeActive = backgroundTask != .invalid
        }
        if !backgroundTimeActive, server != nil {
            message = "Hosting continues while iOS permits background time."
        }
    }
    func foregrounded() {
        finishBackgroundTime()
        _ = meter.sample(at: ProcessInfo.processInfo.systemUptime)
        trafficHistory.removeAll()
        sampleTraffic()
        if busy, !BackgroundPreparation.shared.isRunning { requestBackgroundPreparation() }
        if resumeHostingOnReturn, server == nil { start() }
        resumeHostingOnReturn = false
        if running { refreshAddresses(); connectTunnel() }
        updateIdleTimer()
    }
    private func expireBackgroundTime() {
        finishBackgroundTime()
        message = "iOS background time expired. Hosting will reconnect when Video Pilot returns."
    }
    private func finishBackgroundTime() {
        backgroundGeneration = nil
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        backgroundTimeActive = false
    }
    private func updateIdleTimer() { UIApplication.shared.isIdleTimerDisabled = keepScreenAwake && (busy || running) }
    private func refreshAddresses() { localURLs = Self.addresses().map { "http://\($0):5000" } }
    private func sampleTraffic() {
        traffic = meter.sample(at: ProcessInfo.processInfo.systemUptime)
        trafficHistory.append(traffic)
        if trafficHistory.count > 30 { trafficHistory.removeFirst(trafficHistory.count - 30) }
        addressRefreshTicks += 1
        if running, addressRefreshTicks % 5 == 0 { refreshAddresses() }
    }
    func saveSearchKey() {
        do {
            try Keychain.write(searchKey.trimmingCharacters(in: .whitespacesAndNewlines), account: "youtube-search")
            message = "YouTube search key saved."
        }
        catch { message = "Could not save the search key: \(error.localizedDescription)" }
    }
    func saveTunnelKey() {
        let key = tunnelKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.utf8.count <= 512, !key.contains("\n"), !key.contains("\r") else {
            tunnelMessage = "Enter the TV_SECRET value only, without the name or extra lines."
            return
        }
        do {
            try Keychain.write(key, account: "tunnel-key")
            tunnelKey = key
            if key.isEmpty {
                tunnel?.stop()
                tunnelState = .notConfigured
                tunnelMessage = "Save TV_SECRET from your original MK8 .env file in Settings."
            } else {
                tunnelMessage = "Key saved. Start hosting to connect."
                if running { connectTunnel() }
                else { tunnelState = .disconnected }
            }
        } catch { tunnelMessage = "Could not save the tunnel key: \(error.localizedDescription)" }
    }
    func connectTunnel() {
        guard running, tunnelEnabled else { return }
        let key = Keychain.read("tunnel-key")
        guard !key.isEmpty else {
            tunnel?.stop()
            tunnelState = .notConfigured
            tunnelMessage = "Save TV_SECRET from your original MK8 .env file in Settings."
            return
        }
        if tunnel == nil {
            let relay = PhoneTunnel(publicURL: publicURL) { [weak self] request in
                guard let self, self.running else { return .json(["error": "Host stopped."], status: 503) }
                return await self.respond(to: request)
            }
            relay.stateChanged = { [weak self] state, text in self?.tunnelState = state; self?.tunnelMessage = text }
            relay.received = { [weak self] in self?.meter.record(received: $0) }
            relay.sent = { [weak self] in self?.meter.record(sent: $0) }
            relay.streamsChanged = { [weak self] in self?.tunnelStreams = $0; self?.updateStreams() }
            tunnel = relay
        }
        tunnel?.start(secret: key)
    }
    private func updateStreams() { activeStreams = localStreams + tunnelStreams }
    func addYouTube(_ input: String) {
        guard let id = YouTubeID.parse(input) else { message = "Enter a YouTube video URL or 11-character ID."; return }
        _ = queue(id: id, imported: nil)
    }
    func importVideo(_ url: URL) { _ = queue(id: nil, imported: url) }
    func remove(_ id: UUID) {
        guard !busy else { message = "Wait for the current video to finish."; return }
        do { try library?.remove(id); seekIndexes.removeValue(forKey: id); refresh() } catch { message = error.localizedDescription }
    }
    @discardableResult private func queue(id: String?, imported: URL?) -> LibraryVideo? {
        guard let library else { message = "The library is unavailable."; return nil }
        let video: LibraryVideo
        do { video = try library.add(title: id.map { "YouTube \($0)" } ?? imported?.lastPathComponent ?? "Video", youtubeID: id) }
        catch { message = error.localizedDescription; return nil }
        if !busy { launchPreparation(video: video, imported: imported) }
        else { message = "Added to the preparation queue. It will start automatically." }
        return video
    }
    func retry(_ id: UUID) {
        guard !busy, let library, let video = library.videos.first(where: { $0.id == id }) else { return }
        let job = try? MediaPipeline.store.load(id)
        guard job != nil || video.youtubeID != nil else { message = "Import this file again from Files."; return }
        seekIndexes.removeValue(forKey: id)
        MediaPipeline.store.clearFailures(id)
        MediaDownloader.shared.forget(jobID: id)
        launchPreparation(video: video, restored: job)
    }
    func pausePreparation() { preparationTask?.cancel() }
    func diagnostics(for id: UUID) -> URL? {
        let file = MediaPipeline.diagnosticsURL(id)
        return FileManager.default.fileExists(atPath: file.path) ? file : downloadDiagnostics(for: id)
    }
    func downloadDiagnostics(for id: UUID) -> URL? {
        let file = DownloadDiagnostics.file(for: id)
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }
    private func requestBackgroundPreparation() {
        BackgroundPreparation.shared.begin(title: preparingTitle, enabled: backgroundPreparation) { [weak self] in
            self?.pausePreparation()
        }
    }
    private func launchPreparation(video: LibraryVideo, imported: URL? = nil, restored: MediaPreparationJob? = nil) {
        guard let library, !busy else { return }
        busy = true
        preparingID = video.id
        preparationStartedAt = Date()
        preparation = .init(stage: restored != nil ? .downloading : (video.youtubeID == nil ? .importing : .resolving))
        try? library.update(video.id, state: "preparing")
        updateIdleTimer()
        refresh()
        requestBackgroundPreparation()
        message = "Preparing your video. Progress is on the Videos tab."
        let quality = restored?.quality ?? mediaQuality
        preparationTask = Task {
            let output = library.file(for: video.id)
            var succeeded = false
            do {
                let prepared: PreparedMedia
                let progress = progressCallback(for: video.id)
                let traffic = trafficCallback()
                if let restored {
                    prepared = try await MediaPipeline.resume(restored, output: output,
                        background: backgroundDownloads, progress: progress, traffic: traffic)
                } else if let id = video.youtubeID {
                    prepared = try await MediaPipeline.youtube(id: id, jobID: video.id, output: output,
                        background: backgroundDownloads, quality: quality, progress: progress, traffic: traffic)
                } else if let imported {
                    prepared = try await MediaPipeline.imported(imported, jobID: video.id, output: output,
                        background: backgroundDownloads, quality: quality, progress: progress, traffic: traffic)
                } else { throw MediaError.noStream }
                try Task.checkCancellation()
                try library.update(video.id, title: prepared.title, state: "ready", duration: prepared.duration)
                try? MediaPipeline.store.remove(video.id)
                message = "\(prepared.title) is ready in the Tesla library."
                notify(title: prepared.title, body: "Ready to play in Video Pilot.")
                succeeded = true
            } catch {
                await MediaDownloader.shared.cancel(jobID: video.id)
                try? FileManager.default.removeItem(at: output)
                try? FileManager.default.removeItem(at: MediaPipeline.seekIndexURL(for: output))
                let paused = error is CancellationError || Task.isCancelled
                let text = paused ? "Paused. Tap Resume; completed downloads are saved." : error.localizedDescription
                let title = (try? MediaPipeline.store.load(video.id))?.title
                try? library.update(video.id, title: title, state: paused ? "paused" : "failed", message: text)
                message = text
                // Retain sources, verified chunks and diagnostics until success or explicit deletion.
            }
            MediaDownloader.shared.forget(jobID: video.id)
            BackgroundPreparation.shared.finish(success: succeeded)
            busy = false
            preparingID = nil
            preparationStartedAt = nil
            preparation = nil
            preparationTask = nil
            startNextQueued()
            updateIdleTimer()
            refresh()
        }
    }
    private func startNextQueued() {
        guard !busy, let next = library?.videos.first(where: { $0.state == "preparing" }) else { return }
        launchPreparation(video: next, restored: try? MediaPipeline.store.load(next.id))
    }
    private func refresh() { videos = library?.videos ?? [] }
    private func seekIndex(for id: UUID, file url: URL) -> MPEGTSIndex? {
        if let cached = seekIndexes[id] { return cached }
        let sidecar = MediaPipeline.seekIndexURL(for: url)
        if let data = try? Data(contentsOf: sidecar), let index = try? JSONDecoder().decode(MPEGTSIndex.self, from: data),
           !index.points.isEmpty {
            seekIndexes[id] = index
            return index
        }
        guard let built = try? MPEGTSIndex.build(file: url), !built.points.isEmpty else { return nil }
        // The sidecar is only an optimization; a write failure must not make a
        // video unplayable. The in-memory index still fixes this session.
        if let data = try? JSONEncoder().encode(built) {
            try? data.write(to: sidecar, options: .atomic)
            try? MediaPipeline.protect(sidecar)
        }
        seekIndexes[id] = built
        return built
    }
    private func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = "Video Pilot"
        content.subtitle = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: "video-ready-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
    private func progressCallback(for id: UUID) -> MediaPipeline.Progress {
        { [weak self] progress in
            Task { @MainActor in
                guard let self, self.busy, self.preparingID == id else { return }
                self.preparation = progress
                BackgroundPreparation.shared.update(progress)
                if self.preparingTitle.hasPrefix("YouTube "), let job = try? MediaPipeline.store.load(id),
                   job.title != self.preparingTitle {
                    try? self.library?.update(id, title: job.title, state: "preparing")
                    self.refresh()
                }
            }
        }
    }
    private func trafficCallback() -> MediaPipeline.Traffic {
        { [weak self] received in Task { @MainActor in self?.meter.record(received: received) } }
    }
    private func restorePreparations() async {
        guard let library else { return }
        for job in MediaPipeline.store.jobs() {
            guard let video = library.videos.first(where: { $0.id == job.id }) else {
                try? MediaPipeline.store.remove(job.id); continue
            }
            // Failed and paused jobs stay available for an explicit retry, including cached sources.
            guard video.state == "preparing", !busy else { continue }
            launchPreparation(video: video, restored: job)
        }
    }

    private func respond(to request: HTTPRequest) async -> HTTPResponse {
        guard ["GET", "POST"].contains(request.method) else { return .json(["error": "Method not allowed."], status: 405) }
        // Browser mutations must be same-origin. A tunnel adapter must preserve the external Origin and Host consistently.
        if request.method == "POST", let origin = request.headers["origin"] {
            guard let components = URLComponents(string: origin), let host = components.host,
                  ["http", "https"].contains(components.scheme ?? "") else {
                return .json(["error": "Invalid origin."], status: 403)
            }
            let authority = host + (components.port.map { ":\($0)" } ?? "")
            guard authority == request.headers["host"] else { return .json(["error": "Use the host page to submit requests."], status: 403) }
        }
        let assets: [String: (String, String)] = ["/": ("index.html", "text/html; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript"), "/http-source.js": ("http-source.js", "text/javascript"),
            "/style.css": ("style.css", "text/css"), "/jsmpeg.min.js": ("jsmpeg.min.js", "text/javascript")]
        if request.method == "GET", let (name, type) = assets[request.path] {
            guard let root = Bundle.main.resourceURL?.appendingPathComponent("GeneratedWeb"),
                  let data = try? Data(contentsOf: root.appendingPathComponent(name)) else {
                return .json(["error": "Web assets missing. Run prepare_web.py before building."], status: 503)
            }
            return HTTPResponse(status: 200, contentType: type, body: data,
                headers: ["Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://i.ytimg.com; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"])
        }
        if request.path == "/api/library", request.method == "GET" {
            return HTTPResponse(status: 200, contentType: "application/json", body: (try? JSONEncoder().encode(videos)) ?? Data("[]".utf8))
        }
        if request.path == "/api/status", request.method == "GET" {
            let progressValue: Any
            if let progress = preparation?.fraction { progressValue = progress } else { progressValue = NSNull() }
            return .json(["hosting": running, "busy": busy, "publicAccess": true, "authentication": "faceID-on-start",
                          "youtubeSearch": !searchKey.isEmpty, "youtubeExplore": !searchKey.isEmpty,
                          "tunnel": tunnelState.rawValue, "version": version, "build": build,
                          "activeStreams": activeStreams, "queuedCount": queuedCount, "downloadMbps": traffic.downloadMbps,
                          "uploadMbps": traffic.uploadMbps,
                          "preparationStage": preparation?.stage.rawValue ?? "idle",
                          "preparationProgress": progressValue,
                          "processingSpeed": preparation?.processingSpeed.map { $0 as Any } ?? NSNull(),
                          "preparationSecondsRemaining": preparation?.secondsRemaining.map { $0 as Any } ?? NSNull(),
                          "preparingID": preparingID?.uuidString ?? ""])
        }
        if request.path == "/api/youtube", request.method == "POST" {
            guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: String],
                  let id = YouTubeID.parse(body["url"] ?? "") else {
                return .json(["error": "Enter a valid YouTube URL or video ID."], status: 400)
            }
            guard let video = queue(id: id, imported: nil) else { return .json(["error": message], status: 409) }
            return .json(["id": video.id.uuidString], status: 202)
        }
        if request.path == "/api/search", request.method == "GET" {
            guard !searchKey.isEmpty else { return .json(["error": "Set a YouTube Data API key in the iPhone app to enable search. URL import works without it."], status: 503) }
            let query = request.query.first(where: { $0.name == "q" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !query.isEmpty, query.count <= 200 else { return .json(["error": "Enter a search of up to 200 characters."], status: 400) }
            do {
                let results = try await YouTubeSearch.search(query, apiKey: searchKey)
                return HTTPResponse(status: 200, contentType: "application/json", body: try JSONEncoder().encode(results))
            } catch { return .json(["error": "YouTube search failed. Check the key, quota, and connection on the iPhone."], status: 503) }
        }
        if request.path == "/api/explore", request.method == "GET" {
            guard !searchKey.isEmpty else { return .json(["error": "Set a YouTube Data API key in the iPhone app to enable Explore."], status: 503) }
            do { return .json(try await YouTubeSearch.trending(apiKey: searchKey).map { ["id": $0.id, "title": $0.title, "channel": $0.channel, "thumbnail": $0.thumbnail ?? ""] }) }
            catch { return .json(["error": "YouTube Explore failed. Check the key, quota, and connection on the iPhone."], status: 503) }
        }
        if request.method == "GET", request.path.hasPrefix("/api/stream/"), request.path.hasSuffix(".ts") {
            let raw = String(request.path.dropFirst("/api/stream/".count).dropLast(3))
            guard let id = UUID(uuidString: raw), let video = videos.first(where: { $0.id == id && $0.state == "ready" }),
                  let url = library?.file(for: id), FileManager.default.fileExists(atPath: url.path) else {
                return .json(["error": "Video is not ready or no longer exists."], status: 404)
            }
            let fileSize = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
            let index = seekIndex(for: id, file: url)
            var offset: Int64 = 0
            var seekTime: Double?
            if let rawSeek = request.query.first(where: { $0.name == "seek" })?.value,
               let seek = Double(rawSeek), seek.isFinite, seek > 0, fileSize > 0 {
                if let index, let point = index.point(for: seek) {
                    // The index points to a PAT context, not an arbitrary byte
                    // in a PES packet. That lets JSMpeg rebuild decoder state
                    // after a seek instead of inheriting a partial buffer.
                    offset = min(max(0, point.offset), max(0, fileSize - 188))
                    seekTime = point.time
                    if let measured = index.duration,
                       video.duration == nil || abs((video.duration ?? measured) - measured) > 1 {
                        // Repair legacy library entries whose source duration
                        // disagreed with the prepared MPEG-TS output.
                        try? library?.update(id, state: "ready", duration: measured)
                        refresh()
                    }
                } else {
                    // Keep a conservative compatibility fallback for files
                    // made by an older build that cannot be indexed.
                    if let duration = video.duration, duration > 0 {
                        let ratio = min(0.999, max(0, seek / duration))
                        offset = Int64(Double(fileSize) * ratio)
                        offset -= offset % 188
                    }
                }
            }
            var headers = ["X-Accel-Buffering": "no", "Accept-Ranges": "bytes"]
            if offset > 0 { headers["X-Video-Seek"] = String(offset) }
            if let seekTime { headers["X-Video-Seek-Time"] = String(format: "%.3f", seekTime) }
            if let duration = index?.duration { headers["X-Video-Duration"] = String(format: "%.3f", duration) }
            let fileRange: Range<Int64>? = offset > 0 ? offset..<fileSize : nil
            return HTTPResponse(status: 200, contentType: "video/mp2t", headers: headers,
                                file: url, fileRange: fileRange)
        }
        return .json(["error": "Not found."], status: 404)
    }
    private static func addresses() -> [String] {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0 else { return [] }
        defer { freeifaddrs(list) }
        var addresses = [String]()
        var cursor = list
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.pointee.ifa_flags & UInt32(IFF_UP) != 0 else { continue }
            let name = String(cString: entry.pointee.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("bridge") || name.hasPrefix("ap") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                addresses.append(String(cString: host))
            }
        }
        return Array(Set(addresses)).sorted()
    }
}
