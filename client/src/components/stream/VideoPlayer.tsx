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
  ChevronDown,
  Languages,
  Volume2 as Volume2Icon,
  X,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { formatPlayerTime } from "@/lib/format";
// Type-only: the runtime value is loaded via dynamic import() in the stream
// effect so hls.js stays out of the entry chunk; this import is erased.
import type Hls from "hls.js";
import { baseLanguage, sameLanguage } from "@/lib/language";
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
 * The same ladder for a DASH manifest, off dash.js's representation list.
 *
 * `index` is the position in the list dash.js's own
 * `setRepresentationForTypeByIndex` expects — a relative index, not the
 * representation's absolute id — so it is captured here rather than looked up
 * again at switch time.
 */
export const deriveDashLevels = (
  representations: { height?: number }[] | null | undefined
): { quality: string; height: number; index: number }[] => {
  const seen = new Set<number>();
  const rungs: { quality: string; height: number; index: number }[] = [];
  (representations ?? []).forEach((representation, index) => {
    const height = Number(representation?.height) || 0;
    if (!height || seen.has(height)) return;
    seen.add(height);
    rungs.push({ quality: `${height}p`, height, index });
  });
  return rungs.sort((a, b) => b.height - a.height);
};

/** What one selectable rendition looks like to the menus. */
export interface PlayerTrack {
  /** hls.js's index into its own list, not a position in ours. */
  id: number;
  label: string;
  /** BCP-47 code from the manifest, when it carried one. */
  language: string | null;
}

const trackLabel = (track: { name?: string; lang?: string }, index: number) =>
  track.name?.trim() ||
  (track.lang ? track.lang.toUpperCase() : `Track ${index + 1}`);

/**
 * The audio renditions a parsed master playlist declares, in manifest order.
 *
 * A multi-audio HLS source is a language choice the viewer has to be able to
 * make, and the only place that choice exists is inside the manifest -- there
 * is no URL, no resolver field and no metadata call that carries it. Reading it
 * off the running instance is therefore the only way the menu can list
 * anything. With a single-audio source (the common case) this returns one
 * entry, and the menu honestly shows the one language that exists rather than
 * a button that changes nothing.
 */
export const deriveHlsAudioTracks = (
  instance: Hls | null | undefined
): PlayerTrack[] => {
  const tracks = (instance?.audioTracks ?? []) as {
    id?: number;
    name?: string;
    lang?: string;
  }[];
  return tracks.map((track, index) => ({
    id: typeof track.id === "number" ? track.id : index,
    label: trackLabel(track, index),
    language: track.lang ?? null,
  }));
};

/**
 * The in-manifest subtitle renditions, in manifest order.
 *
 * Distinct from the resolver's WebVTT files: those are external `src` tracks
 * the player injects, these are text the manifest itself declares. Both appear
 * in the same menu because they answer the same question -- "can I read this
 * in my language" -- and they are kept separate internally because turning one
 * on must turn the other off.
 */
export const deriveHlsSubtitleTracks = (
  instance: Hls | null | undefined
): PlayerTrack[] => {
  const tracks = (instance?.subtitleTracks ?? []) as {
    id?: number;
    name?: string;
    lang?: string;
  }[];
  return tracks.map((track, index) => ({
    id: typeof track.id === "number" ? track.id : index,
    label: trackLabel(track, index),
    language: track.lang ?? null,
  }));
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
  /**
   * Base language code to open this title on, or null to open on whatever the
   * manifest declares first.
   *
   * The page works it out from the viewer's language preference, falling back
   * to the language the backend inferred from their address, and it is only a
   * seed: the first row a viewer clicks in the audio or subtitle switchers
   * replaces it for the rest of the session.
   */
  preferredLanguage?: string | null;
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
  preferredLanguage = null,
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
  // DASH's own ladder. Most provider titles are DASH, so without this the
  // quality menu simply never appeared for them — the hls.js ladder is empty
  // and the resolver ships one "Auto" rung.
  const [dashLevels, setDashLevels] = useState<
    { quality: string; height: number; index: number }[]
  >([]);
  const [dashQuality, setDashQuality] = useState<string>("Auto");
  const [posterSettled, setPosterSettled] = useState<boolean>(false);
  // "Off" or a `srcLang` from `subtitleTracks`. Held as a language code rather
  // than a label so two tracks sharing a display name stay distinguishable.
  const [currentSubtitles, setCurrentSubtitles] = useState<string>("Off");
  const subtitleTracks = useMemo(
    () => buildSubtitleTracks(subtitles),
    [subtitles]
  );

  // Renditions the manifest declares, populated once hls.js has walked it.
  // Separate from the resolver's WebVTT list above because these are selected
  // through hls.js and those through the media element's own textTracks -- two
  // mechanisms that must not be confused for one another, or turning one on
  // leaves the other showing.
  const [hlsAudioTracks, setHlsAudioTracks] = useState<PlayerTrack[]>([]);
  const [currentAudio, setCurrentAudio] = useState<number>(0);
  const [hlsSubtitleTracks, setHlsSubtitleTracks] = useState<PlayerTrack[]>([]);
  // `-1` is hls.js's own "no subtitle track" sentinel, held verbatim so the
  // state never has to be translated on its way to the instance.
  const [currentHlsSubtitle, setCurrentHlsSubtitle] = useState<number>(-1);
  // Whether the viewer has clicked a row in either switcher yet. Seeds from
  // `preferredLanguage` until they do, and never after: a track list that
  // arrives late would otherwise re-apply the seed on top of a choice they
  // already made.
  const [tracksTouched, setTracksTouched] = useState<boolean>(false);
  // The chip shows the human label of whichever source is actually on: a
  // resolver WebVTT track (a language code), an in-manifest one (an index), or
  // neither. Deriving it here rather than at the call sites is what keeps the
  // chip and the menu's highlighted row from disagreeing.
  const currentSubtitleLabel = useMemo(() => {
    if (currentSubtitles !== "Off") {
      return subtitleTracks.find(t => t.srcLang === currentSubtitles)?.label ??
        currentSubtitles;
    }
    if (currentHlsSubtitle !== -1) {
      return (
        hlsSubtitleTracks.find(t => t.id === currentHlsSubtitle)?.label ??
        "Subtitles"
      );
    }
    return "Off";
  }, [currentHlsSubtitle, currentSubtitles, hlsSubtitleTracks, subtitleTracks]);
  const [hasUserInteracted, setHasUserInteracted] = useState<boolean>(false);
  const lastProgressRef = useRef<{ seconds: number; duration: number }>({
    seconds: 0,
    duration: 0,
  });

  const videoRef = useRef<HTMLVideoElement>(null);

  // Deep link: `#audio-subtitles` opens the track menu on arrival.
  //
  // The hero's "Audio & subtitles" action uses it, so the viewer lands on the
  // choice itself instead of a paused player they then have to hunt through.
  //
  // Mount effect rather than a `useState` initializer: the hash makes the
  // client's first render differ from the server's, and hydration would warn
  // about the mismatch. The hash is cleared after opening so the state is
  // consumed once and a reload does not reopen a menu the viewer has since
  // dismissed.
  useEffect(() => {
    if (window.location.hash !== "#audio-subtitles") return;
    setSubtitleMenuOpen(true);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`
    );
  }, []);

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

  // External WebVTT cues are evaluated by the browser against the media clock,
  // and after a backward seek Chromium can keep displaying the cue that was
  // active *before* the jump until something forces a re-evaluation. Flipping
  // the showing track off and back on once the seek lands is the cheapest
  // reliable nudge. In-manifest (hls.js) renditions re-cue themselves and are
  // left alone.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handleSeeked = () => {
      if (currentSubtitles === "Off") return;
      const list = video.textTracks;
      for (let i = 0; i < list.length; i += 1) {
        const track = list[i];
        if (track.language === currentSubtitles) track.mode = "hidden";
      }
      requestAnimationFrame(() => {
        for (let i = 0; i < list.length; i += 1) {
          const track = list[i];
          if (track.language === currentSubtitles) track.mode = "showing";
        }
      });
    };
    video.addEventListener("seeked", handleSeeked);
    return () => video.removeEventListener("seeked", handleSeeked);
  }, [currentSubtitles]);

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
  const dashPlayerRef = useRef<any>(null);

  const effectiveIsLoading = externalIsLoading || isLoading;

  // A `loadeddata` listener parked by `attemptAutoplay` while it waits for the
  // first decodable frame. Held so a source swap can tear the stale one down
  // instead of letting it fire against media it was not scheduled for.
  const pendingAutoplayRef = useRef<(() => void) | null>(null);

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

    // `loadedmetadata` (and hls.js's MANIFEST_PARSED) arrives before a frame is
    // decodable: play() there starts the audio clock against a black picture —
    // the "sound before video" glitch. Waiting for current data keeps the two
    // in step, and costs nothing the viewer can see because the poster is
    // covering the frame either way.
    if (video.readyState < 2) {
      if (pendingAutoplayRef.current) {
        video.removeEventListener("loadeddata", pendingAutoplayRef.current);
      }
      const onReady = () => {
        video.removeEventListener("loadeddata", onReady);
        if (pendingAutoplayRef.current === onReady) {
          pendingAutoplayRef.current = null;
        }
        tryPlay(false);
      };
      pendingAutoplayRef.current = onReady;
      video.addEventListener("loadeddata", onReady);
      return;
    }

    tryPlay(false);
  }, []);

  useEffect(() => {
    if (initialQuality && initialQuality !== currentQuality) {
      setCurrentQuality(initialQuality);
    }
  }, [initialQuality]);

  const streamType = useMemo(() => {
    // The backend hands back same-origin *handles*, not the upstream URL, and
    // a handle's path is opaque -- `/api/proxy/dash?token=…` carries no `.mpd`.
    // So the container is read off which route names the handle (the routes
    // that mint them encode it), and only then off a real extension. Getting
    // this wrong is not cosmetic: a DASH playlist fed to `<video src>` fails
    // with a media error the viewer can only read as "broken".
    let pathname: string;
    try {
      pathname = new URL(streamUrl, window.location.origin).pathname.toLowerCase();
    } catch {
      return "mp4";
    }
    if (pathname.endsWith("/proxy/manifest") || pathname.endsWith(".m3u8")) return "hls";
    if (pathname.endsWith("/proxy/dash") || pathname.endsWith(".mpd")) return "dash";
    return "mp4";
  }, [streamUrl]);

  // Two ways a quality list can exist. Preferred: the ladder hls.js parsed out
  // of the master manifest, which works for a single `.m3u8` source. Fallback:
  // one URL per rendition handed over by the resolver.
  const qualityOptions = useMemo<string[]>(() => {
    if (hlsLevels.length > 1) {
      return hlsLevels.map(l => l.quality);
    }
    if (dashLevels.length > 1) {
      return dashLevels.map(l => l.quality);
    }
    return variants.map(v => v.quality).filter((q): q is string => Boolean(q));
  }, [hlsLevels, dashLevels, variants]);

  // While a manifest ladder is in play the active rung is tracked separately,
  // because changing it is an in-player level switch rather than a source swap.
  const activeQuality =
    hlsLevels.length > 1
      ? hlsQuality
      : dashLevels.length > 1
        ? dashQuality
        : currentQuality;

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

      // Paused with a painted frame: the last drawn image stays on the
      // bitmap. Skip getBoundingClientRect (layout) and the canvas resize
      // (which reallocates the backing store) — both are pure waste at 60fps
      // when nothing is moving. The loop stays scheduled so play() resumes
      // without a re-init hitch.
      if (video?.paused && video.videoWidth > 0) {
        animationFrameRef.current = requestAnimationFrame(drawFrame);
        return;
      }

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
    // DASH loads its player asynchronously, so a source can be swapped (or the
    // component unmounted) while the library is still in flight. The flag stops
    // that late arrival from attaching to a video element that has moved on.
    let dashCancelled = false;
    // Same reason as DASH: hls.js is ~600 KB, imported dynamically so it never
    // sits in the entry chunk — a viewer who opens /terms should not download it.
    let hlsCancelled = false;
    setIsLoading(true);
    // Ladder and poster are per-source; drop stale values so a manifest from
    // the previous mirror never leaks into the next one.
    setHlsLevels([]);
    setHlsQuality("Auto");
    setDashLevels([]);
    setDashQuality("Auto");
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
      hlsCancelled = true;
      hls?.destroy();
      hlsRef.current = null;
      // A DASH player may still be importing. Flipping the flag first stops
      // that arrival from attaching to a video element that has moved on.
      dashCancelled = true;
      dashPlayerRef.current?.destroy?.();
      dashPlayerRef.current = null;
      if (pendingAutoplayRef.current) {
        video.removeEventListener("loadeddata", pendingAutoplayRef.current);
        pendingAutoplayRef.current = null;
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      clearStallWatch();
      initAmbientCanvas();
      // Autoplay is deliberately not attempted here: metadata lands before the
      // first decodable frame, and playing from this event is what starts the
      // audio against a black picture. `loadeddata` below is the one that goes.
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
    // First frame is actually decodable -> the poster has done its job, and
    // this is also the earliest point where play() cannot run ahead of the
    // picture. Covers progressive MP4 and native (Safari) HLS, which never
    // emit MANIFEST_PARSED.
    const handleLoadedData = () => {
      setPosterSettled(true);
      attemptAutoplay();
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("error", handleError);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("stalled", handleStalled);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("ended", handleEnded);
    video.addEventListener("loadeddata", handleLoadedData);

    if (streamType === "hls") {
      // Imported lazily, not at module scope: hls.js is the largest library in
      // the bundle and a viewer on /login should never download it. The
      // cancellation flag mirrors the DASH path above — a source swap or
      // unmount while the import is in flight must not attach to a video
      // element that has moved on.
      import("hls.js")
        .then(({ default: Hls }) => {
          if (hlsCancelled) return;

          if (Hls.isSupported()) {
            hls = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
            });
            // The instance exists only after this async import resolves, so
            // the ref is assigned here — not at the synchronous line below,
            // where `hls` is still null.
            hlsRef.current = hls;

            hls.loadSource(streamUrl);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (hlsCancelled) return;
              setHlsLevels(deriveHlsLevels(hls));
              // No `setPosterSettled` here: a parsed manifest is not a decodable
              // frame. Fading the poster this early uncovered black video while
              // the opening segments were still in flight.
              attemptAutoplay();
              initAmbientCanvas();
            });

            // Renditions are parsed *after* the manifest event, and an alternate
            // audio or text track can be discovered when a level playlist loads
            // rather than up front. Reading them on their own update event rather
            // than once after the manifest is what stops a track that arrives late
            // from being missing from the menu for the rest of the session.
            //
            // Each update also mirrors hls.js's own current selection back into
            // component state, so the highlighted row is what the instance is
            // actually doing -- including the default the library picks on its own,
            // which the viewer never chose and must not be shown as chosen.
            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
              if (hlsCancelled) return;
              setHlsAudioTracks(deriveHlsAudioTracks(hls));
              setCurrentAudio(hls.audioTrack);
            });
            hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
              if (hlsCancelled) return;
              setHlsSubtitleTracks(deriveHlsSubtitleTracks(hls));
              setCurrentHlsSubtitle(hls.subtitleTrack);
            });

            // ABR moves the rung on its own when it is in charge, so the label is
            // mirrored from the level the instance actually switched to -- not from
            // the last row the viewer clicked. Otherwise a weak-network downswitch
            // would keep showing the taller rung the player just abandoned, which
            // is exactly the moment the viewer most needs an honest number.
            hls.on(
              Hls.Events.LEVEL_SWITCHED,
              (_event: unknown, data: { level?: number }) => {
                if (hlsCancelled) return;
                const level = hls.levels?.[data?.level ?? -1];
                const height = Number(level?.height) || 0;
                setHlsQuality(height > 0 ? `${height}p` : "Auto");
              }
            );

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
        })
        .catch(() => {
          if (!hlsCancelled) onSourceError?.();
        });
    } else if (streamType === "dash") {
      // No browser plays an `.mpd` natively, so a DASH source has to go
      // through dash.js -- the same role hls.js plays for `.m3u8`. Without it
      // this branch was an immediate `onSourceError`, which is why every
      // provider film (they resolve to DASH, ~11 MPDs for every 1 playlist)
      // looked broken even though the backend had the bytes.
      //
      // Imported lazily, not at module scope: dash.js reads `navigator` while
      // it loads, so a static import makes every test file that touches this
      // component die in Node before it can assert anything.
      import("dashjs")
        .then(({ MediaPlayer }) => {
          if (dashCancelled) return;
          const player = MediaPlayer().create();
          player.updateSettings({
            streaming: {
              buffer: { fastSwitchEnabled: true },
              retryAttempts: { MPD: 1, MediaSegment: 3 },
            },
          });
          player.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
            if (dashCancelled) return;
            // Same rule as hls.js's MANIFEST_PARSED: stream init is not a
            // decodable frame, so the poster stays until `loadeddata`.
            attemptAutoplay();
            initAmbientCanvas();
            // The representation list only exists once the stream is up, and
            // a single-representation (VOD progressive-in-DASH) manifest is
            // common — hence "length > 1" gating the menu rather than mere
            // presence.
            try {
              const representations = (player.getRepresentationsByType?.(
                "video"
              ) ?? []) as { height?: number }[];
              setDashLevels(deriveDashLevels(representations));
            } catch {
              setDashLevels([]);
            }
          });
          // Same contract as hls.js's LEVEL_SWITCHED: ABR may move the rung on
          // its own, so the label is read back from the representation the
          // player actually rendered rather than from the last clicked row.
          player.on(
            MediaPlayer.events.QUALITY_CHANGE_RENDERED,
            (e: { mediaType?: string; newRepresentation?: { height?: number } }) => {
              if (e?.mediaType !== "video") return;
              const height = Number(e?.newRepresentation?.height) || 0;
              setDashQuality(height > 0 ? `${height}p` : "Auto");
            }
          );
          player.on(MediaPlayer.events.ERROR, (e: { error?: { code?: string } }) => {
            // A fatal manifest/segment error is the same end state as a fatal
            // hls.js error: there is nothing left to retry, tell the caller.
            if (dashCancelled) return;
            const code = e?.error?.code;
            if (
              code === "manifestError" ||
              code === "downloadError" ||
              code === "codecUnsupportedError"
            ) {
              player.destroy();
              onSourceError?.();
            }
          });
          player.initialize(video, streamUrl, false);
          dashPlayerRef.current = player;
        })
        .catch(() => {
          // The library failed to load at all. Saying so is the same contract
          // as a media element that cannot play the container.
          if (!dashCancelled) onSourceError?.();
        });
    } else {
      video.src = streamUrl;
    }

    // `hlsRef.current` is assigned inside the dynamic import's `.then()`
    // above — it cannot be set synchronously here because the instance does
    // not exist until hls.js has finished loading.

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

    // `timeupdate` fires ~4x/s. Each `setProgress` re-renders the entire
    // player tree, so only push when the bar has actually moved a visible
    // amount (~0.5%) — on a 2h film that's one render per half-percent of
    // progress, not four per second.
    let lastPct = -1;

    const handleTimeUpdate = () => {
      if (!isNaN(video.duration) && video.duration > 0) {
        const pct = Math.round(((video.currentTime / video.duration) * 100) * 2) / 2;
        if (pct !== lastPct) {
          lastPct = pct;
          setProgress(pct);
        }
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
    setHasUserInteracted(true);
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    // Click-to-play before the first frame would start audio against a black
    // picture, the same glitch autoplay is guarded against. Hand it to the
    // gated path instead, which starts on `loadeddata`.
    if (video.readyState < 2) {
      attemptAutoplay();
      return;
    }
    video
      .play()
      .then(() => {
        setIsPlaying(true);
      })
      .catch(() => {
        setIsPlaying(false);
      });
  }, [isPlaying, attemptAutoplay]);

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

  /*
   * Track selection.
   *
   * Subtitles come from two places and only one choice may be on at a time:
   * the resolver's WebVTT files, selected through `video.textTracks`, and the
   * in-manifest renditions, selected through hls.js. Leaving both alone is how
   * the previous "Native Audio" button failed -- it wrote the literal string
   * "Native" into the *subtitle* selection, matched no track, and as a side
   * effect silently disabled every caption the viewer had turned on while
   * changing nothing about the audio.
   *
   * Each chooser therefore resets the mechanism it is not using, and state is
   * written before the instance so a component with no hls.js running (native
   * HLS, MP4) still moves its own highlight.
   */
  const chooseNoSubtitles = useCallback(() => {
    setTracksTouched(true);
    setCurrentSubtitles("Off");
    setCurrentHlsSubtitle(-1);
    const instance = hlsRef.current;
    if (instance) instance.subtitleTrack = -1;
  }, []);

  const chooseExternalSubtitles = useCallback((lang: string) => {
    setTracksTouched(true);
    setCurrentHlsSubtitle(-1);
    const instance = hlsRef.current;
    if (instance) instance.subtitleTrack = -1;
    setCurrentSubtitles(lang);
  }, []);

  const chooseInStreamSubtitles = useCallback((id: number) => {
    setTracksTouched(true);
    setCurrentSubtitles("Off");
    setCurrentHlsSubtitle(id);
    const instance = hlsRef.current;
    if (instance) instance.subtitleTrack = id;
  }, []);

  const chooseAudioTrack = useCallback((id: number) => {
    setTracksTouched(true);
    setCurrentAudio(id);
    const instance = hlsRef.current;
    if (instance) instance.audioTrack = id;
  }, []);

  /**
   * What the Audio section lists.
   *
   * A source with no alternate renditions still gets an entry, named "Original"
   * rather than a language, so the section is never an empty box and never a
   * button that claims to switch something the manifest did not offer.
   */
  const audioOptions = useMemo<PlayerTrack[]>(
    () =>
      hlsAudioTracks.length > 0
        ? hlsAudioTracks
        : [{ id: 0, label: "Original", language: null }],
    [hlsAudioTracks]
  );

  /**
   * Every subtitle choice, flattened to one list so the menu renders one block.
   *
   * "Off" clears both sources at once, which is the only way the list stays
   * coherent: two independent "off" rows would let a viewer believe they had
   * turned subtitles off while the other mechanism still had a track on.
   */
  const subtitleOptions = useMemo(
    () => [
      {
        key: "off",
        label: "Off",
        active: currentSubtitles === "Off" && currentHlsSubtitle === -1,
        onPick: chooseNoSubtitles,
      },
      ...subtitleTracks.map(track => ({
        key: `file-${track.key}`,
        label: track.label,
        active: currentSubtitles === track.srcLang,
        onPick: () => chooseExternalSubtitles(track.srcLang),
      })),
      ...hlsSubtitleTracks.map(track => ({
        key: `instream-${track.id}`,
        label: track.label,
        active: currentHlsSubtitle === track.id,
        onPick: () => chooseInStreamSubtitles(track.id),
      })),
    ],
    [
      chooseExternalSubtitles,
      chooseInStreamSubtitles,
      chooseNoSubtitles,
      currentHlsSubtitle,
      currentSubtitles,
      hlsSubtitleTracks,
      subtitleTracks,
    ]
  );

  /**
   * Open on the viewer's language, once, before they have touched a switcher.
   *
   * Audio wins over subtitles. A rendition in a language someone speaks is a
   * better default than captions laid over one they do not, so captions are
   * only reached when the manifest declares its audio languages, none of them
   * is the viewer's, and a subtitle track in theirs exists -- and never when
   * the manifest declares no audio languages at all, because the player
   * cannot then know what language the sound is in and turning captions on
   * over audio the viewer already follows would be worse than showing none.
   *
   * Every branch writes state rather than going through the choosers: this is
   * the seed, not a choice, and it must not raise `tracksTouched` or a later
   * track list arriving would look like a decision the viewer never made.
   */
  useEffect(() => {
    if (!preferredLanguage || tracksTouched) return;
    const wanted = baseLanguage(preferredLanguage);
    if (!wanted) return;

    const audioMatch = hlsAudioTracks.find(track =>
      sameLanguage(track.language, wanted)
    );
    if (audioMatch) {
      setCurrentAudio(audioMatch.id);
      const instance = hlsRef.current;
      if (instance && instance.audioTrack !== audioMatch.id) {
        instance.audioTrack = audioMatch.id;
      }
      return;
    }

    // No audio list, or a list that declares no languages: nothing is known
    // about the sound, so subtitles stay where the player put them.
    if (!hlsAudioTracks.some(track => track.language)) return;

    const inManifest = hlsSubtitleTracks.find(
      track => track.id >= 0 && sameLanguage(track.language, wanted)
    );
    if (inManifest) {
      setCurrentSubtitles("Off");
      setCurrentHlsSubtitle(inManifest.id);
      const instance = hlsRef.current;
      if (instance && instance.subtitleTrack !== inManifest.id) {
        instance.subtitleTrack = inManifest.id;
      }
      return;
    }

    const external = subtitleTracks.find(track =>
      sameLanguage(track.srcLang, wanted)
    );
    if (external) {
      setCurrentHlsSubtitle(-1);
      const instance = hlsRef.current;
      if (instance) instance.subtitleTrack = -1;
      setCurrentSubtitles(external.srcLang);
    }
  }, [
    preferredLanguage,
    tracksTouched,
    hlsAudioTracks,
    hlsSubtitleTracks,
    subtitleTracks,
  ]);

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

      // Same contract for a DASH ladder. A manual rung turns ABR off for
      // video — otherwise dash.js's own heuristics overwrite the choice on the
      // next bandwidth estimate — and "Auto" hands it back.
      if (dashLevels.length > 1) {
        const player = dashPlayerRef.current;
        if (!player) return;
        if (quality === "Auto") {
          player.updateSettings({
            streaming: { abr: { autoSwitchBitrate: { video: true } } },
          });
        } else {
          const level = dashLevels.find(l => l.quality === quality);
          if (!level) return;
          player.updateSettings({
            streaming: { abr: { autoSwitchBitrate: { video: false } } },
          });
          // `forceReplace: true` matters: without it dash.js queues the manual
          // switch and only applies it on a natural segment boundary, which
          // never visibly happens mid-buffer — the rung the user clicked just
          // appears not to stick. Forcing a replace swaps the buffer now.
          player.setRepresentationForTypeByIndex("video", level.index, true);
        }
        setDashQuality(quality);
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
    [hlsLevels, dashLevels, currentQuality, variants, onQualityChange]
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

        Spinner only — no text, no backdrop-blur panel. A labelled box over
        live video reads as "stuck"; a ring over the poster reads as "moment".
      */}
      {effectiveIsLoading && !autoCycling && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
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
                      {audioOptions.map(track => (
                        <button
                          key={track.id}
                          onClick={e => {
                            e.stopPropagation();
                            chooseAudioTrack(track.id);
                            setSubtitleMenuOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors flex items-center gap-2 ${
                            currentAudio === track.id
                              ? "text-violet-500 font-bold"
                              : "text-white"
                          }`}
                        >
                          <Volume2Icon className="w-3 h-3" />
                          <span>{track.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Always shown, even when the only option is "Off": a
                      hidden menu reads as "this player has no subtitles",
                      which is wrong the moment a title carries one language —
                      and the viewer has no way to discover it. */}
                  <div className="px-4 py-2">
                    <p className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-2">
                      Subtitles
                    </p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {subtitleOptions.map(option => (
                        <button
                          key={option.key}
                          onClick={e => {
                            e.stopPropagation();
                            option.onPick();
                            setSubtitleMenuOpen(false);
                          }}
                          className={`w-full text-left px-4 py-2 text-xs hover:bg-white/10 transition-colors ${
                            option.active ? "text-violet-500 font-bold" : "text-white"
                          }`}
                        >
                          {option.label}
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
                  aria-label="Quality"
                  aria-expanded={qualityMenuOpen}
                >
                  <span>{activeQuality}</span>
                  <ChevronDown
                    aria-hidden
                    className={`w-3.5 h-3.5 transition-transform ${
                      qualityMenuOpen ? "rotate-180" : ""
                    }`}
                  />
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
    </div>
  );
};
