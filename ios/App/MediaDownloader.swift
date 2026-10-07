import Foundation
import MK8Core

/// URLSession owns background transfers; task descriptions reconnect them to
/// persistent preparation jobs if iOS relaunches the app to deliver a download.
final class MediaDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = MediaDownloader(diagnostics: { DownloadDiagnostics.record($0, report: $1) })
    static let backgroundIdentifier = "com.mk8.iphone.host.media-downloads.v1"
    private let lock = NSLock()
    private var backgroundSession: URLSession!
    private var foregroundSession: URLSession!
    private var backgroundCompletion: (() -> Void)?
    private var handlers: [String: Handler] = [:]
    private var results: [String: Result<URL, Error>] = [:]
    private var downloaded: [String: Result<URL, Error>] = [:]
    private let authentication: (@Sendable (URLAuthenticationChallenge) -> URLCredential?)?
    private let queryRequest: (@Sendable (URL, MediaByteRange) -> URLRequest?)?
    private let diagnostics: (@Sendable (MediaDownloadDescriptor, [String: String]) -> Void)?

    private final class Cancellation: @unchecked Sendable {
        private let lock = NSLock()
        private var task: URLSessionTask?
        private var cancelled = false
        func attach(_ task: URLSessionTask) {
            lock.lock(); self.task = task; let cancel = cancelled; lock.unlock()
            if cancel { task.cancel() }
        }
        func cancel() {
            lock.lock(); cancelled = true; let task = task; lock.unlock()
            task?.cancel()
        }
    }

    private struct Handler {
        let continuation: CheckedContinuation<URL, Error>
        let progress: @Sendable (Int64, Int64?) -> Void
        let traffic: @Sendable (Int64) -> Void
        var lastReceived: Int64
        var lastProgressTime: TimeInterval = 0
        var pendingTraffic: Int64 = 0
    }

    init(backgroundConfiguration: URLSessionConfiguration? = nil,
         authentication: (@Sendable (URLAuthenticationChallenge) -> URLCredential?)? = nil,
         queryRequest: (@Sendable (URL, MediaByteRange) -> URLRequest?)? = nil,
         diagnostics: (@Sendable (MediaDownloadDescriptor, [String: String]) -> Void)? = nil) {
        self.authentication = authentication
        self.queryRequest = queryRequest
        self.diagnostics = diagnostics
        super.init()
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
        let background = backgroundConfiguration ?? URLSessionConfiguration.background(withIdentifier: Self.backgroundIdentifier)
        background.sessionSendsLaunchEvents = true
        background.isDiscretionary = false
        background.waitsForConnectivity = true
        background.allowsCellularAccess = true
        background.allowsExpensiveNetworkAccess = true
        background.httpMaximumConnectionsPerHost = 6
        background.timeoutIntervalForResource = 86_400
        backgroundSession = URLSession(configuration: background, delegate: self, delegateQueue: queue)
        let foreground = URLSessionConfiguration.ephemeral
        foreground.waitsForConnectivity = true
        foreground.allowsCellularAccess = true
        foreground.allowsExpensiveNetworkAccess = true
        foreground.httpMaximumConnectionsPerHost = 6
        foreground.timeoutIntervalForResource = 86_400
        foregroundSession = URLSession(configuration: foreground, delegate: self, delegateQueue: queue)
    }

    func handleBackgroundEvents(completion: @escaping () -> Void) {
        lock.lock()
        backgroundCompletion = completion
        lock.unlock()
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // The app singleton uses nil and keeps the system's normal TLS validation.
        // The native integration harness injects a certificate pin for its loopback fixture.
        if let credential = authentication?(challenge) { completionHandler(.useCredential, credential) }
        else { completionHandler(.performDefaultHandling, nil) }
    }

    private func tasks(in session: URLSession) async -> [URLSessionTask] {
        await withCheckedContinuation { continuation in
            session.getAllTasks { continuation.resume(returning: $0) }
        }
    }

    func downloadTrack(_ url: URL, descriptor: MediaDownloadDescriptor, background: Bool,
                       progress: @escaping @Sendable (Int64, Int64?) -> Void,
                       traffic: @escaping @Sendable (Int64) -> Void,
                       mode: @escaping @Sendable (MediaTransferMode) -> Void = { _ in }) async throws -> URL {
        guard url.scheme == "https" else { throw MediaError.badDownload }
        try Task.checkCancellation()
        let destination = try MediaPipeline.store.file(for: descriptor)
        if FileManager.default.fileExists(atPath: destination.path), Self.fileSize(destination) > 0 {
            let size = Self.fileSize(destination); progress(size, size); return destination
        }
        let planFile = MediaPipeline.store.directory(for: descriptor.jobID)
            .appendingPathComponent(descriptor.track.rawValue + ".transfer.json")
        var plan = (try? Data(contentsOf: planFile)).flatMap { try? JSONDecoder().decode(MediaTransferPlan.self, from: $0) }
        if plan?.url != url || plan?.valid != true { plan = nil }
        let chunksAllowed = await AppActivity.shared.chunkSchedulingAllowed
        if plan == nil {
            // Preserve a transfer already owned by iOS after installation/relaunch.
            let existing = await tasks(in: backgroundSession)
            if existing.contains(where: { $0.taskDescription == descriptor.taskDescription && $0.state != .completed }) {
                mode(.background)
                return try await download(url, descriptor: descriptor, background: true, progress: progress, traffic: traffic)
            }
            guard chunksAllowed, let verified = try await probeTransfer(url, traffic: traffic) else {
                mode(background ? .background : .standard)
                return try await download(url, descriptor: descriptor, background: background, progress: progress, traffic: traffic)
            }
            plan = MediaTransferPlan(url: url, length: verified.length, transport: verified.transport)
            try save(plan!, to: planFile)
        }
        guard var transfer = plan else { throw MediaError.badDownload }
        if transfer.remainderStart != nil {
            mode(background ? .background : .standard)
            return try await downloadRemainder(url, descriptor: descriptor, plan: transfer, destination: destination,
                background: background, progress: progress, traffic: traffic)
        }
        let ranges = transfer.ranges
        let counts = RangeProgress(total: transfer.length, progress: progress)
        do {
            if !chunksAllowed { throw BackgroundHandoff() }
            mode(.parallel)
            try await parallel(url, descriptor: descriptor, ranges: ranges, length: transfer.length,
                               background: background, transport: transfer.rangeTransport, counts: counts, traffic: traffic)
        } catch is BackgroundHandoff {
            // Only the contiguous completed prefix is reused. One remaining background
            // request can finish without the app repeatedly waking to schedule chunks.
            var sizes: [Int64: Int64] = [:]
            for range in ranges {
                let file = try MediaPipeline.store.file(for: .init(jobID: descriptor.jobID, track: descriptor.track,
                                                                   range: range, totalLength: transfer.length))
                sizes[range.start] = Self.fileSize(file)
            }
            let prefix = transfer.completedPrefix(sizes: sizes)
            if prefix < transfer.length {
                transfer.remainderStart = prefix
                try save(transfer, to: planFile)
                mode(.background)
                return try await downloadRemainder(url, descriptor: descriptor, plan: transfer, destination: destination,
                    background: background, progress: progress, traffic: traffic)
            }
        }
        let parts = ranges.map { MediaDownloadDescriptor(jobID: descriptor.jobID, track: descriptor.track,
                                                         range: $0, totalLength: transfer.length) }
        try assemble(parts, length: transfer.length, destination: destination)
        progress(transfer.length, transfer.length)
        return destination
    }

    private struct BackgroundHandoff: Error {}
    private enum ChunkEvent: Sendable { case completed, handoff }

    private func parallel(_ url: URL, descriptor: MediaDownloadDescriptor, ranges: [MediaByteRange], length: Int64,
                          background: Bool, transport: MediaRangeTransport, counts: RangeProgress,
                          traffic: @escaping @Sendable (Int64) -> Void) async throws {
        try await withThrowingTaskGroup(of: ChunkEvent.self) { group in
            var next = 0, completed = 0
            func enqueue(_ index: Int) {
                let range = ranges[index]
                group.addTask {
                    _ = try await self.download(url, descriptor: .init(jobID: descriptor.jobID, track: descriptor.track,
                        range: range, totalLength: length), background: false, transport: transport,
                        progress: { received, _ in counts.update(range.start, received: received) }, traffic: traffic)
                    return .completed
                }
            }
            if background {
                group.addTask {
                    while true {
                        try Task.checkCancellation()
                        if !(await AppActivity.shared.chunkSchedulingAllowed) { return .handoff }
                        try await Task.sleep(nanoseconds: 200_000_000)
                    }
                }
            }
            let workers = descriptor.track == .audio ? 2 : 4
            while next < min(workers, ranges.count) { enqueue(next); next += 1 }
            while let event = try await group.next() {
                switch event {
                case .handoff: group.cancelAll(); throw BackgroundHandoff()
                case .completed:
                    completed += 1
                    if completed == ranges.count { group.cancelAll(); return }
                    if next < ranges.count { enqueue(next); next += 1 }
                }
            }
        }
    }

    private func downloadRemainder(_ url: URL, descriptor: MediaDownloadDescriptor, plan: MediaTransferPlan,
                                   destination: URL, background: Bool,
                                   progress: @escaping @Sendable (Int64, Int64?) -> Void,
                                   traffic: @escaping @Sendable (Int64) -> Void) async throws -> URL {
        guard let start = plan.remainderStart else { throw MediaError.badDownload }
        let remainder = MediaDownloadDescriptor(jobID: descriptor.jobID, track: descriptor.track,
            range: .init(start: start, end: plan.length - 1), totalLength: plan.length)
        _ = try await download(url, descriptor: remainder, background: background, transport: plan.rangeTransport,
            progress: { received, _ in progress(start + received, plan.length) }, traffic: traffic)
        let prefix = plan.ranges.filter { $0.end < start }.map {
            MediaDownloadDescriptor(jobID: descriptor.jobID, track: descriptor.track, range: $0, totalLength: plan.length)
        }
        try assemble(prefix + [remainder], length: plan.length, destination: destination)
        progress(plan.length, plan.length)
        return destination
    }

    private func assemble(_ parts: [MediaDownloadDescriptor], length: Int64, destination: URL) throws {
        try Task.checkCancellation()
        let partial = destination.appendingPathExtension("assembling")
        if FileManager.default.fileExists(atPath: partial.path) { try FileManager.default.removeItem(at: partial) }
        guard FileManager.default.createFile(atPath: partial.path, contents: nil) else { throw MediaError.badDownload }
        try MediaPipeline.protect(partial)
        let writer = try FileHandle(forWritingTo: partial)
        do {
            for descriptor in parts {
                try Task.checkCancellation()
                let part = try MediaPipeline.store.file(for: descriptor)
                guard Self.fileSize(part) == descriptor.range?.count else { throw MediaError.badDownload }
                let reader = try FileHandle(forReadingFrom: part)
                do {
                    while let bytes = try reader.read(upToCount: 256 * 1_024), !bytes.isEmpty {
                        try Task.checkCancellation()
                        try writer.write(contentsOf: bytes)
                    }
                    try reader.close()
                } catch { try? reader.close(); throw error }
            }
            try writer.close()
            guard Self.fileSize(partial) == length else { throw MediaError.downloadFailed("The received file is incomplete. Retry to finish it.") }
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: partial, to: destination)
        } catch { try? writer.close(); try? FileManager.default.removeItem(at: partial); throw error }
        for descriptor in parts {
            if let part = try? MediaPipeline.store.file(for: descriptor) { try? FileManager.default.removeItem(at: part) }
        }
    }

    private func save(_ plan: MediaTransferPlan, to file: URL) throws {
        try JSONEncoder().encode(plan).write(to: file, options: .atomic)
        try MediaPipeline.protect(file)
    }

    private func request(_ url: URL, range: MediaByteRange?, transport: MediaRangeTransport) -> URLRequest? {
        if transport == .googleQuery, let range, let queryRequest { return queryRequest(url, range) }
        return MediaRangeRequest.request(url: url, range: range, transport: transport)
    }

    private func probeTransfer(_ url: URL, traffic: @escaping @Sendable (Int64) -> Void) async throws
        -> (length: Int64, transport: MediaRangeTransport)? {
        // First obtain the total and a byte oracle from a validated HTTP Range.
        // Query slices can return 200 without Content-Range; in that case compare
        // another slice at a nonzero offset before trusting their byte positions.
        let first = MediaByteRange(start: 0, end: 0)
        guard let header = try await probeRange(url, range: first, transport: .header,
                                               expectedTotal: nil, traffic: traffic),
              let length = header.total else { return nil }
        guard let query = try await probeRange(url, range: first, transport: .googleQuery,
                                              expectedTotal: length, traffic: traffic),
              query.bytes == header.bytes else { return (length, .header) }
        if query.total == nil {
            guard length > 1 else { return (length, .header) }
            let start = max(1, length / 2)
            let sample = MediaByteRange(start: start, end: min(length - 1, start + 16_384 - 1))
            guard let oracle = try await probeRange(url, range: sample, transport: .header,
                                                   expectedTotal: length, traffic: traffic),
                  let candidate = try await probeRange(url, range: sample, transport: .googleQuery,
                                                      expectedTotal: length, traffic: traffic),
                  oracle.bytes == candidate.bytes else { return (length, .header) }
        }
        return (length, .googleQuery)
    }

    private struct RangeProbe { let bytes: Data; let total: Int64? }

    private func probeRange(_ url: URL, range: MediaByteRange, transport: MediaRangeTransport,
                            expectedTotal: Int64?, traffic: @escaping @Sendable (Int64) -> Void) async throws -> RangeProbe? {
        // Check real range behavior instead of relying on HEAD or Accept-Ranges.
        guard var request = request(url, range: range, transport: transport) else { return nil }
        request.timeoutInterval = 8
        var received = Data()
        defer { if !received.isEmpty { traffic(Int64(received.count)) } }
        do {
            // Async data(for:delegate:) accepts a task delegate, so it does not
            // deliver the data delegate's response callback. AsyncBytes exposes
            // headers directly and lets us stop an ignored range immediately.
            let delegate = authentication.map { ProbeAuthentication(authentication: $0) }
            let (bytes, response) = try await foregroundSession.bytes(for: request, delegate: delegate)
            defer { bytes.task.cancel() }
            try Task.checkCancellation()
            guard let response = response as? HTTPURLResponse, response.url?.scheme == "https",
                  [200, 206].contains(response.statusCode),
                  response.expectedContentLength <= 0 || response.expectedContentLength == range.count else {
                // Stop at headers if the server ignored Range; never buffer the full video.
                if authentication != nil { print("Native range probe: response rejected") }
                return nil
            }
            let contentRange = response.value(forHTTPHeaderField: "Content-Range")
            let total: Int64?
            if contentRange != nil {
                guard let parsed = MediaByteRange.parse(contentRange: contentRange), parsed.range == range,
                      expectedTotal == nil || parsed.total == expectedTotal else { return nil }
                total = parsed.total
            } else {
                guard transport == .googleQuery, response.statusCode == 200,
                      response.expectedContentLength == range.count, expectedTotal != nil else { return nil }
                total = nil
            }
            for try await byte in bytes {
                received.append(byte)
                guard received.count <= range.count else { return nil }
            }
            try Task.checkCancellation()
            guard received.count == range.count else { return nil }
            return RangeProbe(bytes: received, total: total)
        } catch {
            if authentication != nil { print("Native range probe: " + error.localizedDescription) }
            try Task.checkCancellation()
            return nil
        }
    }

    private final class ProbeAuthentication: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let authentication: @Sendable (URLAuthenticationChallenge) -> URLCredential?
        init(authentication: @escaping @Sendable (URLAuthenticationChallenge) -> URLCredential?) {
            self.authentication = authentication
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            // AsyncBytes uses a per-task delegate for authentication. Preserve an
            // injected test transport there too; normal app TLS stays system-managed.
            if let credential = authentication(challenge) { completionHandler(.useCredential, credential) }
            else { completionHandler(.performDefaultHandling, nil) }
        }
    }

    private final class RangeProgress: @unchecked Sendable {
        private let lock = NSLock()
        private var counts: [Int64: Int64] = [:]
        private let total: Int64
        private let progress: @Sendable (Int64, Int64?) -> Void
        init(total: Int64, progress: @escaping @Sendable (Int64, Int64?) -> Void) {
            self.total = total; self.progress = progress
        }
        func update(_ start: Int64, received: Int64) {
            lock.lock(); counts[start] = max(counts[start] ?? 0, received)
            let count = counts.values.reduce(0, +); lock.unlock()
            progress(count, total)
        }
    }

    func download(_ url: URL, descriptor: MediaDownloadDescriptor, background: Bool,
                  transport: MediaRangeTransport = .header,
                  progress: @escaping @Sendable (Int64, Int64?) -> Void,
                  traffic: @escaping @Sendable (Int64) -> Void) async throws -> URL {
        guard url.scheme == "https" else { throw MediaError.badDownload }
        let destination = try MediaPipeline.store.file(for: descriptor)
        if FileManager.default.fileExists(atPath: destination.path) {
            let size = Self.fileSize(destination)
            if descriptor.range == nil || descriptor.range?.count == size {
                progress(size, size)
                return destination
            }
            try FileManager.default.removeItem(at: destination)
        }
        let cancellation = Cancellation()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            async let backgroundTasks = tasks(in: backgroundSession)
            async let foregroundTasks = tasks(in: foregroundSession)
            let all = await (backgroundTasks + foregroundTasks)
            let existing = all.first { $0.taskDescription == descriptor.taskDescription && $0.state != .completed }
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            // A task can finish between getAllTasks and registering its continuation.
            if let result = results.removeValue(forKey: descriptor.taskDescription) {
                lock.unlock()
                continuation.resume(with: result)
                return
            }
            if FileManager.default.fileExists(atPath: destination.path) {
                lock.unlock()
                let size = Self.fileSize(destination)
                progress(size, size)
                continuation.resume(returning: destination)
                return
            }
            let failureFile = MediaPipeline.store.failureFile(for: descriptor)
            if let text = try? String(contentsOf: failureFile, encoding: .utf8) {
                lock.unlock()
                continuation.resume(throwing: MediaError.downloadFailed(text))
                return
            }
            guard let request = request(url, range: descriptor.range, transport: transport) else {
                lock.unlock()
                continuation.resume(throwing: MediaError.badDownload)
                return
            }
            let task = existing ?? (background ? backgroundSession : foregroundSession).downloadTask(with: request)
            task.priority = URLSessionTask.highPriority
            task.taskDescription = descriptor.taskDescription
            handlers[descriptor.taskDescription] = Handler(continuation: continuation,
                progress: progress, traffic: traffic, lastReceived: task.countOfBytesReceived)
            lock.unlock()
            cancellation.attach(task)
            var report = Self.requestReport(task.originalRequest ?? request)
            report["event"] = "start"
            if let range = descriptor.range { report["rangeBytes"] = String(range.count) }
            diagnostics?(descriptor, report)
            progress(max(0, task.countOfBytesReceived),
                     task.countOfBytesExpectedToReceive > 0 ? task.countOfBytesExpectedToReceive : nil)
            task.resume()
            }
        }, onCancel: { cancellation.cancel() })
    }

    func cancel(jobID: UUID) async {
        async let background = tasks(in: backgroundSession)
        async let foreground = tasks(in: foregroundSession)
        for task in await (background + foreground) {
            if MediaDownloadDescriptor(taskDescription: task.taskDescription)?.jobID == jobID { task.cancel() }
        }
    }

    func forget(jobID: UUID) {
        lock.lock()
        results = results.filter { MediaDownloadDescriptor(taskDescription: $0.key)?.jobID != jobID }
        downloaded = downloaded.filter { MediaDownloadDescriptor(taskDescription: $0.key)?.jobID != jobID }
        lock.unlock()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard let key = downloadTask.taskDescription else { return }
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        guard var handler = handlers[key] else { lock.unlock(); return }
        let received = max(0, totalBytesWritten - handler.lastReceived)
        handler.pendingTraffic += received
        handler.lastReceived = max(handler.lastReceived, totalBytesWritten)
        let publish = now - handler.lastProgressTime >= 0.2 || totalBytesWritten == totalBytesExpectedToWrite
        let trafficBytes = publish ? handler.pendingTraffic : 0
        if publish { handler.lastProgressTime = now; handler.pendingTraffic = 0 }
        handlers[key] = handler
        lock.unlock()
        if trafficBytes > 0 { handler.traffic(trafficBytes) }
        if publish {
            handler.progress(totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let descriptor = MediaDownloadDescriptor(taskDescription: downloadTask.taskDescription) else { return }
        let result: Result<URL, Error>
        do {
            guard let response = downloadTask.response as? HTTPURLResponse,
                  response.url?.scheme == "https" else {
                throw MediaError.badDownload
            }
            let size = Self.fileSize(location)
            if let range = descriptor.range {
                let entireEntity = response.statusCode == 200 && response.value(forHTTPHeaderField: "Content-Range") == nil
                    && range.start == 0 && range.end + 1 == descriptor.totalLength && size == descriptor.totalLength
                // The saved plan's query transport was cross-checked against an
                // HTTP range oracle. Google's 200 query slices omit Content-Range.
                let validatedQuery = queryTransportWasVerified(downloadTask, descriptor: descriptor)
                    && response.statusCode == 200 && response.value(forHTTPHeaderField: "Content-Range") == nil
                    && size == range.count && response.expectedContentLength == size
                guard [200, 206].contains(response.statusCode),
                      range.matches(contentRange: response.value(forHTTPHeaderField: "Content-Range"),
                                    fileSize: size, total: descriptor.totalLength ?? 0) || entireEntity || validatedQuery else {
                    throw MediaError.downloadFailed("The server returned an incomplete video chunk. Retry the download.")
                }
            } else {
                guard response.statusCode == 200, size > 0,
                      response.expectedContentLength <= 0 || response.expectedContentLength == size else {
                    throw MediaError.badDownload
                }
            }
            let mime = response.mimeType?.lowercased() ?? ""
            guard !mime.contains("text/") && !mime.contains("json") else {
                throw MediaError.downloadFailed("The video server returned a page instead of media. Try again.")
            }
            let destination = try MediaPipeline.store.file(for: descriptor)
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: location, to: destination)
            try MediaPipeline.protect(destination)
            result = .success(destination)
        } catch { result = .failure(error) }
        lock.lock()
        downloaded[descriptor.taskDescription] = result
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let descriptor = MediaDownloadDescriptor(taskDescription: task.taskDescription) else { return }
        let key = descriptor.taskDescription
        lock.lock()
        let transferResult = downloaded.removeValue(forKey: key)
        let result = error.map { Result<URL, Error>.failure($0) } ?? transferResult ?? .failure(MediaError.badDownload)
        results[key] = result
        let handler = handlers.removeValue(forKey: key)
        if handler != nil { results.removeValue(forKey: key) }
        lock.unlock()
        if let handler, handler.pendingTraffic > 0 { handler.traffic(handler.pendingTraffic) }
        switch result {
        case .success(let file):
            let size = Self.fileSize(file)
            handler?.progress(size, size)
        case .failure(let error):
            // Cancellation during a handoff is not a failed chunk on the next attempt.
            guard (error as? URLError)?.code != .cancelled else {
                handler?.continuation.resume(with: result); return
            }
            try? error.localizedDescription.write(to: MediaPipeline.store.failureFile(for: descriptor),
                                                  atomically: true, encoding: .utf8)
        }
        handler?.continuation.resume(with: result)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let completion = backgroundCompletion
        backgroundCompletion = nil
        lock.unlock()
        if let completion { DispatchQueue.main.async(execute: completion) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        guard let descriptor = MediaDownloadDescriptor(taskDescription: task.taskDescription) else { return }
        var report = Self.requestReport(task.originalRequest)
        report["event"] = "finishedMetrics"
        report["durationSeconds"] = String(format: "%.3f", metrics.taskInterval.duration)
        report["receivedBytes"] = String(max(task.countOfBytesReceived,
            metrics.transactionMetrics.reduce(Int64(0)) { $0 + $1.countOfResponseBodyBytesReceived }))
        if let transaction = metrics.transactionMetrics.last {
            report["host"] = transaction.response?.url?.host ?? report["host"]
            report["protocol"] = transaction.networkProtocolName ?? "unknown"
            report["cellular"] = String(transaction.isCellular)
            if let response = transaction.response as? HTTPURLResponse { report["status"] = String(response.statusCode) }
            if let start = transaction.requestStartDate, let response = transaction.responseStartDate {
                report["ttfbSeconds"] = String(format: "%.3f", max(0, response.timeIntervalSince(start)))
            }
        }
        diagnostics?(descriptor, report)
    }

    private static func requestReport(_ request: URLRequest?) -> [String: String] {
        // Keep signed media URLs, cookies, and query values out of exported reports.
        let hasQueryRange = request?.value(forHTTPHeaderField: "Range") == nil
            && (request?.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
                .queryItems?.contains { $0.name == "range" } ?? false)
        return ["host": request?.url?.host ?? "unknown", "method": request?.httpMethod ?? "GET",
                "transport": hasQueryRange ? "googleQuery" : "header"]
    }

    private func queryTransportWasVerified(_ task: URLSessionTask, descriptor: MediaDownloadDescriptor) -> Bool {
        guard Self.requestReport(task.originalRequest)["transport"] == "googleQuery", let range = descriptor.range,
              let url = task.originalRequest?.url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let queryRanges = (components.queryItems ?? []).filter { $0.name.lowercased() == "range" }
        guard queryRanges.count == 1, queryRanges[0].value == "\(range.start)-\(range.end)" else { return false }
        let file = MediaPipeline.store.directory(for: descriptor.jobID)
            .appendingPathComponent(descriptor.track.rawValue + ".transfer.json")
        guard let data = try? Data(contentsOf: file),
              let plan = try? JSONDecoder().decode(MediaTransferPlan.self, from: data) else { return false }
        guard plan.valid, plan.rangeTransport == .googleQuery, plan.length == descriptor.totalLength,
              let expected = request(plan.url, range: range, transport: .googleQuery) else { return false }
        return task.originalRequest?.url == expected.url && task.originalRequest?.value(forHTTPHeaderField: "Range") == nil
    }

    private static func fileSize(_ url: URL) -> Int64 {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
    }
}
