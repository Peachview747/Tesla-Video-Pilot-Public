import Foundation

public struct ProcessingSample: Sendable, Equatable {
    public let fraction: Double?
    /// Media seconds prepared per elapsed second (1 means real time).
    public let speed: Double?
    public let secondsRemaining: Double?
}

/// Measures conversion separately from the preceding download. Call with a
/// monotonic clock, such as ProcessInfo.processInfo.systemUptime.
public struct ProcessingMeter {
    private struct Point {
        let timestamp: TimeInterval
        let mediaTime: Double
    }

    private let duration: Double?
    private var points: [Point]
    private var latestMediaTime: Double = 0
    private let window: TimeInterval = 5
    private let warmup: TimeInterval = 2

    public init(startedAt: TimeInterval, duration: Double?) {
        self.duration = duration.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        points = startedAt.isFinite ? [Point(timestamp: startedAt, mediaTime: 0)] : []
    }

    public mutating func sample(mediaTime: Double, at timestamp: TimeInterval) -> ProcessingSample {
        let previousFraction = MediaPreparationProgress.ratio(completed: latestMediaTime, total: duration)
        guard timestamp.isFinite, mediaTime.isFinite, mediaTime >= 0,
              mediaTime >= latestMediaTime,
              points.last.map({ timestamp > $0.timestamp }) ?? true else {
            return ProcessingSample(fraction: previousFraction, speed: nil, secondsRemaining: nil)
        }

        latestMediaTime = mediaTime
        points.append(Point(timestamp: timestamp, mediaTime: mediaTime))
        // Keep the sample immediately before the window as its baseline. A
        // repeated media timestamp contributes elapsed time, so stalls reduce
        // the estimate and eventually clear it rather than displaying a stale rate.
        while points.count > 2 && points[1].timestamp <= timestamp - window {
            points.removeFirst()
        }
        let fraction = MediaPreparationProgress.ratio(completed: mediaTime, total: duration)
        guard mediaTime > 0, let first = points.first,
              timestamp - first.timestamp >= warmup else {
            return ProcessingSample(fraction: fraction, speed: nil, secondsRemaining: nil)
        }
        let speed = (mediaTime - first.mediaTime) / (timestamp - first.timestamp)
        guard speed.isFinite, speed > 0 else {
            return ProcessingSample(fraction: fraction, speed: nil, secondsRemaining: nil)
        }
        let remaining = duration.map { max(0, $0 - mediaTime) / speed }
        return ProcessingSample(fraction: fraction, speed: speed,
                                secondsRemaining: remaining.flatMap { $0.isFinite ? $0 : nil })
    }
}
