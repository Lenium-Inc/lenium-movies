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
  RefreshCw,
  Languages,
  Volume2 as Volume2Icon,
  X,
  SkipBack,
  SkipForward,
} from "lucide-react";
import Hls from "hls.js";

export interface StreamVariant {
  quality: string | null;
  url: string;
  type: "hls" | "dash" | "mp4";
}

export interface VideoPlayerProps {
  streamUrl: string;
  title: string;
  poster: string;
  onClose: () => void;
  variants?: StreamVariant[];
  currentQuality?: string;
  onQualityChange?: (quality: string) => void;
  isLoading?: boolean;
  playbackError?: string | null;
  onRetry?: () => void;
  onSourceError?: () => void;
  hideCloseButton?: boolean;
  autoPlay?: boolean;
}

const QUALITY_ORDER = ["4K", "1080p", "720p", "480p", "360p", "Auto"] as const;
export type QualityOption = (typeof QUALITY_ORDER)[number];

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  streamUrl,
  title,
  poster,
  onClose,
  variants = [],
  currentQuality: initialQuality = "Auto",
  onQualityChange,
  isLoading: externalIsLoading = false,
  playbackError: externalPlaybackError = null,
  onRetry,
  onSourceError,
  hideCloseButton = false,
  autoPlay = true,
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
  const [currentSubtitles, setCurrentSubtitles] = useState<string>("Off");
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [hasUserInteracted, setHasUserInteracted] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement>(null);
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
    if (externalPlaybackError) {
      setPlaybackError(externalPlaybackError);
    }
  }, [externalPlaybackError]);

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

  const canChangeQuality = variants.length > 1;

  const initAmbientCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvasCtxRef.current = ctx;

    const fitCover = (
      source: CanvasImageSource,
      sw: number,
      sh: number
    ) => {
      const w = canvas.width;
      const h = canvas.height;
      const scale = Math.max(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(
        source,
        0,
        0,
        sw,
        sh,
        (w - dw) / 2,
        (h - dh) / 2,
        dw,
        dh
      );
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
      fitCover(
        posterImg,
        posterImg.naturalWidth,
        posterImg.naturalHeight
      );
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
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
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
    setPlaybackError(null);
    setIsLoading(true);

    // If the source stalls (no progress for a while) it is treated as a dead
    // source and handed back to the page so the failover loop can switch
    // mirrors/servers in the background.
    const STALL_TIMEOUT_MS = 12000;
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
      setPlaybackError(
        "Stream currently unavailable. Click to retry source."
      );
      setIsLoading(false);
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

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("error", handleError);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("stalled", handleStalled);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("ended", handleEnded);

    if (streamType === "hls") {
      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoading(false);
          attemptAutoplay();
          initAmbientCanvas();
        });

        hls.on(Hls.Events.ERROR, (_event: unknown, data: { fatal?: boolean }) => {
          if (data.fatal) {
            setPlaybackError(
              "Stream currently unavailable. Click to retry source."
            );
            setIsLoading(false);
            hls?.destroy();
            onSourceError?.();
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
      } else {
        setPlaybackError("Stream currently unavailable. Click to retry source.");
        setIsLoading(false);
        onSourceError?.();
      }
    } else if (streamType === "dash") {
      if (video.canPlayType("application/dash+xml")) {
        video.src = streamUrl;
      } else {
        setPlaybackError("Stream currently unavailable. Click to retry source.");
        setIsLoading(false);
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
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [streamUrl, streamType, initAmbientCanvas, attemptAutoplay, onSourceError]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (!isNaN(video.duration)) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, []);

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
      if (quality === currentQuality) return;
      const variant = variants.find((v) => v.quality === quality);
      if (!variant) return;

      setCurrentQuality(quality);
      setIsLoading(true);
      setPlaybackError(null);
      setQualityMenuOpen(false);
      onQualityChange?.(quality);
    },
    [currentQuality, variants, onQualityChange]
  );

  const formatTime = useCallback((seconds: number) => {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  }, []);

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

  const handleRetry = useCallback(() => {
    setPlaybackError(null);
    setIsLoading(true);
    onRetry?.();
  }, [onRetry]);

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

      {effectiveIsLoading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="pointer-events-auto flex flex-col items-center gap-4 rounded-2xl bg-black/45 px-8 py-6 text-center backdrop-blur-md">
            <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
            {playbackError ? (
              <div className="max-w-md px-4">
                <p className="mb-3 text-sm font-medium tracking-wider text-white/90">
                  {playbackError}
                </p>
                <button
                  onClick={handleRetry}
                  className="mx-auto flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              </div>
            ) : (
              <p className="text-sm font-medium tracking-wider text-white/90">
                Buffering video...
              </p>
            )}
          </div>
        </div>
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
      />

      <div
        className={`absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-end transition-opacity duration-300 z-30 ${
          showControls && hasUserInteracted ? "opacity-100" : "opacity-0 pointer-events-none"
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
          showControls && hasUserInteracted ? "opacity-100" : "opacity-0 pointer-events-none"
        }}`}
      >
        <div className="relative group flex items-center">
          <input
            type="range"
            min="0"
            max="100"
            value={progress || 0}
            onChange={handleSeek}
            className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-red-600 hover:h-2 transition-all"
            onMouseDown={() => {
              if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
            }}
            onMouseUp={() => handleMouseMove()}
          />
        </div>

        <div className="flex items-center justify-between text-white flex-wrap gap-3">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <button
              onClick={togglePlay}
              className="hover:text-red-500 transition-colors flex-shrink-0"
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
              className="hover:text-red-500 transition-colors flex-shrink-0"
              aria-label="Rewind 10s"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
            <button
              onClick={() => {
                const v = videoRef.current;
                if (v) v.currentTime += 10;
              }}
              className="hover:text-red-500 transition-colors flex-shrink-0"
              aria-label="Forward 10s"
            >
              <RotateCw className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 group flex-shrink-0">
              <button
                onClick={toggleMute}
                className="hover:text-red-500 transition-colors flex-shrink-0"
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
                className="w-20 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-white hover:accent-red-500 transition-all"
                onMouseDown={() => {
                  if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
                }}
              />
            </div>

            <span className="text-xs font-medium text-white/80 flex-shrink-0">
              {formatTime(videoRef.current?.currentTime || 0)} / {formatTime(duration)}
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
                <span>{currentSubtitles}</span>
              </button>
              {subtitleMenuOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-56 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                  <div className="px-4 py-2 border-b border-white/10">
                    <p className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
                      Audio Track
                    </p>
                    <div className="space-y-1">
                      <button
                        onClick={(e) => {
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
                  <div className="px-4 py-2">
                    <p className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
                      Subtitles
                    </p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {["Off", "English", "Spanish", "French"].map((sub) => (
                        <button
                          key={sub}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCurrentSubtitles(sub);
                            setSubtitleMenuOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${
                            currentSubtitles === sub ? "text-red-500 font-bold" : "text-white"
                          }`}
                        >
                          {sub}
                        </button>
                      ))}
                    </div>
                  </div>
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
                  <span>{currentQuality}</span>
                </button>
                {qualityMenuOpen && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-28 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                    {variants
                      .filter((v) => v.quality)
                      .map((v) => (
                        <button
                          key={v.quality}
                          onClick={(e) => {
                            e.stopPropagation();
                            switchQuality(v.quality || "Auto");
                          }}
                          className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${
                            currentQuality === (v.quality || "Auto")
                              ? "text-red-500 font-bold"
                              : "text-white"
                          }`}
                        >
                          {v.quality || "Auto"}
                        </button>
                      ))}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        switchQuality("Auto");
                      }}
                      className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${
                        currentQuality === "Auto" ? "text-red-500 font-bold" : "text-white"
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
              className="hover:text-red-500 transition-colors flex-shrink-0"
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