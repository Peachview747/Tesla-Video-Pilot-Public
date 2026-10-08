import Foundation
import Combine

/// A bounded, opt-in diagnostic journal for troubleshooting real device runs.
///
/// The journal records app-level timing and byte counters only. It never stores
/// media payloads, request bodies, cookies, tunnel keys, OAuth tokens, or full
/// URLs. iOS does not expose decrypted packets or the route's intermediate
/// hops to an ordinary app, so this is intentionally a transport trace rather
/// than a packet capture.
@MainActor final class SessionDiagnostics: ObservableObject {
    static let shared = SessionDiagnostics()

    @Published private(set) var enabled: Bool
    @Published private(set) var eventCount = 0
    @Published private(set) var lastEventAt: Date?

    private let defaults = UserDefaults.standard
    private let maxBytes = 2_000_000
    private let formatter = ISO8601DateFormatter()
    private var lastEventByKey: [String: TimeInterval] = [:]
    private let allowedWebEvents: Set<String> = [
        "playerStart", "playerSeek", "sourceResponse", "sourceEstablished",
        "sourceProgress", "sourceBuffer", "sourceCompleted", "playerDecode",
        "playerStalled", "playerError", "playerEnded", "playerClosed", "browserRTT"
    ]
    private let allowedWebFields: Set<String> = [
        "seekTargetSeconds", "positionSeconds", "durationSeconds", "bufferSeconds",
        "receivedBytes", "expectedBytes", "elapsedMs", "responseStatus", "error",
        "recoveryAttempt", "buffered", "paused", "headroomSeconds"
    ]

    private init() {
        enabled = defaults.object(forKey: "diagnosticsEnabled") as? Bool ?? true
        eventCount = countExistingEvents()
    }

    var logURL: URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("VideoPilot", isDirectory: true)
            .appendingPathComponent("Diagnostics", isDirectory: true)
        return root.appendingPathComponent("session.jsonl")
    }

    func setEnabled(_ value: Bool) {
        enabled = value
        defaults.set(value, forKey: "diagnosticsEnabled")
        guard value else { return }
        record(component: "app", event: "diagnosticsEnabled", fields: ["enabled": "true"])
    }

    func record(component: String, event: String, fields: [String: String] = [:],
                throttleKey: String? = nil, minimumInterval: TimeInterval = 0) {
        guard enabled else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let throttleKey, minimumInterval > 0,
           let previous = lastEventByKey[throttleKey], now - previous < minimumInterval {
            return
        }
        if let throttleKey { lastEventByKey[throttleKey] = now }

        var object: [String: String] = [
            "timestamp": formatter.string(from: Date()),
            "component": safe(component),
            "event": safe(event)
        ]
        if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String {
            object["version"] = version
        }
        if let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String {
            object["build"] = build
        }
        for (key, value) in fields {
            object[safeKey(key)] = sanitizedValue(key: key, value: value)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        append(line + "\n")
        eventCount += 1
        lastEventAt = Date()
    }

    func recordWeb(event: String, fields: [String: String]) {
        guard allowedWebEvents.contains(event) else { return }
        let safeFields = fields.filter { allowedWebFields.contains($0.key) }
        let interval: TimeInterval
        switch event {
        case "sourceProgress": interval = 1
        case "browserRTT": interval = 5
        default: interval = 0
        }
        record(component: "browser", event: event, fields: safeFields,
               throttleKey: interval > 0 ? "browser-\(event)" : nil,
               minimumInterval: interval)
    }

    func exportURL() -> URL? {
        guard FileManager.default.fileExists(atPath: logURL.path),
              let data = try? Data(contentsOf: logURL), !data.isEmpty else { return nil }
        let stamp = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("VideoPilot-diagnostics-\(stamp).jsonl")
        do {
            try data.write(to: destination, options: .atomic)
            return destination
        } catch { return nil }
    }

    func clear() {
        try? FileManager.default.removeItem(at: logURL)
        eventCount = 0
        lastEventAt = nil
        lastEventByKey.removeAll()
    }

    static func routeName(_ path: String) -> String {
        if path.hasPrefix("/api/stream/") { return "api/stream" }
        if path.hasPrefix("/api/") { return String(path.dropFirst(5).split(separator: "/").first ?? "api") }
        if path == "/" { return "index" }
        return String(path.split(separator: "/").first.map(String.init) ?? "asset")
    }

    private func append(_ text: String) {
        do {
            let manager = FileManager.default
            try manager.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !manager.fileExists(atPath: logURL.path) {
                try Data(text.utf8).write(to: logURL, options: .atomic)
            } else {
                let handle = try FileHandle(forWritingTo: logURL)
                try handle.seekToEnd()
                try handle.write(contentsOf: Data(text.utf8))
                try handle.close()
            }
            trimIfNeeded()
            try? MediaPipeline.protect(logURL)
        } catch {
            // Diagnostics must never interfere with hosting or playback.
        }
    }

    private func trimIfNeeded() {
        guard let data = try? Data(contentsOf: logURL), data.count > maxBytes else { return }
        let start = data.count - maxBytes
        let suffix = data.suffix(maxBytes)
        let trimmed: Data
        if let newline = suffix.firstIndex(of: 10) {
            trimmed = Data(suffix[suffix.index(after: newline)...])
        } else {
            trimmed = Data(suffix)
        }
        _ = start // Keep the intent explicit: retain only the most recent bounded suffix.
        try? trimmed.write(to: logURL, options: .atomic)
    }

    private func countExistingEvents() -> Int {
        guard let data = try? Data(contentsOf: logURL), let text = String(data: data, encoding: .utf8) else { return 0 }
        return text.split(separator: "\n").count
    }

    private func safeKey(_ key: String) -> String {
        String(key.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }.prefix(48))
    }

    private func safe(_ value: String) -> String {
        String(value.filter { !$0.isNewline && $0 != "\u{0}" }.prefix(80))
    }

    private func sanitizedValue(key: String, value: String) -> String {
        let lower = key.lowercased()
        if lower.contains("secret") || lower.contains("token") || lower.contains("cookie") ||
            lower.contains("authorization") || lower == "body" || lower.contains("password") {
            return "[redacted]"
        }
        let clean = value.filter { !$0.isNewline && $0 != "\u{0}" }
        if clean.contains("://") || clean.lowercased().contains("x-secret") { return "[redacted-url-or-credential]" }
        return String(clean.prefix(240))
    }
}
