import Foundation

/// One whole-second slice of the source for parallel conversion.
public struct TranscodeSegment: Sendable, Equatable {
    /// Seconds into the source where this slice starts.
    public let start: Int
    /// Output frames to encode; nil encodes to the end of the source.
    public let frames: Int?
    public init(start: Int, frames: Int?) { self.start = start; self.frames = frames }
}

public enum TranscodeArguments {
    public static let outputFrameRate = 30

    // Local paths only: media downloads use URLSession, never FFmpeg network protocols.
    public static func make(video: String, audio: String? = nil, output: String,
                            quality: MediaQuality = .balanced, hardwareDecode: Bool = false) -> [String] {
        // Let FFmpeg size its worker pools for the current iPhone. The old
        // fixed two-thread cap made preparation crawl on newer devices.
        var args = inputPrefix(hardwareDecode: hardwareDecode)
        args += ["-i", video]
        if let audio {
            args += ["-i", audio, "-map", "0:v:0", "-map", "1:a:0"]
        } else { args += ["-map", "0:v:0", "-map", "0:a:0?"] }
        args += ["-f", "mpegts"] + videoEncoder(quality: quality) + audioEncoder + [
            // The video owns the timeline. Pad short audio with silence and
            // stop at the video end, rather than emitting an audio-only tail
            // that leaves the Tesla timeline running after the final frame.
            "-af", "apad", "-shortest", "-muxdelay", "0.001", output
        ]
        return args
    }

    private static func inputPrefix(hardwareDecode: Bool) -> [String] {
        var args = ["-hide_banner", "-loglevel", "error", "-xerror", "-y", "-filter_threads", "0", "-threads", "0"]
        // Download hardware-decoded frames to ordinary memory automatically;
        // the MPEG-1 encoder and scale filter still operate on CPU frames.
        if hardwareDecode { args += ["-hwaccel", "videotoolbox"] }
        return args
    }

    private static func videoEncoder(quality: MediaQuality) -> [String] {
        [
            "-codec:v", "mpeg1video",
            // Cap high-frame-rate inputs before resizing. Preserve lower source
            // rates here; output -r performs the final conversion to 30 fps.
            // Bilinear resampling is markedly cheaper than the bicubic default
            // and indistinguishable at Tesla-screen sizes for MPEG-1 output.
            "-vf", "fps=fps='if(gt(source_fps,0),min(30,source_fps),30)',scale=\(quality.width):\(quality.rawValue):force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bilinear,pad=\(quality.width):\(quality.rawValue):(ow-iw)/2:(oh-ih)/2,setsar=1",
            "-r", String(outputFrameRate), "-pix_fmt", "yuv420p", "-b:v", quality.bitrate, "-maxrate", "1800k",
            "-bufsize", "800k", "-bf", "0", "-g", "30", "-threads", "0"
        ]
    }

    private static let audioEncoder = ["-codec:a", "mp2", "-b:a", "128k", "-ar", "44100", "-ac", "2"]

    // MARK: Parallel conversion
    //
    // FFmpeg 5.1 decodes, filters and encodes one output on a single thread,
    // so one conversion cannot use every iPhone core. Whole-second slices of
    // the video are encoded side by side as MPEG-1 elementary streams, joined
    // byte for byte, and muxed with one separately encoded MP2 track. Every
    // supported source rate (24/25/30/50/60) lands on a frame boundary at a
    // whole second, and each non-final slice encodes exactly seconds x 30
    // frames, so the joined timeline matches a single-pass conversion.

    /// Plans up to `maximum` slices of at least `minimumSeconds` each. Returns
    /// an empty plan when the video is too short to benefit.
    public static func segments(duration: Double, maximum: Int, minimumSeconds: Int = 30) -> [TranscodeSegment] {
        guard duration.isFinite, duration > 0, duration < 1_000_000, maximum >= 2, minimumSeconds >= 1 else { return [] }
        let count = min(maximum, Int(duration) / minimumSeconds)
        guard count >= 2 else { return [] }
        let length = Int((duration / Double(count)).rounded(.up))
        var starts: [Int] = []
        for index in 0..<count {
            let start = index * length
            // Never plan a final slice shorter than a second.
            guard Double(start) + 1 < duration else { break }
            starts.append(start)
        }
        guard starts.count >= 2 else { return [] }
        var plan: [TranscodeSegment] = []
        for index in starts.indices {
            let frames: Int? = index == starts.count - 1 ? nil : length * outputFrameRate
            plan.append(TranscodeSegment(start: starts[index], frames: frames))
        }
        return plan
    }

    /// Video-only slice written as a raw MPEG-1 elementary stream.
    public static func videoSegment(video: String, output: String, quality: MediaQuality,
                                    hardwareDecode: Bool, segment: TranscodeSegment) -> [String] {
        var args = inputPrefix(hardwareDecode: hardwareDecode)
        // Input seeking decodes from the previous keyframe and discards up to
        // the exact start, then restarts timestamps at zero for this slice.
        if segment.start > 0 { args += ["-ss", String(segment.start)] }
        args += ["-i", video, "-map", "0:v:0", "-an"] + videoEncoder(quality: quality)
        if let frames = segment.frames { args += ["-frames:v", String(frames)] }
        args += ["-f", "mpeg1video", output]
        return args
    }

    /// The whole audio track as MP2, padded past the video end so the final
    /// mux can stop exactly where the video stops.
    public static func audioTrack(audio: String, output: String, duration: Double) -> [String] {
        let limit = duration.isFinite && duration > 0 ? duration + 1 : 86_400
        return ["-hide_banner", "-loglevel", "error", "-xerror", "-y", "-i", audio,
                "-map", "0:a:0", "-vn"] + audioEncoder
            + ["-af", "apad", "-t", String(format: "%.3f", limit), "-f", "mp2", output]
    }

    /// Stream-copies the joined MPEG-1 video and MP2 audio into MPEG-TS.
    /// Raw elementary video has no timestamps, so they are generated at 30 fps.
    public static func mux(video: String, audio: String, output: String) -> [String] {
        ["-hide_banner", "-loglevel", "error", "-xerror", "-y",
         "-fflags", "+genpts", "-framerate", String(outputFrameRate), "-f", "mpegvideo", "-i", video,
         "-f", "mp3", "-i", audio,
         "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest",
         "-f", "mpegts", "-muxdelay", "0.001", output]
    }
}
