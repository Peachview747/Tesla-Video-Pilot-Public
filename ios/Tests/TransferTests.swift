import XCTest
@testable import MK8Core

final class TransferTests: XCTestCase {
    func testActualTrafficRatesAndIdleReturnToZero() {
        var meter = TransferMeter(startedAt: 10)
        meter.record(received: 1_000_000, sent: 250_000)
        let first = meter.sample(at: 12)
        XCTAssertEqual(first.downloadMbps, 4)
        XCTAssertEqual(first.uploadMbps, 1)
        XCTAssertEqual(first.totalReceivedBytes, 1_000_000)
        let idle = meter.sample(at: 13)
        XCTAssertEqual(idle.downloadMbps, 0)
        XCTAssertEqual(idle.uploadMbps, 0)
        meter.record(received: -100, sent: 125_000)
        XCTAssertEqual(meter.sample(at: 14).uploadMbps, 1)
    }
    func testUnknownDownloadLengthAndConversionTiming() {
        XCTAssertNil(MediaPreparationProgress(stage: .downloading, completedBytes: 100).fraction)
        XCTAssertEqual(MediaPreparationProgress(stage: .downloading, completedBytes: 50, totalBytes: 100).fraction, 0.5)
        XCTAssertEqual(MediaPreparationProgress(stage: .downloading, completedBytes: 110, totalBytes: 100).fraction, 1)
        XCTAssertNil(MediaPreparationProgress.ratio(completed: .nan, total: 100))
        XCTAssertNil(MediaPreparationProgress.ratio(completed: 10, total: 0))
        XCTAssertEqual(MediaPreparationProgress.ratio(completed: 60, total: 120), 0.5)
    }
    func testPreparationSpeedWarmsUpAndMeasuresOnlyConversionTime() {
        var download = TransferMeter(startedAt: 10)
        download.record(received: 10_000_000)
        XCTAssertEqual(download.sample(at: 110).receivedBytesPerSecond, 100_000)

        var preparation = ProcessingMeter(startedAt: 110, duration: 100)
        let startup = preparation.sample(mediaTime: 2, at: 111)
        XCTAssertEqual(startup.fraction, 0.02)
        XCTAssertNil(startup.speed)
        XCTAssertNil(startup.secondsRemaining)
        let measured = preparation.sample(mediaTime: 4, at: 112)
        XCTAssertEqual(measured.speed, 2)
        XCTAssertEqual(measured.secondsRemaining, 48)
        let progress = MediaPreparationProgress(stage: .processing, fraction: measured.fraction,
                                                processingSpeed: measured.speed,
                                                processingSecondsRemaining: measured.secondsRemaining)
        XCTAssertEqual(progress.secondsRemaining, 48)
    }
    func testPreparationStallSlowsAndThenClearsEstimate() {
        var preparation = ProcessingMeter(startedAt: 0, duration: 100)
        _ = preparation.sample(mediaTime: 2, at: 1)
        _ = preparation.sample(mediaTime: 4, at: 2)
        XCTAssertEqual(preparation.sample(mediaTime: 6, at: 3).speed, 2)
        let slowing = preparation.sample(mediaTime: 6, at: 4)
        XCTAssertEqual(slowing.speed, 1.5)
        XCTAssertEqual(slowing.secondsRemaining!, 94 / 1.5, accuracy: 0.001)
        for timestamp in 5...7 { _ = preparation.sample(mediaTime: 6, at: Double(timestamp)) }
        let stalled = preparation.sample(mediaTime: 6, at: 8)
        XCTAssertEqual(stalled.fraction, 0.06)
        XCTAssertNil(stalled.speed)
        XCTAssertNil(stalled.secondsRemaining)
    }
    func testPreparationUnknownDurationAndClampedFraction() {
        var unknown = ProcessingMeter(startedAt: 0, duration: nil)
        let measured = unknown.sample(mediaTime: 4, at: 2)
        XCTAssertEqual(measured.speed, 2)
        XCTAssertNil(measured.fraction)
        XCTAssertNil(measured.secondsRemaining)
        var known = ProcessingMeter(startedAt: 0, duration: 100)
        let finished = known.sample(mediaTime: 101, at: 10)
        XCTAssertEqual(finished.fraction, 1)
        XCTAssertEqual(finished.secondsRemaining, 0)
    }
    func testInvalidPreparationStatisticsNeverPublishRates() {
        var preparation = ProcessingMeter(startedAt: 0, duration: 100)
        XCTAssertNil(preparation.sample(mediaTime: 0, at: 1).speed)
        XCTAssertEqual(preparation.sample(mediaTime: 4, at: 3).speed, 4.0 / 3.0)
        for (mediaTime, timestamp) in [(Double.nan, 4.0), (Double.infinity, 4.0),
                                      (-1.0, 4.0), (3.0, 4.0), (5.0, 2.0),
                                      (5.0, Double.nan), (5.0, Double.infinity)] {
            let invalid = preparation.sample(mediaTime: mediaTime, at: timestamp)
            XCTAssertEqual(invalid.fraction, 0.04)
            XCTAssertNil(invalid.speed)
            XCTAssertNil(invalid.secondsRemaining)
        }
        for duration in [Double.nan, Double.infinity, 0, -1] {
            var unknown = ProcessingMeter(startedAt: 0, duration: duration)
            XCTAssertNil(unknown.sample(mediaTime: 2, at: 2).secondsRemaining)
        }
        let invalidProgress = MediaPreparationProgress(stage: .processing, processingSpeed: .infinity,
                                                      processingSecondsRemaining: 10)
        XCTAssertNil(invalidProgress.processingSpeed)
        XCTAssertNil(invalidProgress.secondsRemaining)
        let negativeETA = MediaPreparationProgress(stage: .processing, processingSpeed: 2,
                                                  processingSecondsRemaining: -1)
        XCTAssertNil(negativeETA.secondsRemaining)
        let downloading = MediaPreparationProgress(stage: .downloading, completedBytes: 50, totalBytes: 100,
                                                  bytesPerSecond: 10, processingSpeed: 2,
                                                  processingSecondsRemaining: 99)
        XCTAssertEqual(downloading.secondsRemaining, 5)
        XCTAssertNil(downloading.processingSpeed)
    }
    func testBackgroundJobSurvivesStoreRecreation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = MediaPreparationStore(root: root)
        let id = UUID()
        let job = MediaPreparationJob(id: id, title: "A video", youtubeID: "QdBZY2fkU-0",
                                      videoURL: URL(string: "https://example.test/video"),
                                      audioURL: URL(string: "https://example.test/audio"))
        try first.save(job)
        let reconnected = MediaPreparationStore(root: root)
        let restored = try reconnected.load(id)
        XCTAssertEqual(restored.videoURL, job.videoURL)
        XCTAssertEqual(restored.audioURL, job.audioURL)
        XCTAssertEqual(reconnected.jobs().map(\.id), [id])
        let descriptor = MediaDownloadDescriptor(jobID: id, track: .audio)
        XCTAssertEqual(MediaDownloadDescriptor(taskDescription: descriptor.taskDescription), descriptor)
        XCTAssertNil(MediaDownloadDescriptor(taskDescription: "../../outside:audio"))
        let safe = MediaPreparationJob(id: UUID(), title: "Import", sourceExtension: "../../outside")
        XCTAssertEqual(safe.sourceExtension, "mp4")
        try reconnected.remove(id)
        XCTAssertTrue(reconnected.jobs().isEmpty)
    }
}
