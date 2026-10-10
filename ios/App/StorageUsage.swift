import Foundation

/// Disk usage for the Settings and Library screens. Measured off the main
/// thread; paths mirror Library (Application Support/MK8), MediaPipeline's
/// preparation store (MK8/.preparation) and SessionDiagnostics.
struct VPStorageReport: Sendable {
    /// Prepared videos, seek indexes and library.json.
    var library: Int64 = 0
    var videoSizes: [UUID: Int64] = [:]
    /// Saved partial downloads and conversion work for unfinished videos.
    var work: Int64 = 0
    /// Temporary files and cached Picture in Picture test movies.
    var temporary: Int64 = 0
    var diagnostics: Int64 = 0
    var available: Int64?
    var total: Int64?
}

enum VPStorage {
    static func measure() async -> VPStorageReport {
        await Task.detached(priority: .utility) { VPStorage.compute() }.value
    }

    /// Deletes temporary files and cached PiP test movies. Returns bytes freed.
    /// Callers must only run this while no video is being prepared, because
    /// the converter writes its intermediate files to the temporary folder.
    static func clearTemporary() async -> Int64 {
        await Task.detached(priority: .utility) { VPStorage.removeTemporary() }.value
    }

    private static var supportDirectory: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    }

    private static var temporaryRoots: [URL] {
        var roots = [FileManager.default.temporaryDirectory]
        if let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            roots.append(caches.appendingPathComponent("PiPPlayback", isDirectory: true))
        }
        return roots
    }

    private static func compute() -> VPStorageReport {
        var report = VPStorageReport()
        let manager = FileManager.default
        if let support = supportDirectory {
            let libraryDirectory = support.appendingPathComponent("MK8", isDirectory: true)
            // Shallow and skipping hidden items: ".preparation" is counted as work.
            let items = (try? manager.contentsOfDirectory(at: libraryDirectory,
                includingPropertiesForKeys: [.isDirectoryKey, .totalFileAllocatedSizeKey, .fileSizeKey],
                options: [.skipsHiddenFiles])) ?? []
            for item in items {
                let size = size(of: item)
                report.library += size
                if item.pathExtension == "ts", let id = UUID(uuidString: item.deletingPathExtension().lastPathComponent) {
                    report.videoSizes[id] = size
                }
            }
            report.work = size(of: libraryDirectory.appendingPathComponent(".preparation", isDirectory: true))
            report.diagnostics = size(of: support.appendingPathComponent("VideoPilot", isDirectory: true)
                .appendingPathComponent("Diagnostics", isDirectory: true))
        }
        for root in temporaryRoots { report.temporary += size(of: root) }
        let home = URL(fileURLWithPath: NSHomeDirectory())
        if let values = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey]) {
            report.available = values.volumeAvailableCapacityForImportantUsage
            report.total = values.volumeTotalCapacity.map { Int64($0) }
        }
        return report
    }

    private static func removeTemporary() -> Int64 {
        let manager = FileManager.default
        var freed: Int64 = 0
        for root in temporaryRoots {
            let items = (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [])) ?? []
            for item in items {
                let size = size(of: item)
                do {
                    try manager.removeItem(at: item)
                    freed += size
                } catch {
                    // Files in use stay; nothing else to do.
                }
            }
        }
        URLCache.shared.removeAllCachedResponses()
        return freed
    }

    private static func size(of url: URL) -> Int64 {
        let keys: [URLResourceKey] = [.isDirectoryKey, .totalFileAllocatedSizeKey, .fileSizeKey]
        guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return 0 }
        guard values.isDirectory == true else {
            return Int64(values.totalFileAllocatedSize ?? values.fileSize ?? 0)
        }
        guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys,
                                                              options: [], errorHandler: nil) else { return 0 }
        var total: Int64 = 0
        while let file = enumerator.nextObject() as? URL {
            guard let item = try? file.resourceValues(forKeys: Set(keys)), item.isDirectory != true else { continue }
            total += Int64(item.totalFileAllocatedSize ?? item.fileSize ?? 0)
        }
        return total
    }
}
