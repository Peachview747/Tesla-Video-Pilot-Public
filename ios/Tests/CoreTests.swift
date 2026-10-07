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
}
