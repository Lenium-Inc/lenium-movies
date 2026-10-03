import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize,
  Settings,
  Languages,
  Volume2 as Volume2Icon,
  X,
  SkipBack,
  SkipForward,
} from "lucide-react";
import Hls from "hls.js";
import { formatPlayerTime } from "@/lib/format";
import { subtitleTrackUrl, type StreamSubtitle } from "@/services/api";

export interface StreamVariant {
  quality: string | null;
  url: string;
  type: "hls" | "dash" | "mp4";
}

/**
 * Extract the variant ladder from a parsed HLS master playlist.
 *
 * The resolver usually returns a *single* `.m3u8` rather than one URL per
 * rendition, so the quality list cannot come from the source array -- the rungs
 * only exist once hls.js has walked the manifest. Returns unique `<height>p`
 * labels, tallest first.
 */
export const deriveHlsLevels = (
  instance: Hls | null | undefined
): { quality: string; height: number }[] => {
  const levels = (instance?.levels ?? []) as { height?: number }[];
  const seen = new Set<string>();
  const rungs: { quality: string; height: number }[] = [];
  for (const level of levels) {
    const height = Number(level.height) || 0;
    if (!height) continue;
    const quality = `${height}p`;
    if (seen.has(quality)) continue;
    seen.add(quality);
    rungs.push({ quality, height });
  }
  return rungs.sort((a, b) => b.height - a.height);
};

/**
 * Turn a resolver subtitle descriptor into the attributes a `<track>` needs.
 *
 * `src` deliberately points at the backend's `/api/subtitles` proxy rather than
 * the raw archive.org link the resolver returns. A `<track>` is fetched with
 * CORS, and Archive.org's download nodes send no `Access-Control-Allow-Origin`,
 * so a direct link is rejected by the browser and no cue ever renders. Routing
 * through the proxy is what makes the track load at all.
 *
 * `default` is only set for the first track: browsers auto-enable a
 * `default` track, and several defaults means several languages overwrite each
 * other. The menu still starts on "Off", so nothing is spoken over the audio
 * until the viewer chooses.
 */
export interface SubtitleTrack {
  key: string;
  label: string;
  srcLang: string;
  src: string;
  default: boolean;
}

export const buildSubtitleTracks = (
  subtitles: StreamSubtitle[] = []
): SubtitleTrack[] =>
  subtitles
    .filter(
      (track): track is StreamSubtitle =>
        Boolean(track?.url) && Boolean(track?.lang)
    )
    .map((track, index) => ({
      key: `${track.lang}-${index}`,
      label: track.label || track.lang,
      srcLang: track.lang,
      src: subtitleTrackUrl(track.url),
      default: index === 0,
    }));

export interface VideoPlayerProps {
  streamUrl: string;
  title: string;
  poster: string;
  onClose: () => void;
  variants?: StreamVariant[];
  /** WebVTT tracks resolved for the current source (see `/api/subtitles`). */
  subtitles?: StreamSubtitle[];
  currentQuality?: string;
  onQualityChange?: (quality: string) => void;
  isLoading?: boolean;
  onSourceError?: () => void;
  hideCloseButton?: boolean;
  autoPlay?: boolean;
  /**
   * The page is silently cycling through alternate sources after a failure.
   * Buffering/error chrome is suppressed so ambient poster stays on screen.
   */
  autoCycling?: boolean;
  /**
   * Playback position, reported as it advances.
   *
   * This is the only place the player knows how far in someone is, and the
   * Continue Watching shelf is built from exactly that number, so the page owns
   * the recording and the player only reports. Sampling is throttled inside the
   * component: `timeupdate` fires several times a second and every call here is
   * a storage write on the page's side.
   */
  onProgress?: (progress: { seconds: number; durationSeconds: number }) => void;
}

const QUALITY_ORDER = ["4K", "1080p", "720p", "480p", "360p", "Auto"] as const;

/**
 * Seconds of playback between progress reports. Fine enough that the resume
 * point someone sees in Continue Watching is close to where they stopped, coarse
 * enough that it is not a storage write several times a second.
 */
const RESUME_SAMPLE_SECONDS = 10;
export type QualityOption = (typeof QUALITY_ORDER)[number];

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  streamUrl,
  title,
  poster,
  onClose,
  variants = [],
  subtitles = [],
  currentQuality: initialQuality = "Auto",
  onQualityChange,
  isLoading: externalIsLoading = false,
  onSourceError,
  hideCloseButton = false,
  autoPlay = true,
  autoCycling = false,
  onProgress,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(autoPlay);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [progress, setProgress] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [qualityMenuOpen, setQualityMenuOpen] = useState<boolean>(false);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState<boolean>(false);
  const [currentQuality, setCurrentQuality] = useState<string>(initialQuality);
  const [hlsLevels, setHlsLevels] = useState<
    { quality: string; height: number }[]
  >([]);
  const [hlsQuality, setHlsQuality] = useState<string>("Auto");
  const [posterSettled, setPosterSettled] = useState<boolean>(false);
  // "Off" or a `srcLang` from `subtitleTracks`. Held as a language code rather
  // than a label so two tracks sharing a display name stay distinguishable.
  const [currentSubtitles, setCurrentSubtitles] = useState<string>("Off");
  const subtitleTracks = useMemo(
    () => buildSubtitleTracks(subtitles),
    [subtitles]
  );
  // `currentSubtitles` is a language code; the chip shows the human label.
  const currentSubtitleLabel = useMemo(
    () =>
      currentSubtitles === "Off"
        ? "Off"
        : (subtitleTracks.find(t => t.srcLang === currentSubtitles)?.label ??
          currentSubtitles),
    [currentSubtitles, subtitleTracks]
  );
  const [hasUserInteracted, setHasUserInteracted] = useState<boolean>(false);
  const lastProgressRef = useRef<{ seconds: number; duration: number }>({
    seconds: 0,
    duration: 0,
  });

  const videoRef = useRef<HTMLVideoElement>(null);

  // Enabling a track is a property of the loaded media element, so it has to be
  // reapplied whenever the element, the track list, or the selection changes --
  // and again after `loadedmetadata`, because a source swap discards the modes
  // that were set on the previous media.
  const applySubtitleMode = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const list = video.textTracks;
    for (let i = 0; i < list.length; i += 1) {
      const track = list[i];
      const shouldShow =
        currentSubtitles !== "Off" && track.language === currentSubtitles;
      track.mode = shouldShow ? "showing" : "disabled";
    }
  }, [currentSubtitles]);

  useEffect(() => {
    applySubtitleMode();
  }, [applySubtitleMode, subtitleTracks, streamUrl]);

  // A new source is a new position: the previous title's sample must not be
  // compared against this one's clock, or a fresh load looks like progress.
  useEffect(() => {
    lastProgressRef.current = { seconds: 0, duration: 0 };
  }, [streamUrl]);
  const playerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const posterImgRef = useRef<HTMLImageElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hlsRef = useRef<any>(null);

  const effectiveIsLoading = externalIsLoading || isLoading;

  const attemptAutoplay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const tryPlay = (muted: boolean) => {
      if (muted) {
        video.muted = true;
        setIsMuted(true);
      }
      const promise = video.play();
      if (promise) {
        promise
          .then(() => {
            setIsPlaying(true);
            setIsLoading(false);
          })
          .catch((err: unknown) => {
            const name = err instanceof DOMException ? err.name : "";
            if (!muted && name === "NotAllowedError") {
              // Autoplay is blocked without a user gesture — retry muted so the
              // video at least starts; the viewer can unmute from the overlay.
              tryPlay(true);
            } else {
              setIsPlaying(false);
              setIsLoading(false);
            }
          });
      }
    };

    tryPlay(false);
  }, []);

  useEffect(() => {
    if (initialQuality && initialQuality !== currentQuality) {
      setCurrentQuality(initialQuality);
    }
  }, [initialQuality]);

  const streamType = useMemo(() => {
    try {
      const pathname = new URL(streamUrl).pathname.toLowerCase();
      if (pathname.endsWith(".m3u8")) return "hls";
      if (pathname.endsWith(".mpd")) return "dash";
      return "mp4";
    } catch {
      return "mp4";
    }
  }, [streamUrl]);

  // Two ways a quality list can exist. Preferred: the ladder hls.js parsed out
  // of the master manifest, which works for a single `.m3u8` source. Fallback:
  // one URL per rendition handed over by the resolver.
  const qualityOptions = useMemo<string[]>(() => {
    if (hlsLevels.length > 1) {
      return hlsLevels.map(l => l.quality);
    }
    return variants.map(v => v.quality).filter((q): q is string => Boolean(q));
  }, [hlsLevels, variants]);

  // While the manifest ladder is in play the active rung is tracked separately,
  // because changing it is an in-player level switch rather than a source swap.
  const activeQuality = hlsLevels.length > 1 ? hlsQuality : currentQuality;

  const canChangeQuality = qualityOptions.length > 1;

  const initAmbientCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvasCtxRef.current = ctx;

    const fitCover = (source: CanvasImageSource, sw: number, sh: number) => {
      const w = canvas.width;
      const h = canvas.height;
      const scale = Math.max(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(source, 0, 0, sw, sh, (w - dw) / 2, (h - dh) / 2, dw, dh);
    };

    const paintPoster = () => {
      const posterImg = posterImgRef.current;
      if (!posterImg || !posterImg.complete || posterImg.naturalWidth === 0) {
        return;
      }
      const playerRect = playerRef.current?.getBoundingClientRect();
      if (!playerRect) return;
      canvas.width = playerRect.width;
      canvas.height = playerRect.height;
      fitCover(posterImg, posterImg.naturalWidth, posterImg.naturalHeight);
      ctx.filter = "blur(80px)";
      ctx.globalAlpha = 0.55;
      ctx.drawImage(
        canvas,
        0,
        0,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
      ctx.filter = "none";
      ctx.globalAlpha = 1;
    };

    const drawFrame = () => {
      const video = videoRef.current;
      const playerRect = playerRef.current?.getBoundingClientRect();
      if (!playerRect) {
        animationFrameRef.current = requestAnimationFrame(drawFrame);
        return;
      }
      if (!video) {
        paintPoster();
        animationFrameRef.current = requestAnimationFrame(drawFrame);
        return;
      }
      canvas.width = playerRect.width;
      canvas.height = playerRect.height;

      // No decodable video frame yet (loading / buffering / switched source):
      // keep the ambient canvas alive with the poster art instead of a black
      // void, so source changes never flash the player to pure black.
      if (!video.videoWidth || video.paused || video.ended) {
        if (!video.videoWidth) paintPoster();
        animationFrameRef.current = requestAnimationFrame(drawFrame);
        return;
      }

      const videoAspect = video.videoWidth / video.videoHeight;
      const canvasAspect = canvas.width / canvas.height;

      let drawWidth, drawHeight, drawX, drawY;

      if (videoAspect > canvasAspect) {
        drawHeight = canvas.height;
        drawWidth = canvas.height * videoAspect;
        drawX = (canvas.width - drawWidth) / 2;
        drawY = 0;
      } else {
        drawWidth = canvas.width;
        drawHeight = canvas.width / videoAspect;
        drawX = 0;
        drawY = (canvas.height - drawHeight) / 2;
      }

      ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);

      ctx.filter = "blur(80px)";
      ctx.globalAlpha = 0.4;
      ctx.drawImage(
        canvas,
        0,
        0,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
      ctx.filter = "none";
      ctx.globalAlpha = 1;

      animationFrameRef.current = requestAnimationFrame(drawFrame);
    };

    paintPoster();
    animationFrameRef.current = requestAnimationFrame(drawFrame);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    let hls: any = null;
    setIsLoading(true);
    // Ladder and poster are per-source; drop stale values so a manifest from
    // the previous mirror never leaks into the next one.
    setHlsLevels([]);
    setHlsQuality("Auto");
    setPosterSettled(false);

    // If the source stalls (no progress for a while) it is treated as a dead
    // source and handed back to the page so the failover loop can switch
    // mirrors/servers in the background. ~6s cadence keeps auto-cycles snappy.
    const STALL_TIMEOUT_MS = 6000;
    const startStallWatch = () => {
      if (stallTimerRef.current) return;
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        if (videoRef.current && videoRef.current.readyState < 3) {
          onSourceError?.();
        }
      }, STALL_TIMEOUT_MS);
    };
    const clearStallWatch = () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };

    const cleanup = () => {
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setIsLoading(false);
      clearStallWatch();
      initAmbientCanvas();
      attemptAutoplay();
    };

    const handleError = () => {
      clearStallWatch();
      // Reported, never rendered. The page owns the failure state: it walks the
      // candidate chain and keeps its own overlay up, so an error card painted
      // here would appear and vanish once per candidate on the way to the one
      // that works.
      onSourceError?.();
    };

    const handleWaiting = () => {
      setIsLoading(true);
      startStallWatch();
    };
    const handleStalled = () => {
      setIsLoading(true);
      startStallWatch();
    };
    const handlePlaying = () => {
      clearStallWatch();
      setIsLoading(false);
      setIsPlaying(true);
    };
    const handleCanPlay = () => {
      clearStallWatch();
      setIsLoading(false);
    };
    const handleEnded = () => setIsPlaying(false);
    // First frame is actually decodable -> the poster has done its job. This
    // covers progressive MP4 and native (Safari) HLS, which never emit
    // MANIFEST_PARSED.
    const handleLoadedData = () => setPosterSettled(true);

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("error", handleError);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("stalled", handleStalled);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("ended", handleEnded);
    video.addEventListener("loadeddata", handleLoadedData);

    if (streamType === "hls") {
      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setHlsLevels(deriveHlsLevels(hls));
          setIsLoading(false);
          setPosterSettled(true);
          attemptAutoplay();
          initAmbientCanvas();
        });

        hls.on(
          Hls.Events.ERROR,
          (_event: unknown, data: { fatal?: boolean }) => {
            if (data.fatal) {
              hls?.destroy();
              onSourceError?.();
            }
          }
        );
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
      } else {
        onSourceError?.();
      }
    } else if (streamType === "dash") {
      if (video.canPlayType("application/dash+xml")) {
        video.src = streamUrl;
      } else {
        onSourceError?.();
      }
    } else {
      video.src = streamUrl;
    }

    hlsRef.current = hls;

    return () => {
      cleanup();
      clearStallWatch();
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("error", handleError);
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("stalled", handleStalled);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("loadeddata", handleLoadedData);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [
    streamUrl,
    streamType,
    initAmbientCanvas,
    attemptAutoplay,
    onSourceError,
    autoCycling,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (!isNaN(video.duration)) {
        setProgress((video.currentTime / video.duration) * 100);
      }
      if (!onProgress || isNaN(video.duration) || video.duration <= 0) return;
      const seconds = Math.floor(video.currentTime);
      // Throttled to a sample every RESUME_SAMPLE_SECONDS of playback. The
      // alternative is writing to storage four times a second per viewer.
      if (seconds - lastProgressRef.current.seconds < RESUME_SAMPLE_SECONDS)
        return;
      lastProgressRef.current = {
        seconds,
        duration: Math.floor(video.duration),
      };
      onProgress({
        seconds,
        durationSeconds: Math.floor(video.duration),
      });
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, [onProgress]);

  // Preload the poster so the ambient canvas always has art to paint, even
  // before the first video frame decodes.
  useEffect(() => {
    const img = new Image();
    posterImgRef.current = img;
    img.src = poster;
    img.onload = () => {
      posterImgRef.current = img;
      initAmbientCanvas();
    };
    img.onerror = () => {
      posterImgRef.current = null;
    };
    return () => {
      posterImgRef.current = null;
    };
  }, [poster, initAmbientCanvas]);

  const handleMouseMove = useCallback(() => {
    if (!hasUserInteracted) setHasUserInteracted(true);
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  }, [hasUserInteracted, isPlaying]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      video
        .play()
        .then(() => {
          setIsPlaying(true);
        })
        .catch(() => {
          setIsPlaying(false);
        });
    }
  }, [isPlaying]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      if (!video || isNaN(duration)) return;
      const seekTime = (parseFloat(e.target.value) / 100) * duration;
      video.currentTime = seekTime;
      setProgress(parseFloat(e.target.value));
    },
    [duration]
  );

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      if (!video) return;
      const newVol = parseFloat(e.target.value);
      setVolume(newVol);
      setIsMuted(newVol === 0);
      video.volume = newVol;
    },
    []
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isMuted) {
      video.volume = volume || 0.5;
      setIsMuted(false);
    } else {
      video.volume = 0;
      setIsMuted(true);
    }
  }, [isMuted, volume]);

  const toggleFullscreen = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!document.fullscreenElement) {
      player.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }, []);

  const switchQuality = useCallback(
    (quality: string) => {
      // Manifest ladder: hand the level straight to hls.js. No reload, no
      // buffer restart, and the resolver is never asked for a second URL.
      if (hlsLevels.length > 1) {
        const instance = hlsRef.current;
        if (!instance) return;
        if (quality === "Auto") {
          instance.currentLevel = -1;
        } else {
          const index = (instance.levels ?? []).findIndex(
            (level: { height?: number }) =>
              `${Number(level.height) || 0}p` === quality
          );
          if (index === -1) return;
          instance.currentLevel = index;
        }
        setHlsQuality(quality);
        setQualityMenuOpen(false);
        return;
      }

      if (quality === currentQuality) return;
      const variant = variants.find(v => v.quality === quality);
      if (!variant) return;

      setCurrentQuality(quality);
      setIsLoading(true);
      setQualityMenuOpen(false);
      onQualityChange?.(quality);
    },
    [hlsLevels, currentQuality, variants, onQualityChange]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      const video = videoRef.current;
      if (!video) return;

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case "ArrowRight":
          e.preventDefault();
          video.currentTime = Math.min(duration, video.currentTime + 10);
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          setVolume(video.volume);
          setIsMuted(false);
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          setVolume(video.volume);
          if (video.volume === 0) setIsMuted(true);
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "Escape":
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
          break;
      }
    },
    [togglePlay, toggleMute, toggleFullscreen, duration]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const preventContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div
      ref={playerRef}
      onMouseMove={handleMouseMove}
      onContextMenu={preventContextMenu}
      className="relative w-full h-full aspect-video rounded-2xl overflow-hidden bg-black select-none font-sans"
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 -z-10 w-full h-full"
        aria-hidden="true"
      />

      {/*
        Buffering only. A failure is reported to the page and never drawn here:
        the page is already walking the candidate chain behind one overlay, so an
        error card with a retry button inside the frame would appear and vanish
        once per candidate on the way to the source that works -- and its retry
        would restart a chain that had just been proven to need a different
        candidate, not a second attempt at the same one.
      */}
      {effectiveIsLoading && !autoCycling && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="pointer-events-none flex flex-col items-center gap-4 rounded-2xl bg-black/45 px-8 py-6 text-center backdrop-blur-md">
            <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
            <p className="text-sm font-medium tracking-wider text-white/90">
              Buffering video...
            </p>
          </div>
        </div>
      )}

      {/* Held at full opacity until a real frame is decodable. The native
          `poster` attribute clears as soon as the element paints, which left an
          empty box while hls.js fetched the manifest and opening segments. */}
      {poster && (
        <img
          src={poster}
          alt=""
          aria-hidden
          draggable={false}
          className={`pointer-events-none absolute inset-0 z-20 h-full w-full object-cover transition-opacity duration-500 ${
            posterSettled ? "opacity-0" : "opacity-100"
          }`}
        />
      )}

      <video
        ref={videoRef}
        poster={poster}
        className="w-full h-full object-contain cursor-pointer"
        onClick={togglePlay}
        onContextMenu={preventContextMenu}
        playsInline
        preload="metadata"
        controls={false}
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
        onDragStart={preventContextMenu}
      >
        {subtitleTracks.map(track => (
          <track
            key={track.key}
            kind="subtitles"
            src={track.src}
            srcLang={track.srcLang}
            label={track.label}
            default={track.default}
          />
        ))}
      </video>

      <div
        className={`absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-end transition-opacity duration-300 z-30 ${
          showControls && hasUserInteracted
            ? "opacity-100"
            : "opacity-0 pointer-events-none"
        }`}
      >
        {!hideCloseButton && (
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-black/40 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white transition-all flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div
        className={`absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex flex-col gap-2.5 transition-opacity duration-300 z-30 ${
          showControls && hasUserInteracted
            ? "opacity-100"
            : "opacity-0 pointer-events-none"
        }}`}
      >
        <div className="relative group flex items-center">
          <input
            type="range"
            min="0"
            max="100"
            value={progress || 0}
            onChange={handleSeek}
            className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-violet-600 hover:h-2 transition-all"
            onMouseDown={() => {
              if (controlsTimeoutRef.current)
                clearTimeout(controlsTimeoutRef.current);
            }}
            onMouseUp={() => handleMouseMove()}
          />
        </div>

        <div className="flex items-center justify-between text-white flex-wrap gap-3">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <button
              onClick={togglePlay}
              className="hover:text-violet-500 transition-colors flex-shrink-0"
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current" />
              )}
            </button>

            <button
              onClick={() => {
                const v = videoRef.current;
                if (v) v.currentTime -= 10;
              }}
              className="hover:text-violet-500 transition-colors flex-shrink-0"
              aria-label="Rewind 10s"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
            <button
              onClick={() => {
                const v = videoRef.current;
                if (v) v.currentTime += 10;
              }}
              className="hover:text-violet-500 transition-colors flex-shrink-0"
              aria-label="Forward 10s"
            >
              <RotateCw className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 group flex-shrink-0">
              <button
                onClick={toggleMute}
                className="hover:text-violet-500 transition-colors flex-shrink-0"
                aria-label={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-5 h-5" />
                ) : (
                  <Volume2 className="w-5 h-5" />
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-20 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-white hover:accent-violet-500 transition-all"
                onMouseDown={() => {
                  if (controlsTimeoutRef.current)
                    clearTimeout(controlsTimeoutRef.current);
                }}
              />
            </div>

            <span className="text-xs font-medium text-white/80 flex-shrink-0">
              {formatPlayerTime(videoRef.current?.currentTime || 0)} /{" "}
              {formatPlayerTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-3 relative flex-shrink-0">
            <div className="relative z-40">
              <button
                onClick={() => {
                  setSubtitleMenuOpen(!subtitleMenuOpen);
                  setQualityMenuOpen(false);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                aria-label="Audio & Subtitles"
              >
                <Languages className="w-4 h-4" />
                <span>{currentSubtitleLabel}</span>
              </button>
              {subtitleMenuOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-56 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                  <div className="px-4 py-2 border-b border-white/10">
                    <p className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
                      Audio Track
                    </p>
                    <div className="space-y-1">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setCurrentSubtitles("Native");
                          setSubtitleMenuOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors flex items-center gap-2"
                      >
                        <Volume2Icon className="w-3 h-3" />
                        <span>Native Audio</span>
                      </button>
                    </div>
                  </div>
                  {subtitleTracks.length > 0 && (
                    <div className="px-4 py-2">
                      <p className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
                        Subtitles
                      </p>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {["Off", ...subtitleTracks.map(t => t.srcLang)].map(
                          sub => {
                            const label =
                              sub === "Off"
                                ? "Off"
                                : (subtitleTracks.find(t => t.srcLang === sub)
                                    ?.label ?? sub);
                            return (
                              <button
                                key={sub}
                                onClick={e => {
                                  e.stopPropagation();
                                  setCurrentSubtitles(sub);
                                  setSubtitleMenuOpen(false);
                                }}
                                className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${
                                  currentSubtitles === sub
                                    ? "text-violet-500 font-bold"
                                    : "text-white"
                                }`}
                              >
                                {label}
                              </button>
                            );
                          }
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {canChangeQuality && (
              <div className="relative z-40">
                <button
                  onClick={() => {
                    setQualityMenuOpen(!qualityMenuOpen);
                    setSubtitleMenuOpen(false);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                >
                  <Settings className="w-4 h-4" />
                  <span>{activeQuality}</span>
                </button>
                {qualityMenuOpen && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-28 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                    {qualityOptions.map(quality => (
                      <button
                        key={quality}
                        onClick={e => {
                          e.stopPropagation();
                          switchQuality(quality);
                        }}
                        className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${
                          activeQuality === quality
                            ? "text-violet-500 font-bold"
                            : "text-white"
                        }`}
                      >
                        {quality}
                      </button>
                    ))}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        switchQuality("Auto");
                      }}
                      className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${
                        activeQuality === "Auto"
                          ? "text-violet-500 font-bold"
                          : "text-white"
                      }`}
                    >
                      Auto
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={toggleFullscreen}
              className="hover:text-violet-500 transition-colors flex-shrink-0"
              aria-label="Fullscreen"
            >
              <Maximize className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {!hasUserInteracted && !effectiveIsLoading && (
        <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
          <button
            onClick={() => {
              setHasUserInteracted(true);
              togglePlay();
            }}
            className="w-20 h-20 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center transition-all hover:bg-white/30 hover:scale-110"
            aria-label="Play"
          >
            <Play className="w-8 h-8 text-white ml-1" />
          </button>
        </div>
      )}
    </div>
  );
};
