import XCTest
@testable import MK8Core

final class CoreTests: XCTestCase {
    func testVideoURLsAndLookalikeDomains() {
        let id = "QdBZY2fkU-0"
        for value in [id, "https://youtu.be/\(id)?t=2", "https://www.youtube.com/watch?v=\(id)&t=20", "https://m.youtube.com/shorts/\(id)"] {
            XCTAssertEqual(YouTubeID.parse(value), id)
        }
        for value in ["https://youtube.com.evil.test/watch?v=\(id)", "https://evil.test/\(id)", "file:///tmp/a", "short", "https://youtu.be/\(id)/extra"] {
            XCTAssertNil(YouTubeID.parse(value))
        }
    }
    func testPartialHeaderAndBody() throws {
        let head = "POST /api/youtube HTTP/1.1\r\nContent-Length: 4\r\n\r\n"
        XCTAssertNil(try HTTPRequest.parse(Data("GET / HTTP/1.1\r\n".utf8)))
        XCTAssertNil(try HTTPRequest.parse(Data((head + "12").utf8)))
        let request = try XCTUnwrap(HTTPRequest.parse(Data((head + "1234").utf8)))
        XCTAssertEqual(request.body, Data("1234".utf8))
        XCTAssertEqual(request.path, "/api/youtube")
    }
    func testRejectsAmbiguousFramingAndOversizedRequests() {
        for value in [
            "POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\na",
            "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
            "POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
            "POST / HTTP/1.1\r\nContent-Length: 20000\r\n\r\n",
            "GET //evil.test/ HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\n\r\n"
        ] { XCTAssertThrowsError(try HTTPRequest.parse(Data(value.utf8))) }
        XCTAssertThrowsError(try HTTPRequest.parse(Data(repeating: 65, count: 16_385)))
    }
    func testFFmpegPathsStaySeparateArguments() {
        let path = "/tmp/a 'quoted' name.mp4"
        let args = TranscodeArguments.make(video: path, audio: "/tmp/audio.m4a", output: "/tmp/out.ts")
        XCTAssertEqual(args[args.firstIndex(of: "-i")! + 1], path)
        XCTAssertTrue(args.contains("mpeg1video"))
        XCTAssertTrue(args.contains("mp2"))
        XCTAssertEqual(args[args.firstIndex(of: "-bf")! + 1], "0")
        XCTAssertEqual(args.last, "/tmp/out.ts")
    }
    func testHardwareDecodeIsInputOnlyAndFrameCapPrecedesResize() {
        let args = TranscodeArguments.make(video: "/tmp/source.mp4", audio: "/tmp/audio.m4a",
                                          output: "/tmp/out.ts", quality: .high, hardwareDecode: true)
        XCTAssertLessThan(args.firstIndex(of: "-hwaccel")!, args.firstIndex(of: "-i")!)
        XCTAssertEqual(args.filter { $0 == "videotoolbox" }.count, 1)
        XCTAssertFalse(args.contains("-hwaccel_output_format"))
        XCTAssertTrue(args.contains("-xerror"))
        let filter = args[args.firstIndex(of: "-vf")! + 1]
        XCTAssertTrue(filter.hasPrefix("fps=fps='if(gt(source_fps,0),min(30,source_fps),30)',scale=1280:720"))
        XCTAssertEqual(args[args.firstIndex(of: "-r")! + 1], "30")
        XCTAssertFalse(TranscodeArguments.make(video: "/tmp/source.mp4", output: "/tmp/out.ts").contains("videotoolbox"))
    }

    func testMPEGTSIndexUsesTimestampsInsteadOfByteRatio() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("fixture.ts")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        func pts(_ seconds: Int) -> [UInt8] {
            let value = UInt64(seconds * 90_000)
            return [UInt8(0x21 | ((value >> 29) & 0x0e)), UInt8(value >> 22),
                    UInt8(0x01 | ((value >> 14) & 0xfe)), UInt8(value >> 7),
                    UInt8(0x01 | ((value << 1) & 0xfe))]
        }
        func packet(pid: Int, start: Bool, payload: [UInt8]) -> [UInt8] {
            var bytes = [UInt8](repeating: 0xff, count: 188)
            bytes[0] = 0x47
            bytes[1] = UInt8((start ? 0x40 : 0) | ((pid >> 8) & 0x1f))
            bytes[2] = UInt8(pid & 0xff)
            bytes[3] = 0x30 // adaptation + payload
            bytes[4] = UInt8(188 - 5 - payload.count)
            bytes[5] = 0
            let payloadStart = 5 + Int(bytes[4])
            bytes.replaceSubrange(payloadStart..<min(188, payloadStart + payload.count),
                                  with: payload.prefix(188 - payloadStart))
            return bytes
        }
        var bytes = [UInt8]()
        // A repeated PAT gives the index a decoder-safe context near every
        // timestamp; the PAT body itself is not needed by the index scanner.
        for second in 0...3 {
            bytes += packet(pid: 0, start: true, payload: [0])
            let pes: [UInt8] = [0, 0, 1, 0xe0, 0, 12, 0x80, 0x80, 5] + pts(second) + [0, 0, 1, 0xb7]
            bytes += packet(pid: 256, start: true, payload: pes)
            if second == 1 {
                // Make the file deliberately variable-size between timestamp
                // points; a file-size ratio would now land at the wrong time.
                for _ in 0..<4 { bytes += packet(pid: 257, start: false, payload: [0]) }
            }
        }
        try Data(bytes).write(to: file)

        let index = try MPEGTSIndex.build(file: file, pointInterval: 0.5)
        XCTAssertEqual(try XCTUnwrap(index.points.first).time, 0, accuracy: 0.001)
        XCTAssertGreaterThan(index.duration ?? 0, 3)
        let point = try XCTUnwrap(index.point(for: 2.6))
        XCTAssertEqual(point.time, 2, accuracy: 0.001)
        XCTAssertEqual(point.offset, 1_504)
        XCTAssertEqual(try XCTUnwrap(index.point(for: -1)).time, 0, accuracy: 0.001)
    }

    func testMPEGTSIndexRejectsUnalignedFiles() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data(repeating: 0x47, count: 189).write(to: file)
        XCTAssertThrowsError(try MPEGTSIndex.build(file: file))
    }
}
