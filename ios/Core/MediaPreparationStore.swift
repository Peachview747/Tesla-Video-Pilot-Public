import Foundation

public enum MediaTrack: String, Codable, Sendable, Hashable { case video, audio }

public struct MediaPreparationJob: Codable, Identifiable, Sendable {
    public let id: UUID
    public let title: String
    public let youtubeID: String?
    public let videoURL: URL?
    public let audioURL: URL?
    public let sourceExtension: String
    public let createdAt: Date
    public let quality: MediaQuality?
    public var isTransportStream: Bool { sourceExtension == "ts" }

    public init(id: UUID, title: String, youtubeID: String? = nil,
                videoURL: URL? = nil, audioURL: URL? = nil,
                sourceExtension: String = "mp4", createdAt: Date = Date(), quality: MediaQuality? = nil) {
        self.id = id
        self.title = title
        self.youtubeID = youtubeID
        self.videoURL = videoURL
        self.audioURL = audioURL
        let ext = sourceExtension.lowercased()
        self.sourceExtension = !ext.isEmpty && ext.count <= 12 && ext.utf8.allSatisfy {
            (48...57).contains($0) || (97...122).contains($0)
        } ? ext : "mp4"
        self.createdAt = createdAt
        self.quality = quality
    }
}

public struct MediaDownloadDescriptor: Codable, Sendable, Equatable {
    public let jobID: UUID
    public let track: MediaTrack
    public let rangeStart: Int64?
    public let rangeEnd: Int64?
    public let totalLength: Int64?
    public init(jobID: UUID, track: MediaTrack, range: MediaByteRange? = nil, totalLength: Int64? = nil) {
        self.jobID = jobID; self.track = track
        self.rangeStart = range?.start; self.rangeEnd = range?.end; self.totalLength = totalLength
    }
    public var range: MediaByteRange? {
        guard let start = rangeStart, let end = rangeEnd else { return nil }
        return MediaByteRange(start: start, end: end)
    }
    public var taskDescription: String {
        // Fixed UUID/track fields let a background URLSession reconnect after app termination.
        jobID.uuidString + ":" + track.rawValue + (range.map { ":\($0.start):\($0.end):\(totalLength ?? 0)" } ?? "")
    }
    public init?(taskDescription: String?) {
        guard let parts = taskDescription?.split(separator: ":"), parts.count == 2 || parts.count == 5,
              let id = UUID(uuidString: String(parts[0])),
              let track = MediaTrack(rawValue: String(parts[1])) else { return nil }
        if parts.count == 5 {
            guard let start = Int64(parts[2]), let end = Int64(parts[3]), let total = Int64(parts[4]),
                  start >= 0, end >= start, end < total, total <= 50_000_000_000 else { return nil }
            self.init(jobID: id, track: track, range: .init(start: start, end: end), totalLength: total)
        } else { self.init(jobID: id, track: track) }
    }
}

public struct MediaPreparationStore: Sendable {
    public let root: URL
    public init(root: URL) { self.root = root }
    public func directory(for id: UUID) -> URL { root.appendingPathComponent(id.uuidString) }
    public func save(_ job: MediaPreparationJob) throws {
        let directory = directory(for: job.id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        try JSONEncoder().encode(job).write(to: directory.appendingPathComponent("job.json"), options: .atomic)
    }
    public func load(_ id: UUID) throws -> MediaPreparationJob {
        let url = directory(for: id).appendingPathComponent("job.json")
        let job = try JSONDecoder().decode(MediaPreparationJob.self, from: Data(contentsOf: url))
        guard job.id == id, !job.sourceExtension.isEmpty, job.sourceExtension.count <= 12,
              job.sourceExtension.utf8.allSatisfy({ (48...57).contains($0) || (97...122).contains($0) }) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return job
    }
    public func jobs() -> [MediaPreparationJob] {
        let directories = (try? FileManager.default.contentsOfDirectory(at: root,
                                     includingPropertiesForKeys: nil)) ?? []
        return directories.compactMap { url -> MediaPreparationJob? in
            guard let id = UUID(uuidString: url.lastPathComponent) else { return nil }
            return try? load(id)
        }.sorted { $0.createdAt < $1.createdAt }
    }
    public func file(for job: MediaPreparationJob, track: MediaTrack) -> URL {
        directory(for: job.id).appendingPathComponent(track == .video ? "source." + job.sourceExtension : "audio.m4a")
    }
    public func failureFile(for descriptor: MediaDownloadDescriptor) -> URL {
        directory(for: descriptor.jobID).appendingPathComponent(descriptor.track.rawValue
            + (descriptor.range.map { ".\($0.start).\($0.end)" } ?? "") + ".error.txt")
    }
    public func file(for descriptor: MediaDownloadDescriptor) throws -> URL {
        let job = try load(descriptor.jobID)
        guard let range = descriptor.range else { return file(for: job, track: descriptor.track) }
        return directory(for: job.id).appendingPathComponent("\(descriptor.track.rawValue).\(range.start).\(range.end).part")
    }
    public func clearFailures(_ id: UUID) {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory(for: id), includingPropertiesForKeys: nil)) ?? []
        for file in files where file.lastPathComponent.hasSuffix(".error.txt") { try? FileManager.default.removeItem(at: file) }
    }
    public func remove(_ id: UUID) throws {
        let directory = directory(for: id)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
}
