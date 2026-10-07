import XCTest
@testable import MK8Core

final class MediaPreparationTests: XCTestCase {
    func testGoogleQueryRangePreservesSignedQueryBytesWithoutASecondHTTPRange() throws {
        let encoded = "sig=a%2fb%2Bc%3d&n=A+B%2f&token=%7e&repeat=%2520&repeat=&flag&sparams=id%2Citag"
        let url = try XCTUnwrap(URL(string: "https://r1---sn.example.googlevideo.com/videoplayback?" + encoded))
        let request = try XCTUnwrap(MediaRangeRequest.request(url: url,
            range: .init(start: 1_048_576, end: 2_097_151), transport: .googleQuery))
        let result = try XCTUnwrap(request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
        XCTAssertEqual(result.percentEncodedQuery, encoded + "&range=1048576-2097151")
        XCTAssertNil(request.value(forHTTPHeaderField: "Range"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept-Encoding"), "identity")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery, encoded)
    }
    func testGoogleQueryRangeRequiresTheGooglevideoHostBoundaryAndHTTPS() throws {
        for host in ["googlevideo.com", "r1.googlevideo.com"] {
            let url = try XCTUnwrap(URL(string: "https://" + host + "/videoplayback"))
            let request = try XCTUnwrap(MediaRangeRequest.request(url: url, range: .init(start: 0, end: 0),
                                                                  transport: .googleQuery))
            XCTAssertEqual(request.url?.query, "range=0-0")
        }
        for value in ["http://r1.googlevideo.com/video", "https://googlevideo.com.example.test/video",
                      "https://evilgooglevideo.com/video", "https://example.test/video",
                      "https://user:password@r1.googlevideo.com/video"] {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertFalse(MediaRangeRequest.supportsGoogleQuery(url))
            XCTAssertNil(MediaRangeRequest.request(url: url, range: .init(start: 0, end: 0), transport: .googleQuery))
        }
    }
    func testGoogleQueryRangeRejectsAnExistingOrSignedRange() throws {
        for query in ["range=0-100", "%72ange=0-100", "RANGE=0-100", "range", "sparams=id,range,expire",
                      "lsparams=ip%2Crange", "sparams=id&sparams=range", "sparams=%20range%20"] {
            let url = try XCTUnwrap(URL(string: "https://r1.googlevideo.com/videoplayback?" + query))
            XCTAssertFalse(MediaRangeRequest.supportsGoogleQuery(url), query)
            XCTAssertNil(MediaRangeRequest.request(url: url, range: .init(start: 0, end: 0), transport: .googleQuery), query)
            // A rejected Google-specific strategy does not disable the generic header request.
            XCTAssertEqual(MediaRangeRequest.request(url: url, range: .init(start: 0, end: 0))?.url, url)
        }
    }
    func testMediaRangeRequestsKeepGenericHTTPSAndRejectInvalidRanges() throws {
        let url = try XCTUnwrap(URL(string: "https://example.test/video?token=A%2fb+%3D"))
        let ranged = try XCTUnwrap(MediaRangeRequest.request(url: url, range: .init(start: 10, end: 20)))
        XCTAssertEqual(ranged.url, url)
        XCTAssertEqual(ranged.value(forHTTPHeaderField: "Range"), "bytes=10-20")
        XCTAssertEqual(ranged.value(forHTTPHeaderField: "Accept-Encoding"), "identity")
        let whole = try XCTUnwrap(MediaRangeRequest.request(url: url, range: nil))
        XCTAssertEqual(whole.url, url)
        XCTAssertNil(whole.value(forHTTPHeaderField: "Range"))
        XCTAssertNil(MediaRangeRequest.request(url: URL(string: "http://example.test/video")!, range: nil))
        for range in [MediaByteRange(start: -1, end: 10), .init(start: 20, end: 10),
                      .init(start: 0, end: Int64.max)] {
            XCTAssertNil(MediaRangeRequest.request(url: url, range: range))
        }
        XCTAssertNil(MediaRangeRequest.request(url: URL(string: "https://r1.googlevideo.com/video")!,
                                               range: nil, transport: .googleQuery))
    }
    func testMediaRangeTransportPersistsAsAStableIdentifier() throws {
        for transport in [MediaRangeTransport.header, .googleQuery] {
            XCTAssertEqual(try JSONDecoder().decode(MediaRangeTransport.self,
                from: JSONEncoder().encode(transport)), transport)
        }
    }
    func testRangeResponseParsingRejectsMalformedOrUnknownEntitySizes() {
        let response = MediaByteRange.parse(contentRange: " bytes 0-0/1234 ")
        XCTAssertEqual(response?.range, .init(start: 0, end: 0))
        XCTAssertEqual(response?.total, 1234)
        for value in [nil, "bytes 0-0/*", "bytes 0-100/100", "bytes 20-10/100", "bytes -1-10/100",
                      "bytes 0-0/50000000001", "bytes 0-0/100/200", "items 0-0/100"] {
            XCTAssertNil(MediaByteRange.parse(contentRange: value))
        }
    }
    func testBackgroundHandoffUsesOnlyVerifiedContiguousChunks() {
        let plan = MediaTransferPlan(url: URL(string: "https://example.test/video")!, length: 10_000_000)
        let ranges = plan.ranges
        XCTAssertEqual(plan.completedPrefix(sizes: [0: ranges[0].count, ranges[2].start: ranges[2].count]), ranges[0].count)
        XCTAssertEqual(plan.completedPrefix(sizes: [0: ranges[0].count - 1]), 0)
        XCTAssertEqual(plan.completedPrefix(sizes: Dictionary(uniqueKeysWithValues: ranges.map { ($0.start, $0.count) })), plan.length)
    }
    func testPersistentTransferPlanValidatesSourceAndRemainderBoundaries() throws {
        var plan = MediaTransferPlan(url: URL(string: "https://example.test/video")!, length: 10_000_000)
        plan.remainderStart = 4 * 1_024 * 1_024
        let saved = try JSONDecoder().decode(MediaTransferPlan.self, from: JSONEncoder().encode(plan))
        XCTAssertTrue(saved.valid)
        XCTAssertEqual(saved.remainderStart, plan.remainderStart)
        plan.remainderStart = 1
        XCTAssertFalse(plan.valid)
        XCTAssertFalse(MediaTransferPlan(url: URL(string: "http://example.test/video")!, length: 100).valid)
        XCTAssertFalse(MediaTransferPlan(url: URL(string: "https://example.test/video")!, length: 0).valid)
    }
    func testRangesCoverTheFileExactlyAndValidateReturnedBytes() {
        let ranges = MediaByteRange.make(length: 5_000_001)
        XCTAssertEqual(ranges.count, 3)
        XCTAssertEqual(ranges.first?.start, 0)
        XCTAssertEqual(ranges.last?.end, 5_000_000)
        XCTAssertEqual(ranges.reduce(0) { $0 + $1.count }, 5_000_001)
        for pair in zip(ranges, ranges.dropFirst()) { XCTAssertEqual(pair.0.end + 1, pair.1.start) }
        XCTAssertTrue(ranges[0].matches(contentRange: "bytes 0-2097151/5000001", fileSize: 2_097_152, total: 5_000_001))
        XCTAssertFalse(ranges[0].matches(contentRange: "bytes 0-2097151/5000001", fileSize: 12, total: 5_000_001))
        XCTAssertFalse(ranges[0].matches(contentRange: "bytes 1-2097152/5000001", fileSize: 2_097_152, total: 5_000_001))
        XCTAssertTrue(MediaByteRange.make(length: -1).isEmpty)
    }
    func testBackgroundChunkDescriptorRoundTripAndInvalidRanges() {
        let id = UUID()
        let value = MediaDownloadDescriptor(jobID: id, track: .video, range: .init(start: 2, end: 10), totalLength: 20)
        XCTAssertEqual(MediaDownloadDescriptor(taskDescription: value.taskDescription), value)
        XCTAssertNil(MediaDownloadDescriptor(taskDescription: id.uuidString + ":video:10:2:20"))
        XCTAssertNil(MediaDownloadDescriptor(taskDescription: id.uuidString + ":video:0:20:20"))
        XCTAssertEqual(MediaDownloadDescriptor(taskDescription: id.uuidString + ":audio")?.track, .audio)
    }
    func testLegacyJobsRemainReadableAndRetryKeepsCompletedFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = MediaPreparationStore(root: root)
        let job = MediaPreparationJob(id: UUID(), title: "Cached", videoURL: URL(string: "https://example.test/video"))
        try store.save(job)
        let jobFile = store.directory(for: job.id).appendingPathComponent("job.json")
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: jobFile)) as? [String: Any])
        json.removeValue(forKey: "quality")
        try JSONSerialization.data(withJSONObject: json).write(to: jobFile)
        XCTAssertNil(try store.load(job.id).quality)
        let source = store.file(for: job, track: .video)
        try Data([1, 2, 3]).write(to: source)
        let error = store.failureFile(for: .init(jobID: job.id, track: .video))
        try Data("Network failure".utf8).write(to: error)
        store.clearFailures(job.id)
        XCTAssertEqual(try Data(contentsOf: source), Data([1, 2, 3]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: error.path))
    }
    func testDownloadETAUsesBytesAndUnknownOrStoppedRatesHaveNoETA() {
        let value = MediaPreparationProgress(stage: .downloading, completedBytes: 20, totalBytes: 100, bytesPerSecond: 10)
        XCTAssertEqual(value.secondsRemaining, 8)
        XCTAssertNil(MediaPreparationProgress(stage: .downloading, bytesPerSecond: 10).secondsRemaining)
        XCTAssertNil(MediaPreparationProgress(stage: .downloading, totalBytes: 100).secondsRemaining)
    }
}
