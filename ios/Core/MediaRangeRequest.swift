import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum MediaRangeTransport: String, Codable, Sendable {
    case header, googleQuery
}

/// Googlevideo also accepts a bounded byte range in its query. Add only that
/// unsigned parameter; rebuilding the other query items can change signed URLs.
/// Query ranges define the requested resource, so do not also apply HTTP Range.
public enum MediaRangeRequest {
    public static func supportsGoogleQuery(_ url: URL) -> Bool {
        guard let components = httpsComponents(url), let host = components.host?.lowercased(),
              host == "googlevideo.com" || host.hasSuffix(".googlevideo.com") else { return false }
        for item in components.queryItems ?? [] {
            let name = item.name.lowercased()
            // Existing ranges may describe a different entity; do not replace them.
            if name == "range" { return false }
            if name == "sparams" || name == "lsparams" {
                let signed = (item.value ?? "").split(separator: ",").map {
                    $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                }
                if signed.contains("range") { return false }
            }
        }
        return true
    }

    public static func request(url: URL, range: MediaByteRange?,
                               transport: MediaRangeTransport = .header) -> URLRequest? {
        guard var components = httpsComponents(url) else { return nil }
        if let range {
            guard range.start >= 0, range.end >= range.start, range.end < 50_000_000_000 else { return nil }
        }
        var destination = url
        if transport == .googleQuery {
            guard let range, supportsGoogleQuery(url) else { return nil }
            let existing = components.percentEncodedQuery ?? ""
            components.percentEncodedQuery = existing + (existing.isEmpty ? "" : "&")
                + "range=\(range.start)-\(range.end)"
            guard let ranged = components.url else { return nil }
            destination = ranged
        }
        var request = URLRequest(url: destination)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if transport == .header, let range { request.setValue(range.header, forHTTPHeaderField: "Range") }
        return request
    }

    private static func httpsComponents(_ url: URL) -> URLComponents? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https", let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        return components
    }
}
