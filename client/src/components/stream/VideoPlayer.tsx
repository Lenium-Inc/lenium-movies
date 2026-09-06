import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Gauge,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Subtitles,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  proxiedStreamUrl,
  STREAM_QUALITY_ORDER,
  type StreamMovie,
  type StreamQuality,
} from "@/services/api";
import {
  cancelInFlightPrefetch,
  currentPrefetch,
  prefetchPending,
  resolvePrefetched,
} from "@/services/prefetch";
import { celebrate } from "@/services/achievements";
import { recordWatch } from "@/services/stats";
import { getSettings } from "@/services/settings";

interface VideoPlayerProps {
  title: string;
  movie: StreamMovie;
  onClose: () => void;
}

const rank = (quality: StreamQuality) => {
  const index = STREAM_QUALITY_ORDER.indexOf(quality);
  return index === -1 ? STREAM_QUALITY_ORDER.length : index;
};

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Fullscreen-native player with quality selection, −15s/+15s circular seek,
 * centered play/pause, playback speed, subtitles, and a monochrome control
 * surface. Playback starts from the prefetched leading segment when one exists
 * for the chosen quality (blob-first, instant) and hands off to the full
 * stream at the segment's end. Watch-time and title progress feed the mindful
 * stats engine; earned achievements surface as minimal monochrome toasts.
 */
export function VideoPlayer({ title, movie, onClose }: VideoPlayerProps) {
  const variants = useMemo(() => {
    const list = (movie.streams ?? [])
      .slice()
      .sort((a, b) => rank(a.quality) - rank(b.quality));
    return list;
  }, [movie]);

  const [quality, setQuality] = useState<StreamQuality | null>(null);
  const [usingBlob, setUsingBlob] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [subsOn, setSubsOn] = useState(() => {
    if (!movie.subtitles?.length) return false;
    return getSettings().subtitles !== "off";
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [menu, setMenu] = useState<"none" | "quality" | "speed">("none");
  const [uiVisible, setUiVisible] = useState(true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handoffDone = useRef(false);
  const timeToRestore = useRef(0);
  const lastBlobUrl = useRef<string | null>(null);
  const lastTimeRef = useRef(0);
  const watchBucketRef = useRef(0);
  const durationRef = useRef(0);
  const uiTimerRef = useRef<number | null>(null);

  // ---- default quality ----------------------------------------------------
  const preferred = useMemo(() => getSettings().quality, []);
  useEffect(() => {
    const pre = currentPrefetch();
    if (pre && pre.movieId === movie.id) {
      setQuality(pre.quality);
      return;
    }
    if (!variants.length) return;
    if (preferred === "auto") {
      const candidate =
        variants.find(v => v.quality === "480p")?.quality ??
        variants.find(v => v.quality === "320p")?.quality ??
        variants[variants.length - 1].quality;
      setQuality(candidate);
      return;
    }
    const exact = variants.find(v => v.quality === preferred);
    if (exact) {
      setQuality(exact.quality);
      return;
    }
    const lower = [...variants]
      .sort((a, b) => rank(a.quality) - rank(b.quality))
      .find(v => rank(v.quality) <= rank(preferred));
    setQuality((lower ?? variants[variants.length - 1]).quality);
  }, [movie.id, variants, preferred]);

  // ---- blob-first segment -------------------------------------------------
  useEffect(() => {
    if (quality == null) return;
    const pre = currentPrefetch();
    if (pre && pre.movieId === movie.id && pre.quality === quality) {
      let cancelled = false;
      void resolvePrefetched(pre).then(blob => {
        if (!cancelled && blob) {
          const url = URL.createObjectURL(blob);
          if (lastBlobUrl.current) URL.revokeObjectURL(lastBlobUrl.current);
          lastBlobUrl.current = url;
          setBlobUrl(url);
          setUsingBlob(true);
          setStatus("loading");
          handoffDone.current = false;
        }
      });
      return () => {
        cancelled = true;
      };
    }
    setUsingBlob(false);
    setBlobUrl(null);
    handoffDone.current = false;
  }, [quality, movie.id]);

  useEffect(() => {
    return () => {
      if (lastBlobUrl.current) URL.revokeObjectURL(lastBlobUrl.current);
      const bucket = watchBucketRef.current;
      if (bucket > 0) {
        recordWatch(movie.id, bucket, durationRef.current || undefined, {
          title: movie.title,
          poster: movie.poster_url,
          year: movie.year ?? null,
        });
      }
    };
  }, [movie.id, movie.title, movie.poster_url, movie.year]);

  // Terminate a background pre-fetch that targets a different quality than the
  // player actually started on — the chosen stream gets the bandwidth.
  useEffect(() => {
    if (!prefetchPending()) return;
    const pre = currentPrefetch();
    if (pre && pre.movieId === movie.id && pre.quality === quality) return;
    cancelInFlightPrefetch();
  }, [quality, movie.id]);

  const networkUrl = useMemo(() => {
    const variant = quality
      ? variants.find(v => v.quality === quality)
      : undefined;
    return proxiedStreamUrl(variant?.url ?? movie.stream_url);
  }, [variants, quality, movie.stream_url]);

  const src = usingBlob && blobUrl ? blobUrl : networkUrl;

  // ---- ui auto-hide --------------------------------------------------------
  const revealUi = useCallback(() => {
    setUiVisible(true);
    if (uiTimerRef.current) window.clearTimeout(uiTimerRef.current);
    uiTimerRef.current = window.setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused) setUiVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    revealUi();
    return () => {
      if (uiTimerRef.current) window.clearTimeout(uiTimerRef.current);
    };
  }, [revealUi]);

  // ---- playback helpers ----------------------------------------------------
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
    revealUi();
  }, [revealUi]);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
      setCurrentTime(video.currentTime);
      revealUi();
    },
    [revealUi]
  );

  const handoff = useCallback(() => {
    if (handoffDone.current) return;
    handoffDone.current = true;
    const current = videoRef.current?.currentTime ?? 0;
    timeToRestore.current = current;
    setUsingBlob(false);
    setStatus("loading");
  }, []);

  const selectQuality = useCallback(
    (next: StreamQuality) => {
      setMenu("none");
      if (next === quality) return;
      const current = videoRef.current?.currentTime ?? 0;
      timeToRestore.current = current;
      handoffDone.current = true;
      setBlobUrl(null);
      setUsingBlob(false);
      setQuality(next);
      setStatus("loading");
    },
    [quality]
  );

  // ---- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT") return;
      switch (event.key) {
        case "Escape":
          onClose();
          break;
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
        case "j":
          seekBy(-15);
          break;
        case "ArrowRight":
        case "l":
          seekBy(15);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          setMuted(value => !value);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, togglePlay, seekBy]);

  function toggleFullscreen() {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void container.requestFullscreen().catch(() => {});
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ---- subtitles ------------------------------------------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (const track of Array.from(video.textTracks)) {
      track.mode = subsOn ? "showing" : "hidden";
    }
  }, [subsOn, src, usingBlob]);

  // ---- watch-time tracking --------------------------------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onUpdate = () => {
      setCurrentTime(video.currentTime);
      if (!video.paused) {
        const now = video.currentTime;
        const last = lastTimeRef.current;
        lastTimeRef.current = now;
        if (last >= 0 && now > last && now - last < 6) {
          watchBucketRef.current += now - last;
          if (watchBucketRef.current >= 5) {
            const seconds = watchBucketRef.current;
            watchBucketRef.current = 0;
            const gained = recordWatch(
              movie.id,
              seconds,
              video.duration || undefined,
              { title: movie.title, poster: movie.poster_url, year: movie.year ?? null }
            );
            if (gained.length) celebrate(gained);
          }
        }
      }
    };
    const onDuration = () => {
      setDuration(video.duration || 0);
      durationRef.current = video.duration || 0;
    };
    video.addEventListener("timeupdate", onUpdate);
    video.addEventListener("durationchange", onDuration);
    return () => {
      video.removeEventListener("timeupdate", onUpdate);
      video.removeEventListener("durationchange", onDuration);
    };
  }, [movie.id]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} player`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-sm font-semibold text-white">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onClose}
              aria-label="Close player"
              className="rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div
          ref={containerRef}
          className="group relative flex items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black"
          onMouseMove={revealUi}
          onTouchStart={revealUi}
        >
          {(status === "loading" || status === "error") && (
            <div className="absolute inset-0 z-10 grid place-items-center text-xs">
              <span className="px-6 text-center text-[#99999d]">
                {status === "error"
                  ? "This video can't play right now. Try again in a moment."
                  : "Starting playback…"}
              </span>
            </div>
          )}

          <video
            key={`${quality ?? "default"}-${usingBlob ? "blob" : "net"}`}
            ref={videoRef}
            src={src}
            autoPlay
            playsInline
            muted={muted}
            onClick={togglePlay}
            className={`block w-full cursor-pointer bg-black object-contain ${
              isFullscreen ? "h-full w-full" : "max-h-[72vh]"
            }`}
            onLoadedMetadata={() => {
              const video = videoRef.current;
              if (video) {
                setDuration(video.duration || 0);
                durationRef.current = video.duration || 0;
                video.volume = volume;
                video.muted = muted;
                if (!usingBlob && timeToRestore.current > 0) {
                  video.currentTime = timeToRestore.current;
                  timeToRestore.current = 0;
                  void video.play().catch(() => {});
                }
              }
            }}
            onLoadedData={() => setStatus("ready")}
            onPlaying={() => setStatus("ready")}
            onWaiting={() => setStatus("loading")}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={() => {
              if (usingBlob && duration > 0) {
                if (currentTime >= Math.max(duration - 0.75, 0)) handoff();
              }
            }}
            onError={event => {
              console.error(
                `[VideoPlayer] stream failed for "${title}"`,
                event.currentTarget.error,
                src
              );
              if (usingBlob) {
                handoff();
              } else if (status !== "error") {
                setStatus("error");
              }
            }}
          >
            {movie.subtitles?.map(track => (
              <track
                key={track.lang}
                kind="subtitles"
                srcLang={track.lang}
                label={track.label}
                src={proxiedStreamUrl(track.url)}
              />
            ))}
          </video>

          {/* centered pause / play */}
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className={`absolute left-1/2 top-1/2 z-10 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-black shadow-2xl transition ${
              uiVisible || !playing ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            {playing ? (
              <Pause className="h-6 w-6 fill-current" />
            ) : (
              <Play className="ml-0.5 h-6 w-6 fill-current" />
            )}
          </button>

          {/* floating controls bar */}
          <div
            className={`absolute inset-x-0 bottom-0 z-10 px-3 pb-3 transition-opacity ${
              uiVisible ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <div className="mx-auto max-w-[760px] rounded-xl border border-white/10 bg-black/70 px-3 py-2 backdrop-blur-md">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={event => {
                const video = videoRef.current;
                if (video) video.currentTime = Number(event.target.value);
              }}
              className="w-full accent-white"
              aria-label="Seek"
            />
            <div className="mt-1 flex items-center gap-2 text-[10px] tabular-nums text-white/70">
              <span>{fmtTime(currentTime)}</span>
              <span>/</span>
              <span>{fmtTime(duration)}</span>
              <span className="ml-auto flex items-center gap-1">
                <span className="text-white/40">{progress.toFixed(0)}%</span>
              </span>
            </div>

            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => seekBy(-15)}
                aria-label="Back 15 seconds"
                className="grid h-9 w-11 place-items-center rounded-full text-white hover:bg-white/10"
              >
                <span className="relative grid h-7 w-7 place-items-center">
                  <RotateCcw className="h-6 w-6" />
                  <span className="absolute text-[8px] font-bold">15</span>
                </span>
              </button>

              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                className="grid h-9 w-9 place-items-center rounded-full bg-white text-black hover:bg-white/90"
              >
                {playing ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                )}
              </button>

              <button
                type="button"
                onClick={() => seekBy(15)}
                aria-label="Forward 15 seconds"
                className="grid h-9 w-11 place-items-center rounded-full text-white hover:bg-white/10"
              >
                <span className="relative grid h-7 w-7 place-items-center">
                  <RotateCw className="h-6 w-6" />
                  <span className="absolute text-[8px] font-bold">15</span>
                </span>
              </button>

              <span className="mx-1 h-5 w-px bg-white/15" />

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenu(menu === "speed" ? "none" : "speed")}
                  aria-haspopup="listbox"
                  aria-expanded={menu === "speed"}
                  className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-white/10"
                >
                  <Gauge className="h-3.5 w-3.5" />
                  {rate}x
                </button>
                {menu === "speed" && (
                  <div
                    role="listbox"
                    aria-label="Playback speed"
                    className="absolute bottom-full left-0 z-10 mb-1 min-w-[6rem] overflow-hidden rounded-lg border border-white/10 bg-[#1c1c20] shadow-xl"
                  >
                    {RATES.map(value => (
                      <button
                        key={value}
                        role="option"
                        aria-selected={value === rate}
                        onClick={() => {
                          setMenu("none");
                          setRate(value);
                          const video = videoRef.current;
                          if (video) video.playbackRate = value;
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] text-white hover:bg-white/10"
                      >
                        <span>{value}x</span>
                        {value === rate && <span>✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setMuted(value => !value)}
                  aria-label={muted ? "Unmute" : "Mute"}
                  className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10"
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={event => {
                    const value = Number(event.target.value);
                    setVolume(value);
                    setMuted(value === 0);
                    const video = videoRef.current;
                    if (video) {
                      video.volume = value;
                      video.muted = value === 0;
                    }
                  }}
                  className="w-16 accent-white"
                  aria-label="Volume"
                />
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10"
                >
                  {isFullscreen ? (
                    <Minimize2 className="h-4 w-4" />
                  ) : (
                    <Maximize2 className="h-4 w-4" />
                  )}
                </button>
              </div>

              {variants.length > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenu(menu === "quality" ? "none" : "quality")}
                    aria-haspopup="listbox"
                    aria-expanded={menu === "quality"}
                    className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-white/10"
                  >
                    {quality ?? "Auto"}
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  {menu === "quality" && (
                    <div
                      role="listbox"
                      aria-label="Playback quality"
                      className="absolute bottom-full right-0 z-10 mb-1 min-w-[7rem] overflow-hidden rounded-lg border border-white/10 bg-[#1c1c20] shadow-xl"
                    >
                      {variants.map(variant => (
                        <button
                          key={variant.quality}
                          role="option"
                          aria-selected={variant.quality === quality}
                          onClick={() => selectQuality(variant.quality)}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] text-white hover:bg-white/10"
                        >
                          <span>{variant.quality}</span>
                          {variant.quality === quality && <span>✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {movie.subtitles && movie.subtitles.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSubsOn(on => !on)}
                  aria-label="Toggle subtitles"
                  aria-pressed={subsOn}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] font-semibold transition ${
                    subsOn ? "bg-white text-black" : "text-white hover:bg-white/10"
                  }`}
                >
                  <Subtitles className="h-3.5 w-3.5" />
                  {subsOn ? "On" : "Off"}
                </button>
              )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}