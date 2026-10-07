import Foundation

public struct HTTPRequest {
    public let method: String
    public let target: String
    public let headers: [String: String]
    public let body: Data
    public var path: String { String(target.split(separator: "?", maxSplits: 1).first ?? "") }
    public var query: [URLQueryItem] {
        URLComponents(string: "http://localhost" + target)?.queryItems ?? []
    }

    public enum ParseError: Error { case malformed, tooLarge, unsupportedTransferEncoding }

    // Return nil for incomplete input. Never guess at message framing.
    public static func parse(_ data: Data) throws -> HTTPRequest? {
        let limit = 16_384
        let delimiter = Data("\r\n\r\n".utf8)
        guard let boundary = data.range(of: delimiter) else {
            if data.count > limit { throw ParseError.tooLarge }
            return nil
        }
        guard boundary.lowerBound <= limit,
              let text = String(data: data[..<boundary.lowerBound], encoding: .utf8) else {
            throw ParseError.tooLarge
        }
        let lines = text.components(separatedBy: "\r\n")
        let start = (lines.first ?? "").split(separator: " ")
        guard start.count == 3, start[2] == "HTTP/1.1", start[1].hasPrefix("/"),
              !start[1].hasPrefix("//") else { throw ParseError.malformed }
        var headers = [String: String]()
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw ParseError.malformed }
            let name = String(line[..<colon]).lowercased()
            guard !name.isEmpty, headers[name] == nil,
                  name.range(of: "^[a-z0-9!#$%&'*+.^_`|~-]+$", options: .regularExpression) != nil else {
                throw ParseError.malformed
            }
            headers[name] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        if headers["transfer-encoding"] != nil { throw ParseError.unsupportedTransferEncoding }
        let lengthString = headers["content-length"] ?? "0"
        guard lengthString.range(of: "^[0-9]+$", options: .regularExpression) != nil,
              let length = Int(lengthString), length <= limit else { throw ParseError.tooLarge }
        let end = boundary.upperBound + length
        guard data.count >= end else { return nil }
        // This host intentionally supports one request per connection.
        guard data.count == end else { throw ParseError.malformed }
        return HTTPRequest(method: String(start[0]), target: String(start[1]),
                           headers: headers, body: Data(data[boundary.upperBound..<end]))
    }
}
