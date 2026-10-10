import Foundation

/// Channel name and release date for a library video. YouTubeKit's metadata
/// has neither, so they come from YouTube's public oEmbed endpoint (channel)
/// and the watch page's structured data (release date). No API key or Google
/// account is needed, and a failure just leaves the fields empty.
enum YouTubeDetails {
    struct Details { var channel: String?; var publishedAt: String? }

    static func fetch(_ youtubeID: String) async -> Details {
        async let channel = channelName(youtubeID)
        async let published = releaseDate(youtubeID)
        return Details(channel: await channel, publishedAt: await published)
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    private static func channelName(_ id: String) async -> String? {
        var components = URLComponents(string: "https://www.youtube.com/oembed")!
        components.queryItems = [URLQueryItem(name: "url", value: "https://www.youtube.com/watch?v=\(id)"),
                                 URLQueryItem(name: "format", value: "json")]
        guard let url = components.url,
              let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = (object["author_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty else { return nil }
        return String(name.prefix(200))
    }

    /// Returns an ISO 8601 timestamp such as `2009-10-24T23:57:33-07:00`.
    private static func releaseDate(_ id: String) async -> String? {
        guard let url = URL(string: "https://www.youtube.com/watch?v=\(id)&hl=en") else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        request.setValue("en-US", forHTTPHeaderField: "Accept-Language")
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return parseReleaseDate(String(decoding: data, as: UTF8.self))
    }

    static func parseReleaseDate(_ html: String) -> String? {
        let patterns = [#""publishDate":"([^"]{10,40})""#, #""uploadDate":"([^"]{10,40})""#,
                        #"itemprop="datePublished" content="([^"]{10,40})""#]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
                  let range = Range(match.range(at: 1), in: html) else { continue }
            let value = String(html[range])
            if value.range(of: #"^\d{4}-\d{2}-\d{2}"#, options: .regularExpression) != nil { return value }
        }
        return nil
    }
}
