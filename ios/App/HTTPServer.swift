import Foundation
import Network
import CryptoKit
import MK8Core

struct HTTPResponse {
    var status: Int
    let contentType: String
    var body: Data = Data()
    var headers: [String: String] = [:]
    var file: URL? = nil
    var fileRange: Range<Int64>? = nil
    static func json(_ value: Any, status: Int = 200) -> HTTPResponse {
        HTTPResponse(status: status, contentType: "application/json",
                     body: (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8))
    }

    /// Bundled web assets (index, app.js, jsmpeg, css) are revalidated instead
    /// of re-sent: the browser keeps its copy and asks with If-None-Match, so a
    /// page load over the tunnel costs a few hundred bytes once cached. API and
    /// media responses are untouched and stay no-store.
    func revalidated(for request: HTTPRequest) -> HTTPResponse {
        guard request.method == "GET", status == 200, file == nil, !body.isEmpty,
              !request.path.hasPrefix("/api/") else { return self }
        let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let tag = "\"" + String(digest.prefix(32)) + "\""
        var copy = self
        copy.headers["ETag"] = tag
        copy.headers["Cache-Control"] = "private, no-cache"
        let candidates = (request.headers["if-none-match"] ?? "").split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        if candidates.contains(tag) || candidates.contains("W/" + tag) {
            copy.status = 304
            copy.body = Data()
        }
        return copy
    }
}

@MainActor final class HTTPServer {
    typealias Router = @MainActor (HTTPRequest) async -> HTTPResponse
    private let route: Router
    private var listener: NWListener?
    private var peers: [UUID: Peer] = [:]
    private let maxConnections = 8
    var ready: (() -> Void)?
    var failed: ((String) -> Void)?
    var received: ((Int64) -> Void)?
    var sent: ((Int64) -> Void)?
    var streamsChanged: ((Int) -> Void)?

    init(route: @escaping Router) { self.route = route }
    func start() throws {
        stop()
        let listener = try NWListener(using: .tcp, on: 5000)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            Task { @MainActor in
                guard let self, let listener, self.listener === listener else { return }
                switch state {
                case .ready: self.ready?()
                case .failed: self.failed?("The local server could not start on port 5000.")
                default: break
                }
            }
        }
        listener.newConnectionHandler = { [weak self, weak listener] connection in
            Task { @MainActor in
                guard let self, let listener, self.listener === listener else { connection.cancel(); return }
                self.accept(connection)
            }
        }
        listener.start(queue: .main)
    }
    func stop() {
        listener?.cancel()
        listener = nil
        for peer in Array(peers.values) { peer.finish() }
        peers.removeAll()
        streamsChanged?(0)
    }
    private func accept(_ connection: NWConnection) {
        guard peers.count < maxConnections else { connection.cancel(); return }
        SessionDiagnostics.shared.record(component: "http", event: "connectionAccepted",
            fields: ["active": String(peers.count + 1)])
        let peer = Peer(connection: connection, route: route)
        peer.received = { [weak self] in self?.received?($0) }
        peer.sent = { [weak self] in self?.sent?($0) }
        peer.streamingChanged = { [weak self] in self?.updateStreamCount() }
        peer.closed = { [weak self, weak peer] in
            if let peer { self?.peers.removeValue(forKey: peer.id); self?.updateStreamCount() }
        }
        peers[peer.id] = peer
        peer.start()
    }
    private func updateStreamCount() { streamsChanged?(peers.values.filter(\.isStreaming).count) }
}

@MainActor private final class Peer {
    let id = UUID()
    let connection: NWConnection
    let route: HTTPServer.Router
    var closed: (() -> Void)?
    var received: ((Int64) -> Void)?
    var sent: ((Int64) -> Void)?
    var streamingChanged: (() -> Void)?
    private(set) var isStreaming = false
    private var input = Data()
    private var body: RelayBody?
    private var requestTask: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var currentRoute = "unknown"
    private var requestStartedAt = ProcessInfo.processInfo.systemUptime
    private var sentBytes: Int64 = 0
    private var done = false

    init(connection: NWConnection, route: @escaping HTTPServer.Router) {
        self.connection = connection
        self.route = route
    }
    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                if case .failed = state { self?.finish() }
                if case .cancelled = state { self?.finish() }
            }
        }
        connection.start(queue: .main)
        armTimeout(seconds: 15, stage: "request")
        read()
    }
    private func armTimeout(seconds: UInt64, stage: String) {
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            guard !Task.isCancelled, let self, !self.done else { return }
            SessionDiagnostics.shared.record(component: "http", event: "timeout",
                fields: ["route": self.currentRoute, "stage": stage])
            self.finish()
        }
    }
    func finish() {
        guard !done else { return }
        done = true
        if let body, body.isFile, sentBytes > 0 {
            let seconds = max(0.001, ProcessInfo.processInfo.systemUptime - requestStartedAt)
            SessionDiagnostics.shared.record(component: "http", event: "streamSummary",
                fields: ["route": currentRoute, "bytes": String(sentBytes), "expectedBytes": String(body.length),
                         "complete": String(body.finished), "elapsedMs": String(format: "%.0f", seconds * 1000),
                         "mbps": String(format: "%.2f", Double(sentBytes) * 8 / seconds / 1_000_000)])
        }
        requestTask?.cancel()
        timeout?.cancel()
        body?.close()
        body = nil
        isStreaming = false
        connection.cancel()
        closed?()
    }
    private func read() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self, !self.done else { return }
                if let data { self.received?(Int64(data.count)); self.input.append(data) }
                do {
                    if let request = try HTTPRequest.parse(self.input) {
                        self.input.removeAll()
                        self.currentRoute = SessionDiagnostics.routeName(request.path)
                        self.requestStartedAt = ProcessInfo.processInfo.systemUptime
                        SessionDiagnostics.shared.record(component: "http", event: "request",
                            fields: ["method": request.method, "route": self.currentRoute])
                        self.requestTask = Task { [weak self] in
                            guard let self else { return }
                            let response = await self.route(request).revalidated(for: request)
                            if !self.done { self.respond(response) }
                        }
                    } else if complete || error != nil { self.finish() }
                    else { self.read() }
                } catch { self.respond(.json(["error": "Invalid or oversized HTTP request."], status: 400)) }
            }
        }
    }
    private func respond(_ response: HTTPResponse) {
        guard !done else { return }
        timeout?.cancel()
        do {
            if let path = response.file { body = try RelayBody(file: path, range: response.fileRange) }
            else { body = RelayBody(data: response.body) }
        } catch { finish(); return }
        guard let body else { finish(); return }
        let length = body.length
        isStreaming = body.isFile
        if isStreaming { streamingChanged?() }
        SessionDiagnostics.shared.record(component: "http", event: "response",
            fields: ["route": currentRoute, "status": String(response.status), "bytes": String(length),
                     "stream": String(isStreaming),
                     "elapsedMs": String(format: "%.1f", (ProcessInfo.processInfo.systemUptime - requestStartedAt) * 1000)])
        let reason = [200: "OK", 202: "Accepted", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized",
                      403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
                      429: "Too Many Requests", 503: "Service Unavailable"][response.status] ?? "Error"
        var headers = response.headers
        headers["Content-Type"] = response.contentType
        headers["Content-Length"] = String(length)
        headers["Connection"] = "close"
        headers["Cache-Control"] = response.headers["Cache-Control"] ?? "no-store"
        headers["X-Content-Type-Options"] = "nosniff"
        headers["Referrer-Policy"] = "no-referrer"
        let text = "HTTP/1.1 \(response.status) \(reason)\r\n" + headers.sorted(by: { $0.key < $1.key })
            .map { "\($0.key): \($0.value)\r\n" }.joined() + "\r\n"
        send(Data(text.utf8)) { [weak self] in
            self?.nextChunk()
        }
    }
    private func nextChunk() {
        guard !done, let body else { return }
        do {
            let chunk = try body.nextChunk()
            if chunk.isEmpty { finish(); return }
            send(chunk) { [weak self] in
                // NWConnection's completion supplies backpressure. Keep only one
                // bounded chunk in flight; do not impose an extra timer on video.
                guard let self else { return }
                if body.finished { self.finish() }
                else { self.nextChunk() }
            }
        } catch { finish() }
    }
    private func send(_ data: Data, then completion: @escaping @MainActor () -> Void) {
        guard !done else { return }
        // A disconnected or frozen browser may leave contentProcessed pending
        // indefinitely. Reap only a stalled write, never a continuously active
        // response, so abandoned seeks cannot occupy all eight local slots.
        armTimeout(seconds: 45, stage: "write")
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            Task { @MainActor in
                guard let self, !self.done else { return }
                self.timeout?.cancel()
                if error != nil { self.finish() } else {
                    self.sentBytes += Int64(data.count)
                    self.sent?(Int64(data.count))
                    completion()
                }
            }
        })
    }
}
