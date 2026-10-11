import Foundation
import ffmpegkit
import MK8Core

@main enum ConverterSmoke {
    static func run(_ args: [String]) throws {
        guard let session = FFmpegKit.execute(withArguments: args), ReturnCode.isSuccess(session.getReturnCode()) else {
            throw NSError(domain: "MK8ConverterCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native FFmpeg conversion failed."])
        }
    }
    static func validate(_ output: URL, quality: MediaQuality, duration: Double) throws {
        let information = FFprobeKit.getMediaInformation(output.path)?.getMediaInformation()
        let streams = information?.getStreams() as? [StreamInformation] ?? []
        guard let video = streams.first(where: { $0.getType() == "video" && $0.getCodec() == "mpeg1video" }),
              video.getWidth()?.intValue == quality.width, video.getHeight()?.intValue == quality.rawValue,
              video.getAverageFrameRate() == "30/1",
              streams.contains(where: { $0.getType() == "audio" && $0.getCodec() == "mp2" }),
              let durationString = information?.getDuration(), let actualDuration = Double(durationString),
              abs(actualDuration - duration) < 0.2 else {
            throw NSError(domain: "MK8ConverterCheck", code: 2, userInfo: [NSLocalizedDescriptionKey: "Playback codecs, dimensions, frame rate, or duration changed."])
        }
        let bytes = try Data(contentsOf: output)
        guard bytes.count >= 188, bytes.count % 188 == 0,
              stride(from: 0, to: bytes.count, by: 188).allSatisfy({ bytes[$0] == 0x47 }) else {
            throw NSError(domain: "MK8ConverterCheck", code: 3, userInfo: [NSLocalizedDescriptionKey: "Output is not packet-aligned MPEG-TS."])
        }
        try run(["-hide_banner", "-loglevel", "error", "-xerror", "-i", output.path, "-f", "null", "-"])
    }

    actor Attempts {
        private(set) var hardware: [Bool] = []
        func record(_ arguments: [String]) { hardware.append(arguments.contains("videotoolbox")) }
    }

    static func checkFallbackAndCancellation(source: URL, root: URL) async throws {
        let output = root.appendingPathComponent("fallback.ts")
        let attempts = Attempts()
        try await MediaConverter.convert(video: source, audio: nil, output: output, duration: 2,
            quality: .balanced, progress: { _ in }, runner: { arguments, _, _ in
                await attempts.record(arguments)
                if arguments.contains("videotoolbox") {
                    try Data([9]).write(to: output)
                    throw MediaConverter.Failure(code: 1, log: "Forced unavailable hardware decoder")
                }
                guard !FileManager.default.fileExists(atPath: output.path) else {
                    throw NSError(domain: "MK8ConverterCheck", code: 4, userInfo: [NSLocalizedDescriptionKey: "Hardware partial output was not removed before retry."])
                }
                try Data([1]).write(to: output)
            })
        guard await attempts.hardware == [true, false], FileManager.default.fileExists(atPath: source.path) else {
            throw NSError(domain: "MK8ConverterCheck", code: 5, userInfo: [NSLocalizedDescriptionKey: "Software fallback did not retain its source."])
        }
        let cancelled = Attempts()
        do {
            try await MediaConverter.convert(video: source, audio: nil, output: output, duration: 2,
                quality: .balanced, progress: { _ in }, runner: { arguments, _, _ in
                    await cancelled.record(arguments)
                    throw CancellationError()
                })
            throw NSError(domain: "MK8ConverterCheck", code: 6, userInfo: [NSLocalizedDescriptionKey: "Cancellation was swallowed."])
        } catch is CancellationError { }
        guard await cancelled.hardware == [true] else {
            throw NSError(domain: "MK8ConverterCheck", code: 7, userInfo: [NSLocalizedDescriptionKey: "Cancellation incorrectly restarted conversion."])
        }
        // Model expiration while a hardware attempt is failing: a cancelled
        // outer task must not enter its software retry.
        let expired = Attempts()
        let task = Task {
            try await MediaConverter.convert(video: source, audio: nil, output: output, duration: 2,
                quality: .balanced, progress: { _ in }, runner: { arguments, _, _ in
                    await expired.record(arguments)
                    withUnsafeCurrentTask { $0?.cancel() }
                    throw MediaConverter.Failure(code: 1, log: "Hardware failed during expiration")
                })
        }
        do {
            _ = try await task.value
            throw NSError(domain: "MK8ConverterCheck", code: 8, userInfo: [NSLocalizedDescriptionKey: "Expiration was swallowed."])
        } catch is CancellationError { }
        guard await expired.hardware == [true] else {
            throw NSError(domain: "MK8ConverterCheck", code: 9, userInfo: [NSLocalizedDescriptionKey: "Expiration restarted conversion."])
        }
    }

    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("MK8 converter 'quoted' " + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("sample.mp4").path
        let audio = root.appendingPathComponent("audio.m4a").path
        try run(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25",
                 "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", "-c:v", "mpeg4",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", source])
        try run(["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-c:a", "copy", audio])
        for quality in MediaQuality.allCases {
            for separateAudio in [false, true] {
                let output = root.appendingPathComponent("\(quality.rawValue)-\(separateAudio).ts")
                try run(TranscodeArguments.make(video: source, audio: separateAudio ? audio : nil, output: output.path, quality: quality))
                try validate(output, quality: quality, duration: 1)
            }
        }
        let h264 = root.appendingPathComponent("H264 60fps.mp4")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "scripts/fixtures/h264-60fps.mp4"), to: h264)
        let h264Audio = root.appendingPathComponent("H264 audio.m4a")
        try run(["-hide_banner", "-loglevel", "error", "-y", "-i", h264.path, "-vn", "-c:a", "copy", h264Audio.path])
        for quality in MediaQuality.allCases {
            for separateAudio in [false, true] {
                let output = root.appendingPathComponent("H264-\(quality.rawValue)-\(separateAudio).ts")
                try await MediaConverter.convert(video: h264, audio: separateAudio ? h264Audio : nil,
                    output: output, duration: 2, quality: quality, progress: { _ in })
                try validate(output, quality: quality, duration: 2)
            }
        }
        // Parallel slices: two whole-second segments joined and muxed with one
        // MP2 track must match the single-pass format, timeline and duration.
        for quality in MediaQuality.allCases {
            let output = root.appendingPathComponent("H264-parallel-\(quality.rawValue).ts")
            try await MediaConverter.convertInSegments(video: h264, audio: h264Audio, output: output, duration: 2,
                quality: quality, segments: [TranscodeSegment(start: 0, frames: 30), TranscodeSegment(start: 1, frames: nil)],
                hardwareDecode: false, progress: { _ in })
            try validate(output, quality: quality, duration: 2)
        }
        try await checkFallbackAndCancellation(source: h264, root: root)
        print("Native converter smoke passed: 25fps software and 60fps H264 production worker, all qualities, combined/separate audio, 30fps MPEG-1 + MP2 output decoded; parallel segments, hardware fallback and cancellation/expiration verified.")
    }
}
