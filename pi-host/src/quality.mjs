export const QUALITIES = [360, 540, 720, 1080];
const PROFILES = {
  360: {width:640, bitrate:500, maximum:650},
  540: {width:960, bitrate:1000, maximum:1200},
  720: {width:1280, bitrate:2000, maximum:2400},
  1080: {width:1920, bitrate:4500, maximum:5400},
};
export function parseQuality(value) {
  const quality = Number(String(value).replace(/p$/, ""));
  if (!QUALITIES.includes(quality)) throw new Error("Quality must be 360p, 540p, 720p, or 1080p.");
  return quality;
}
export function encodeArgs(input, output, quality) {
  const height = parseQuality(quality), profile = PROFILES[height];
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", input,
    "-vf", `scale=${profile.width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${profile.width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "mpeg1video", "-threads", "2",
    "-b:v", `${profile.bitrate}k`, "-maxrate", `${profile.maximum}k`, "-bufsize", `${profile.maximum * 2}k`,
    "-bf", "0", "-g", "30", "-c:a", "mp2", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-muxdelay", "0.001", "-mpegts_flags", "+resend_headers", "-f", "mpegts", output];
}
