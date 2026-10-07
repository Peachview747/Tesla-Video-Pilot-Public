import Foundation

struct SearchVideo: Codable {
    let id: String
    let title: String
    let channel: String
    let thumbnail: String?
}

enum YouTubeSearch {
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
        return try JSONDecoder().decode(Result.self, from: data).items.map {
            SearchVideo(id: $0.id.videoId, title: $0.snippet.title, channel: $0.snippet.channelTitle,
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
