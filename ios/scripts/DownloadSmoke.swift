import Foundation
import Security
import MK8Core

// Supply the UIKit-independent dependencies while compiling the production
// MediaDownloader unchanged for the native macOS integration check.
enum MediaError: LocalizedError {
    case badDownload, downloadFailed(String)
    var errorDescription: String? {
        switch self {
        case .badDownload: return "Invalid media response"
        case .downloadFailed(let text): return text
        }
    }
}
enum MediaPipeline {
    static let store = MediaPreparationStore(root: FileManager.default.temporaryDirectory
        .appendingPathComponent("MK8 download smoke " + UUID().uuidString))
    static func protect(_ file: URL) throws {}
}
enum DownloadDiagnostics {
    static func record(_ descriptor: MediaDownloadDescriptor, report: [String: String]) {}
}
@MainActor final class AppActivity {
    static let shared = AppActivity()
    var chunkSchedulingAllowed = true
}
private final class ModeCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [MediaTransferMode] = []
    private var bytes: Int64 = 0
    func add(_ value: MediaTransferMode) { lock.lock(); recorded.append(value); lock.unlock() }
    var values: [MediaTransferMode] { lock.lock(); defer { lock.unlock() }; return recorded }
    func addTraffic(_ count: Int64) { lock.lock(); bytes += count; lock.unlock() }
    var traffic: Int64 { lock.lock(); defer { lock.unlock() }; return bytes }
}
private final class DiagnosticsCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var reports: [[String: String]] = []
    func add(_ report: [String: String]) { lock.lock(); reports.append(report); lock.unlock() }
    var values: [[String: String]] { lock.lock(); defer { lock.unlock() }; return reports }
}
private final class FixtureTrust: NSObject, URLSessionDelegate, @unchecked Sendable {
    let certificate: Data
    let port: Int?
    init(certificate: Data, port: Int?) { self.certificate = certificate; self.port = port }
    func credential(_ challenge: URLAuthenticationChallenge) -> URLCredential? {
        guard challenge.protectionSpace.host == "127.0.0.1", challenge.protectionSpace.port == port,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              SecCertificateCopyData(leaf) as Data == certificate else { return nil }
        return URLCredential(trust: trust)
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let credential = credential(challenge) { completionHandler(.useCredential, credential) }
        else { completionHandler(.performDefaultHandling, nil) }
    }
}
@main enum DownloadSmoke {
    static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "MK8DownloadCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func main() async throws {
        let base = URL(string: CommandLine.arguments[1])!
        let length = 16 * 1_024 * 1_024 + 17
        let expected = Data((0..<length).map { UInt8($0 % 251) })
        let pinnedCertificate = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let trust = FixtureTrust(certificate: pinnedCertificate, port: base.port)
        let diagnostics = DiagnosticsCapture()
        let downloader = MediaDownloader(backgroundConfiguration: .ephemeral, authentication: { trust.credential($0) },
            queryRequest: { url, range in
                guard url.lastPathComponent.hasPrefix("query"),
                      var eligible = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
                // Build a real Googlevideo query request using the production Core
                // helper, then send that exact query/header to the pinned fixture.
                eligible.host = "fixture.googlevideo.com"; eligible.port = nil; eligible.path = "/videoplayback"
                guard let mediaURL = eligible.url,
                      var request = MediaRangeRequest.request(url: mediaURL, range: range, transport: .googleQuery),
                      var endpoint = URLComponents(url: request.url!, resolvingAgainstBaseURL: false) else { return nil }
                endpoint.host = url.host; endpoint.port = url.port; endpoint.path = url.path
                request.url = endpoint.url
                return request
            }, diagnostics: { _, report in diagnostics.add(report) })
        defer { try? FileManager.default.removeItem(at: MediaPipeline.store.root) }
        let routes = ["normal", "compat", "ignored", "bad-range", "truncated", "handoff", "handoff-zero",
                      "query", "query-compat", "query-ignored", "query-bad-range", "query-truncated",
                      "query-handoff", "query-handoff-zero", "query-resume", "legacy-resume",
                      "query-no-cr", "query-wrong-offset", "query-no-cr-truncated",
                      "query-no-cr-handoff", "query-no-cr-handoff-zero", "existing-range"]
        for route in routes {
            await MainActor.run { AppActivity.shared.chunkSchedulingAllowed = true }
            let id = UUID()
            var endpoint = URLComponents(url: base.appendingPathComponent(route), resolvingAgainstBaseURL: false)!
            endpoint.percentEncodedQuery = "token=PRIVATE%2BVALUE%2FTOKEN%3D"
            if route == "existing-range" { endpoint.percentEncodedQuery! += "&range=0-0" }
            let url = endpoint.url!
            try MediaPipeline.store.save(.init(id: id, title: route, videoURL: url))
            let descriptor = MediaDownloadDescriptor(jobID: id, track: .video)
            let mode = ModeCapture()
            let handoff = route.hasSuffix("handoff") || route.hasSuffix("handoff-zero")
            let zeroPrefix = route.hasSuffix("handoff-zero")
            if route.hasSuffix("resume") {
                let planFile = MediaPipeline.store.directory(for: id).appendingPathComponent("video.transfer.json")
                let plan = MediaTransferPlan(url: url, length: Int64(length),
                                             transport: route == "query-resume" ? .googleQuery : nil)
                try JSONEncoder().encode(plan).write(to: planFile)
                if route == "legacy-resume" {
                    let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: planFile)) as! [String: Any]
                    try expect(saved["transport"] == nil, "Legacy plan fixture unexpectedly contains a transport")
                }
                let first = MediaByteRange(start: 0, end: plan.chunkSize - 1)
                let cached = try MediaPipeline.store.file(for: .init(jobID: id, track: .video, range: first,
                                                                     totalLength: Int64(length)))
                try expected.prefix(Int(plan.chunkSize)).write(to: cached)
            }
            let transfer = Task {
                try await downloader.downloadTrack(url, descriptor: descriptor, background: handoff,
                    progress: { _, _ in }, traffic: { mode.addTraffic($0) }, mode: { mode.add($0) })
            }
            if handoff && !zeroPrefix {
                let first = try MediaPipeline.store.file(for: .init(jobID: id, track: .video,
                    range: .init(start: 0, end: 4 * 1_024 * 1_024 - 1), totalLength: Int64(length)))
                var found = false
                for _ in 0..<150 {
                    if FileManager.default.fileExists(atPath: first.path) { found = true; break }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                try expect(found, "First chunk never completed")
                await MainActor.run { AppActivity.shared.chunkSchedulingAllowed = false }
            }
            if zeroPrefix {
                for _ in 0..<100 {
                    if mode.values.contains(.parallel) { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                await MainActor.run { AppActivity.shared.chunkSchedulingAllowed = false }
            }
            let failureExpected = route.hasSuffix("bad-range") || route.hasSuffix("truncated") || route == "existing-range"
            do {
                let file = try await transfer.value
                try expect(!failureExpected, "Accepted malformed or truncated range output")
                try expect(try Data(contentsOf: file) == expected, "Assembled media bytes differ from source")
                if route == "normal" || route == "compat" || route == "query" || route == "query-compat" {
                    try expect(mode.values.contains(.parallel), "Verified range download missed the fast path")
                    try expect(mode.traffic == Int64(length) + (route.hasPrefix("query") ? 2 : 1),
                               "Coalesced traffic counters lost or duplicated bytes")
                }
                if route == "query-no-cr" {
                    try expect(mode.values.contains(.parallel), "Validated 200 query response missed parallel transfer")
                    try expect(mode.traffic == Int64(length) + 2 + 2 * 16_384,
                               "Nonzero query verification traffic was lost or duplicated")
                }
                if route == "ignored" {
                    try expect(!mode.values.contains(.parallel), "Range-ignoring server entered the parallel path")
                }
                if handoff {
                    try expect(mode.values.contains(.background), "No background handoff occurred")
                    let planFile = MediaPipeline.store.directory(for: id).appendingPathComponent("video.transfer.json")
                    let plan = try JSONDecoder().decode(MediaTransferPlan.self, from: Data(contentsOf: planFile))
                    try expect(plan.remainderStart == (zeroPrefix ? 0 : 4 * 1_024 * 1_024), "Handoff used the wrong contiguous prefix")
                }
                if route.hasPrefix("query") {
                    let planFile = MediaPipeline.store.directory(for: id).appendingPathComponent("video.transfer.json")
                    let plan = try JSONDecoder().decode(MediaTransferPlan.self, from: Data(contentsOf: planFile))
                    try expect(plan.rangeTransport == (route == "query-ignored" || route == "query-wrong-offset" ? .header : .googleQuery),
                               "Chosen range transport was not persisted")
                }
                if route.hasSuffix("resume") {
                    let planFile = MediaPipeline.store.directory(for: id).appendingPathComponent("video.transfer.json")
                    let plan = try JSONDecoder().decode(MediaTransferPlan.self, from: Data(contentsOf: planFile))
                    try expect(mode.traffic == Int64(length) - plan.chunkSize,
                               "Reloaded transfer plan did not reuse its verified cached chunk")
                    try expect(plan.rangeTransport == (route == "query-resume" ? .googleQuery : .header),
                               "Legacy or query plan restored with the wrong transport")
                }
            } catch {
                if !failureExpected { throw error }
                let destination = try MediaPipeline.store.file(for: descriptor)
                try expect(!FileManager.default.fileExists(atPath: destination.path), "Failed transfer left a ready source file")
            }
            try MediaPipeline.store.remove(id)
            print("Native download check passed: " + route)
        }
        // A zero-byte leftover cannot satisfy a completed direct download.
        let emptyID = UUID()
        var emptyEndpoint = URLComponents(url: base.appendingPathComponent("normal"), resolvingAgainstBaseURL: false)!
        emptyEndpoint.queryItems = [URLQueryItem(name: "token", value: "PRIVATE+VALUE/TOKEN=")]
        let emptyURL = emptyEndpoint.url!
        try MediaPipeline.store.save(.init(id: emptyID, title: "empty cache", videoURL: emptyURL))
        let emptyDescriptor = MediaDownloadDescriptor(jobID: emptyID, track: .video)
        try Data().write(to: MediaPipeline.store.file(for: emptyDescriptor))
        let replacement = try await downloader.download(emptyURL, descriptor: emptyDescriptor, background: false,
            progress: { _, _ in }, traffic: { _ in })
        try expect(try Data(contentsOf: replacement) == expected, "Empty cache was mistaken for a finished download")
        let metricsSession = URLSession(configuration: .ephemeral, delegate: trust, delegateQueue: nil)
        defer { metricsSession.invalidateAndCancel() }
        let (data, _) = try await metricsSession.data(from: base.appendingPathComponent("metrics"))
        let metrics = try JSONSerialization.jsonObject(with: data) as? [String: Int] ?? [:]
        try expect((metrics["max_parallel"] ?? 0) >= 4, "Foreground downloads were serialized")
        try expect(metrics["head_requests"] == 0, "Range detection still relies on HEAD")
        try expect(metrics["handoff_remainders"] == 1, "Handoff did not use one remaining transfer")
        try expect(metrics["handoff_zero_remainders"] == 1, "Zero-prefix handoff did not use one remaining transfer")
        try expect((metrics["max_query_parallel"] ?? 0) >= 4, "Query transfers were serialized")
        try expect(metrics["query_handoff_remainders"] == 1, "Query handoff lost its remaining-transfer transport")
        try expect(metrics["query_handoff_zero_remainders"] == 1, "Query zero-prefix handoff lost its transport")
        try expect(metrics["query_no_cr_handoff_remainders"] == 1,
                   "Validated 200 query handoff lost its remaining-transfer transport")
        try expect(metrics["query_no_cr_handoff_zero_remainders"] == 1,
                   "Validated 200 query zero-prefix handoff lost its transport")
        try expect(metrics["query_ignored_probes"] == 1 && metrics["query_ignored_header_probes"] == 1,
                   "Unsupported query range did not fall back to a verified HTTP Range probe")
        try expect(metrics["query_resume_probes"] == 0 && metrics["query_resume_cached_requests"] == 0,
                   "Restored query plan re-probed or re-downloaded its cached prefix")
        try expect(metrics["legacy_resume_probes"] == 0 && metrics["legacy_resume_cached_requests"] == 0,
                   "Legacy header plan re-probed or re-downloaded its cached prefix")
        let reports = diagnostics.values
        try expect(reports.contains { $0["event"] == "start" && $0["transport"] == "googleQuery" },
                   "Ongoing query transfers have no safe request diagnostic")
        try expect(reports.contains { $0["event"] == "finishedMetrics" && $0["protocol"] == "http/1.1"
            && $0["host"] == "127.0.0.1" && (Int64($0["receivedBytes"] ?? "") ?? 0) > 0 },
                   "Native task metrics were not captured")
        try expect(!reports.description.contains("PRIVATE") && !reports.description.contains("token="),
                   "Download diagnostics leaked signed URL query values")
        print("Native downloader smoke passed: header/query parallel transfers, query fallback, exact bytes, malformed/truncated rejection, durable cached-prefix background handoff and safe native metrics.")
    }
}
