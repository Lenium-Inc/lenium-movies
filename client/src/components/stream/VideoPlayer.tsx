// player/VideoPlayer.tsx
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
  Subtitles,
  X,
  Loader2,
  WifiOff,
  Server,
  Monitor,
  AlertCircle,
  RefreshCw,
  Wifi,
  Zap,
  Languages,
  Volume2 as Volume2Icon,
  Headphones,
} from "lucide-react";

export interface StreamMirror {
  name: string;
  url: string;
}

export type EmbedProvider =
  | "vidsrc"
  | "embed.su"
  | "2embed"
  | "multiembed"
  | "goojara"
  | "vidlink"
  | "vidstream"
  | "autoembed"
  | "unknown";

export interface PlaybackError {
  type:
    | "network"
    | "provider_unavailable"
    | "geo_blocked"
    | "not_found"
    | "rate_limited"
    | "unknown";
  message: string;
  recoverable: boolean;
  provider?: EmbedProvider;
  retryCount: number;
}

export interface VideoPlayerProps {
  streamUrl: string;
  title: string;
  poster: string;
  onClose: () => void;
  movie?: {
    id: string;
    title: string;
    media_type?: "movie" | "tv";
    season?: number;
    episode?: number;
    mirrors?: StreamMirror[];
  };
  mirrors?: StreamMirror[];
  season?: number;
  episode?: number;
  mediaType?: "movie" | "tv";
  onPlayEpisode?: (season: number, episode: number) => void;
  // New props for multi-provider support
  currentProvider?: EmbedProvider;
  availableMirrors?: StreamMirror[];
  currentMirrorIndex?: number;
  onMirrorChange?: (index: number) => void;
  selectedQuality?: QualityOption;
  onQualityChange?: (quality: QualityOption) => void;
  availableQualities?: readonly QualityOption[];
  isLoading?: boolean;
  playbackError?: PlaybackError | null;
  onRetry?: () => void;
  // Callback when iframe successfully loads
  onIframeLoad?: () => void;
}

export const QUALITY_ORDER = ["4K", "1080p", "720p", "480p", "320p"] as const;
export type QualityOption = (typeof QUALITY_ORDER)[number];

const PROVIDER_CONFIGS: Record<
  EmbedProvider,
  { name: string; supportsQuality: boolean; qualityParam: string }
> = {
  vidsrc: { name: "VidSrc", supportsQuality: true, qualityParam: "quality" },
  "embed.su": {
    name: "Embed.su",
    supportsQuality: true,
    qualityParam: "quality",
  },
  autoembed: {
    name: "AutoEmbed",
    supportsQuality: true,
    qualityParam: "quality",
  },
  "2embed": { name: "2Embed", supportsQuality: true, qualityParam: "q" },
  multiembed: {
    name: "MultiEmbed",
    supportsQuality: true,
    qualityParam: "qual",
  },
  goojara: { name: "Goojara", supportsQuality: false, qualityParam: "" },
  vidlink: { name: "VidLink", supportsQuality: true, qualityParam: "quality" },
  vidstream: {
    name: "VidStream",
    supportsQuality: true,
    qualityParam: "quality",
  },
  unknown: { name: "Unknown", supportsQuality: false, qualityParam: "" },
};

function detectEmbedProvider(url: string): EmbedProvider {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("vidsrc")) return "vidsrc";
    if (hostname.includes("embed.su")) return "embed.su";
    if (hostname.includes("autoembed")) return "autoembed";
    if (hostname.includes("2embed")) return "2embed";
    if (hostname.includes("multiembed")) return "multiembed";
    if (hostname.includes("goojara")) return "goojara";
    if (hostname.includes("vidlink")) return "vidlink";
    if (hostname.includes("vidstream")) return "vidstream";
  } catch {
    // Invalid URL
  }
  return "unknown";
}

function applyQualityToUrl(
  url: string,
  quality: string,
  provider: EmbedProvider
): string {
  if (provider === "unknown" || !PROVIDER_CONFIGS[provider]?.supportsQuality)
    return url;
  try {
    const urlObj = new URL(url);
    const config = PROVIDER_CONFIGS[provider];
    urlObj.searchParams.set(config.qualityParam, quality);
    return urlObj.toString();
  } catch {
    return url;
  }
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  streamUrl,
  title,
  poster,
  onClose,
  movie,
  mirrors = [],
  season,
  episode,
  mediaType,
  onPlayEpisode,
  // New props
  currentProvider = "unknown",
  availableMirrors = [],
  currentMirrorIndex = 0,
  onMirrorChange,
  selectedQuality = "480p" as QualityOption,
  onQualityChange,
  availableQualities = QUALITY_ORDER,
  isLoading: externalIsLoading = false,
  playbackError: externalPlaybackError = null,
  onRetry,
  onIframeLoad,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [progress, setProgress] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [qualityMenuOpen, setQualityMenuOpen] = useState<boolean>(false);
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState<boolean>(false);
  const [mirrorMenuOpen, setMirrorMenuOpen] = useState<boolean>(false);
  const [currentQuality, setCurrentQuality] = useState<QualityOption>(
    selectedQuality as QualityOption
  );
  const [currentSubtitles, setCurrentSubtitles] = useState<string>("Off");
  const [currentMirror, setCurrentMirror] =
    useState<number>(currentMirrorIndex);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qualityChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // Sync with external props
  useEffect(() => {
    setCurrentMirror(currentMirrorIndex);
  }, [currentMirrorIndex]);

  useEffect(() => {
    if (selectedQuality && selectedQuality !== currentQuality) {
      setCurrentQuality(selectedQuality as QualityOption);
    }
  }, [selectedQuality]);

  useEffect(() => {
    setPlaybackError(
      externalPlaybackError
        ? `${externalPlaybackError.type}: ${externalPlaybackError.message}`
        : null
    );
  }, [externalPlaybackError]);

  // Determine effective mirrors
  const effectiveMirrors = useMemo(() => {
    if (availableMirrors.length > 0) return availableMirrors;
    const baseMirrors: StreamMirror[] = [
      {
        name: `${PROVIDER_CONFIGS[currentProvider]?.name || "Primary"} Server`,
        url: streamUrl,
      },
    ];
    if (mirrors.length) return [...baseMirrors, ...mirrors];
    return baseMirrors;
  }, [availableMirrors, mirrors, streamUrl, currentProvider]);

  // Determine if embed
  const isEmbed = useMemo(() => {
    const url = effectiveMirrors[currentMirror]?.url || streamUrl;
    return (
      url.includes("embed") ||
      url.includes("vidsrc") ||
      url.includes("goojara") ||
      url.includes("vidlink") ||
      url.includes("vidstream")
    );
  }, [effectiveMirrors, currentMirror, streamUrl]);

  // Get current mirror URL with quality applied
  const currentMirrorUrl = useMemo(() => {
    const url = effectiveMirrors[currentMirror]?.url || streamUrl;
    if (isEmbed) {
      return applyQualityToUrl(url, currentQuality, currentProvider);
    }
    return url;
  }, [
    effectiveMirrors,
    currentMirror,
    streamUrl,
    currentQuality,
    isEmbed,
    currentProvider,
  ]);

  const providerConfig = useMemo(
    () => PROVIDER_CONFIGS[currentProvider],
    [currentProvider]
  );
  const supportsQuality = providerConfig?.supportsQuality ?? false;
  const effectiveIsLoading = externalIsLoading || isLoading;

  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  }, [isPlaying]);

  // For direct video playback
  useEffect(() => {
    if (isEmbed) return; // Skip for iframe embeds

    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      if (!isNaN(video.duration)) {
        setProgress((video.currentTime / video.duration) * 100);
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setIsLoading(false);
      video.play().catch(() => setIsPlaying(false));
    };

    const handleError = () => {
      const error = video.error?.message || "Playback failed";
      setPlaybackError(`Error: ${error}. Trying next server...`);
      setIsLoading(false);
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("waiting", () => setIsLoading(true));
    video.addEventListener("playing", () => setIsLoading(false));
    video.addEventListener("error", handleError);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("waiting", () => setIsLoading(true));
      video.removeEventListener("playing", () => setIsLoading(false));
      video.removeEventListener("error", handleError);
    };
  }, [currentMirrorUrl, currentMirror, isEmbed]);

  // For iframe embeds - listen for load events
  useEffect(() => {
    if (!isEmbed) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      setIframeLoaded(true);
      setIsLoading(false);
    };

    const handleError = () => {
      setPlaybackError("Failed to load embed. Trying next server...");
      setIsLoading(false);
    };

    iframe.addEventListener("load", handleLoad);
    iframe.addEventListener("error", handleError);

    return () => {
      iframe.removeEventListener("load", handleLoad);
      iframe.removeEventListener("error", handleError);
    };
  }, [currentMirrorUrl, isEmbed]);

  const togglePlay = useCallback(() => {
    if (isEmbed) {
      // For embeds, we can't directly control playback
      // The embed handles its own play/pause
      setIsPlaying(!isPlaying);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying, isEmbed]);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isEmbed) return; // Can't seek iframe embeds directly
      const video = videoRef.current;
      if (!video || isNaN(duration)) return;
      const seekTime = (parseFloat(e.target.value) / 100) * duration;
      video.currentTime = seekTime;
      setProgress(parseFloat(e.target.value));
    },
    [duration, isEmbed]
  );

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isEmbed) return; // Can't control iframe volume directly
      const video = videoRef.current;
      if (!video) return;
      const newVol = parseFloat(e.target.value);
      setVolume(newVol);
      setIsMuted(newVol === 0);
      video.volume = newVol;
    },
    [isEmbed]
  );

  const toggleMute = useCallback(() => {
    if (isEmbed) {
      setIsMuted(!isMuted);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (isMuted) {
      video.volume = volume || 0.5;
      setIsMuted(false);
    } else {
      video.volume = 0;
      setIsMuted(true);
    }
  }, [isMuted, volume, isEmbed]);

  const toggleFullscreen = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!document.fullscreenElement) {
      player.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }, []);

  const switchMirror = useCallback(
    (index: number) => {
      if (index === currentMirror) return;
      setCurrentMirror(index);
      setIsLoading(true);
      setPlaybackError(null);
      setQualityMenuOpen(false);
      setIframeLoaded(false);
      onMirrorChange?.(index);
    },
    [currentMirror, onMirrorChange]
  );

  const switchQuality = useCallback(
    (quality: QualityOption) => {
      if (quality === currentQuality) return;

      setCurrentQuality(quality);
      setIsLoading(true);
      setPlaybackError(null);
      setQualityMenuOpen(false);
      setIframeLoaded(false);
      onQualityChange?.(quality);

      // For embeds, the URL change will trigger reload
      if (isEmbed) {
        qualityChangeTimeoutRef.current = setTimeout(() => {
          setIsLoading(false);
        }, 1500);
      }
    },
    [currentQuality, isEmbed, onQualityChange]
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

      if (isEmbed) {
        // Limited keyboard support for embeds
        switch (e.key) {
          case "f":
            e.preventDefault();
            toggleFullscreen();
            break;
          case "Escape":
            if (document.fullscreenElement) {
              document.exitFullscreen();
            }
            break;
        }
        return;
      }

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
    [togglePlay, toggleMute, toggleFullscreen, duration, isEmbed]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Prevent context menu on video/iframe
  const preventContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const handleRetry = useCallback(() => {
    setPlaybackError(null);
    setIsLoading(true);
    setIframeLoaded(false);
    onRetry?.();
  }, [onRetry]);

  return (
    <div
      ref={playerRef}
      onMouseMove={handleMouseMove}
      onContextMenu={preventContextMenu}
      className="relative w-full h-full aspect-video rounded-xl overflow-hidden bg-black select-none font-sans"
    >
      {/* Background Poster / Loading State / Error State */}
      {effectiveIsLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
            <img
              src={poster}
              alt={title}
              className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm"
            />
            <div className="relative z-20 flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
              {playbackError ? (
                <div className="text-center max-w-md px-4">
                  <p className="text-white/80 font-medium text-sm tracking-wider mb-3">
                    {playbackError}
                  </p>
                  <button
                    onClick={handleRetry}
                    className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg text-white text-sm font-medium transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Retry
                  </button>
                </div>
              ) : (
                <p className="text-white/80 font-medium text-sm tracking-wider">
                  Loading stream at {currentQuality}...
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Video Element (for direct streams) */}
      {!isEmbed && (
        <video
          ref={videoRef}
          src={currentMirrorUrl}
          poster={poster}
          className="w-full h-full object-contain cursor-pointer"
          onClick={togglePlay}
          onContextMenu={preventContextMenu}
          playsInline
          preload="metadata"
        />
      )}

      {/* Iframe Embed (for VidSrc, etc.) */}
      {isEmbed && (
        <iframe
          ref={iframeRef}
          src={currentMirrorUrl}
          title={title}
          className="w-full h-full border-0"
          allowFullScreen
          allow="fullscreen; autoplay; encrypted-media; picture-in-picture; accelerometer; clipboard-write"
          onLoad={() => {
            setIframeLoaded(true);
            onIframeLoad?.();
          }}
        />
      )}

      {/* Top Header Overlay */}
      <div
        className={`absolute top-0 inset-x-0 p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-between transition-opacity duration-300 z-30 ${showControls ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-white text-base font-semibold tracking-wide drop-shadow-md truncate">
            {title}
          </h1>
          {mediaType === "tv" && season && episode && (
            <span className="px-2 py-0.5 text-xs font-medium bg-white/10 border border-white/10 rounded text-white/80">
              S{season} E{episode}
            </span>
          )}
          {isEmbed && (
            <span className="px-2 py-0.5 text-xs font-medium bg-blue-500/20 border border-blue-500/30 rounded text-blue-400 flex items-center gap-1">
              <Monitor className="h-3 w-3" />
              {providerConfig?.name || "Embed"}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-black/40 hover:bg-white/20 border border-white/10 flex items-center justify-center text-white transition-all flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom Controls */}
      <div
        className={`absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex flex-col gap-2.5 transition-opacity duration-300 z-30 ${showControls ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {/* Timeline Scrubber - only for direct video */}
        {!isEmbed && (
          <div className="relative group flex items-center">
            <input
              type="range"
              min="0"
              max="100"
              value={progress || 0}
              onChange={handleSeek}
              className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-red-600 hover:h-2 transition-all"
              onMouseDown={() => {
                if (controlsTimeoutRef.current)
                  clearTimeout(controlsTimeoutRef.current);
              }}
              onMouseUp={() => handleMouseMove()}
            />
          </div>
        )}

        {/* Control Buttons Bar */}
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

            {!isEmbed && (
              <>
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
              </>
            )}

            {/* Volume Control - only for direct video */}
            {!isEmbed && (
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
                    if (controlsTimeoutRef.current)
                      clearTimeout(controlsTimeoutRef.current);
                  }}
                />
              </div>
            )}

            {/* Timestamp - only for direct video */}
            {!isEmbed && (
              <span className="text-xs font-medium text-white/80 flex-shrink-0">
                {formatTime(videoRef.current?.currentTime || 0)} /{" "}
                {formatTime(duration)}
              </span>
            )}

            {isEmbed && (
              <span className="text-xs font-medium text-white/60 flex-shrink-0">
                Stream via {providerConfig?.name || "embed provider"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 relative flex-shrink-0">
            {/* Language/Audio/Subtitles Flyout - for both embed and direct video */}
            <div className="relative z-40">
              <button
                onClick={() => {
                  setSubtitleMenuOpen(!subtitleMenuOpen);
                  setQualityMenuOpen(false);
                  setMirrorMenuOpen(false);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                aria-label="Audio & Subtitles"
              >
                <Languages className="w-4 h-4" />
                <span>{currentSubtitles}</span>
              </button>
              {subtitleMenuOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-56 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                  {/* Audio Track Section */}
                  <div className="px-4 py-2 border-b border-white/10">
                    <p className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
                      Audio Track
                    </p>
                    <div className="space-y-1">
                      {isEmbed ? (
                        <>
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setCurrentSubtitles("English (Dubbed)");
                              setSubtitleMenuOpen(false);
                            }}
                            className="w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors flex items-center gap-2"
                          >
                            <Headphones className="w-3 h-3" />
                            <span>English (Dubbed)</span>
                          </button>
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
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                  {/* Subtitles Section */}
                  <div className="px-4 py-2">
                    <p className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
                      Subtitles
                    </p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {isEmbed
                        ? [
                            "Off",
                            "English [Auto]",
                            "English",
                            "Spanish",
                            "French",
                            "German",
                            "Italian",
                            "Portuguese",
                            "Japanese",
                            "Korean",
                            "Chinese",
                          ].map(sub => (
                            <button
                              key={sub}
                              onClick={e => {
                                e.stopPropagation();
                                setCurrentSubtitles(sub);
                                setSubtitleMenuOpen(false);
                              }}
                              className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors flex items-center gap-2 ${currentSubtitles === sub ? "text-red-500 font-bold" : "text-white"}`}
                            >
                              {sub === "Off" ? (
                                <Subtitles className="w-3 h-3 opacity-50" />
                              ) : sub === "English [Auto]" ? (
                                <span className="text-[10px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded">
                                  Auto
                                </span>
                              ) : (
                                <Subtitles className="w-3 h-3" />
                              )}
                              <span>{sub}</span>
                            </button>
                          ))
                        : ["Off", "English", "Spanish", "French"].map(sub => (
                            <button
                              key={sub}
                              onClick={e => {
                                e.stopPropagation();
                                setCurrentSubtitles(sub);
                                setSubtitleMenuOpen(false);
                              }}
                              className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentSubtitles === sub ? "text-red-500 font-bold" : "text-white"}`}
                            >
                              {sub}
                            </button>
                          ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Quality Selector */}
            <div className="relative z-40">
              <button
                onClick={() => {
                  setQualityMenuOpen(!qualityMenuOpen);
                  setSubtitleMenuOpen(false);
                  setMirrorMenuOpen(false);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                disabled={isEmbed && !supportsQuality}
              >
                <Settings className="w-4 h-4" />
                <span>{currentQuality}</span>
                {isEmbed && supportsQuality && (
                  <span className="text-[10px] text-white/40">(embed)</span>
                )}
              </button>
              {qualityMenuOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-28 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                  {availableQualities.map(q => (
                    <button
                      key={q}
                      onClick={e => {
                        e.stopPropagation();
                        switchQuality(q as QualityOption);
                      }}
                      disabled={isEmbed && !supportsQuality}
                      className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${currentQuality === q ? "text-red-500 font-bold" : "text-white"} ${isEmbed && !supportsQuality ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Mirror/Server Selector */}
            {effectiveMirrors.length > 1 && (
              <div className="relative z-40">
                <button
                  onClick={() => {
                    setMirrorMenuOpen(!mirrorMenuOpen);
                    setSubtitleMenuOpen(false);
                    setQualityMenuOpen(false);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-xs font-semibold tracking-wider transition-all"
                >
                  <Server className="w-4 h-4" />
                  <span>
                    {effectiveMirrors[currentMirror]?.name ||
                      `Server ${currentMirror + 1}`}
                  </span>
                </button>
                {mirrorMenuOpen && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-44 bg-zinc-900 border border-white/10 rounded-lg shadow-xl overflow-hidden py-1 z-50">
                    {effectiveMirrors.map((mirror, idx) => (
                      <button
                        key={idx}
                        onClick={e => {
                          e.stopPropagation();
                          switchMirror(idx);
                        }}
                        className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors flex items-center gap-2 ${currentMirror === idx ? "text-red-500 font-bold" : "text-white"}`}
                      >
                        {currentMirror === idx && (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        )}
                        {mirror.name}
                      </button>
                    ))}
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
    </div>
  );
};
