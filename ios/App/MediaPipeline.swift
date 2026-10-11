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

/// Where the time went for one preparation: download, waiting for iOS,
/// conversion and indexing. Shown in diagnostics and /api/status.
struct PreparationTimings: Sendable {
    var quality: Int
    var downloadSeconds: Double?
    var downloadedBytes: Int64 = 0
    var waitSeconds: Double = 0
    var processingSeconds: Double?
    var hardwareDecode: Bool?
    /// Time spent in attempts that failed before the conversion that worked.
    var fallbackSeconds: Double?
    /// Encoder sessions run side by side (1 = single pass).
    var segments: Int = 1
    var indexSeconds: Double = 0
    var mediaSeconds: Double?
    var outputBytes: Int64 = 0
    var totalSeconds: Double = 0
    var finishedAt = Date()

    var downloadMbps: Double? {
        guard let seconds = downloadSeconds, seconds > 0, downloadedBytes > 0 else { return nil }
        return Double(downloadedBytes) * 8 / seconds / 1_000_000
    }
    /// Media seconds prepared per wall-clock second (1 = real time).
    var processingSpeed: Double? {
        guard let seconds = processingSeconds, seconds > 0, let media = mediaSeconds, media > 0 else { return nil }
        return media / seconds
    }
    var outputKbps: Double? {
        guard let media = mediaSeconds, media > 0, outputBytes > 0 else { return nil }
        return Double(outputBytes) * 8 / media / 1_000
    }

    private static func rounded(_ value: Double?, _ places: Double = 100) -> Any {
        guard let value, value.isFinite else { return NSNull() }
        return (value * places).rounded() / places
    }

    var json: [String: Any] {
        ["quality": quality, "totalSeconds": Self.rounded(totalSeconds),
         "downloadSeconds": Self.rounded(downloadSeconds), "downloadedBytes": downloadedBytes,
         "downloadMbps": Self.rounded(downloadMbps), "waitSeconds": Self.rounded(waitSeconds),
         "processingSeconds": Self.rounded(processingSeconds), "processingSpeed": Self.rounded(processingSpeed),
         "hardwareDecode": hardwareDecode.map { $0 as Any } ?? NSNull(),
         "fallbackSeconds": Self.rounded(fallbackSeconds), "segments": segments,
         "indexSeconds": Self.rounded(indexSeconds), "mediaSeconds": Self.rounded(mediaSeconds),
         "outputBytes": outputBytes, "outputKbps": Self.rounded(outputKbps, 1),
         "finishedAt": ISO8601DateFormatter().string(from: finishedAt)]
    }

    var fields: [String: String] {
        var result: [String: String] = [:]
        for (key, value) in json where !(value is NSNull) { result[key] = String(describing: value) }
        return result
    }
}

@MainActor enum PreparationStats {
    /// The most recent successful preparation, or nil before the first one.
    private(set) static var last: PreparationTimings?
    static func record(_ timings: PreparationTimings) {
        last = timings
        SessionDiagnostics.shared.record(component: "pipeline", event: "prepared", fields: timings.fields)
    }
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
        let job = try await stageImported(source, jobID: jobID, quality: quality)
        return try await resume(job, output: output, background: background, progress: progress, traffic: traffic)
    }

    /// Copy a Files import while its security-scoped URL is still available.
    /// Queued jobs must own a durable local source before that URL is released.
    /// The hidden staging directory is never returned by store.jobs(), so an
    /// interrupted copy cannot be mistaken for a resumable preparation job.
    static func stageImported(_ source: URL, jobID: UUID, quality: MediaQuality) async throws -> MediaPreparationJob {
        try Task.checkCancellation()
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let job = MediaPreparationJob(id: jobID, title: source.deletingPathExtension().lastPathComponent,
                                       sourceExtension: source.pathExtension, quality: quality)
        let staging = store.root.appendingPathComponent(".importing-" + UUID().uuidString)
        let stagedStore = MediaPreparationStore(root: staging)
        defer { try? FileManager.default.removeItem(at: staging) }
        try stagedStore.save(job)
        let local = stagedStore.file(for: job, track: .video)
        let reader = try FileHandle(forReadingFrom: source)
        defer { try? reader.close() }
        guard FileManager.default.createFile(atPath: local.path, contents: nil) else { throw MediaError.badDownload }
        try protect(local)
        let writer = try FileHandle(forWritingTo: local)
        do {
            var count: Int64 = 0
            while let bytes = try reader.read(upToCount: 256 * 1_024), !bytes.isEmpty {
                try Task.checkCancellation()
                try writer.write(contentsOf: bytes)
                count += Int64(bytes.count)
            }
            try writer.close()
            try Task.checkCancellation()
            guard count > 0 else { throw MediaError.badDownload }
            try FileManager.default.moveItem(at: stagedStore.directory(for: job.id), to: store.directory(for: job.id))
        } catch {
            try? writer.close()
            throw error
        }
        return job
    }

    static func resume(_ job: MediaPreparationJob, output: URL, background: Bool,
                       progress: @escaping Progress, traffic: @escaping Traffic) async throws -> PreparedMedia {
        let started = ProcessInfo.processInfo.systemUptime
        var timings = PreparationTimings(quality: (job.quality ?? .balanced).rawValue)
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
            timings.downloadSeconds = ProcessInfo.processInfo.systemUptime - started
            timings.downloadedBytes = size(of: source) + (audio.map { size(of: $0) } ?? 0)
        } else { source = store.file(for: job, track: .video) }

        try Task.checkCancellation()
        let waitStarted = ProcessInfo.processInfo.systemUptime
        let allowed = await AppActivity.shared.processingAllowed
        if !allowed { progress(.init(stage: .waitingForApp)) }
        try await AppActivity.shared.waitUntilProcessingAllowed()
        try Task.checkCancellation()
        timings.waitSeconds = ProcessInfo.processInfo.systemUptime - waitStarted
        let processingStarted = ProcessInfo.processInfo.systemUptime
        let sourceDuration = await duration(of: source)
        try Task.checkCancellation()
        // A previous failed conversion must never leave a stale index paired
        // with a newly downloaded file.
        try? FileManager.default.removeItem(at: seekIndexURL(for: output))
        if job.isTransportStream {
            // Checking only the opening packets admitted truncated or corrupt
            // tails. The bounded scanner validates every transport packet.
            do { _ = try MPEGTSIndex.build(file: source) }
            catch is CancellationError { throw CancellationError() }
            catch { throw MediaError.invalidTransport }
            if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
            try FileManager.default.copyItem(at: source, to: output)
            try protect(output)
            timings.processingSeconds = ProcessInfo.processInfo.systemUptime - processingStarted
        } else {
            progress(.init(stage: .processing, fraction: sourceDuration == nil ? nil : 0))
            let report = try await convert(video: source, audio: audio, output: output, duration: sourceDuration,
                                           quality: job.quality ?? .balanced, jobID: job.id, progress: progress)
            timings.processingSeconds = report.seconds
            timings.hardwareDecode = report.hardwareDecode
            timings.fallbackSeconds = report.failedHardwareSeconds
            timings.segments = report.segments
        }
        let indexStarted = ProcessInfo.processInfo.systemUptime
        // MPEG-TS is variable bitrate, so a file-size ratio cannot provide a
        // reliable seek position. Build a timestamp index once while the file
        // is local; playback reuses it for every later seek. Prefer the
        // output's measured duration because FFmpeg can trim or round frames
        // differently from the downloaded source track.
        let index: MPEGTSIndex?
        do { index = try MPEGTSIndex.build(file: output) }
        catch is CancellationError { throw CancellationError() }
        catch { throw MediaError.invalidTransport }
        try Task.checkCancellation()
        if let index, !index.points.isEmpty {
            try? writeSeekIndex(index, for: output)
        }
        let finished = ProcessInfo.processInfo.systemUptime
        timings.indexSeconds = finished - indexStarted
        timings.totalSeconds = finished - started
        timings.mediaSeconds = index?.duration ?? sourceDuration
        timings.outputBytes = size(of: output)
        timings.finishedAt = Date()
        let finishedTimings = timings
        await MainActor.run { PreparationStats.record(finishedTimings) }
        progress(.init(stage: .finalizing, fraction: 1))
        return PreparedMedia(title: job.title, duration: index?.duration ?? sourceDuration)
    }

    private static func convert(video: URL, audio: URL?, output: URL, duration: Double?,
                                quality: MediaQuality, jobID: UUID,
                                progress: @escaping Progress) async throws -> MediaConverter.Report {
        let report: MediaConverter.Report
        do {
            report = try await MediaConverter.convert(video: video, audio: audio, output: output,
                duration: duration, quality: quality, progress: progress)
        } catch let failure as MediaConverter.Failure {
            let text = "Video Pilot converter · FFmpeg 5.1.2\nExit code: \(failure.code)\nQuality: \(quality.title)\n\n"
                + String(failure.log.suffix(24_000))
            try? text.write(to: diagnosticsURL(jobID), atomically: true, encoding: .utf8)
            throw MediaError.conversionFailed(failure.detail)
        }
        try Task.checkCancellation()
        try protect(output)
        return report
    }

    private static func size(of url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
    }

    static func diagnosticsURL(_ id: UUID) -> URL { store.directory(for: id).appendingPathComponent("conversion.log") }
    static func seekIndexURL(for output: URL) -> URL {
        output.deletingPathExtension().appendingPathExtension("seek.json")
    }
    private static func writeSeekIndex(_ index: MPEGTSIndex, for output: URL) throws {
        let data = try JSONEncoder().encode(index)
        try data.write(to: seekIndexURL(for: output), options: .atomic)
        try protect(seekIndexURL(for: output))
    }
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
