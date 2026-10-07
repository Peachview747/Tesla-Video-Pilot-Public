import Foundation
import MK8Core

/// Local transfer details deliberately omit URLs, query values, cookies and IPs.
enum DownloadDiagnostics {
    private static let writer = Writer()

    static func file(for id: UUID) -> URL {
        MediaPipeline.store.directory(for: id).appendingPathComponent("download-details.txt")
    }

    static func record(_ descriptor: MediaDownloadDescriptor, report: [String: String]) {
        writer.record(descriptor, report: report)
    }

    private final class Writer: @unchecked Sendable {
        private let lock = NSLock()
        private let allowed = Set(["event", "host", "protocol", "method", "transport", "status",
                                   "receivedBytes", "durationSeconds", "ttfbSeconds", "cellular",
                                   "rangeBytes"])

        func record(_ descriptor: MediaDownloadDescriptor, report: [String: String]) {
            lock.lock(); defer { lock.unlock() }
            // Late callbacks must not recreate a removed preparation job.
            guard (try? MediaPipeline.store.load(descriptor.jobID)) != nil else { return }
            let values = report.filter { allowed.contains($0.key) }.sorted { $0.key < $1.key }
            let fields = values.map { key, value in
                let clean = value.replacingOccurrences(of: "\n", with: " ")
                    .replacingOccurrences(of: "\r", with: " ")
                return key + "=" + String(clean.prefix(180))
            }.joined(separator: " · ")
            let line = ISO8601DateFormatter().string(from: Date()) + " · " + descriptor.track.rawValue
                + " · " + fields + "\n"
            let destination = DownloadDiagnostics.file(for: descriptor.jobID)
            let previous = (try? String(contentsOf: destination, encoding: .utf8)) ?? ""
            let header = "Video Pilot download details\nObserved media-server transfers; separate from a network speed test.\n"
            let text = header + String((previous.replacingOccurrences(of: header, with: "") + line).suffix(32_000))
            do {
                try text.write(to: destination, atomically: true, encoding: .utf8)
                try MediaPipeline.protect(destination)
            } catch { /* Diagnostics never fail a media download. */ }
        }
    }
}
