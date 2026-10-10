import Foundation

/// Keyless YouTube search through the same InnerTube endpoint youtube.com
/// uses. Unlike the Data API it needs no key or quota and returns duration,
/// views and age, plus a continuation token for "Load more".
enum YouTubeInnerTube {
    struct Hit: Encodable {
        let id: String
        let title: String
        let channel: String
        let thumbnail: String
        let duration: String?
        let views: String?
        let published: String?
    }
    struct Page: Encodable {
        let results: [Hit]
        let continuation: String?
    }
    enum Failure: LocalizedError {
        case unavailable
        var errorDescription: String? { "YouTube search is unavailable right now. Try again in a moment." }
    }

    /// `sp` values from youtube.com's filter menu, all restricted to videos.
    static let filters: [String: String] = [
        "any": "EgIQAQ==", "short": "EgQQARgB", "medium": "EgQQARgD", "long": "EgQQARgC",
        "week": "EgQIAxAB", "newest": "CAISAhAB"
    ]
    private static let clientVersion = "2.20250101.00.00"
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    static func search(_ query: String, filter: String, continuation: String?) async throws -> Page {
        var body: [String: Any] = ["context": ["client": ["clientName": "WEB", "clientVersion": clientVersion,
                                                          "hl": "en", "gl": "US"]]]
        if let continuation, !continuation.isEmpty { body["continuation"] = continuation }
        else { body["query"] = query; body["params"] = filters[filter] ?? filters["any"]! }
        var request = URLRequest(url: URL(string: "https://www.youtube.com/youtubei/v1/search?prettyPrint=false")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) else { throw Failure.unavailable }
        var renderers: [[String: Any]] = []
        var token: String?
        walk(object, renderers: &renderers, token: &token)
        var seen = Set<String>()
        let hits = renderers.compactMap { renderer -> Hit? in
            guard let id = renderer["videoId"] as? String, id.count == 11, seen.insert(id).inserted,
                  let title = text(renderer["title"]), !title.isEmpty else { return nil }
            // Live streams cannot be prepared as a finished file.
            if renderer["lengthText"] == nil, text(renderer["publishedTimeText"]) == nil { return nil }
            return Hit(id: id, title: title,
                       channel: text(renderer["ownerText"]) ?? text(renderer["longBylineText"]) ?? "",
                       thumbnail: "https://i.ytimg.com/vi/\(id)/mqdefault.jpg",
                       duration: text(renderer["lengthText"]),
                       views: text(renderer["shortViewCountText"]) ?? text(renderer["viewCountText"]),
                       published: text(renderer["publishedTimeText"]))
        }
        return Page(results: hits, continuation: token)
    }

    /// Typeahead suggestions from YouTube's public completion endpoint.
    static func suggestions(_ query: String) async throws -> [String] {
        var components = URLComponents(string: "https://suggestqueries-clients6.youtube.com/complete/search")!
        components.queryItems = [URLQueryItem(name: "client", value: "youtube"), URLQueryItem(name: "ds", value: "yt"),
                                 URLQueryItem(name: "hl", value: "en"), URLQueryItem(name: "gl", value: "us"),
                                 URLQueryItem(name: "q", value: query)]
        let (data, response) = try await session.data(from: components.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.unavailable }
        return parseSuggestions(String(decoding: data, as: UTF8.self))
    }

    /// The response is JSONP: `window.google.ac.h(["q",[["one",0,[]],...],{}])`.
    static func parseSuggestions(_ body: String) -> [String] {
        guard let open = body.firstIndex(of: "("), let close = body.lastIndex(of: ")"), open < close,
              let array = try? JSONSerialization.jsonObject(with: Data(body[body.index(after: open)..<close].utf8)) as? [Any],
              array.count > 1, let entries = array[1] as? [Any] else { return [] }
        return Array(entries.compactMap { ($0 as? [Any])?.first as? String }.prefix(8))
    }

    private static func walk(_ value: Any, renderers: inout [[String: Any]], token: inout String?) {
        if let dictionary = value as? [String: Any] {
            if let renderer = dictionary["videoRenderer"] as? [String: Any] { renderers.append(renderer) }
            if token == nil, let command = dictionary["continuationCommand"] as? [String: Any] {
                token = command["token"] as? String
            }
            for child in dictionary.values { walk(child, renderers: &renderers, token: &token) }
        } else if let array = value as? [Any] {
            for child in array { walk(child, renderers: &renderers, token: &token) }
        }
    }
    private static func text(_ value: Any?) -> String? {
        guard let value = value as? [String: Any] else { return nil }
        if let simple = value["simpleText"] as? String { return simple }
        if let runs = value["runs"] as? [[String: Any]] {
            let joined = runs.compactMap { $0["text"] as? String }.joined()
            return joined.isEmpty ? nil : joined
        }
        return nil
    }
}
