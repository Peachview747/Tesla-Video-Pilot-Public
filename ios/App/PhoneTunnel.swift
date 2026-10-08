import Foundation
import MK8Core

// Runs inside the app. No desktop executable, subprocess, or VPN entitlement.
// A single TLS WebSocket multiplexes bounded, browser-driven response streams.
@MainActor final class PhoneTunnel {
    typealias Router = HTTPServer.Router
    private let publicURL: URL
    private let route: Router
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var runner: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var generation = UUID()
    private var peers: [UUID: RelayPeer] = [:]
    private var lastPong = ProcessInfo.processInfo.systemUptime
    private var sawHello = false
    var stateChanged: ((TunnelConnectionState, String) -> Void)?
    var received: ((Int64) -> Void)?
    var sent: ((Int64) -> Void)?
    var streamsChanged: ((Int) -> Void)?

    init(publicURL: URL, route: @escaping Router) {
        self.publicURL = publicURL
        self.route = route
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
    }

    func start(secret: String) {
        stop()
        guard !secret.isEmpty else { stateChanged?(.notConfigured, "Save your tunnel key in Settings."); return }
        let current = UUID()
        generation = current
        runner = Task { [weak self] in
            var attempts = 0
            while !Task.isCancelled {
                guard let self, self.generation == current else { return }
                self.stateChanged?(attempts == 0 ? .connecting : .reconnecting,
                    attempts == 0 ? "Connecting your iPhone to Cloudflare…" : "Reconnecting your iPhone…")
                do {
                    try await self.checkWorker(secret: secret)
                    try Task.checkCancellation()
                    guard self.generation == current else { return }
                    var request = URLRequest(url: self.publicURL.appendingPathComponent("__iphone/connect"))
                    var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                    components.scheme = "wss"
                    request.url = components.url
                    request.setValue(secret, forHTTPHeaderField: "x-secret")
                    let socket = self.session.webSocketTask(with: request)
                    socket.maximumMessageSize = RelayProtocol.maximumChunk + 16
                    self.socket = socket
                    self.sawHello = false
                    self.lastPong = ProcessInfo.processInfo.systemUptime
                    socket.resume()
                    self.startHeartbeat(socket: socket, generation: current)
                    while !Task.isCancelled, self.socket === socket, self.generation == current {
                        let message = try await socket.receive()
                        try Task.checkCancellation()
                        guard self.socket === socket, self.generation == current else { return }
                        switch message {
                        case .string(let text):
                            self.received?(Int64(text.utf8.count))
                            try self.handle(text, socket: socket)
                        case .data: throw RelayError.protocolMismatch
                        @unknown default: throw RelayError.protocolMismatch
                        }
                        if self.sawHello { attempts = 0 }
                    }
                } catch {
                    guard !Task.isCancelled, self.generation == current else { return }
                    self.closeSocket()
                    if let failure = error as? RelayError, failure.requiresSetup {
                        self.stateChanged?(.failed, failure.localizedDescription)
                        self.runner = nil
                        return
                    }
                    attempts += 1
                    self.stateChanged?(.reconnecting, "Connection interrupted. Retrying automatically…")
                    let delay = min(30, 1 << min(attempts, 5))
                    try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000)
                }
            }
        }
    }

    func stop() {
        generation = UUID()
        runner?.cancel()
        runner = nil
        closeSocket()
        stateChanged?(.disconnected, "Tunnel stopped.")
    }

    private func closeSocket() {
        heartbeat?.cancel()
        heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        for peer in peers.values { peer.close() }
        peers.removeAll()
        streamsChanged?(0)
    }

    private func checkWorker(secret: String) async throws {
        var request = URLRequest(url: publicURL.appendingPathComponent("__iphone/status"))
        request.setValue(secret, forHTTPHeaderField: "x-secret")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RelayError.workerSetup }
        if http.statusCode == 401 { throw RelayError.keyRejected }
        guard http.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["protocol"] as? String == RelayProtocol.name else { throw RelayError.workerSetup }
        guard object["configured"] as? Bool == true else { throw RelayError.keyRejected }
    }

    private func startHeartbeat(socket: URLSessionWebSocketTask, generation: UUID) {
        heartbeat?.cancel()
        heartbeat = Task { [weak self, weak socket] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled, let self, let socket, self.socket === socket, self.generation == generation else { return }
                let age = ProcessInfo.processInfo.systemUptime - self.lastPong
                if (!self.sawHello && age > 15) || age > 40 {
                    socket.cancel(with: .goingAway, reason: nil)
                    return
                }
                do { try await self.send(["type": "ping", "id": UUID().uuidString.lowercased()], socket: socket) }
                catch { socket.cancel(with: .goingAway, reason: nil); return }
            }
        }
    }

    private func handle(_ text: String, socket: URLSessionWebSocketTask) throws {
        guard text.utf8.count <= 32768, let data = text.data(using: .utf8),
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = value["type"] as? String else { throw RelayError.protocolMismatch }
        if type == "hello" {
            guard !sawHello, value["protocol"] as? String == RelayProtocol.name else { throw RelayError.protocolMismatch }
            sawHello = true
            lastPong = ProcessInfo.processInfo.systemUptime
            stateChanged?(.connected, "Connected. Open the public address in the Tesla browser.")
            return
        }
        guard sawHello else { throw RelayError.protocolMismatch }
        if type == "pong" { lastPong = ProcessInfo.processInfo.systemUptime; return }
        guard let rawID = value["id"] as? String, let id = UUID(uuidString: rawID) else { throw RelayError.protocolMismatch }
        if type == "cancel" { remove(id); return }
        if type == "pull" {
            guard let peer = peers[id] else { return }
            guard peer.ready else { throw RelayError.protocolMismatch }
            let startDrain: Bool
            do { startDrain = try peer.credits.grant() }
            catch {
                // A late/duplicate pull can race a seek cancellation. It is
                // local to this peer; tearing down the whole tunnel would
                // strand every other browser request.
                return
            }
            guard startDrain else { return }
            peer.transferTask = Task { [weak self, weak peer] in
                guard let self, let peer else { return }
                do {
                    while self.socket === socket, self.peers[id] === peer, !Task.isCancelled,
                          peer.credits.consume() {
                        let chunk = try peer.nextChunk()
                        if !chunk.isEmpty {
                            let frame = try RelayProtocol.frame(id: id, payload: chunk)
                            try await self.send(frame, socket: socket)
                        }
                        // Cancel/reconnect can run while a WebSocket send awaits
                        // completion. Never send another frame or remove its successor.
                        guard !Task.isCancelled, self.socket === socket, self.peers[id] === peer else { return }
                        if peer.finished {
                            try await self.send(["type": "end", "id": rawID], socket: socket)
                            guard !Task.isCancelled, self.socket === socket, self.peers[id] === peer else { return }
                            self.remove(id)
                            return
                        }
                        // A fast reader can replenish credit immediately; let
                        // heartbeat, UI and other response streams run as well.
                        await Task.yield()
                    }
                    if self.peers[id] === peer { peer.transferTask = nil }
                } catch { await self.fail(id, peer: peer, socket: socket) }
            }
            return
        }
        guard type == "request" else { throw RelayError.protocolMismatch }
        if peers[id] != nil {
            sendEmptyResponse(status: 409, id: rawID, socket: socket)
            return
        }
        if peers.count >= RelayProtocol.maximumRequests {
            // A browser seek can briefly overlap the request it replaces. A
            // bounded HTTP error is recoverable; a protocol disconnect is not.
            sendEmptyResponse(status: 429, id: rawID, socket: socket)
            return
        }
        guard let method = value["method"] as? String, let target = value["target"] as? String,
              let headers = value["headers"] as? [String: String], let body = value["body"] as? String else {
            throw RelayError.protocolMismatch
        }
        let request: HTTPRequest
        do {
            request = try RelayProtocol.request(method: method, target: target, headers: headers,
                base64Body: body, publicURL: publicURL)
        } catch {
            Task { [weak self] in
                try? await self?.send(["type": "response", "id": rawID, "status": 400,
                    "headers": ["Content-Type": "application/json"], "length": 0], socket: socket)
            }
            return
        }
        let peer = RelayPeer()
        peers[id] = peer
        peer.preparationTask = Task { [weak self, weak peer] in
            guard let self, let peer else { return }
            let response = await self.route(request)
            guard !Task.isCancelled, self.socket === socket, self.peers[id] === peer else { return }
            do {
                try peer.prepare(response)
                self.updateStreams()
                var headers = response.headers
                headers["Content-Type"] = response.contentType
                headers["Cache-Control"] = "no-store"
                headers["X-Content-Type-Options"] = "nosniff"
                headers["Referrer-Policy"] = "no-referrer"
                try await self.send(["type": "response", "id": rawID, "status": response.status,
                                     "headers": headers, "length": peer.length], socket: socket)
                // Bodies are sent only after a pull. Empty responses need no credit.
                guard !Task.isCancelled, self.socket === socket, self.peers[id] === peer else { return }
                if peer.length == 0 { self.remove(id) }
                else { peer.preparationTask = nil }
            } catch { await self.fail(id, peer: peer, socket: socket) }
        }
    }

    private func send(_ object: [String: Any], socket: URLSessionWebSocketTask) async throws {
        try Task.checkCancellation()
        guard self.socket === socket else { throw CancellationError() }
        let data = try JSONSerialization.data(withJSONObject: object)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
        try Task.checkCancellation()
        guard self.socket === socket else { throw CancellationError() }
        sent?(Int64(data.count))
    }
    private func sendEmptyResponse(status: Int, id: String, socket: URLSessionWebSocketTask) {
        Task { [weak self] in
            guard let self else { return }
            try? await self.send(["type": "response", "id": id, "status": status,
                                 "headers": ["Content-Type": "application/json"], "length": 0], socket: socket)
        }
    }
    private func send(_ data: Data, socket: URLSessionWebSocketTask) async throws {
        try Task.checkCancellation()
        guard self.socket === socket else { throw CancellationError() }
        try await socket.send(.data(data))
        try Task.checkCancellation()
        guard self.socket === socket else { throw CancellationError() }
        sent?(Int64(data.count))
    }
    private func fail(_ id: UUID, peer: RelayPeer, socket: URLSessionWebSocketTask) async {
        // Check request identity as well as connection identity on both sides of
        // the await: a late failure must not remove a new request with this ID.
        guard !Task.isCancelled, self.socket === socket, peers[id] === peer else { return }
        try? await send(["type": "error", "id": id.uuidString.lowercased()], socket: socket)
        guard !Task.isCancelled, self.socket === socket, peers[id] === peer else { return }
        remove(id)
    }
    private func remove(_ id: UUID) { peers.removeValue(forKey: id)?.close(); updateStreams() }
    private func updateStreams() { streamsChanged?(peers.values.filter(\.isFile).count) }
}

@MainActor private final class RelayPeer {
    var preparationTask: Task<Void, Never>?
    var transferTask: Task<Void, Never>?
    var ready = false
    var credits = RelayCredits()
    private var body: RelayBody?
    var length: Int { body?.length ?? 0 }
    var isFile: Bool { body?.isFile == true }
    var finished: Bool { body?.finished == true }
    func prepare(_ response: HTTPResponse) throws {
        if let url = response.file { body = try RelayBody(file: url, range: response.fileRange) }
        else { body = RelayBody(data: response.body) }
        ready = true
    }
    func nextChunk() throws -> Data {
        guard let body else { throw CancellationError() }
        return try body.nextChunk()
    }
    func close() {
        ready = false
        credits.close()
        preparationTask?.cancel()
        transferTask?.cancel()
        preparationTask = nil
        transferTask = nil
        body?.close()
        body = nil
    }
}

private enum RelayError: LocalizedError {
    case workerSetup, keyRejected, protocolMismatch
    var requiresSetup: Bool { self == .workerSetup || self == .keyRejected }
    var errorDescription: String? {
        switch self {
        case .workerSetup: return "Update Cloudflare using the iPhone tunnel setup on your PC, then tap Reconnect."
        case .keyRejected: return "Cloudflare rejected the tunnel key. Check TV_SECRET in your original MK8 .env file and save it in Settings."
        case .protocolMismatch: return "Cloudflare sent an incompatible relay message."
        }
    }
}
