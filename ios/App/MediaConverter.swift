import Foundation
import ffmpegkit
import MK8Core

/// The actual native conversion worker, also compiled by the macOS smoke check.
/// Only input decoding can use VideoToolbox; Tesla playback requires MPEG-1.
enum MediaConverter {
    typealias Progress = @Sendable (MediaPreparationProgress) -> Void
    typealias Runner = @Sendable ([String], Double?, @escaping Progress) async throws -> Void

    struct Failure: Error {
        let code: Int32
        let log: String
        var detail: String {
            log.split(separator: "\n").last.map { String($0.prefix(180)) } ?? "Converter exit \(code)"
        }
    }

    /// What the successful attempt used, for pipeline timing diagnostics.
    struct Report: Sendable {
        let hardwareDecode: Bool
        /// Wall time of the successful encode.
        let seconds: Double
        /// Time lost to failed attempts (parallel or VideoToolbox) before the one that worked.
        let failedHardwareSeconds: Double?
        /// Encoder sessions that ran side by side (1 = single pass).
        let segments: Int
    }

    /// Failure code for joining/muxing parallel slices (encoding succeeded).
    static let joinStageCode: Int32 = -2

    /// Setting key; false forces the single-pass converter.
    static let parallelDefaultsKey = "parallelConversion"

    /// FFmpeg 5.1 runs decode, filter and encode for one output on a single
    /// thread, so independent slices are how a conversion uses every core.
    /// Leave one core for the HTTP server, tunnel and UI.
    static var parallelSegmentLimit: Int {
        if UserDefaults.standard.object(forKey: parallelDefaultsKey) as? Bool == false { return 1 }
        return min(4, max(1, ProcessInfo.processInfo.activeProcessorCount - 1))
    }

    @discardableResult
    static func convert(video: URL, audio: URL?, output: URL, duration: Double?,
                        quality: MediaQuality, progress: @escaping Progress,
                        runner: Runner? = nil) async throws -> Report {
        guard video.standardizedFileURL != output.standardizedFileURL,
              audio?.standardizedFileURL != output.standardizedFileURL else {
            throw Failure(code: -1, log: "The converted video must be saved separately from its source.")
        }
        var completed = false
        defer {
            // A failed or cancelled encode must not leave a partial stream that
            // another player or retry can mistake for a finished library file.
            if !completed { try? FileManager.default.removeItem(at: output) }
        }
        let execute = runner ?? run
        let started = ProcessInfo.processInfo.systemUptime
        var hardwareFailure: Failure?
        var failedHardwareSeconds: Double?
        var parallelFailure: Failure?
        // Fast path: whole-second slices encoded side by side. Needs a known
        // duration and the separate audio track YouTube downloads provide.
        // VideoToolbox first, then CPU decoding (iOS may withhold the hardware
        // decoder in the background); any other failure falls back to the
        // proven single-pass conversion below.
        if let audio, let duration {
            let plan = TranscodeArguments.segments(duration: duration, maximum: parallelSegmentLimit)
            if plan.count >= 2 {
                for hardware in [true, false] {
                    try Task.checkCancellation()
                    if FileManager.default.fileExists(atPath: output.path) {
                        try FileManager.default.removeItem(at: output)
                    }
                    do {
                        try await convertInSegments(video: video, audio: audio, output: output, duration: duration,
                            quality: quality, segments: plan, hardwareDecode: hardware, progress: progress, runner: execute)
                        try Task.checkCancellation()
                        guard fileSize(output) > 0 else {
                            throw Failure(code: joinStageCode, log: "The parallel converter did not produce a video.")
                        }
                        completed = true
                        return Report(hardwareDecode: hardware, seconds: ProcessInfo.processInfo.systemUptime - started,
                                      failedHardwareSeconds: failedHardwareSeconds, segments: plan.count)
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        try Task.checkCancellation()
                        let failure = error as? Failure ?? Failure(code: -1, log: error.localizedDescription)
                        let earlier = parallelFailure.map { $0.log + "\n\n" } ?? ""
                        parallelFailure = Failure(code: failure.code, log: earlier + failure.log)
                        failedHardwareSeconds = ProcessInfo.processInfo.systemUptime - started
                        // The slices encoded but could not be joined: a CPU
                        // decode would fail the same way, so go single pass.
                        if failure.code == joinStageCode { break }
                    }
                }
            }
        }
        for hardware in [true, false] {
            try Task.checkCancellation()
            let attemptStarted = ProcessInfo.processInfo.systemUptime
            if FileManager.default.fileExists(atPath: output.path) {
                try FileManager.default.removeItem(at: output)
            }
            progress(.init(stage: .processing, fraction: duration == nil ? nil : 0))
            let arguments = TranscodeArguments.make(video: video.path, audio: audio?.path,
                output: output.path, quality: quality, hardwareDecode: hardware)
            do {
                try await execute(arguments, duration, progress)
                try Task.checkCancellation()
                guard fileSize(output) > 0 else { throw Failure(code: -1, log: "The converter did not produce a video.") }
                completed = true
                return Report(hardwareDecode: hardware,
                              seconds: ProcessInfo.processInfo.systemUptime - attemptStarted,
                              failedHardwareSeconds: failedHardwareSeconds, segments: 1)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // A personal-signed app may not get a hardware decoder for a
                // codec, device state, or background execution. Retry from the
                // retained source with the same output format on the CPU.
                try Task.checkCancellation()
                let failure = error as? Failure ?? Failure(code: -1, log: error.localizedDescription)
                if hardware {
                    hardwareFailure = failure
                    failedHardwareSeconds = ProcessInfo.processInfo.systemUptime - started
                    continue
                }
                let parallelContext = parallelFailure.map { "Parallel attempt:\n\($0.log)\n\n" } ?? ""
                let context = parallelContext
                    + (hardwareFailure.map { "VideoToolbox attempt:\n\($0.log)\n\nSoftware attempt:\n" } ?? "")
                throw Failure(code: failure.code, log: context + failure.log)
            }
        }
        throw Failure(code: -1, log: "The converter did not run.")
    }

    /// Encodes `segments` concurrently, joins the MPEG-1 elementary streams and
    /// muxes them with one MP2 track into `output`. Internal so the macOS smoke
    /// check can exercise it on a short fixture.
    static func convertInSegments(video: URL, audio: URL, output: URL, duration: Double,
                                  quality: MediaQuality, segments: [TranscodeSegment], hardwareDecode: Bool,
                                  progress: @escaping Progress, runner: Runner? = nil) async throws {
        guard segments.count >= 2 else { throw Failure(code: -1, log: "A parallel conversion needs two or more segments.") }
        let execute = runner ?? run
        let work = FileManager.default.temporaryDirectory
            .appendingPathComponent("mk8-segments-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: work) }
        let audioOutput = work.appendingPathComponent("audio.mp2")
        let parts = segments.indices.map { work.appendingPathComponent("part-\($0).m1v") }
        let meter = SegmentMeter(duration: duration, count: segments.count, progress: progress)
        progress(.init(stage: .processing, fraction: 0))
        let audioArguments = TranscodeArguments.audioTrack(audio: audio.path, output: audioOutput.path, duration: duration)
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await execute(audioArguments, nil, { _ in }) }
            for index in segments.indices {
                let segment = segments[index]
                let length: Double
                if let frames = segment.frames { length = Double(frames) / Double(TranscodeArguments.outputFrameRate) }
                else { length = max(1, duration - Double(segment.start)) }
                let arguments = TranscodeArguments.videoSegment(video: video.path, output: parts[index].path,
                    quality: quality, hardwareDecode: hardwareDecode, segment: segment)
                group.addTask {
                    try await execute(arguments, length, { value in meter.update(index, fraction: value.fraction, length: length) })
                }
            }
            try await group.waitForAll()
        }
        try Task.checkCancellation()
        let joined = work.appendingPathComponent("video.m1v")
        try concatenate(parts, into: joined)
        try Task.checkCancellation()
        do {
            try await execute(TranscodeArguments.mux(video: joined.path, audio: audioOutput.path, output: output.path),
                              nil, { _ in })
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let failure = error as? Failure
            throw Failure(code: joinStageCode, log: "Joining the converted slices failed (exit \(failure?.code ?? -1)):\n"
                + (failure?.log ?? error.localizedDescription))
        }
    }

    private static func concatenate(_ parts: [URL], into destination: URL) throws {
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw Failure(code: -1, log: "Could not join the converted segments.")
        }
        let writer = try FileHandle(forWritingTo: destination)
        defer { try? writer.close() }
        for index in parts.indices {
            let reader = try FileHandle(forReadingFrom: parts[index])
            defer { try? reader.close() }
            var wrote = false
            while let bytes = try reader.read(upToCount: 1_048_576), !bytes.isEmpty {
                try Task.checkCancellation()
                try writer.write(contentsOf: bytes)
                wrote = true
            }
            guard wrote else { throw Failure(code: -1, log: "Converted segment \(index + 1) is empty.") }
        }
    }

    private static func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
    }

    /// Sums every slice's encoded media time into one progress/speed reading.
    private final class SegmentMeter: @unchecked Sendable {
        private let lock = NSLock()
        private var meter: ProcessingMeter
        private var times: [Double]
        private var lastEmitted: TimeInterval = 0
        private let progress: Progress
        init(duration: Double, count: Int, progress: @escaping Progress) {
            meter = ProcessingMeter(startedAt: ProcessInfo.processInfo.systemUptime, duration: duration)
            times = Array(repeating: 0, count: count)
            self.progress = progress
        }
        func update(_ index: Int, fraction: Double?, length: Double) {
            let now = ProcessInfo.processInfo.systemUptime
            lock.lock()
            guard index >= 0, index < times.count else { lock.unlock(); return }
            times[index] = max(times[index], (fraction ?? 0) * length)
            guard now - lastEmitted >= 0.25 else { lock.unlock(); return }
            lastEmitted = now
            let sample = meter.sample(mediaTime: times.reduce(0, +), at: now)
            lock.unlock()
            progress(.init(stage: .processing, fraction: sample.fraction,
                           processingSpeed: sample.speed, processingSecondsRemaining: sample.secondsRemaining))
        }
    }

    private static func run(_ arguments: [String], duration: Double?, progress: @escaping Progress) async throws {
        let cancellation = Cancellation()
        let meter = StatisticsMeter(duration: duration)
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let session = FFmpegKit.execute(withArgumentsAsync: arguments, withCompleteCallback: { session in
                    if ReturnCode.isCancel(session?.getReturnCode()) {
                        continuation.resume(throwing: CancellationError())
                    } else if ReturnCode.isSuccess(session?.getReturnCode()) {
                        continuation.resume()
                    } else {
                        continuation.resume(throwing: Failure(
                            code: session?.getReturnCode()?.getValue() ?? -1,
                            log: session?.getAllLogsAsString() ?? session?.getFailStackTrace() ?? "No converter output."))
                    }
                }, withLogCallback: nil, withStatisticsCallback: { statistics in
                    guard let statistics else { return }
                    let sample = meter.sample(mediaTime: Double(statistics.getTime()) / 1000)
                    progress(.init(stage: .processing, fraction: sample.fraction,
                                   processingSpeed: sample.speed, processingSecondsRemaining: sample.secondsRemaining))
                })
                guard let session else {
                    continuation.resume(throwing: Failure(code: -1, log: "The native converter could not start."))
                    return
                }
                cancellation.attach(session)
            }
        }, onCancel: { cancellation.cancel() })
        try Task.checkCancellation()
    }

    private final class StatisticsMeter: @unchecked Sendable {
        private let lock = NSLock()
        private var meter: ProcessingMeter
        init(duration: Double?) {
            meter = ProcessingMeter(startedAt: ProcessInfo.processInfo.systemUptime, duration: duration)
        }
        func sample(mediaTime: Double) -> ProcessingSample {
            lock.lock(); defer { lock.unlock() }
            return meter.sample(mediaTime: mediaTime, at: ProcessInfo.processInfo.systemUptime)
        }
    }

    private final class Cancellation: @unchecked Sendable {
        private let lock = NSLock()
        private var session: FFmpegSession?
        private var cancelled = false
        func attach(_ session: FFmpegSession) {
            lock.lock(); self.session = session; let cancel = cancelled; lock.unlock()
            if cancel { session.cancel() }
        }
        func cancel() {
            lock.lock(); cancelled = true; let session = session; lock.unlock(); session?.cancel()
        }
    }
}
