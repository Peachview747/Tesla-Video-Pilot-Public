import Foundation
import AVFoundation
import YouTubeKit
import MK8Core

enum MediaError: LocalizedError {
    case noStream, badDownload, invalidTransport
    case conversionFailed(String)
    case downloadFailed(String)
    var errorDescription: String? {
        switch self {
        case .noStream: return "YouTube did not provide a compatible stream. Try another video or import a local file."
        case .badDownload: return "The video download failed. Check the connection and try again."
        case .invalidTransport: return "The file is not a packet-aligned MPEG-TS stream. Import MP4/MOV to convert it."
        case .conversionFailed(let detail): return "Preparation failed: \(detail). The download is saved; tap Retry."
        case .downloadFailed(let message): return "Download failed: " + message
        }
    }
}

struct PreparedMedia {
    let title: String
    let duration: Double?
}

enum MediaPipeline {
    typealias Progress = @Sendable (MediaPreparationProgress) -> Void
    typealias Traffic = @Sendable (Int64) -> Void
    static var store: MediaPreparationStore {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return MediaPreparationStore(root: support.appendingPathComponent("MK8/.preparation"))
    }

    static func youtube(id: String, jobID: UUID, output: URL, background: Bool, quality: MediaQuality,
                        progress: @escaping Progress, traffic: @escaping Traffic) async throws -> PreparedMedia {
        progress(.init(stage: .resolving))
        let youtube = YouTube(videoID: id, methods: [.local])
        let streams = try await youtube.streams
        // H.264 avoids AV1 software decoding; adaptive tracks avoid large progressive downloads.
        let compatible = streams.filter { $0.fileExtension == .mp4 && $0.videoCodec == .avc1 }
        func select(_ candidates: [YouTubeKit.Stream]) -> YouTubeKit.Stream? {
            let below = candidates.filter { ($0.videoResolution ?? Int.max) <= quality.rawValue }
            let pool = below.isEmpty ? candidates : below
            return pool.sorted {
                let a = $0.videoResolution ?? Int.max, b = $1.videoResolution ?? Int.max
                if a != b { return below.isEmpty ? a < b : a > b }
                return ($0.averageBitrate ?? $0.bitrate ?? Int.max) < ($1.averageBitrate ?? $1.bitrate ?? Int.max)
            }.first
        }
        let audioStreams = streams.filter { !$0.includesVideoTrack && $0.audioCodec == .mp4a }
        let preferredAudio = audioStreams.filter { ($0.bitrate ?? Int.max) <= 160_000 }
        let selectedAudio = (preferredAudio.isEmpty ? audioStreams : preferredAudio).sorted {
            ($0.bitrate ?? 0) > ($1.bitrate ?? 0)
        }.first
        let adaptive = selectedAudio == nil ? nil : select(compatible.filterVideoOnly())
        let video = adaptive ?? select(compatible.filterVideoAndAudio())
        guard let video else { throw MediaError.noStream }
        var audioURL: URL?
        if adaptive != nil {
            guard let audio = selectedAudio else {
                throw MediaError.noStream
            }
            audioURL = audio.url
        }
        let metadata = try? await youtube.metadata
        let job = MediaPreparationJob(id: jobID, title: metadata?.title ?? "YouTube \(id)",
                                       youtubeID: id, videoURL: video.url, audioURL: audioURL, quality: quality)
        try store.save(job)
        return try await resume(job, output: output, background: background, progress: progress, traffic: traffic)
    }

    static func imported(_ source: URL, jobID: UUID, output: URL, background: Bool, quality: MediaQuality,
                         progress: @escaping Progress, traffic: @escaping Traffic) async throws -> PreparedMedia {
        progress(.init(stage: .importing))
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let job = MediaPreparationJob(id: jobID, title: source.deletingPathExtension().lastPathComponent,
                                       sourceExtension: source.pathExtension, quality: quality)
        try store.save(job)
        try FileManager.default.copyItem(at: source, to: store.file(for: job, track: .video))
        try protect(store.file(for: job, track: .video))
        return try await resume(job, output: output, background: background, progress: progress, traffic: traffic)
    }

    static func resume(_ job: MediaPreparationJob, output: URL, background: Bool,
                       progress: @escaping Progress, traffic: @escaping Traffic) async throws -> PreparedMedia {
        let source: URL
        var audio: URL?
        if let videoURL = job.videoURL {
            progress(.init(stage: .downloading))
            let combined = DownloadProgress(tracks: job.audioURL == nil ? [.video] : [.video, .audio], progress: progress)
            let measuredTraffic: Traffic = { bytes in combined.recordTraffic(bytes); traffic(bytes) }
            async let video = MediaDownloader.shared.downloadTrack(videoURL,
                descriptor: .init(jobID: job.id, track: .video), background: background,
                progress: { combined.update(.video, received: $0, total: $1) }, traffic: measuredTraffic,
                mode: { combined.setMode($0) })
            if let audioURL = job.audioURL {
                async let downloadedAudio = MediaDownloader.shared.downloadTrack(audioURL,
                    descriptor: .init(jobID: job.id, track: .audio), background: background,
                    progress: { combined.update(.audio, received: $0, total: $1) }, traffic: measuredTraffic)
                let downloaded = try await (video, downloadedAudio)
                source = downloaded.0
                audio = downloaded.1
            } else { source = try await video }
        } else { source = store.file(for: job, track: .video) }

        try Task.checkCancellation()
        let allowed = await AppActivity.shared.processingAllowed
        if !allowed { progress(.init(stage: .waitingForApp)) }
        try await AppActivity.shared.waitUntilProcessingAllowed()
        try Task.checkCancellation()
        let duration = await duration(of: source)
        if job.isTransportStream {
            let handle = try FileHandle(forReadingFrom: source)
            defer { try? handle.close() }
            let bytes = try handle.read(upToCount: 188 * 20) ?? Data()
            guard bytes.count >= 188 * 3, bytes.count % 188 == 0,
                  stride(from: 0, to: bytes.count, by: 188).allSatisfy({ bytes[$0] == 0x47 }) else {
                throw MediaError.invalidTransport
            }
            if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
            try FileManager.default.copyItem(at: source, to: output)
        } else {
            progress(.init(stage: .processing, fraction: duration == nil ? nil : 0))
            try await convert(video: source, audio: audio, output: output, duration: duration,
                              quality: job.quality ?? .balanced, jobID: job.id, progress: progress)
        }
        progress(.init(stage: .finalizing, fraction: 1))
        return PreparedMedia(title: job.title, duration: duration)
    }

    private static func convert(video: URL, audio: URL?, output: URL, duration: Double?,
                                quality: MediaQuality, jobID: UUID, progress: @escaping Progress) async throws {
        do {
            try await MediaConverter.convert(video: video, audio: audio, output: output,
                duration: duration, quality: quality, progress: progress)
        } catch let failure as MediaConverter.Failure {
            let report = "Video Pilot converter · FFmpeg 5.1.2\nExit code: \(failure.code)\nQuality: \(quality.title)\n\n"
                + String(failure.log.suffix(24_000))
            try? report.write(to: diagnosticsURL(jobID), atomically: true, encoding: .utf8)
            throw MediaError.conversionFailed(failure.detail)
        }
        try Task.checkCancellation()
        try protect(output)
    }

    static func diagnosticsURL(_ id: UUID) -> URL { store.directory(for: id).appendingPathComponent("conversion.log") }
    static func protect(_ file: URL) throws {
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
    }
    private static func duration(of url: URL) async -> Double? {
        guard let time = try? await AVURLAsset(url: url).load(.duration) else { return nil }
        let seconds = CMTimeGetSeconds(time)
        return seconds.isFinite && seconds > 0 ? seconds : nil
    }

    private final class DownloadProgress: @unchecked Sendable {
        private let lock = NSLock()
        private var counts: [MediaTrack: (received: Int64, total: Int64?)]
        private let progress: Progress
        private var lastTime = ProcessInfo.processInfo.systemUptime
        private var lastBytes: Int64 = 0
        private var trafficBytes: Int64 = 0
        private var speed: Double = 0
        private var mode: MediaTransferMode?
        init(tracks: [MediaTrack], progress: @escaping Progress) {
            counts = Dictionary(uniqueKeysWithValues: tracks.map { ($0, (0, nil)) })
            self.progress = progress
        }
        func recordTraffic(_ bytes: Int64) {
            lock.lock(); trafficBytes += max(0, bytes); lock.unlock()
        }
        func setMode(_ value: MediaTransferMode) { lock.lock(); mode = value; lock.unlock() }
        func update(_ track: MediaTrack, received: Int64, total: Int64?) {
            lock.lock()
            counts[track] = (max(counts[track]?.received ?? 0, received), total)
            let received = counts.values.reduce(Int64(0)) { $0 + $1.received }
            let totals = counts.values.compactMap(\.total)
            let total: Int64? = totals.count == counts.count ? totals.reduce(0, +) : nil
            let now = ProcessInfo.processInfo.systemUptime
            let elapsed = now - lastTime
            if elapsed >= 0.5 {
                let rate = Double(max(0, trafficBytes - lastBytes)) / elapsed
                speed = speed == 0 ? rate : speed * 0.5 + rate * 0.5
                lastTime = now; lastBytes = trafficBytes
            }
            let rate = speed
            let transferMode = mode
            lock.unlock()
            progress(.init(stage: .downloading, completedBytes: received, totalBytes: total, bytesPerSecond: rate,
                           transferMode: transferMode))
        }
    }
}
