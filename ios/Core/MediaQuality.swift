import Foundation

public enum MediaQuality: Int, Codable, CaseIterable, Sendable, Identifiable {
    case fast = 360, balanced = 480, high = 720
    public var id: Int { rawValue }
    public var title: String {
        switch self {
        case .fast: return "Fast · 360p"
        case .balanced: return "Balanced · 480p"
        case .high: return "Sharper · 720p"
        }
    }
    public var width: Int { self == .fast ? 640 : (self == .balanced ? 854 : 1280) }
    public var bitrate: String { self == .fast ? "800k" : (self == .balanced ? "1100k" : "1500k") }
}

/// Small, bounded requests avoid the single long transfer used for large media.
public struct MediaByteRange: Sendable, Equatable {
    public let start: Int64
    public let end: Int64
    public init(start: Int64, end: Int64) { self.start = start; self.end = end }
    public var count: Int64 { end - start + 1 }
    public var header: String { "bytes=\(start)-\(end)" }
    public static func make(length: Int64, chunkSize: Int64 = 2 * 1_024 * 1_024) -> [Self] {
        guard length > 0, length <= 50_000_000_000, chunkSize > 0, chunkSize <= 50_000_000_000 else { return [] }
        return stride(from: Int64(0), to: length, by: Int(chunkSize)).map {
            Self(start: $0, end: min(length - 1, $0 + chunkSize - 1))
        }
    }
    public func matches(contentRange: String?, fileSize: Int64, total: Int64) -> Bool {
        guard let response = Self.parse(contentRange: contentRange) else { return false }
        return response.range == self && response.total == total && fileSize == count
    }
    public static func parse(contentRange: String?) -> (range: Self, total: Int64)? {
        guard let value = contentRange?.trimmingCharacters(in: .whitespaces), value.hasPrefix("bytes ") else { return nil }
        let fields = value.dropFirst(6).split(separator: "/", omittingEmptySubsequences: false)
        guard fields.count == 2, let total = Int64(fields[1]), total > 0, total <= 50_000_000_000 else { return nil }
        let bounds = fields[0].split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2, let start = Int64(bounds[0]), let end = Int64(bounds[1]),
              start >= 0, end >= start, end < total else { return nil }
        return (.init(start: start, end: end), total)
    }
}
