import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { JSMpegHttpSource } from "@/lib/jsmpeg-http-source";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Loader2,
  SkipBack,
  SkipForward,
} from "lucide-react";

declare global {
  interface Window {
    JSMpeg: any;
  }
}

interface BulletproofVideoPlayerProps {
  videoId: number;
  title?: string;
  onClose?: () => void;
  /** Optional duration in seconds (from library metadata) for UI only */
  durationHint?: number | null;
}

/**
 * BulletproofVideoPlayer — true Drive-mode playback for Tesla
 *
 * Architecture:
 *   Laptop ffmpeg → MPEG-TS (mpeg1video + mp2) over HTTP
 *   → JSMpeg (pure JS + WebGL/canvas) on the Tesla browser
 *
 * There is NO <video> element. Tesla's OS-level pause hook has nothing to
 * attach to, so the picture cannot go black when you shift into Drive.
 *
 * This is the same class of technique used by proven Tesla theater clients
 * (JSMpeg / MPEG1 canvas path).
 */
export function BulletproofVideoPlayer({
  videoId,
  title,
  onClose,
  durationHint,
}: BulletproofVideoPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [scriptReady, setScriptReady] = useState(false);
  const [showDebug, setShowDebug] = useState(true);
  const [debug, setDebug] = useState({
    playerState: "init",
    currentTime: 0,
    hasAudio: false,
  });

  // Load JSMpeg from the same origin (vendored into public/)
  useEffect(() => {
    if (window.JSMpeg) {
      setScriptReady(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "/jsmpeg.min.js";
    script.async = true;
    script.onload = () => setScriptReady(true);
    script.onerror = () =>
      setError(
        "Failed to load JSMpeg decoder. Check that /jsmpeg.min.js is served.",
      );
    document.head.appendChild(script);
    return () => {
      // leave the script; it is a singleton
    };
  }, []);

  const destroyPlayer = useCallback(() => {
    if (playerRef.current) {
      try {
        playerRef.current.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
    }
  }, []);

  // Create / recreate the JSMpeg player when script + canvas are ready
  useEffect(() => {
    if (!scriptReady || !canvasRef.current || !window.JSMpeg) return;

    destroyPlayer();
    setIsLoading(true);
    setError(null);

    const url = `/api/stream/${videoId}.ts`;

    try {
      const player = new window.JSMpeg.Player(url, {
        source: JSMpegHttpSource,
        loop: false,
        canvas: canvasRef.current,
        autoplay: true,
        audio: true,
        video: true,
        // Larger buffers help on flaky hotspot links
        videoBufferSize: 1024 * 1024 * 2,
        audioBufferSize: 128 * 1024,
        // Throttle decode a bit so the Tesla CPU stays happy
        disableGl: false, // prefer WebGL when available
        onSourceEstablished: () => {
          setIsLoading(false);
          setIsPlaying(true);
          setDebug((d) => ({ ...d, playerState: "source-ok" }));
        },
        onSourceCompleted: () => {
          setDebug((d) => ({ ...d, playerState: "loaded" }));
        },
        onSourceError: (message: string) => {
          setError(message);
          setIsLoading(false);
          setIsPlaying(false);
        },
        onPlay: () => setIsPlaying(true),
        onPause: () => setIsPlaying(false),
        onEnded: () => setIsPlaying(false),
        onStalled: () => setIsLoading(true),
        onVideoDecode: () => setIsLoading(false),
      });

      playerRef.current = player;
      player.audioOut?.context?.resume().catch(() => {});
      player.audioOut?.unlock?.();
      setDebug((d) => ({
        ...d,
        playerState: "playing",
        hasAudio: !!player.audio,
      }));
    } catch (err) {
      console.error("[Bulletproof] player create failed", err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    }

    return () => destroyPlayer();
  }, [scriptReady, videoId, destroyPlayer]);

  // Debug ticker
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      setDebug((d) => ({
        ...d,
        currentTime: p.currentTime ?? 0,
        playerState: p.paused ? "paused" : "playing",
      }));
    }, 500);
    return () => clearInterval(id);
  }, []);

  const play = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.audioOut?.context?.resume().catch(() => {});
      p.audioOut?.unlock?.();
      p.play();
      setIsPlaying(true);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const pause = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.pause();
      setIsPlaying(false);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const toggleMute = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    const next = !isMuted;
    try {
      if (p.audio) {
        p.audio.volume = next ? 0 : volume;
      }
      // Some builds expose volume on the player itself
      if (typeof p.volume === "number") {
        p.volume = next ? 0 : volume;
      }
    } catch {
      /* ignore */
    }
    setIsMuted(next);
  }, [isMuted, volume]);

  const setVol = useCallback(
    (v: number) => {
      const p = playerRef.current;
      setVolume(v);
      if (v > 0 && isMuted) setIsMuted(false);
      try {
        if (p?.audio) p.audio.volume = v;
        if (p && typeof p.volume === "number") p.volume = v;
      } catch {
        /* ignore */
      }
    },
    [isMuted],
  );

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

  // Seeking in progressive MPEG-TS via JSMpeg is limited. Best-effort:
  // destroy and restart (starts near the beginning). For true random access
  // a future version can add -ss support on the ffmpeg side.
  const restart = useCallback(() => {
    // Force the effect to re-run by toggling a key — simplest is to destroy
    // and recreate with the same URL (browser will re-request the stream).
    destroyPlayer();
    setIsLoading(true);
    // Small delay then recreate
    setTimeout(() => {
      if (!canvasRef.current || !window.JSMpeg) return;
      const url = `/api/stream/${videoId}.ts`;
      try {
        const player = new window.JSMpeg.Player(url, {
          source: JSMpegHttpSource,
          loop: false,
          canvas: canvasRef.current,
          autoplay: true,
          audio: true,
          video: true,
          videoBufferSize: 1024 * 1024 * 2,
          audioBufferSize: 128 * 1024,
          onSourceEstablished: () => {
            setIsLoading(false);
            setIsPlaying(true);
          },
          onSourceError: (message: string) => {
            setError(message);
            setIsLoading(false);
            setIsPlaying(false);
          },
          onPlay: () => setIsPlaying(true),
          onPause: () => setIsPlaying(false),
          onEnded: () => setIsPlaying(false),
          onStalled: () => setIsLoading(true),
          onVideoDecode: () => setIsLoading(false),
        });
        playerRef.current = player;
        player.audioOut?.context?.resume().catch(() => {});
        player.audioOut?.unlock?.();
        setIsPlaying(true);
      } catch (err) {
        setError(String(err));
        setIsLoading(false);
      }
    }, 100);
  }, [destroyPlayer, videoId]);

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black flex flex-col select-none"
    >
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full"
          style={{ imageRendering: "auto" }}
          onClick={togglePlayPause}
        />

        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 gap-3">
            <Loader2 className="w-12 h-12 animate-spin text-white" />
            <p className="text-white/80 text-sm">
              Starting bulletproof stream…
            </p>
            <p className="text-white/50 text-xs">
              ffmpeg → MPEG-TS → JSMpeg (no &lt;video&gt;)
            </p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6">
            <div className="text-center text-white max-w-md">
              <p className="text-red-400 font-semibold mb-2">Playback error</p>
              <p className="text-sm mb-4">{error}</p>
              <Button variant="secondary" onClick={restart}>
                Retry
              </Button>
            </div>
          </div>
        )}

        {!isPlaying && !isLoading && !error && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer"
            onClick={togglePlayPause}
          >
            <div className="bg-white/20 rounded-full p-4">
              <Play className="w-16 h-16 text-white" />
            </div>
          </div>
        )}
      </div>

      {showDebug && (
        <div className="absolute top-2 left-2 bg-black/85 text-white text-xs p-2 rounded font-mono max-w-xs z-10">
          <div className="font-bold text-emerald-400 mb-1">
            Bulletproof (JSMpeg)
          </div>
          <div>State: {debug.playerState}</div>
          <div>Time: {formatTime(debug.currentTime)}</div>
          <div>Audio: {debug.hasAudio ? "yes" : "no"}</div>
          <div>Video ID: {videoId}</div>
          <div className="text-white/50 mt-1">
            No &lt;video&gt; element — Tesla cannot black it out
          </div>
          <button
            className="mt-1 text-blue-400 underline"
            onClick={() => setShowDebug(false)}
          >
            Hide
          </button>
        </div>
      )}
      {!showDebug && (
        <button
          className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded z-10"
          onClick={() => setShowDebug(true)}
        >
          Debug
        </button>
      )}

      <div className="bg-gradient-to-t from-black/90 to-transparent p-4">
        {title && (
          <div className="text-white text-sm mb-2 truncate">{title}</div>
        )}
        <div className="flex justify-between text-white/70 text-xs mb-2">
          <span>{formatTime(debug.currentTime)}</span>
          <span>{durationHint ? formatTime(durationHint) : "—"}</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={restart}
              className="text-white hover:bg-white/20"
              title="Restart stream"
            >
              <SkipBack className="w-5 h-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={togglePlayPause}
              className="text-white hover:bg-white/20"
              disabled={isLoading}
            >
              {isPlaying ? (
                <Pause className="w-6 h-6" />
              ) : (
                <Play className="w-6 h-6" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={restart}
              className="text-white hover:bg-white/20"
              title="Restart"
            >
              <SkipForward className="w-5 h-5" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleMute}
              className="text-white hover:bg-white/20"
            >
              {isMuted ? (
                <VolumeX className="w-5 h-5" />
              ) : (
                <Volume2 className="w-5 h-5" />
              )}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={(e) => setVol(parseFloat(e.target.value))}
              className="w-24 accent-white"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleFullscreen}
              className="text-white hover:bg-white/20"
            >
              <Maximize className="w-5 h-5" />
            </Button>
            {onClose && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="text-white hover:bg-white/20"
              >
                Close
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
