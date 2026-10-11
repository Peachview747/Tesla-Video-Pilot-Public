import Foundation

// The native transports read one bounded chunk at a time. File length is fixed
// when response headers are prepared; a later truncation must fail, not silently
// finish an advertised response early.
public final class RelayBody {
    public enum Failure: Error { case closed, incompleteFile, invalidLength }

    public let length: Int
    public let isFile: Bool
    private var file: FileHandle?
    private var data: Data
    private var offset = 0
    private var closed = false

    public var finished: Bool { offset >= length }

    public init(data: Data) {
        self.data = data
        length = data.count
        isFile = false
    }

    public convenience init(file url: URL) throws {
        try self.init(file: url, range: nil)
    }

    public init(file url: URL, range: Range<Int64>?) throws {
        let opened = try FileHandle(forReadingFrom: url)
        do {
            let size = try opened.seekToEnd()
            guard size <= UInt64(Int.max) else { throw Failure.invalidLength }
            let start = range?.lowerBound ?? 0
            let end = range?.upperBound ?? Int64(size)
            guard start >= 0, end >= start, end <= Int64(size) else { throw Failure.invalidLength }
            try opened.seek(toOffset: UInt64(start))
            file = opened
            length = Int(end - start)
            data = Data()
            isFile = true
        } catch {
            try? opened.close()
            throw error
        }
    }

    public func nextChunk() throws -> Data {
        guard !closed else { throw Failure.closed }
        let count = min(isFile ? RelayProtocol.fileChunk : RelayProtocol.maximumChunk, length - offset)
        guard count > 0 else { return Data() }
        let chunk: Data
        if let file {
            var received = Data()
            received.reserveCapacity(count)
            while received.count < count {
                guard let bytes = try file.read(upToCount: count - received.count), !bytes.isEmpty else {
                    throw Failure.incompleteFile
                }
                received.append(bytes)
            }
            chunk = received
        } else { chunk = data.subdata(in: offset..<(offset + count)) }
        offset += chunk.count
        return chunk
    }

    public func close() {
        guard !closed else { return }
        closed = true
        try? file?.close()
        file = nil
        data = Data()
    }

    deinit { try? file?.close() }
}

// A new Worker pull may arrive before URLSession finishes the preceding async
// send. Keep the granted credits behind the serial drain instead of treating
// that legitimate ordering as a protocol error. A legacy Worker grants one
// credit per pull (limit 1); a windowed Worker grants several at once so the
// phone can keep frames in flight across the Cloudflare round trip.
public struct RelayCredits {
    public enum Failure: Error { case closed, duplicate }
    public private(set) var draining = false
    public private(set) var available = 0
    private var closed = false

    public var pending: Bool { available > 0 }

    public init() {}

    // True means the caller must start the sole drain task.
    public mutating func grant(_ count: Int = 1, limit: Int = 1) throws -> Bool {
        guard !closed else { throw Failure.closed }
        guard count > 0, limit > 0, count <= limit - available else { throw Failure.duplicate }
        available += count
        if draining { return false }
        draining = true
        return true
    }

    public mutating func consume() -> Bool {
        guard !closed, available > 0 else { draining = false; return false }
        available -= 1
        return true
    }

    public mutating func close() {
        closed = true
        available = 0
        draining = false
    }
}
