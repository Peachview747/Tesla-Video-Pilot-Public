import Foundation

public struct TransferSample: Identifiable, Sendable {
    public var id: TimeInterval { timestamp }
    public let timestamp: TimeInterval
    public let receivedBytesPerSecond: Double
    public let sentBytesPerSecond: Double
    public let totalReceivedBytes: Int64
    public let totalSentBytes: Int64
    public var downloadMbps: Double { receivedBytesPerSecond * 8 / 1_000_000 }
    public var uploadMbps: Double { sentBytesPerSecond * 8 / 1_000_000 }
}

public struct TransferMeter {
    private var previousTime: TimeInterval
    private var previousReceived: Int64 = 0
    private var previousSent: Int64 = 0
    private var received: Int64 = 0
    private var sent: Int64 = 0

    public init(startedAt: TimeInterval) { previousTime = startedAt }

    public mutating func record(received: Int64 = 0, sent: Int64 = 0) {
        self.received += max(0, received)
        self.sent += max(0, sent)
    }

    public mutating func sample(at time: TimeInterval) -> TransferSample {
        let elapsed = time - previousTime
        let down = elapsed > 0 ? Double(received - previousReceived) / elapsed : 0
        let up = elapsed > 0 ? Double(sent - previousSent) / elapsed : 0
        if elapsed > 0 {
            previousTime = time
            previousReceived = received
            previousSent = sent
        }
        return TransferSample(timestamp: time, receivedBytesPerSecond: down,
                              sentBytesPerSecond: up, totalReceivedBytes: received,
                              totalSentBytes: sent)
    }
}

public enum MediaTransferMode: String, Sendable { case parallel, background, standard }

public struct MediaPreparationProgress: Sendable, Equatable {
    public enum Stage: String, Sendable {
        case resolving, importing, downloading, waitingForApp, processing, finalizing
    }
    public let stage: Stage
    public let completedBytes: Int64
    public let totalBytes: Int64?
    public let fraction: Double?
    public let bytesPerSecond: Double
    public let transferMode: MediaTransferMode?
    public let processingSpeed: Double?
    public let processingSecondsRemaining: Double?
    public var secondsRemaining: Double? {
        if stage == .processing { return processingSecondsRemaining }
        guard stage == .downloading, let totalBytes, bytesPerSecond > 0 else { return nil }
        return Double(max(0, totalBytes - completedBytes)) / bytesPerSecond
    }

    public init(stage: Stage, completedBytes: Int64 = 0, totalBytes: Int64? = nil,
                fraction: Double? = nil, bytesPerSecond: Double = 0, transferMode: MediaTransferMode? = nil,
                processingSpeed: Double? = nil, processingSecondsRemaining: Double? = nil) {
        self.stage = stage
        self.transferMode = transferMode
        self.processingSpeed = stage == .processing
            ? processingSpeed.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } : nil
        self.processingSecondsRemaining = self.processingSpeed != nil
            ? processingSecondsRemaining.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil } : nil
        self.completedBytes = max(0, completedBytes)
        self.bytesPerSecond = bytesPerSecond.isFinite ? max(0, bytesPerSecond) : 0
        self.totalBytes = totalBytes.flatMap { $0 > 0 ? $0 : nil }
        if stage == .downloading {
            self.fraction = Self.ratio(completed: Double(self.completedBytes),
                                       total: self.totalBytes.map(Double.init))
        } else {
            self.fraction = fraction.flatMap { $0.isFinite ? min(1, max(0, $0)) : nil }
        }
    }

    public static func ratio(completed: Double, total: Double?) -> Double? {
        guard completed.isFinite, let total, total.isFinite, total > 0 else { return nil }
        return min(1, max(0, completed / total))
    }
}
