"use client";

import Hls from "hls.js";
import {
  Download,
  Maximize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PlayerStatus,
  QualityOption,
  StreamPayload,
} from "@/types/stream";

interface NativeStreamPlayerProps {
  titleId: string;
  initialPayload: StreamPayload;
  title: string;
}

interface QualityChoice {
  id: string;
  label: string;
  height: number;
  level: number;
  url?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function proxyMediaErrorStatus(data: {
  response?: unknown;
  networkDetails?: unknown;
}): number | undefined {
  const response = data.response as { code?: number } | undefined;
  const network = data.networkDetails as { status?: number } | undefined;
  return response?.code ?? network?.status;
}

export function NativeStreamPlayer({
  titleId,
  initialPayload,
  title,
}: NativeStreamPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fallbackIndexRef = useRef(0);
  const restorePlaybackRef = useRef<{ time: number; shouldPlay: boolean } | null>(
    null
  );
  const retryRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const [payload, setPayload] = useState(initialPayload);
  const [activeMasterUrl, setActiveMasterUrl] = useState(initialPayload.masterUrl);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [selectedQuality, setSelectedQuality] = useState("auto");
  const [selectedSubtitle, setSelectedSubtitle] = useState("off");
  const [fullscreen, setFullscreen] = useState(false);
  const [qualityChoices, setQualityChoices] = useState<QualityChoice[]>([]);
  const [retryMessage, setRetryMessage] = useState("");

  const refreshStream = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    const video = videoRef.current;
    if (video) {
      restorePlaybackRef.current = {
        time: video.currentTime,
        shouldPlay: !video.paused,
      };
    }
    setStatus("recovering");
    setRetryMessage("");
    try {
      const episodeQuery = payload.selectedEpisode
        ? `&season=${payload.selectedEpisode.season}&episode=${payload.selectedEpisode.episode}`
        : "";
      const response = await fetch(
        `/api/v1/stream/resolve?titleId=${encodeURIComponent(titleId)}${episodeQuery}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error("Stream refresh failed.");
      const fresh = (await response.json()) as StreamPayload;
      setPayload(fresh);
      fallbackIndexRef.current = 0;
      setActiveMasterUrl(fresh.masterUrl);
      setSelectedQuality("auto");
      setStatus("loading");
      retryRef.current += 1;
    } catch {
      setStatus("error");
      setRetryMessage("This stream could not reconnect. Try again.");
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [
    titleId,
    payload.selectedEpisode?.season,
    payload.selectedEpisode?.episode,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    setStatus("loading");
    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
        fragLoadingMaxRetry: 3,
        fragLoadingRetryDelay: 700,
      });
      hlsRef.current = hls;
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls?.loadSource(activeMasterUrl);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const restore = restorePlaybackRef.current;
        if (restore) {
          restorePlaybackRef.current = null;
          if (restore.time > 0) {
            video.currentTime = restore.time;
          }
          if (restore.shouldPlay) {
            void video.play().catch(() => setStatus("paused"));
          }
        }
        setStatus(video.paused ? "paused" : "playing");
        const discovered = data.levels
          .map((level, index) => ({
            id: `level-${index}`,
            label: level.height ? `${level.height}p` : "Adaptive",
            height: level.height ?? 0,
            level: index,
          }))
          .sort((a, b) => b.height - a.height);
        setQualityChoices([
          { id: "auto", label: "Auto", height: 0, level: -1 },
          ...discovered.filter(
            (choice, index, list) =>
              list.findIndex(other => other.height === choice.height) === index
          ),
        ]);
        if (video.paused) {
          void video.play().catch(() => setStatus("paused"));
        }
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        const statusCode = proxyMediaErrorStatus(data);
        const retryCount = retryRef.current;
        if ((statusCode === 403 || statusCode === 404) && retryCount < 3) {
          const alternate =
            payload.fallbackMasterUrls[fallbackIndexRef.current];
          if (alternate) {
            const videoElement = videoRef.current;
            if (videoElement) {
              restorePlaybackRef.current = {
                time: videoElement.currentTime,
                shouldPlay: !videoElement.paused,
              };
            }
            fallbackIndexRef.current += 1;
            retryRef.current += 1;
            setActiveMasterUrl(alternate);
            setStatus("recovering");
          } else {
            void refreshStream();
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retryCount < 3) {
          retryRef.current += 1;
          setStatus("recovering");
          window.setTimeout(() => hls?.startLoad(), 900 * retryRef.current);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && retryCount < 3) {
          retryRef.current += 1;
          setStatus("recovering");
          hls?.recoverMediaError();
          return;
        }
        setStatus("error");
        setRetryMessage("Playback stopped unexpectedly. Try reconnecting.");
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = activeMasterUrl;
      video.load();
      video.addEventListener(
        "loadedmetadata",
        () => {
          const restore = restorePlaybackRef.current;
          if (!restore) return;
          restorePlaybackRef.current = null;
          video.currentTime = Math.min(restore.time, video.duration || restore.time);
          if (restore.shouldPlay) {
            void video.play().catch(() => setStatus("paused"));
          }
        },
        { once: true }
      );
    } else {
      setStatus("error");
      setRetryMessage("This browser does not support HLS playback.");
    }

    const onNativeError = () => {
      const code = video.error?.code;
      if ((code === MediaError.MEDIA_ERR_NETWORK || code === MediaError.MEDIA_ERR_DECODE) && retryRef.current < 3) {
        retryRef.current += 1;
        void refreshStream();
      } else if (code && code !== MediaError.MEDIA_ERR_ABORTED) {
        setStatus("error");
        setRetryMessage("Playback stopped unexpectedly. Try reconnecting.");
      }
    };
    video.addEventListener("error", onNativeError);

    return () => {
      video.removeEventListener("error", onNativeError);
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      if (!hls && video.src.startsWith(window.location.origin)) {
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [activeMasterUrl, payload.qualities, payload.fallbackMasterUrls, refreshStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const updateTime = () => setCurrentTime(video.currentTime || 0);
    const updateDuration = () => setDuration(video.duration || 0);
    const onPlay = () => setStatus("playing");
    const onPause = () => setStatus("paused");
    const onWaiting = () => setStatus("loading");
    const onCanPlay = () => setStatus(video.paused ? "paused" : "playing");
    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("durationchange", updateDuration);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    return () => {
      video.removeEventListener("timeupdate", updateTime);
      video.removeEventListener("durationchange", updateDuration);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
    };
  }, []);

  useEffect(() => {
    const onFullscreen = () =>
      setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  const fallbackQualities = useMemo(() => payload.qualities, [payload.qualities]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setStatus("paused"));
    else video.pause();
  };

  const selectQuality = (id: string) => {
    setSelectedQuality(id);
    const choice = qualityChoices.find(item => item.id === id);
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (!choice || !video) return;
    if (choice.url) {
      const position = video.currentTime;
      const wasPlaying = !video.paused;
      hls?.loadSource(choice.url);
      if (!hls) video.src = choice.url;
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = position;
          if (wasPlaying) void video.play().catch(() => setStatus("paused"));
        },
        { once: true }
      );
    } else if (hls) {
      hls.currentLevel = choice.level;
    }
  };

  const selectSubtitle = (id: string) => {
    setSelectedSubtitle(id);
    const video = videoRef.current;
    if (!video) return;
    for (let index = 0; index < video.textTracks.length; index += 1) {
      video.textTracks[index].mode =
        payload.subtitles[index]?.id === id ? "showing" : "disabled";
    }
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await containerRef.current.requestFullscreen();
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <section
      ref={containerRef}
      aria-label={`Player for ${title}`}
      className="group/player relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_28px_100px_rgba(0,0,0,.6)]"
    >
      <video
        ref={videoRef}
        className="h-full w-full bg-black object-contain"
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
        aria-label={title}
        onClick={togglePlayback}
        onVolumeChange={event => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
      >
        {payload.subtitles.map(track => (
          <track
            key={track.id}
            kind="subtitles"
            srcLang={track.language}
            label={track.label}
            src={track.url}
          />
        ))}
      </video>

      {status === "loading" || status === "recovering" ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/15">
          <span className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" />
          <span className="sr-only">
            {status === "recovering" ? "Reconnecting to stream" : "Loading stream"}
          </span>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-black/80 p-6 text-center">
          <div>
            <p className="font-semibold text-white">{retryMessage}</p>
            <button
              type="button"
              onClick={() => {
                retryRef.current = 0;
                void refreshStream();
              }}
              className="mt-4 rounded-full bg-white px-5 py-2 text-sm font-semibold text-black hover:bg-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/95 via-black/65 to-transparent px-4 pb-4 pt-14 opacity-100 transition-opacity sm:px-6 sm:pb-5 sm:group-hover/player:opacity-100">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          aria-label="Seek"
          style={{ "--seek-progress": `${progress}%` } as CSSProperties}
          onChange={event => {
            const video = videoRef.current;
            if (video) video.currentTime = Number(event.currentTarget.value);
          }}
          className="player-seek mb-3 block w-full cursor-pointer"
        />

        <div className="flex flex-wrap items-center gap-3 text-white">
          <button
            type="button"
            onClick={togglePlayback}
            aria-label={status === "playing" ? "Pause" : "Play"}
            className="grid h-10 w-10 place-items-center rounded-full bg-white text-black transition hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {status === "playing" ? (
              <Pause className="h-4 w-4 fill-current" />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            )}
          </button>
          <span className="min-w-[88px] text-xs tabular-nums text-white/75">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <button
            type="button"
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = !video.muted;
              setMuted(video.muted);
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            aria-label="Volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={event => {
              const video = videoRef.current;
              if (!video) return;
              video.volume = Number(event.currentTarget.value);
              video.muted = video.volume === 0;
            }}
            className="hidden w-20 accent-white sm:block"
          />

          <div className="ml-auto flex items-center gap-2">
            <label className="sr-only" htmlFor="player-quality">
              Video quality
            </label>
            <select
              id="player-quality"
              value={selectedQuality}
              onChange={event => selectQuality(event.currentTarget.value)}
              className="max-w-24 rounded-md border border-white/15 bg-black/60 px-2 py-1.5 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              {(qualityChoices.length ? qualityChoices : [
                { id: "auto", label: "Auto", height: 0, level: -1 },
                ...fallbackQualities.map(option => ({
                  ...option,
                  level: -1,
                })),
              ]).map(choice => (
                <option key={choice.id} value={choice.id} className="bg-zinc-900">
                  {choice.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="player-subtitles">
              Subtitles
            </label>
            <select
              id="player-subtitles"
              value={selectedSubtitle}
              onChange={event => selectSubtitle(event.currentTarget.value)}
              className="max-w-28 rounded-md border border-white/15 bg-black/60 px-2 py-1.5 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              <option value="off" className="bg-zinc-900">Subtitles off</option>
              {payload.subtitles.map(track => (
                <option key={track.id} value={track.id} className="bg-zinc-900">
                  {track.label}
                </option>
              ))}
            </select>
            {payload.downloadableQualities.length ? (
              <details className="relative">
                <summary className="grid h-9 w-9 list-none cursor-pointer place-items-center rounded-md border border-white/15 bg-black/60 hover:bg-white/10 [&::-webkit-details-marker]:hidden">
                  <Download className="h-4 w-4" />
                  <span className="sr-only">Download offline</span>
                </summary>
                <div className="absolute bottom-full right-0 mb-2 min-w-40 rounded-lg border border-white/10 bg-zinc-950/95 p-1 shadow-xl">
                  {payload.downloadableQualities.map(quality => (
                    <a
                      key={quality}
                      href={`/api/v1/download?titleId=${encodeURIComponent(titleId)}&quality=${encodeURIComponent(quality)}${payload.selectedEpisode ? `&season=${payload.selectedEpisode.season}&episode=${payload.selectedEpisode.episode}` : ""}`}
                      className="block rounded px-3 py-2 text-left text-xs hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    >
                      Download {quality}
                    </a>
                  ))}
                </div>
              </details>
            ) : null}
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
              className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              <Maximize className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
