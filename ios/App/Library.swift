import Foundation
import Combine
import MK8Core

struct LibraryVideo: Codable, Identifiable {
    let id: UUID
    var title: String
    var youtubeID: String?
    var state: String
    var message: String?
    var duration: Double?
    var createdAt: Date
}

@MainActor final class Library: ObservableObject {
    @Published private(set) var videos: [LibraryVideo] = []
    let directory: URL
    private var index: URL { directory.appendingPathComponent("library.json") }

    init() throws {
        directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true).appendingPathComponent("MK8")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try MediaPipeline.protect(directory)
        if FileManager.default.fileExists(atPath: index.path) {
            videos = try JSONDecoder().decode([LibraryVideo].self, from: Data(contentsOf: index))
            for i in videos.indices where videos[i].state == "preparing" && (try? MediaPipeline.store.load(videos[i].id)) == nil {
                videos[i].state = "failed"
                videos[i].message = "Preparation was interrupted. Add this video again."
            }
            try save()
        }
    }
    func file(for id: UUID) -> URL { directory.appendingPathComponent(id.uuidString + ".ts") }
    func add(title: String, youtubeID: String? = nil) throws -> LibraryVideo {
        let video = LibraryVideo(id: UUID(), title: title, youtubeID: youtubeID, state: "preparing", createdAt: Date())
        videos.insert(video, at: 0)
        do { try save() } catch { videos.removeAll { $0.id == video.id }; throw error }
        return video
    }
    func update(_ id: UUID, title: String? = nil, state: String, message: String? = nil, duration: Double? = nil) throws {
        guard let i = videos.firstIndex(where: { $0.id == id }) else { return }
        if let title { videos[i].title = title }
        videos[i].state = state
        videos[i].message = message
        videos[i].duration = duration
        try save()
    }
    func remove(_ id: UUID) throws {
        let file = file(for: id)
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        try MediaPipeline.store.remove(id)
        videos.removeAll { $0.id == id }
        try save()
    }
    private func save() throws {
        try JSONEncoder().encode(videos).write(to: index, options: .atomic)
        try MediaPipeline.protect(index)
    }
}
