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
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "MK8", code: 3, userInfo: [NSLocalizedDescriptionKey: "YouTube account request failed."])
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
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "MK8", code: 1, userInfo: [NSLocalizedDescriptionKey: "YouTube search failed. Check the API key and quota on the iPhone."])
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
    /// Activities are the closest account-aware home feed: they contain the
    /// latest uploads from channels the signed-in account follows.
    static func subscriptions(accessToken: String) async throws -> [SearchVideo] {
        let data = try await request("activities", query: [
            URLQueryItem(name: "part", value: "snippet,contentDetails"), URLQueryItem(name: "mine", value: "true"),
            URLQueryItem(name: "maxResults", value: "25")
        ], accessToken: accessToken)
        struct Result: Decodable {
            struct Item: Decodable {
                struct Snippet: Decodable {
                    struct Thumbnail: Decodable { let url: String }
                    let title: String
                    let channelTitle: String
                    let thumbnails: [String: Thumbnail]
                }
                struct ContentDetails: Decodable {
                    struct Upload: Decodable { let videoId: String? }
                    let upload: Upload?
                }
                let snippet: Snippet
                let contentDetails: ContentDetails?
            }
            let items: [Item]
        }
        return try JSONDecoder().decode(Result.self, from: data).items.compactMap {
            guard let id = $0.contentDetails?.upload?.videoId else { return nil }
            return SearchVideo(id: id, title: $0.snippet.title, channel: $0.snippet.channelTitle,
                               thumbnail: $0.snippet.thumbnails["medium"]?.url)
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
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NSError(domain: "MK8", code: 2, userInfo: [NSLocalizedDescriptionKey: "YouTube Explore failed. Check the API key and quota on the iPhone."]) }
        struct Result: Decodable { struct Item: Decodable { let id: String; let snippet: Snippet }; struct Snippet: Decodable { let title: String; let channelTitle: String; let thumbnails: [String: Thumbnail] }; struct Thumbnail: Decodable { let url: String }; let items: [Item] }
        return try JSONDecoder().decode(Result.self, from: data).items.map { SearchVideo(id: $0.id, title: $0.snippet.title, channel: $0.snippet.channelTitle, thumbnail: $0.snippet.thumbnails["medium"]?.url) }
    }
}
