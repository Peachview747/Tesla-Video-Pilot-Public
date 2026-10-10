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
    @Published private(set) var youtubeSignedIn = false
    let youtubeOAuth = YouTubeOAuth()
    let pipPlayback = PiPPlayback()
    @Published var keepHostingAlive = (UserDefaults.standard.object(forKey: "keepHostingAlive") as? Bool) ?? false {
        didSet {
            UserDefaults.standard.set(keepHostingAlive, forKey: "keepHostingAlive")
            updateKeepAlive()
        }
    }
    private var leavingForeground = false
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
    let version = "0.1.31"
    let build = "43"
    var preparingTitle: String { videos.first { $0.id == preparingID }?.title ?? "Your video" }
    var queuedCount: Int { videos.filter { $0.state == "preparing" && $0.id != preparingID }.count }
    private var library: Library?
    private var server: HTTPServer?
    private var tunnel: PhoneTunnel?
    private var localStreams = 0
    private var tunnelStreams = 0
    // Indexes are built once per prepared file and then reused by every
    // browser seek. Existing library items without a sidecar are migrated in
    // a utility task so opening or seeking never blocks the HTTP route.
    private var seekIndexes: [UUID: MPEGTSIndex] = [:]
    private var seekIndexTasks: [UUID: Task<MPEGTSIndex?, Never>] = [:]
    private var seekIndexGenerations: [UUID: UUID] = [:]
    private var importsInProgress = Set<UUID>()
    private var removalsRequested = Set<UUID>()
    private let networkMonitor = NWPathMonitor()
    private var meter: TransferMeter
    private var metricsTask: Task<Void, Never>?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var resumeHostingOnReturn = false
    private var backgroundGeneration: UUID?
    private var addressRefreshTicks = 0
    private var preparationTask: Task<Void, Never>?
    private var diagnosticsProbeTask: Task<Void, Never>?
    private var authenticationContext: LAContext?
    private var authenticationGeneration: UUID?
    private let diagnosticsLogger = SessionDiagnostics.shared

    init() {
        let now = ProcessInfo.processInfo.systemUptime
        var meter = TransferMeter(startedAt: now)
        traffic = meter.sample(at: now)
        self.meter = meter
        youtubeSignedIn = youtubeOAuth.signedIn
        diagnosticsLogger.record(component: "app", event: "launch")
        Keychain.migrateToAfterFirstUnlock("tunnel-key")
        do { library = try Library(); refresh(); fillMissingDetails() }
        catch { message = "Could not open the local library: \(error.localizedDescription)" }
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let state = PhoneConnection(path: path)
            Task { @MainActor in
                let changed = self?.phoneConnection.name != state.name || self?.phoneConnection.state != state.state
                self?.phoneConnection = state
                if let self {
                    self.diagnosticsLogger.record(component: "network", event: "path",
                        fields: ["state": state.stateLabel, "interface": state.interfaceName,
                                 "constrained": String(state.lowDataMode), "expensive": String(state.expensive)],
                        throttleKey: "network-path", minimumInterval: changed ? 0 : 5)
                }
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
    deinit { metricsTask?.cancel(); diagnosticsProbeTask?.cancel(); networkMonitor.cancel() }
    func start() {
        guard server == nil, library != nil, !authorizingHost else { return }
        guard hostAuthorized else { requestHostAuthorization(); return }
        diagnosticsLogger.record(component: "host", event: "startRequested")
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
        let generation = UUID()
        authenticationGeneration = generation
        authenticationContext = context
        message = "Confirm Face ID to authorize the Tesla host."
        context.evaluatePolicy(.deviceOwnerAuthentication,
                               localizedReason: "Authorize Video Pilot to host your Tesla browser.") { [weak self] success, error in
            Task { @MainActor in
                guard let self, self.authenticationGeneration == generation else { return }
                self.authenticationGeneration = nil
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
            self.updateKeepAlive()
            self.refreshAddresses()
            self.updateIdleTimer()
            self.message = "Host ready. Face ID authorized this app session; keep the public address private."
            self.diagnosticsLogger.record(component: "host", event: "ready", fields: ["port": "5000"])
            self.connectTunnel()
            self.startDiagnosticsProbes()
        }
        server.failed = { [weak self, weak server] error in
            guard let self, let server, self.server === server else { return }
            self.diagnosticsLogger.record(component: "host", event: "failed", fields: ["error": error])
            self.stop(); self.message = error
        }
        do { try server.start() } catch { stop(); message = error.localizedDescription }
    }
    func stop() {
        authenticationGeneration = nil
        authenticationContext?.invalidate()
        authenticationContext = nil
        authorizingHost = false
        diagnosticsLogger.record(component: "host", event: "stopped")
        diagnosticsProbeTask?.cancel()
        diagnosticsProbeTask = nil
        resumeHostingOnReturn = false
        tunnel?.stop()
        server?.stop()
        server = nil
        running = false
        updateKeepAlive()
        localURLs = []
        activeStreams = 0
        localStreams = 0
        tunnelStreams = 0
        if !busy { finishBackgroundTime() }
        updateIdleTimer()
    }
    func preparingToBackground() {
        leavingForeground = true
        // Begin before suspension, rather than waiting to activate audio after
        // the app has already entered the background.
        updateKeepAlive()
    }
    private func updateKeepAlive() {
        SilentAudioKeepAlive.shared.update(enabled: keepHostingAlive,
            hosting: running, foreground: !leavingForeground)
    }
    func backgrounded() {
        preparingToBackground()
        diagnosticsLogger.record(component: "app", event: "backgrounded",
            fields: ["pipActive": "\(pipPlayback.active)", "hosting": "\(running)",
                     "keepaliveActive": "\(SilentAudioKeepAlive.shared.isActive)"])
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
        diagnosticsLogger.record(component: "app", event: "foregrounded",
            fields: ["pipActive": "\(pipPlayback.active)", "hosting": "\(running)",
                     "keepaliveActive": "\(SilentAudioKeepAlive.shared.isActive)"])
        leavingForeground = false
        updateKeepAlive()
        finishBackgroundTime()
        _ = meter.sample(at: ProcessInfo.processInfo.systemUptime)
        trafficHistory.removeAll()
        sampleTraffic()
        if busy, !BackgroundPreparation.shared.isRunning { requestBackgroundPreparation() }
        if resumeHostingOnReturn, server == nil { start() }
        resumeHostingOnReturn = false
        if running { refreshAddresses(); connectTunnel(force: false) }
        updateIdleTimer()
    }
    private func expireBackgroundTime() {
        diagnosticsLogger.record(component: "app", event: "backgroundGraceExpired",
            fields: ["pipActive": "\(pipPlayback.active)", "hosting": "\(running)",
                     "keepaliveActive": "\(SilentAudioKeepAlive.shared.isActive)"])
        finishBackgroundTime()
        message = SilentAudioKeepAlive.shared.isActive || pipPlayback.active
            ? "Background grace expired. Audio hosting support is experimental; check the Tesla connection."
            : "iOS background time expired. Hosting will reconnect when Video Pilot returns."
    }
    private func finishBackgroundTime() {
        backgroundGeneration = nil
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        backgroundTimeActive = false
    }
    func setDiagnosticsEnabled(_ value: Bool) {
        diagnosticsLogger.setEnabled(value)
        if value, running { startDiagnosticsProbes() }
        if !value { diagnosticsProbeTask?.cancel(); diagnosticsProbeTask = nil }
    }
    func diagnosticsExportURL() -> URL? { diagnosticsLogger.exportURL() }
    func clearDiagnostics() { diagnosticsLogger.clear() }
    private func startDiagnosticsProbes() {
        diagnosticsProbeTask?.cancel()
        guard diagnosticsLogger.enabled else { return }
        diagnosticsProbeTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.runDiagnosticsProbe()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }
    private func runDiagnosticsProbe() async {
        guard diagnosticsLogger.enabled, running else { return }
        let key = Keychain.read("tunnel-key")
        guard !key.isEmpty else { return }
        var request = URLRequest(url: publicURL.appendingPathComponent("__iphone/status"))
        request.setValue(key, forHTTPHeaderField: "x-secret")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let started = ProcessInfo.processInfo.systemUptime
        do {
            request.timeoutInterval = 8
            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            let (_, response) = try await session.data(for: request)
            let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            diagnosticsLogger.record(component: "network", event: "workerProbe",
                fields: ["status": String(status), "elapsedMs": String(format: "%.1f", elapsed),
                         "probe": "phone-to-cloudflare-https"])
        } catch {
            let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
            diagnosticsLogger.record(component: "network", event: "workerProbe",
                fields: ["status": "error", "elapsedMs": String(format: "%.1f", elapsed),
                         "error": error.localizedDescription])
        }
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
    func signInYouTube() {
        message = "Complete Google sign-in in the secure browser window."
        Task { @MainActor in
            do {
                try await youtubeOAuth.signIn()
                youtubeSignedIn = youtubeOAuth.signedIn
                message = "YouTube account connected."
            } catch { message = error.localizedDescription }
        }
    }
    func signOutYouTube() {
        youtubeOAuth.signOut()
        youtubeSignedIn = false
        message = "YouTube account disconnected."
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
    /// `force: false` leaves a connected or already-connecting tunnel alone, so
    /// returning to the foreground does not drop every active stream.
    func connectTunnel(force: Bool = true) {
        guard running, tunnelEnabled else { return }
        // A locked phone cannot read the Keychain; fall back to the key already
        // loaded in memory rather than stopping the tunnel as "not configured".
        var key = Keychain.read("tunnel-key")
        if key.isEmpty { key = tunnelKey.trimmingCharacters(in: .whitespacesAndNewlines) }
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
            relay.stateChanged = { [weak self] state, text in
                self?.tunnelState = state
                self?.tunnelMessage = text
                self?.diagnosticsLogger.record(component: "tunnel", event: "state",
                    fields: ["state": state.rawValue])
            }
            relay.received = { [weak self] in self?.meter.record(received: $0) }
            relay.sent = { [weak self] in self?.meter.record(sent: $0) }
            relay.streamsChanged = { [weak self] in self?.tunnelStreams = $0; self?.updateStreams() }
            tunnel = relay
        }
        if !force, tunnel != nil,
           tunnelState == .connected || tunnelState == .connecting || tunnelState == .reconnecting { return }
        tunnel?.start(secret: key)
    }
    private func updateStreams() { activeStreams = localStreams + tunnelStreams }
    func addYouTube(_ input: String) {
        guard let id = YouTubeID.parse(input) else { message = "Enter a YouTube video URL or 11-character ID."; return }
        _ = queue(id: id, imported: nil)
    }
    func importVideo(_ url: URL) {
        guard let library else { message = "The library is unavailable."; return }
        do {
            let video = try library.add(title: url.deletingPathExtension().lastPathComponent, state: "importing")
            importsInProgress.insert(video.id)
            refresh()
            let quality = mediaQuality
            Task {
                do {
                    _ = try await MediaPipeline.stageImported(url, jobID: video.id, quality: quality)
                    try library.update(video.id, state: "preparing")
                    message = "Imported video added to the preparation queue."
                } catch {
                    try? library.update(video.id, state: "failed", message: error.localizedDescription)
                    message = "Import failed: \(error.localizedDescription)"
                }
                importsInProgress.remove(video.id)
                if removalsRequested.remove(video.id) != nil { _ = remove(video.id) }
                refresh()
                startNextQueued()
            }
        } catch { message = error.localizedDescription }
    }
    @discardableResult func remove(_ id: UUID) -> Bool {
        guard let library, library.videos.contains(where: { $0.id == id }) else { return false }
        if busy && preparingID == id {
            removalsRequested.insert(id)
            preparationTask?.cancel()
            message = "Cancelling preparation and removing the video…"
            return true
        }
        if importsInProgress.contains(id) {
            removalsRequested.insert(id)
            message = "Removing the imported video when its file copy finishes…"
            return true
        }
        do {
            try library.remove(id)
            seekIndexes.removeValue(forKey: id)
            seekIndexTasks.removeValue(forKey: id)?.cancel()
            seekIndexGenerations.removeValue(forKey: id)
            refresh()
            return true
        }
        catch { message = error.localizedDescription; return false }
    }
    @discardableResult private func queue(id: String?, imported: URL?) -> LibraryVideo? {
        guard let library else { message = "The library is unavailable."; return nil }
        if let id, let existing = library.videos.first(where: {
            guard let existingID = $0.youtubeID else { return false }
            return existingID == id
        }) {
            message = existing.state == "preparing"
                ? "That video is already in the preparation queue."
                : "That video is already in your library. Use Play or Retry instead."
            return nil
        }
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
        seekIndexTasks.removeValue(forKey: id)?.cancel()
        seekIndexGenerations.removeValue(forKey: id)
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
    /// Channel and release date power the Tesla library's sort options. They
    /// are fetched once per video; older library items are filled at launch.
    private func fillDetails(_ id: UUID, youtubeID: String) {
        Task { @MainActor [weak self] in
            let details = await YouTubeDetails.fetch(youtubeID)
            guard let self, details.channel != nil || details.publishedAt != nil else { return }
            try? self.library?.setDetails(id, channel: details.channel, publishedAt: details.publishedAt)
            self.refresh()
        }
    }
    private func fillMissingDetails() {
        let missing = (library?.videos ?? []).compactMap { video -> (UUID, String)? in
            guard let youtubeID = video.youtubeID, video.channel == nil || video.publishedAt == nil else { return nil }
            return (video.id, youtubeID)
        }
        guard !missing.isEmpty else { return }
        Task { @MainActor [weak self] in
            for (id, youtubeID) in missing {
                let details = await YouTubeDetails.fetch(youtubeID)
                guard let self else { return }
                if details.channel != nil || details.publishedAt != nil {
                    try? self.library?.setDetails(id, channel: details.channel, publishedAt: details.publishedAt)
                }
            }
            self?.refresh()
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
                if let youtubeID = video.youtubeID { fillDetails(video.id, youtubeID: youtubeID) }
                message = "\(prepared.title) is ready in the Tesla library."
                notify(title: prepared.title, body: "Ready to play in Video Pilot.")
                succeeded = true
            } catch {
                await MediaDownloader.shared.cancel(jobID: video.id)
                try? FileManager.default.removeItem(at: output)
                try? FileManager.default.removeItem(at: MediaPipeline.seekIndexURL(for: output))
                seekIndexTasks.removeValue(forKey: video.id)?.cancel()
                seekIndexGenerations.removeValue(forKey: video.id)
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
            if removalsRequested.remove(video.id) != nil {
                if remove(video.id) { message = "Video removed." }
            }
            startNextQueued()
            updateIdleTimer()
            refresh()
        }
    }
    private func startNextQueued() {
        guard !busy, let next = library?.videos.filter({ $0.state == "preparing" }).min(by: { $0.createdAt < $1.createdAt }) else { return }
        launchPreparation(video: next, restored: try? MediaPipeline.store.load(next.id))
    }
    private func refresh() { videos = library?.videos ?? [] }
    private func cachedSeekIndex(for id: UUID, file url: URL) -> MPEGTSIndex? {
        if let cached = seekIndexes[id] { return cached }
        let sidecar = MediaPipeline.seekIndexURL(for: url)
        if let data = try? Data(contentsOf: sidecar), let index = try? JSONDecoder().decode(MPEGTSIndex.self, from: data),
           index.version == MPEGTSIndex.currentVersion, !index.points.isEmpty {
            seekIndexes[id] = index
            return index
        }
        return nil
    }
    private func seekIndex(for id: UUID, file url: URL) async -> MPEGTSIndex? {
        if let cached = cachedSeekIndex(for: id, file: url) { return cached }
        // Building a timestamp index scans the entire MPEG-TS file. Never do
        // that synchronously in the main-actor HTTP route: a large first seek
        // used to pause the tunnel heartbeat long enough for Cloudflare to
        // declare the phone disconnected. Coalesce concurrent seeks for the
        // same legacy file into one utility-priority background scan.
        let task: Task<MPEGTSIndex?, Never>
        let generation: UUID
        if let existing = seekIndexTasks[id] {
            task = existing
            guard let existingGeneration = seekIndexGenerations[id] else { return nil }
            generation = existingGeneration
        } else {
            generation = UUID()
            seekIndexGenerations[id] = generation
            task = Task.detached(priority: .utility) {
                try? MPEGTSIndex.build(file: url)
            }
            seekIndexTasks[id] = task
        }
        let result = await task.value
        // Delete/retry may replace this file while the background scan awaits.
        // A stale task must never recreate a sidecar or overwrite a new index.
        guard seekIndexGenerations[id] == generation else { return nil }
        seekIndexGenerations[id] = nil
        guard let built = result, !built.points.isEmpty,
              library?.videos.contains(where: { $0.id == id && $0.state == "ready" }) == true,
              FileManager.default.fileExists(atPath: url.path) else {
            seekIndexTasks[id] = nil
            return nil
        }
        // The sidecar is only an optimization; a write failure must not make a
        // video unplayable. The in-memory index still fixes this session.
        if let data = try? JSONEncoder().encode(built) {
            let sidecar = MediaPipeline.seekIndexURL(for: url)
            try? data.write(to: sidecar, options: .atomic)
            try? MediaPipeline.protect(sidecar)
        }
        seekIndexes[id] = built
        seekIndexTasks[id] = nil
        return built
    }
    private func primeSeekIndex(for id: UUID, file url: URL) {
        guard seekIndexes[id] == nil, seekIndexTasks[id] == nil else { return }
        // Start migration in the background. The first legacy seek uses a
        // bounded byte-ratio fallback immediately; later seeks use the exact
        // MPEG-TS anchors once this task has finished, so the HTTP route never
        // waits long enough to trip the tunnel's response timeout.
        Task { [weak self] in _ = await self?.seekIndex(for: id, file: url) }
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
            // Failed and paused jobs stay available for an explicit retry.
            _ = video
        }
        startNextQueued()
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
            "/diagnostics.js": ("diagnostics.js", "text/javascript"),
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
                          "youtubeSearch": true, "youtubeExplore": !searchKey.isEmpty || youtubeSignedIn,
                          "youtubeSignedIn": youtubeSignedIn,
                          "tunnel": tunnelState.rawValue, "version": version, "build": build,
                          "activeStreams": activeStreams, "queuedCount": queuedCount, "downloadMbps": traffic.downloadMbps,
                          "uploadMbps": traffic.uploadMbps,
                          "preparationStage": preparation?.stage.rawValue ?? "idle",
                          "preparationProgress": progressValue,
                          "processingSpeed": preparation?.processingSpeed.map { $0 as Any } ?? NSNull(),
                          "preparationSecondsRemaining": preparation?.secondsRemaining.map { $0 as Any } ?? NSNull(),
                          "preparingID": preparingID?.uuidString ?? "",
                          "diagnosticsEnabled": diagnosticsLogger.enabled,
                          "diagnosticsEventCount": diagnosticsLogger.eventCount])
        }
        if request.path == "/api/diagnostics/export", request.method == "GET" {
            guard let data = diagnosticsLogger.exportData() else {
                return .json(["error": "No diagnostic events recorded yet."], status: 404)
            }
            return HTTPResponse(status: 200, contentType: "application/x-ndjson; charset=utf-8", body: data,
                                headers: ["Content-Disposition": "attachment; filename=VideoPilot-diagnostics.jsonl"])
        }
        if request.path == "/api/diagnostics", request.method == "POST" {
            guard diagnosticsLogger.enabled,
                  let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let events = object["events"] as? [[String: Any]] else {
                return .json(["accepted": false])
            }
            var accepted = 0
            for entry in events.prefix(64) {
                guard let event = entry["event"] as? String, event.count <= 64 else { continue }
                var fields: [String: String] = [:]
                if let raw = entry["fields"] as? [String: Any] {
                    for (key, value) in raw.prefix(24) { fields[key] = String(describing: value) }
                }
                if let eventID = entry["eventId"] as? String { fields["eventId"] = eventID }
                if let occurredAt = entry["occurredAt"] as? String { fields["occurredAt"] = occurredAt }
                if diagnosticsLogger.recordWeb(event: event, fields: fields) { accepted += 1 }
            }
            diagnosticsLogger.record(component: "browser", event: "batchReceived",
                fields: ["accepted": String(accepted)], throttleKey: "browser-batch", minimumInterval: 1)
            return .json(["accepted": accepted == min(events.count, 64), "count": accepted])
        }
        if request.path == "/api/youtube", request.method == "POST" {
            guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: String],
                  let id = YouTubeID.parse(body["url"] ?? "") else {
                return .json(["error": "Enter a valid YouTube URL or video ID."], status: 400)
            }
            guard let video = queue(id: id, imported: nil) else { return .json(["error": message], status: 409) }
            return .json(["id": video.id.uuidString], status: 202)
        }
        if request.path == "/api/library/remove", request.method == "POST" {
            guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: String],
                  let rawID = body["id"], let id = UUID(uuidString: rawID) else {
                return .json(["error": "Choose a library item to remove."], status: 400)
            }
            guard library?.videos.contains(where: { $0.id == id }) == true else {
                return .json(["error": "That library item no longer exists."], status: 404)
            }
            guard remove(id) else { return .json(["error": message], status: 409) }
            return .json(["removed": !removalsRequested.contains(id), "pending": removalsRequested.contains(id)])
        }
        if request.path == "/api/search", request.method == "GET" {
            let value = { (name: String) in request.query.first(where: { $0.name == name })?.value ?? "" }
            let query = value("q").trimmingCharacters(in: .whitespacesAndNewlines)
            let continuation = value("continuation")
            let filter = YouTubeInnerTube.filters[value("filter")] == nil ? "any" : value("filter")
            guard !query.isEmpty, query.count <= 200, continuation.count <= 3000 else {
                return .json(["error": "Enter a search of up to 200 characters."], status: 400)
            }
            do {
                let page = try await YouTubeInnerTube.search(query, filter: filter, continuation: continuation.isEmpty ? nil : continuation)
                return HTTPResponse(status: 200, contentType: "application/json", body: try JSONEncoder().encode(page))
            } catch {
                // Fall back to the Data API when the account or key allows it.
                guard continuation.isEmpty, youtubeSignedIn || !searchKey.isEmpty else {
                    return .json(["error": error.localizedDescription], status: 503)
                }
                do {
                    let results: [SearchVideo]
                    if youtubeSignedIn {
                        results = try await youtubeOAuth.retryUnauthorized { token in
                            try await YouTubeSearch.search(query, accessToken: token)
                        }
                    } else { results = try await YouTubeSearch.search(query, apiKey: searchKey) }
                    let page = YouTubeInnerTube.Page(results: results.map {
                        YouTubeInnerTube.Hit(id: $0.id, title: $0.title, channel: $0.channel,
                                             thumbnail: $0.thumbnail ?? "https://i.ytimg.com/vi/\($0.id)/mqdefault.jpg",
                                             duration: nil, views: nil, published: nil)
                    }, continuation: nil)
                    return HTTPResponse(status: 200, contentType: "application/json", body: try JSONEncoder().encode(page))
                } catch {
                    youtubeSignedIn = youtubeOAuth.signedIn
                    return .json(["error": "YouTube search failed: \(error.localizedDescription)"], status: 503)
                }
            }
        }
        if request.path == "/api/suggest", request.method == "GET" {
            let query = (request.query.first(where: { $0.name == "q" })?.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty, query.count <= 120 else { return .json([String]()) }
            let suggestions = (try? await YouTubeInnerTube.suggestions(query)) ?? []
            return HTTPResponse(status: 200, contentType: "application/json", body: (try? JSONEncoder().encode(suggestions)) ?? Data("[]".utf8))
        }
        if request.path == "/api/explore", request.method == "GET" {
            do {
                let results: [SearchVideo]
                if youtubeSignedIn {
                    results = try await youtubeOAuth.retryUnauthorized { token in
                        try await YouTubeSearch.subscriptions(accessToken: token)
                    }
                } else {
                    guard !searchKey.isEmpty else { return .json(["error": "Sign in with Google on the iPhone or add a YouTube Data API key in Settings."], status: 503) }
                    results = try await YouTubeSearch.trending(apiKey: searchKey)
                }
                return .json(results.map { ["id": $0.id, "title": $0.title, "channel": $0.channel, "thumbnail": $0.thumbnail ?? ""] })
            }
            catch {
                youtubeSignedIn = youtubeOAuth.signedIn
                return .json(["error": "YouTube Explore failed: \(error.localizedDescription)"], status: 503)
            }
        }
        if request.method == "GET", request.path.hasPrefix("/api/stream/"), request.path.hasSuffix(".ts") {
            let raw = String(request.path.dropFirst("/api/stream/".count).dropLast(3))
            guard let id = UUID(uuidString: raw), let video = videos.first(where: { $0.id == id && $0.state == "ready" }),
                  let url = library?.file(for: id), FileManager.default.fileExists(atPath: url.path) else {
                return .json(["error": "Video is not ready or no longer exists."], status: 404)
            }
            let fileSize = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
            var offset: Int64 = 0
            var seekTime: Double?
            var index: MPEGTSIndex? = cachedSeekIndex(for: id, file: url)
            if index == nil { primeSeekIndex(for: id, file: url) }
            if let rawSeek = request.query.first(where: { $0.name == "seek" })?.value,
               let seek = Double(rawSeek), seek.isFinite, seek > 0, fileSize > 0 {
                // A normal playback start does not need to scan the file. A
                // legacy library item without a sidecar is indexed only when
                // a real seek asks for it, and that scan happens off the main
                // actor in seekIndex(for:file:).
                index = cachedSeekIndex(for: id, file: url)
                if let index, let point = index.point(for: seek) {
                    // The index points to a PAT context, not an arbitrary byte
                    // in a PES packet. That lets JSMpeg rebuild decoder state
                    // after a seek instead of inheriting a partial buffer.
                    offset = min(max(0, point.offset), max(0, fileSize - 188))
                    seekTime = point.time
                } else {
                    // Do not hold the HTTP response while migrating a large
                    // legacy file. Start the exact scan in the background and
                    // use a packet-aligned approximation for this first seek.
                    primeSeekIndex(for: id, file: url)
                    if let duration = video.duration, duration > 0 {
                        let ratio = min(0.999, max(0, seek / duration))
                        offset = Int64(Double(fileSize) * ratio)
                        offset -= offset % 188
                    }
                }
            }
            if let measured = index?.duration,
               video.duration == nil || abs((video.duration ?? measured) - measured) > 1 {
                try? library?.update(id, state: "ready", duration: measured)
                refresh()
            }
            var headers = ["X-Accel-Buffering": "no", "Accept-Ranges": "bytes"]
            if offset > 0 { headers["X-Video-Seek"] = String(offset) }
            if let seekTime { headers["X-Video-Seek-Time"] = String(format: "%.3f", seekTime) }
            if let duration = index?.duration ?? video.duration, duration > 0 {
                headers["X-Video-Duration"] = String(format: "%.3f", duration)
            }
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
