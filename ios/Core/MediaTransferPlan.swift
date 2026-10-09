import Foundation

/// Records the verified entity size and a possible single-transfer background handoff.
public struct MediaTransferPlan: Codable, Sendable {
    public let url: URL
    public let length: Int64
    public let chunkSize: Int64
    /// Missing in saved plans from earlier builds, which used HTTP Range headers.
    public let transport: MediaRangeTransport?
    public var remainderStart: Int64?
    public init(url: URL, length: Int64, chunkSize: Int64 = 4 * 1_024 * 1_024, remainderStart: Int64? = nil,
                transport: MediaRangeTransport? = nil) {
        self.url = url; self.length = length; self.chunkSize = chunkSize; self.remainderStart = remainderStart
        self.transport = transport
    }
    public var rangeTransport: MediaRangeTransport { transport ?? .header }
    public var valid: Bool {
        url.scheme == "https" && length > 0 && length <= 50_000_000_000 && chunkSize > 0 && chunkSize <= 16 * 1_024 * 1_024
            && (length - 1) / chunkSize + 1 <= 65_536
            && (remainderStart == nil || (remainderStart! >= 0 && remainderStart! < length && remainderStart! % chunkSize == 0))
    }
    public var ranges: [MediaByteRange] { valid ? MediaByteRange.make(length: length, chunkSize: chunkSize) : [] }
    public func completedPrefix(sizes: [Int64: Int64]) -> Int64 {
        var prefix: Int64 = 0
        for range in ranges {
            guard sizes[range.start] == range.count else { break }
            prefix = range.end + 1
        }
        return prefix
    }
}
