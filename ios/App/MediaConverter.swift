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
        /// Time lost to a failed VideoToolbox attempt before the CPU retry.
        let failedHardwareSeconds: Double?
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
        var hardwareFailure: Failure?
        var failedHardwareSeconds: Double?
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
                let size = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.int64Value ?? 0
                guard size > 0 else { throw Failure(code: -1, log: "The converter did not produce a video.") }
                completed = true
                return Report(hardwareDecode: hardware,
                              seconds: ProcessInfo.processInfo.systemUptime - attemptStarted,
                              failedHardwareSeconds: failedHardwareSeconds)
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
                    failedHardwareSeconds = ProcessInfo.processInfo.systemUptime - attemptStarted
                    continue
                }
                let context = hardwareFailure.map { "VideoToolbox attempt:\n\($0.log)\n\nSoftware attempt:\n" } ?? ""
                throw Failure(code: failure.code, log: context + failure.log)
            }
        }
        throw Failure(code: -1, log: "The converter did not run.")
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
