import Foundation

public enum TranscodeArguments {
    // Local paths only: media downloads use URLSession, never FFmpeg network protocols.
    public static func make(video: String, audio: String? = nil, output: String,
                            quality: MediaQuality = .balanced, hardwareDecode: Bool = false) -> [String] {
        // Let FFmpeg size its worker pools for the current iPhone. The old
        // fixed two-thread cap made preparation crawl on newer devices.
        var args = ["-hide_banner", "-loglevel", "error", "-xerror", "-y", "-filter_threads", "0", "-threads", "0"]
        // Download hardware-decoded frames to ordinary memory automatically;
        // the MPEG-1 encoder and scale filter still operate on CPU frames.
        if hardwareDecode { args += ["-hwaccel", "videotoolbox"] }
        args += ["-i", video]
        if let audio {
            args += ["-i", audio, "-map", "0:v:0", "-map", "1:a:0"]
        } else { args += ["-map", "0:v:0", "-map", "0:a:0?"] }
        args += [
            "-f", "mpegts", "-codec:v", "mpeg1video",
            // Cap high-frame-rate inputs before resizing. Preserve lower source
            // rates here; output -r performs the final conversion to 30 fps.
            "-vf", "fps=fps='if(gt(source_fps,0),min(30,source_fps),30)',scale=\(quality.width):\(quality.rawValue):force_original_aspect_ratio=decrease:force_divisible_by=2,pad=\(quality.width):\(quality.rawValue):(ow-iw)/2:(oh-ih)/2,setsar=1",
            "-r", "30", "-pix_fmt", "yuv420p", "-b:v", quality.bitrate, "-maxrate", "1800k",
            "-bufsize", "800k", "-bf", "0", "-g", "30", "-threads", "0",
            "-codec:a", "mp2", "-b:a", "128k", "-ar", "44100", "-ac", "2",
            "-muxdelay", "0.001", output
        ]
        return args
    }
}
