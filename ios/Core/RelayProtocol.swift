import Foundation

public enum RelayProtocol {
    public static let name = "mk8-relay-v1"
    // Keep a complete media frame below URLSession's 128 KiB WebSocket message
    // limit. Larger frames reduce the per-credit round-trip cost on cellular
    // while the browser-driven pull protocol still provides backpressure.
    public static let maximumChunk = 131_056 // 131,072 bytes minus the UUID prefix
    // Preserve complete MPEG-TS packets while using almost all of the frame
    // allowance. The last partial frame is still permitted for exact bytes.
    public static let fileChunk = maximumChunk / 188 * 188
    public static let maximumRequests = 8

    public enum InvalidMessage: Error { case request, frame }

    // The relay only invokes the same constrained router as the local server.
    // Never accept a remote origin, arbitrary URL, or CRLF-bearing header.
    public static func request(method: String, target: String, headers: [String: String],
                               base64Body: String, publicURL: URL) throws -> HTTPRequest {
        guard ["GET", "POST"].contains(method), target.hasPrefix("/"), !target.hasPrefix("//"),
              !target.contains("#"), target.utf8.count <= 4096,
              !target.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              let body = Data(base64Encoded: base64Body), body.count <= 16_384,
              headers.count <= 64, let host = publicURL.host else { throw InvalidMessage.request }
        let authority = host + (publicURL.port.map { ":\($0)" } ?? "")
        var normalized: [String: String] = [:]
        for (name, value) in headers {
            let lower = name.lowercased()
            guard lower.range(of: "^[a-z0-9!#$%&'*+.^_`|~-]+$", options: .regularExpression) != nil,
                  normalized[lower] == nil,
                  !value.unicodeScalars.contains(where: { $0.value < 32 && $0.value != 9 || $0.value == 127 }) else {
                throw InvalidMessage.request
            }
            normalized[lower] = value
        }
        guard normalized["host"] == authority, normalized["transfer-encoding"] == nil else { throw InvalidMessage.request }
        if let origin = normalized["origin"] {
            guard origin == publicURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) else {
                throw InvalidMessage.request
            }
        }
        normalized["content-length"] = String(body.count)
        let text = "\(method) \(target) HTTP/1.1\r\n" + normalized.sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value)\r\n" }.joined() + "\r\n"
        guard let parsed = try HTTPRequest.parse(Data(text.utf8) + body) else { throw InvalidMessage.request }
        return parsed
    }

    // Binary frames have a fixed UUID prefix; payload bytes are never base64 encoded.
    public static func frame(id: UUID, payload: Data) throws -> Data {
        guard !payload.isEmpty, payload.count <= maximumChunk else { throw InvalidMessage.frame }
        var bytes = id.uuid
        return withUnsafeBytes(of: &bytes) { Data($0) } + payload
    }
}
