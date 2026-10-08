import Foundation
import XCTest
@testable import MK8Core

final class RelayTests: XCTestCase {
    private let url = URL(string: "https://tv.jcruzhoovertesla.workers.dev")!

    func testRelayPreservesCookiesOriginAndBody() throws {
        let body = Data("{\"url\":\"dQw4w9WgXcQ\"}".utf8)
        let request = try RelayProtocol.request(method: "POST", target: "/api/youtube",
            headers: ["Host": url.host!, "Origin": url.absoluteString, "Cookie": "video-pilot-test=1"],
            base64Body: body.base64EncodedString(), publicURL: url)
        XCTAssertEqual(request.body, body)
        XCTAssertEqual(request.headers["cookie"], "video-pilot-test=1")
        XCTAssertEqual(request.headers["origin"], url.absoluteString)
        XCTAssertEqual(request.path, "/api/youtube")
    }

    func testRelayRejectsCrossOriginAndRequestInjection() throws {
        let valid = ["host": url.host!]
        for target in ["https://other.test/", "//other.test/", "/x\r\nHost: attacker", "/a b"] {
            XCTAssertThrowsError(try RelayProtocol.request(method: "GET", target: target, headers: valid,
                base64Body: "", publicURL: url))
        }
        for headers in [["host": "other.test"], ["host": url.host!, "origin": "https://other.test"],
                        ["host": url.host!, "cookie": "ok\r\nx-secret: leak"],
                        ["host": url.host!, "Host": url.host!], ["host": url.host!, "transfer-encoding": "chunked"]] {
            XCTAssertThrowsError(try RelayProtocol.request(method: "GET", target: "/", headers: headers,
                base64Body: "", publicURL: url))
        }
        XCTAssertThrowsError(try RelayProtocol.request(method: "POST", target: "/api/youtube", headers: valid,
            base64Body: Data(repeating: 1, count: 16_385).base64EncodedString(), publicURL: url))
    }

    func testBinaryFramesKeepExactPayloadAndRequestIdentity() throws {
        let id = UUID(uuidString: "00112233-4455-6677-8899-aabbccddeeff")!
        let payload = Data([0x47, 0, 255, 2])
        let framed = try RelayProtocol.frame(id: id, payload: payload)
        XCTAssertEqual(Array(framed.prefix(16)), [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255])
        XCTAssertEqual(framed.dropFirst(16), payload)
        XCTAssertThrowsError(try RelayProtocol.frame(id: id, payload: Data()))
        XCTAssertThrowsError(try RelayProtocol.frame(id: id, payload: Data(repeating: 0, count: RelayProtocol.maximumChunk + 1)))
    }

    func testFileChunksFillExistingFrameLimitWithoutSplittingTSPackets() throws {
        XCTAssertEqual(RelayProtocol.fileChunk, 131_036)
        XCTAssertEqual(RelayProtocol.fileChunk % 188, 0)
        XCTAssertLessThanOrEqual(RelayProtocol.fileChunk, RelayProtocol.maximumChunk)
        let bytes = Data((0..<(RelayProtocol.fileChunk * 3 + 188 * 7)).map { UInt8($0 % 251) })
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let body = try RelayBody(file: url)
        defer { body.close() }
        XCTAssertEqual(body.length, bytes.count)
        var reconstructed = Data()
        var sizes: [Int] = []
        while !body.finished {
            let chunk = try body.nextChunk()
            sizes.append(chunk.count)
            XCTAssertEqual(chunk.count % 188, 0)
            let frame = try RelayProtocol.frame(id: UUID(), payload: chunk)
            XCTAssertLessThanOrEqual(frame.count, RelayProtocol.maximumChunk + 16)
            reconstructed.append(frame.dropFirst(16))
        }
        XCTAssertEqual(sizes, [RelayProtocol.fileChunk, RelayProtocol.fileChunk, RelayProtocol.fileChunk, 188 * 7])
        XCTAssertEqual(reconstructed, bytes)
        XCTAssertTrue(try body.nextChunk().isEmpty)
    }

    func testMemoryBodyKeepsExactBytesAcrossMaximumSizedChunks() throws {
        let bytes = Data((0..<(RelayProtocol.maximumChunk * 2 + 17)).map { UInt8($0 % 251) })
        let body = RelayBody(data: bytes)
        defer { body.close() }
        var reconstructed = Data()
        var sizes: [Int] = []
        while !body.finished {
            let chunk = try body.nextChunk()
            sizes.append(chunk.count)
            reconstructed.append(chunk)
        }
        XCTAssertEqual(sizes, [RelayProtocol.maximumChunk, RelayProtocol.maximumChunk, 17])
        XCTAssertEqual(reconstructed, bytes)
        XCTAssertTrue(try RelayBody(data: Data()).nextChunk().isEmpty)
    }

    func testTruncatedFileFailsInsteadOfAdvertisingSuccessfulCompletion() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let bytes = Data(repeating: 0x47, count: RelayProtocol.fileChunk * 2)
        try bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let body = try RelayBody(file: url)
        defer { body.close() }
        XCTAssertEqual(try body.nextChunk().count, RelayProtocol.fileChunk)
        let writer = try FileHandle(forWritingTo: url)
        try writer.truncate(atOffset: UInt64(RelayProtocol.fileChunk + 3))
        try writer.close()
        XCTAssertThrowsError(try body.nextChunk()) { error in
            guard case RelayBody.Failure.incompleteFile = error else { return XCTFail("Unexpected error: \(error)") }
        }
        XCTAssertEqual(body.length, bytes.count)
        XCTAssertFalse(body.finished)
    }

    func testClosedBodyCannotReadOrContinueAfterCancellation() throws {
        let body = RelayBody(data: Data(repeating: 1, count: RelayProtocol.maximumChunk * 2))
        XCTAssertEqual(try body.nextChunk().count, RelayProtocol.maximumChunk)
        body.close()
        body.close()
        XCTAssertThrowsError(try body.nextChunk()) { error in
            guard case RelayBody.Failure.closed = error else { return XCTFail("Unexpected error: \(error)") }
        }
    }

    func testClosedFileCannotReadAndKeepsNonPacketFinalBytes() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let bytes = Data(repeating: 0x47, count: RelayProtocol.fileChunk + 17)
        try bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let body = try RelayBody(file: url)
        XCTAssertEqual(try body.nextChunk().count, RelayProtocol.fileChunk)
        XCTAssertEqual(try body.nextChunk(), Data(repeating: 0x47, count: 17))
        body.close()
        body.close()
        XCTAssertThrowsError(try body.nextChunk())
    }

    func testNextPullBeforeSendCompletionUsesSameSerialDrain() throws {
        var credits = RelayCredits()
        XCTAssertTrue(try credits.grant()) // First pull starts a drain.
        XCTAssertTrue(credits.consume()) // First frame is now being sent.
        XCTAssertTrue(credits.draining)
        XCTAssertFalse(credits.pending)
        XCTAssertFalse(try credits.grant()) // Worker asks again before send callback.
        XCTAssertTrue(credits.pending)
        XCTAssertTrue(credits.consume()) // Existing drain serves the queued credit.
        XCTAssertFalse(credits.consume()) // It exits once no credit remains.
        XCTAssertFalse(credits.draining)
        XCTAssertTrue(try credits.grant()) // A later pull can start a fresh drain.
        XCTAssertTrue(credits.consume())
    }

    func testCreditsBoundQueueAndIgnoreNoWorkAfterCancellation() throws {
        var credits = RelayCredits()
        XCTAssertTrue(try credits.grant())
        XCTAssertThrowsError(try credits.grant()) // At most one queued pull.
        XCTAssertTrue(credits.consume())
        XCTAssertFalse(try credits.grant())
        XCTAssertThrowsError(try credits.grant()) // Also bounded while a send awaits.
        credits.close()
        XCTAssertFalse(credits.consume())
        XCTAssertThrowsError(try credits.grant())
        XCTAssertFalse(credits.pending)
        XCTAssertFalse(credits.draining)
    }

    @MainActor func testQueuedPullDuringSuspendedSendDrainsAndRestartsWithoutLosingBytes() async throws {
        let bytes = Data((0..<(RelayProtocol.maximumChunk * 2 + 17)).map { UInt8($0 % 251) })
        let drain = RelayTestDrain(body: RelayBody(data: bytes))
        XCTAssertTrue(try drain.credits.grant())
        let firstDrain = Task { try await drain.run() }
        await drain.barrier.waitUntilPaused()
        // The first binary send has not completed, but the Worker already read
        // its bytes and sent its next pull. It must reuse the same drain task.
        XCTAssertFalse(try drain.credits.grant())
        XCTAssertThrowsError(try drain.credits.grant())
        drain.barrier.resume()
        let firstFrames = try await firstDrain.value
        XCTAssertEqual(firstFrames.count, 2)
        XCTAssertFalse(drain.credits.draining)
        XCTAssertFalse(drain.body.finished)
        XCTAssertTrue(try drain.credits.grant())
        let finalFrames = try await drain.run()
        XCTAssertEqual(finalFrames.count, 1)
        XCTAssertTrue(drain.body.finished)
        let reconstructed = (firstFrames + finalFrames).reduce(into: Data()) { result, frame in
            XCTAssertLessThanOrEqual(frame.count, RelayProtocol.maximumChunk + 16)
            result.append(frame.dropFirst(16))
        }
        XCTAssertEqual(reconstructed, bytes)
        drain.body.close()
    }
}

@MainActor private final class RelayTestDrain {
    let body: RelayBody
    let barrier = RelaySendBarrier()
    var credits = RelayCredits()
    private var pausedOnce = false

    init(body: RelayBody) { self.body = body }

    func run() async throws -> [Data] {
        var frames: [Data] = []
        while credits.consume() {
            frames.append(try RelayProtocol.frame(id: UUID(), payload: body.nextChunk()))
            if !pausedOnce {
                pausedOnce = true
                await barrier.pause()
            }
        }
        return frames
    }
}

@MainActor private final class RelaySendBarrier {
    private var send: CheckedContinuation<Void, Never>?
    private var observer: CheckedContinuation<Void, Never>?

    func pause() async {
        await withCheckedContinuation { continuation in
            send = continuation
            observer?.resume()
            observer = nil
        }
    }
    func waitUntilPaused() async {
        if send != nil { return }
        await withCheckedContinuation { observer = $0 }
    }
    func resume() {
        send?.resume()
        send = nil
    }
}
