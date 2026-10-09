import Foundation

struct SearchVideo: Codable {
    let id: String
    let title: String
    let channel: String
    let thumbnail: String?
}

enum YouTubeSearch {
    private static func request(_ path: String, query: [URLQueryItem], accessToken: String) async throws -> Data {
        var components = URLComponents(string: "https://www.googleapis.com/youtube/v3/\(path)")!
        components.queryItems = query
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw apiError(data: data, status: status, fallback: "YouTube account request failed")
        }
        return data
    }

    static func search(_ query: String, accessToken: String) async throws -> [SearchVideo] {
        let data = try await request("search", query: [
            URLQueryItem(name: "part", value: "snippet"), URLQueryItem(name: "type", value: "video"),
            URLQueryItem(name: "maxResults", value: "25"), URLQueryItem(name: "q", value: query)
        ], accessToken: accessToken)
        return try decodeSearch(data)
    }

    static func search(_ query: String, apiKey: String) async throws -> [SearchVideo] {
        var components = URLComponents(string: "https://www.googleapis.com/youtube/v3/search")!
        components.queryItems = [
            URLQueryItem(name: "part", value: "snippet"), URLQueryItem(name: "type", value: "video"),
            URLQueryItem(name: "maxResults", value: "25"), URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "key", value: apiKey)
        ]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw apiError(data: data, status: status, fallback: "YouTube search failed")
        }
        struct Result: Decodable {
            struct Item: Decodable {
                struct ID: Decodable { let videoId: String }
                struct Snippet: Decodable {
                    struct Thumbnail: Decodable { let url: String }
                    let title: String
                    let channelTitle: String
                    let thumbnails: [String: Thumbnail]
                }
                let id: ID
                let snippet: Snippet
            }
            let items: [Item]
        }
        return try decodeSearch(data)
    }

    private static func decodeSearch(_ data: Data) throws -> [SearchVideo] {
        struct Result: Decodable {
            struct Item: Decodable {
                struct ID: Decodable { let videoId: String? }
                struct Snippet: Decodable {
                    struct Thumbnail: Decodable { let url: String }
                    let title: String
                    let channelTitle: String
                    let thumbnails: [String: Thumbnail]
                }
                let id: ID
                let snippet: Snippet
            }
            let items: [Item]
        }
        return try JSONDecoder().decode(Result.self, from: data).items.compactMap {
            guard let id = $0.id.videoId else { return nil }
            return SearchVideo(id: id, title: $0.snippet.title, channel: $0.snippet.channelTitle,
                               thumbnail: $0.snippet.thumbnails["medium"]?.url)
        }
    }

    /// The Data API does not expose YouTube's private recommendation model.
    /// Build a useful account feed from the signed-in user's subscriptions and
    /// each channel's uploads playlist instead of pretending activities are a
    /// recommendation feed for that user.
    static func subscriptions(accessToken: String) async throws -> [SearchVideo] {
        struct Subscriptions: Decodable {
            struct Item: Decodable {
                struct Snippet: Decodable {
                    struct Resource: Decodable { let channelId: String? }
                    let resourceId: Resource
                }
                let snippet: Snippet
            }
            let items: [Item]
        }
        let subscriptions = try JSONDecoder().decode(Subscriptions.self, from: try await request("subscriptions", query: [
            URLQueryItem(name: "part", value: "snippet"), URLQueryItem(name: "mine", value: "true"),
            URLQueryItem(name: "maxResults", value: "50"), URLQueryItem(name: "order", value: "alphabetical")
        ], accessToken: accessToken)).items.compactMap { $0.snippet.resourceId.channelId }
        guard !subscriptions.isEmpty else { return [] }

        struct Channels: Decodable {
            struct Item: Decodable {
                struct ContentDetails: Decodable {
                    struct Playlists: Decodable { let uploads: String? }
                    let relatedPlaylists: Playlists
                }
                let contentDetails: ContentDetails
            }
            let items: [Item]
        }
        let channelIDs = subscriptions.joined(separator: ",")
        let channels = try JSONDecoder().decode(Channels.self, from: try await request("channels", query: [
            URLQueryItem(name: "part", value: "contentDetails"), URLQueryItem(name: "id", value: channelIDs)
        ], accessToken: accessToken)).items.compactMap { $0.contentDetails.relatedPlaylists.uploads }

        struct FeedItem { let video: SearchVideo; let publishedAt: String }
        let feed = try await withThrowingTaskGroup(of: [FeedItem].self, returning: [FeedItem].self) { group in
            for playlistID in channels {
                group.addTask {
                    struct Playlist: Decodable {
                        struct Item: Decodable {
                            struct Snippet: Decodable {
                                struct Thumbnail: Decodable { let url: String }
                                let title: String
                                let channelTitle: String
                                let publishedAt: String?
                                let thumbnails: [String: Thumbnail]
                            }
                            struct ContentDetails: Decodable { let videoId: String? }
                            let snippet: Snippet
                            let contentDetails: ContentDetails
                        }
                        let items: [Item]
                    }
                    let data = try await request("playlistItems", query: [
                        URLQueryItem(name: "part", value: "snippet,contentDetails"),
                        URLQueryItem(name: "playlistId", value: playlistID), URLQueryItem(name: "maxResults", value: "5")
                    ], accessToken: accessToken)
                    let items = try JSONDecoder().decode(Playlist.self, from: data).items
                    return items.compactMap { item in
                        guard let id = item.contentDetails.videoId else { return nil }
                        return FeedItem(video: SearchVideo(id: id, title: item.snippet.title, channel: item.snippet.channelTitle,
                                                           thumbnail: item.snippet.thumbnails["medium"]?.url),
                                        publishedAt: item.snippet.publishedAt ?? "")
                    }
                }
            }
            var result: [FeedItem] = []
            for try await items in group { result.append(contentsOf: items) }
            return result
        }
        var seen = Set<String>()
        return feed.sorted { $0.publishedAt > $1.publishedAt }.compactMap {
            seen.insert($0.video.id).inserted ? $0.video : nil
        }
    }

    static func trending(apiKey: String, region: String = "US") async throws -> [SearchVideo] {
        var components = URLComponents(string: "https://www.googleapis.com/youtube/v3/videos")!
        components.queryItems = [
            URLQueryItem(name: "part", value: "snippet"), URLQueryItem(name: "chart", value: "mostPopular"),
            URLQueryItem(name: "regionCode", value: region), URLQueryItem(name: "maxResults", value: "20"),
            URLQueryItem(name: "key", value: apiKey)
        ]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw apiError(data: data, status: status, fallback: "YouTube Explore failed")
        }
        struct Result: Decodable { struct Item: Decodable { let id: String; let snippet: Snippet }; struct Snippet: Decodable { let title: String; let channelTitle: String; let thumbnails: [String: Thumbnail] }; struct Thumbnail: Decodable { let url: String }; let items: [Item] }
        return try JSONDecoder().decode(Result.self, from: data).items.map { SearchVideo(id: $0.id, title: $0.snippet.title, channel: $0.snippet.channelTitle, thumbnail: $0.snippet.thumbnails["medium"]?.url) }
    }

    private static func apiError(data: Data, status: Int, fallback: String) -> NSError {
        struct Envelope: Decodable { struct Detail: Decodable { let message: String? }; let error: Detail? }
        let detail: String? = (try? JSONDecoder().decode(Envelope.self, from: data))?.error?.message
        let suffix = detail.map { ": \($0)" } ?? ""
        return NSError(domain: "MK8.YouTube", code: status, userInfo: [NSLocalizedDescriptionKey: "\(fallback) (HTTP \(status))\(suffix)"])
    }
}
