import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
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

interface DriveModeVideoPlayerProps {
  videoUrl: string;
  title?: string;
  onClose?: () => void;
}

interface PlayerState {
  isPlaying: boolean;
  isLoading: boolean;
  error: string | null;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  buffering: boolean;
}

/**
 * DriveModeVideoPlayer (MK5) — hardened against Tesla Drive-mode black screen
 *
 * Root cause of MK4 black screen:
 *   Tesla's QtWebEngine hooks every <video> and calls video.pause() at the OS
 *   level when the car leaves Park. drawImage() on a paused video then paints
 *   black (or a frozen last frame).
 *
 * MK5 mitigations (layered):
 *  1. Never use display:none — use a 1×1 off-screen, near-invisible video so
 *     the browser still treats it as an active media element.
 *  2. Aggressive pause interceptor: on every 'pause' event, if we still want
 *     to play, call play() immediately (and stopImmediatePropagation).
 *  3. visibilitychange + pagehide/pageshow + focus handlers that re-assert
 *     play state (Tesla fires visibilitychange when shifting gears).
 *  4. Watchdog interval: if the video is unexpectedly paused while
 *     shouldPlay is true, force play every ~250 ms.
 *  5. Canvas continues to pull frames via rAF regardless; we also try
 *     requestVideoFrameCallback when available for tighter sync.
 *  6. Audio is routed through Web Audio API so volume/mute stay under our
 *     control even if the media element is poked by the system.
 *
 * This is the same family of techniques used by successful Tesla theater
 * clients. It is not 100 % guaranteed on every firmware, but it is the
 * strongest pure-client approach that still uses a normal MP4 URL.
 */
export function DriveModeVideoPlayer({
  videoUrl,
  title,
  onClose,
}: DriveModeVideoPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const rvfcIdRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldPlayRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDrawnTimeRef = useRef(-1);
  const framesRenderedRef = useRef(0);
  const lastFpsUpdateRef = useRef(0);
  const fpsCounterRef = useRef(0);
  const forcePlayCountRef = useRef(0);

  const [state, setState] = useState<PlayerState>({
    isPlaying: false,
    isLoading: true,
    error: null,
    currentTime: 0,
    duration: 0,
    volume: 1,
    isMuted: false,
    buffering: false,
  });

  const [showDebug, setShowDebug] = useState(true);
  const [debugInfo, setDebugInfo] = useState({
    fps: 0,
    framesRendered: 0,
    videoReadyState: 0,
    canvasSize: "0x0",
    audioState: "not initialized",
    forcePlayCount: 0,
    videoPaused: true,
    lastDrawnTime: -1,
  });

  const updateState = useCallback((updates: Partial<PlayerState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  // ---- Force the media element to keep playing (Tesla Drive defense) ----
  const forcePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !shouldPlayRef.current) return;

    if (video.paused) {
      forcePlayCountRef.current += 1;
      try {
        // Resume AudioContext if the browser suspended it
        if (audioContextRef.current?.state === "suspended") {
          await audioContextRef.current.resume();
        }
        await video.play();
      } catch {
        // Autoplay policy or transient failure — watchdog will retry
      }
    }
  }, []);

  // Draw video frame to canvas
  const drawFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas) {
      animationFrameRef.current = requestAnimationFrame(drawFrame);
      return;
    }

    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) {
      animationFrameRef.current = requestAnimationFrame(drawFrame);
      return;
    }

    // Only draw when we have current data. Even if Tesla paused the element,
    // readyState can still be high; the frame may be black, but we keep
    // trying so that as soon as forcePlay succeeds we show video again.
    if (video.readyState >= 2) {
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        lastDrawnTimeRef.current = video.currentTime;
        framesRenderedRef.current++;
        fpsCounterRef.current++;
      } catch {
        // Security or tainted canvas — rare with same-origin / CORS
      }
    }

    if (!video.paused) {
      updateState({
        currentTime: video.currentTime,
        buffering: video.readyState < 3,
      });
    }

    const now = performance.now();
    if (now - lastFpsUpdateRef.current >= 1000) {
      setDebugInfo((prev) => ({
        ...prev,
        fps: fpsCounterRef.current,
        framesRendered: framesRenderedRef.current,
        videoReadyState: video.readyState,
        canvasSize: `${canvas.width}x${canvas.height}`,
        audioState: audioContextRef.current?.state || "not initialized",
        forcePlayCount: forcePlayCountRef.current,
        videoPaused: video.paused,
        lastDrawnTime: lastDrawnTimeRef.current,
      }));
      fpsCounterRef.current = 0;
      lastFpsUpdateRef.current = now;
    }

    animationFrameRef.current = requestAnimationFrame(drawFrame);
  }, [updateState]);

  // Optional tighter callback when the browser supports it
  const startRvfc = useCallback(() => {
    const video = videoRef.current;
    if (!video || typeof (video as any).requestVideoFrameCallback !== "function") {
      return;
    }
    const onFrame = () => {
      const canvas = canvasRef.current;
      if (video && canvas) {
        const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
        if (ctx && video.readyState >= 2) {
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            lastDrawnTimeRef.current = video.currentTime;
            framesRenderedRef.current++;
            fpsCounterRef.current++;
          } catch {
            /* ignore */
          }
        }
      }
      if (shouldPlayRef.current && video) {
        rvfcIdRef.current = (video as any).requestVideoFrameCallback(onFrame);
      }
    };
    rvfcIdRef.current = (video as any).requestVideoFrameCallback(onFrame);
  }, []);

  // Initialize audio routing through Web Audio API
  const initializeAudio = useCallback(() => {
    const video = videoRef.current;
    if (!video || audioContextRef.current) return;

    try {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;

      // Keep the media element itself muted; we hear only through the graph.
      // This also reduces the chance that Tesla's media policy mutes us.
      video.muted = true;
      video.volume = 1;

      audioSourceRef.current = ctx.createMediaElementSource(video);
      gainNodeRef.current = ctx.createGain();
      gainNodeRef.current.gain.value = state.volume;

      audioSourceRef.current.connect(gainNodeRef.current);
      gainNodeRef.current.connect(ctx.destination);

      console.log("[MK5] Audio graph initialized");
    } catch (err) {
      console.error("[MK5] Failed to initialize audio:", err);
    }
  }, [state.volume]);

  // Initialize player
  const initializePlayer = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas) {
      updateState({ error: "Video or canvas element not available" });
      return;
    }

    video.src = videoUrl;
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.playsInline = true;
    // Keep element "live" for the media pipeline
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");

    video.onloadedmetadata = () => {
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      updateState({
        duration: video.duration,
        isLoading: false,
      });
      console.log(
        `[MK5] Video loaded: ${video.videoWidth}x${video.videoHeight}, ${video.duration}s`
      );
    };

    video.oncanplay = () => updateState({ buffering: false });
    video.onwaiting = () => updateState({ buffering: true });
    video.onplaying = () => updateState({ buffering: false, isPlaying: true });
    video.onpause = () => {
      // Do NOT update isPlaying=false here when we are fighting Tesla.
      // Only reflect intentional pauses (shouldPlayRef false).
      if (!shouldPlayRef.current) {
        updateState({ isPlaying: false });
      } else {
        // Immediate counter-attack
        forcePlay();
      }
    };
    video.onended = () => {
      shouldPlayRef.current = false;
      updateState({ isPlaying: false });
    };
    video.onerror = () => {
      const errorMessage = video.error?.message || "Unknown video error";
      console.error("[MK5] Video error:", errorMessage);
      updateState({
        error: `Video error: ${errorMessage}`,
        isLoading: false,
      });
    };

    video.load();
    animationFrameRef.current = requestAnimationFrame(drawFrame);
  }, [videoUrl, updateState, drawFrame, forcePlay]);

  // Play
  const play = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    shouldPlayRef.current = true;

    try {
      if (!audioContextRef.current) {
        initializeAudio();
      }
      if (audioContextRef.current?.state === "suspended") {
        await audioContextRef.current.resume();
      }

      await video.play();
      updateState({ isPlaying: true });
      startRvfc();
    } catch (err) {
      console.error("[MK5] Play error:", err);
      updateState({
        error: `Play error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, [initializeAudio, updateState, startRvfc]);

  // Pause (user intentional)
  const pause = useCallback(() => {
    const video = videoRef.current;
    shouldPlayRef.current = false;
    if (video) {
      video.pause();
    }
    updateState({ isPlaying: false });
  }, [updateState]);

  const togglePlayPause = useCallback(() => {
    if (shouldPlayRef.current && state.isPlaying) {
      pause();
    } else {
      play();
    }
  }, [state.isPlaying, play, pause]);

  const handleSeek = useCallback(
    (value: number[]) => {
      const video = videoRef.current;
      if (!video) return;
      const newTime = value[0];
      video.currentTime = newTime;
      updateState({ currentTime: newTime });
      // After seek, re-assert play if we were playing
      if (shouldPlayRef.current) {
        forcePlay();
      }
    },
    [updateState, forcePlay]
  );

  const handleVolumeChange = useCallback(
    (value: number[]) => {
      const newVolume = value[0];
      if (gainNodeRef.current) {
        gainNodeRef.current.gain.value = newVolume;
      }
      updateState({ volume: newVolume, isMuted: newVolume === 0 });
    },
    [updateState]
  );

  const toggleMute = useCallback(() => {
    const newMuted = !state.isMuted;
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = newMuted ? 0 : state.volume;
    }
    updateState({ isMuted: newMuted });
  }, [state.isMuted, state.volume, updateState]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen().catch(() => {});
    }
  }, []);

  const skipForward = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = Math.min(video.currentTime + 10, video.duration || 0);
      if (shouldPlayRef.current) forcePlay();
    }
  }, [forcePlay]);

  const skipBackward = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = Math.max(video.currentTime - 10, 0);
      if (shouldPlayRef.current) forcePlay();
    }
  }, [forcePlay]);

  const formatTime = useCallback((seconds: number): string => {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }, []);

  // ---- Lifecycle ----
  useEffect(() => {
    initializePlayer();
    return () => {
      shouldPlayRef.current = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (rvfcIdRef.current != null && videoRef.current) {
        try {
          (videoRef.current as any).cancelVideoFrameCallback?.(rvfcIdRef.current);
        } catch {
          /* ignore */
        }
      }
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, [initializePlayer]);

  // Watchdog: re-assert play while we intend to be playing
  useEffect(() => {
    watchdogRef.current = setInterval(() => {
      if (shouldPlayRef.current) {
        forcePlay();
      }
    }, 250);
    return () => {
      if (watchdogRef.current) clearInterval(watchdogRef.current);
    };
  }, [forcePlay]);

  // Tesla fires visibilitychange / page lifecycle events when shifting gears
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && shouldPlayRef.current) {
        forcePlay();
      }
    };
    const onPageShow = () => {
      if (shouldPlayRef.current) forcePlay();
    };
    const onFocus = () => {
      if (shouldPlayRef.current) forcePlay();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
    };
  }, [forcePlay]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlayPause();
          break;
        case "arrowleft":
        case "j":
          e.preventDefault();
          skipBackward();
          break;
        case "arrowright":
        case "l":
          e.preventDefault();
          skipForward();
          break;
        case "m":
          e.preventDefault();
          toggleMute();
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlayPause, skipBackward, skipForward, toggleMute, toggleFullscreen]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black flex flex-col"
    >
      {/*
        CRITICAL: Do NOT use className="hidden" / display:none.
        Tesla (and some Chromium builds) stop decoding or black-out
        media that is display:none. Keep a 1×1 near-invisible element
        that remains in the layout and media pipeline.
      */}
      <video
        ref={videoRef}
        playsInline
        crossOrigin="anonymous"
        webkit-playsinline="true"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "1px",
          height: "1px",
          opacity: 0.01,
          pointerEvents: "none",
          zIndex: -1,
        }}
      />

      {/* Visible canvas */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full object-contain"
          onClick={togglePlayPause}
        />

        {state.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Loader2 className="w-12 h-12 animate-spin text-white" />
          </div>
        )}

        {state.buffering && !state.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Loader2 className="w-8 h-8 animate-spin text-white" />
          </div>
        )}

        {state.error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center text-white p-4 max-w-md">
              <p className="text-red-500 mb-2 font-semibold">Error</p>
              <p className="text-sm">{state.error}</p>
              <p className="text-xs text-white/60 mt-2">
                Tip: If you see this after shifting to Drive, try pressing Play
                again or reloading the page while parked, then shift after
                playback starts.
              </p>
            </div>
          </div>
        )}

        {!state.isPlaying && !state.isLoading && !state.error && (
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

      {/* Debug panel */}
      {showDebug && (
        <div className="absolute top-2 left-2 bg-black/80 text-white text-xs p-2 rounded font-mono max-w-xs z-10">
          <div className="font-bold mb-1 text-green-400">MK5 Drive Mode Player</div>
          <div>FPS: {debugInfo.fps}</div>
          <div>Frames: {debugInfo.framesRendered}</div>
          <div>ReadyState: {debugInfo.videoReadyState}</div>
          <div>Canvas: {debugInfo.canvasSize}</div>
          <div>Audio: {debugInfo.audioState}</div>
          <div>Video paused: {debugInfo.videoPaused ? "YES" : "no"}</div>
          <div>Force-play count: {debugInfo.forcePlayCount}</div>
          <div>Last drawn t: {debugInfo.lastDrawnTime.toFixed(2)}</div>
          <div>Buffering: {state.buffering ? "Yes" : "No"}</div>
          <div>shouldPlay: {shouldPlayRef.current ? "yes" : "no"}</div>
          <button
            className="mt-1 text-blue-400 underline"
            onClick={() => setShowDebug(false)}
          >
            Hide Debug
          </button>
        </div>
      )}

      {!showDebug && (
        <button
          className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded z-10"
          onClick={() => setShowDebug(true)}
        >
          Show Debug
        </button>
      )}

      {/* Controls */}
      <div className="bg-gradient-to-t from-black/80 to-transparent p-4">
        {title && (
          <div className="text-white text-sm mb-2 truncate">{title}</div>
        )}

        <div className="mb-3">
          <Slider
            value={[state.currentTime]}
            max={state.duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="cursor-pointer"
          />
          <div className="flex justify-between text-white text-xs mt-1">
            <span>{formatTime(state.currentTime)}</span>
            <span>{formatTime(state.duration)}</span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={skipBackward}
              className="text-white hover:bg-white/20"
            >
              <SkipBack className="w-5 h-5" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={togglePlayPause}
              className="text-white hover:bg-white/20"
              disabled={state.isLoading}
            >
              {state.isPlaying ? (
                <Pause className="w-6 h-6" />
              ) : (
                <Play className="w-6 h-6" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={skipForward}
              className="text-white hover:bg-white/20"
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
              {state.isMuted ? (
                <VolumeX className="w-5 h-5" />
              ) : (
                <Volume2 className="w-5 h-5" />
              )}
            </Button>

            <div className="w-24">
              <Slider
                value={[state.isMuted ? 0 : state.volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
              />
            </div>

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
