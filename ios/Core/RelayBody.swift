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
// send. Keep exactly one pending credit behind the serial drain instead of
// treating that legitimate ordering as a protocol error.
public struct RelayCredits {
    public enum Failure: Error { case closed, duplicate }
    public private(set) var draining = false
    public private(set) var pending = false
    private var closed = false

    public init() {}

    // True means the caller must start the sole drain task.
    public mutating func grant() throws -> Bool {
        guard !closed else { throw Failure.closed }
        guard !pending else { throw Failure.duplicate }
        pending = true
        if draining { return false }
        draining = true
        return true
    }

    public mutating func consume() -> Bool {
        guard !closed, pending else { draining = false; return false }
        pending = false
        return true
    }

    public mutating func close() {
        closed = true
        pending = false
        draining = false
    }
}

