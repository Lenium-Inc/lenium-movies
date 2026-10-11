import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type CSSProperties,
} from "react";
import { useLocation, useParams, useSearch } from "wouter";
import { Check, Star, ArrowLeft, Play, Share2, Plus } from "lucide-react";
import { getRating, setRating, subscribeRatings } from "@/services/ratings";
import {
  apiUrl,
  fetchDiscover,
  fetchTrailer,
  getStreamSource,
  MOVIE_RESOLVE_TIMEOUT_MS,
  resolveStream,
  sanitizeSubtitles,
  StreamNotFoundError,
  StreamExhaustedError,
  StreamTimeoutError,
  type CatalogItem,
  type ResolvedStream,
  type StreamMovie,
  type TrailerInfo,
} from "@/services/api";
import { VideoPlayer, type StreamVariant } from "@/components/stream/VideoPlayer";
import { DownloadButton } from "@/components/stream/DownloadButton";
import { StreamLoader, type StreamLoadStage } from "@/components/stream/StreamLoader";
import { formatRuntime } from "@/lib/format";
import { titleUnavailable } from "@/lib/playbackCopy";
import { WatchTVControls, type SeasonInfo } from "@/components/stream/WatchTVControls";
import { cancelInFlightPrefetch, prefetchForOpen } from "@/services/prefetch";
import { useLocalSession } from "@/context/LocalSessionContext";
import { getProgress, progressForTitle, recordWatch, subscribeStats } from "@/services/stats";
import type {
  Movie,
  ResolvedStream as ResolvedStreamType,
  StreamVariant as StreamVariantType,
} from "@/components/movies/types";
import type { StreamEpisode } from "@/services/api";
import { buildWatchPath, resolveMediaType } from "@/lib/watchRoute";
import { progressKey } from "@/lib/progressKey";
import { absoluteUrl } from "@/lib/siteUrl";
import { publishWatchSeo, resetWatchSeo } from "@/lib/watchSeo";
import { useTasteRecorder } from "@/hooks/useTaste";
import { DEFAULT_PREFERRED_LANGUAGE, useAppSettings } from "@/contexts/AppSettingsContext";
import { ReleaseCountdown } from "@/components/watch/ReleaseCountdown";
import { resolveTrailer, trailerThumbnail } from "@/lib/tmdbTrailers";
import { formatReleaseDate, isUpcoming } from "@/services/notifications";
import { isEmbedSourceUrl, orderDirectStreams } from "@/lib/streamUtils";
import { tmdbImage, type TmdbImageSize } from "@/lib/tmdbImages";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { apiHistoryAdd } from "@/services/auth";
import { pushRemoveToRemote, pushToggleToRemote } from "@/services/lists";
import { toast } from "sonner";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

/** Delegates to `tmdbImage` so the requested rendition actually takes effect. */
function getImageUrl(path: string, size: TmdbImageSize): string {
  if (path?.startsWith("http")) return tmdbImage(path, size);
  return path ? `${TMDB_IMAGE_BASE_URL}/${size}${path}` : "";
}

const RATE_AFTER_SECONDS = 15 * 60;
const REMOTE_PROGRESS_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 3;
const COLD_START_BACKOFF_MS = 4000;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_DELAY_MS = 1200;
const MAX_AUTO_RETRY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Every `<iframe>` on the page uses this exact set. `allow-same-origin` is the
 * one that matters: without it the frame is an opaque origin, so the embedded
 * player cannot read its own storage or fetch its segments and renders black.
 * `allow="autoplay"` is the second: Chrome refuses unmuted autoplay on a fresh
 * origin without it.
 */
const FRAME_ALLOW = "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write";
const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox allow-forms";

const PLAYER_FRAME_CLASS =
  "relative w-full mx-auto aspect-video min-h-[300px] rounded-[18px] overflow-hidden border border-white/10 group";

const PLAYER_GLOW_CLASS =
  "absolute -inset-x-2 -top-7 -bottom-3 rounded-[24px] blur-[50px] opacity-70 -z-10 pointer-events-none transition-all duration-700";

const HERO_GLOW_STYLE: CSSProperties = {
  background:
    "radial-gradient(60% 70% at 30% 40%, #4a3320 0%, transparent 70%), radial-gradient(50% 60% at 80% 60%, #2b1d4a 0%, transparent 70%)",
};

const HERO_FRAME_STYLE: CSSProperties = {
  background:
    "radial-gradient(520px 320px at 50% 25%, #3a2c1a 0%, #14100a 55%, #05060a 100%)",
};

const WATCH_GHOST_BUTTON =
  "inline-flex h-[42px] items-center gap-2 rounded-[10px] border border-white/14 bg-transparent px-4 text-sm text-[#f1f3f8] transition hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400";

const WATCH_GHOST_ICON_BUTTON =
  "grid h-[42px] w-[42px] place-items-center rounded-[10px] border border-white/14 bg-transparent text-[#f1f3f8] transition hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400";

function classifyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (error instanceof StreamExhaustedError) {
    return { type: "exhausted", message: titleUnavailable, recoverable: false, retryCount: 0 };
  }

  if (error instanceof StreamNotFoundError) {
    return {
      type: "not_found",
      message: `"${error.message.replace('No playable stream found for "', "").replace('"', "")}" isn't available to stream yet.`,
      recoverable: false,
      retryCount: 0,
    };
  }

  if (lowerMessage.includes("404") || lowerMessage.includes("not found")) {
    return { type: "not_found", message: "This title isn't available to stream.", recoverable: false, retryCount: 0 };
  }

  if (
    lowerMessage.includes("403") ||
    lowerMessage.includes("forbidden") ||
    lowerMessage.includes("geo") ||
    lowerMessage.includes("region")
  ) {
    return { type: "geo_blocked", message: "This content is not available in your region.", recoverable: false, retryCount: 0 };
  }

  if (lowerMessage.includes("429") || lowerMessage.includes("rate limit") || lowerMessage.includes("too many requests")) {
    return { type: "rate_limited", message: "Too many requests. Please wait a moment and try again.", recoverable: true, retryCount: 0 };
  }

  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("fetch") ||
    lowerMessage.includes("connection") ||
    lowerMessage.includes("timeout")
  ) {
    return { type: "network", message: "Network error. Please check your connection and try again.", recoverable: true, retryCount: 0 };
  }

  if (lowerMessage.includes("embed") || lowerMessage.includes("provider") || lowerMessage.includes("source")) {
    return {
      type: "provider_unavailable",
      message: "The streaming provider is currently unavailable. Trying alternative sources...",
      recoverable: true,
      retryCount: 0,
    };
  }

  if (
    lowerMessage.includes("unexpected token") ||
    lowerMessage.includes("non-json") ||
    lowerMessage.includes("unexpected payload shape")
  ) {
    return { type: "server_error", message: "The movie service returned an error. Please try again.", recoverable: true, retryCount: 0 };
  }

  return { type: "unknown", message: "We couldn't load this stream. Please try again.", recoverable: true, retryCount: 0 };
}

function isWorthRetrying(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

export async function fetchMovieDetails(
  tmdbId: string,
  kind: "movie" | "tv" = "movie"
): Promise<Movie | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOVIE_RESOLVE_TIMEOUT_MS);
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(apiUrl("/api/movies/resolve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tmdbId, media_type: kind }),
        signal: controller.signal,
      });
      if (response.ok || !isWorthRetrying(response.status)) break;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    if (!response?.ok) return null;
    const data = await response.json();
    if (!data.movie) return null;

    const m = data.movie;
    const mediaType = m.media_type === "tv" ? "tv" : "movie";
    const year = m.year ? parseInt(m.year) : null;
    const runtime = typeof m.runtime === "number" ? m.runtime : null;
    const rating = m.rating ?? null;
    const score = typeof m.vote_average === "number" ? m.vote_average : null;
    const genre = Array.isArray(m.genres) ? m.genres : [];
    const director = m.director ?? null;
    const cast = Array.isArray(m.cast) ? m.cast : [];
    const country = m.country ?? null;
    const language = m.language ?? null;
    const releaseDate = m.release_date ?? null;

    return {
      id: parseInt(m.id),
      providerId: m.id,
      title: m.title,
      year,
      runtime,
      rating,
      score,
      genre,
      poster: m.poster_url,
      backdrop: m.backdrop_url || m.poster_url,
      synopsis: m.overview || "",
      director,
      source: "tmdb",
      mediaType,
      cast,
      country,
      language,
      releaseDate,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function WatchPage() {
  const [location, navigate] = useLocation();
  const params = useParams();

  const tmdbId = params.id;
  // wouter's `useLocation` returns a pathname only, so `location.search` is
  // always undefined. Reading the query from it made `?type=tv` silently
  // become "movie", which is why every series resolved as a feature film.
  const search = useSearch();
  const searchParams = useMemo(() => new URLSearchParams(search || ""), [search]);
  const urlSeason = parseInt(searchParams.get("season") || "1", 10);
  const urlEpisode = parseInt(searchParams.get("episode") || "1", 10);
  const urlType = searchParams.get("type") || "movie";

  const [movie, setMovie] = useState<Movie | null>(null);
  const [movieLoading, setMovieLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [season, setSeason] = useState(urlSeason);
  const [episode, setEpisode] = useState(urlEpisode);

  useEffect(() => {
    setSeason(urlSeason);
    setEpisode(urlEpisode);
  }, [urlSeason, urlEpisode]);

  const isSeries = useMemo<boolean>(
    () =>
      resolveMediaType({
        localMediaType: movie?.mediaType,
        resolverMediaType: resolved?.stream?.media_type,
        urlType,
      }) === "tv",
    [movie, resolved?.stream?.media_type, urlType]
  );

  useEffect(() => {
    if (movie && movie.mediaType === "movie" && (season !== 1 || episode !== 1)) {
      setSeason(1);
      setEpisode(1);
    }
  }, [movie, season, episode]);

  const [myRating, setMyRating] = useState<number>(0);
  const [watchedSeconds, setWatchedSeconds] = useState(0);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [episodeDetails, setEpisodeDetails] = useState<any>(null);
  const [currentEpisodeTitle, setCurrentEpisodeTitle] = useState("");

  // Refs for retry logic.
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRetryRef = useRef(0);
  const autoRetryStartedRef = useRef(Date.now());
  // The live copy of `resolving`. The retry timer fires ~1s after a failure,
  // long after React has re-rendered and created a new `resolveAndPlay` whose
  // captured `resolving` is `true`; guarding on state instead of this ref is
  // what made every automatic retry return immediately.
  const resolvingRef = useRef(false);

  const resolveCacheRef = useRef<Map<string, ResolvedStream>>(new Map());

  const { isInMyList, toggleMyList, addToHistory } = useLocalSession();
  const { user: authUser } = useAuth();
  const { activeProfile } = useActiveProfile();
  const activeProfileId = activeProfile ? String(activeProfile.id) : null;
  const recordTaste = useTasteRecorder(activeProfileId);

  useEffect(() => {
    if (!tmdbId) return;
    setMovieLoading(true);
    // The kind has to travel with the id. A TMDB id is only meaningful against
    // its own type, and the resolver defaults an absent `media_type` to
    // "movie" -- so a series looked up as a film is a lookup in the wrong
    // catalog, which answers "unavailable" for a title that does stream.
    fetchMovieDetails(tmdbId, urlType === "tv" ? "tv" : "movie").then(m => {
      if (m) {
        setMovie(m);
        setMyRating(getRating(m.id) ?? 0);
        publishWatchSeo({
          id: m.providerId,
          title: m.title,
          description: m.synopsis || undefined,
          image: m.backdrop || m.poster || undefined,
          year: m.year,
        });
      }
      setMovieLoading(false);
    });
    return () => resetWatchSeo();
  }, [tmdbId, urlType]);

  useEffect(() => {
    if (!movie) return;
    return subscribeRatings(() => setMyRating(getRating(movie.id) ?? 0));
  }, [movie?.id]);

  useEffect(() => {
    if (!movie) return;
    const mediaType = isSeries ? "tv" : "movie";
    const key = progressKey(movie.providerId ?? movie.id, mediaType, season, episode);
    const refresh = () =>
      setWatchedSeconds(
        Math.max(
          getProgress(String(movie.id)),
          getProgress(key),
          resolved ? getProgress(resolved.stream.id) : 0,
          progressForTitle(movie.title)
        )
      );
    refresh();
    return subscribeStats(refresh);
  }, [movie?.id, movie?.providerId, movie?.title, resolved, isSeries, season, episode]);

  const canRate = watchedSeconds >= RATE_AFTER_SECONDS;

  useEffect(() => {
    if (!movie) return;
    let active = true;
    setTrailer(null);
    void fetchTrailer(movie.title, movie.year)
      .then(info => {
        if (active) setTrailer(info);
      })
      .catch(() => {
        if (active) setTrailer(null);
      });
    return () => {
      active = false;
    };
  }, [movie?.title, movie?.year]);

  const resolvedStreamId = resolved?.stream?.id;
  const fetchEpisodeInfo = useCallback(
    async (s: number, e: number) => {
      if (!resolvedStreamId || !/^\d+$/.test(resolvedStreamId)) return;
      try {
        const details = await fetch(
          apiUrl(`/api/episodes?tmdb_id=${resolvedStreamId}&season=${s}&episode=${e}`)
        );
        if (details.ok) {
          const data = await details.json();
          if (data.success) {
            setEpisodeDetails(data.episode);
            setCurrentEpisodeTitle(data.episode.title || `S${s} E${e}`);
          }
        }
      } catch (err) {
        console.warn("Failed to fetch episode details:", err);
      }
    },
    [resolvedStreamId]
  );

  useEffect(() => {
    if (movie?.mediaType === "tv" && resolvedStreamId) {
      void fetchEpisodeInfo(season, episode);
    } else {
      setEpisodeDetails(null);
      setCurrentEpisodeTitle(movie?.title || "");
    }
  }, [season, episode, movie?.mediaType, resolvedStreamId, fetchEpisodeInfo]);

  const resolveWithRetry = useCallback(
    async (
      title: string,
      year?: number | null,
      options?: {
        season?: number;
        episode?: number;
        tmdbId?: string;
        mediaType?: "movie" | "tv";
      },
      attempt = 1
    ): Promise<ResolvedStream> => {
      // The kind belongs in the key. A movie and a series can share a TMDB id
      // namespace, and caching on the id alone lets a film's entry satisfy a
      // series' lookup -- the id matches, the content does not.
      const cacheKey = `${options?.mediaType ?? "movie"}:${options?.tmdbId ?? title}`;
      const cached = resolveCacheRef.current.get(cacheKey);
      if (cached) return cached;

      try {
        const stream = await resolveStream(title, year, options);
        resolveCacheRef.current.set(cacheKey, stream);
        return stream;
      } catch (error) {
        const playbackError = classifyError(error);
        if (!playbackError.recoverable || attempt >= MAX_RETRY_ATTEMPTS) throw error;
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        return resolveWithRetry(title, year, options, attempt + 1);
      }
    },
    []
  );

  const resolveAndPlay = useCallback(
    async (targetSeason: number, targetEpisode: number) => {
      // Guard on the ref, never on `resolving` state: the retry timer below
      // outlives the render that scheduled it.
      if (resolvingRef.current || !movie) return;
      resolvingRef.current = true;
      setResolving(true);

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }

      const mediaType: "movie" | "tv" = isSeries ? "tv" : "movie";

      try {
        let base = resolved?.stream ?? null;
        if (!base) {
          const stream = await resolveWithRetry(movie.title, movie.year, {
            tmdbId: movie.providerId,
            mediaType,
          });
          setResolved(stream);
          if (stream.language) setDetectedLanguage(stream.language);
          recordTaste("play", movie, { weight: 1 });
          base = stream.stream;
        }
        setSeason(targetSeason);
        setEpisode(targetEpisode);

        let playable: StreamMovie = base;

        if (mediaType && /^\d+$/.test(base.id)) {
          try {
            const source = await getStreamSource({
              tmdbId: base.id,
              mediaType,
              season: mediaType === "tv" ? targetSeason : undefined,
              episode: mediaType === "tv" ? targetEpisode : undefined,
            });
            if (source.language) setDetectedLanguage(source.language);

            playable = {
              ...base,
              stream_url: source.url,
              sources: source.sources,
              mirrors: source.mirrors,
              // Carried explicitly in both directions so a later direct resolve
              // cannot inherit a stale `true` from a previous embed.
              is_embed: source.isEmbed === true,
              ...(source.subtitles ? { subtitles: source.subtitles } : {}),
              season: targetSeason,
              episode: targetEpisode,
            };
          } catch (error) {
            console.warn(
              `[WatchPage] playback-init failed for "${base.title}" (S${targetSeason}E${targetEpisode}), using resolved stream`,
              error
            );
          }
        }

        setResolved({ stream: playable, exact: true });
        prefetchForOpen(playable);

        navigate(
          buildWatchPath(movie.providerId, {
            mediaType: isSeries ? "tv" : "movie",
            season: targetSeason,
            episode: targetEpisode,
          }),
          { replace: true }
        );

        // A success earns a fresh budget for whatever comes next.
        autoRetryRef.current = 0;
        autoRetryStartedRef.current = Date.now();
      } catch (error) {
        const playbackError = classifyError(error);
        console.error(
          `[WatchPage] could not resolve "${movie.title}" (${movie.year ?? "unknown year"})`,
          error
        );

        autoRetryRef.current += 1;
        const budgetSpent =
          autoRetryRef.current >= MAX_RETRY_ATTEMPTS ||
          Date.now() - autoRetryStartedRef.current >= MAX_AUTO_RETRY_WINDOW_MS;

        if (playbackError.recoverable && !budgetSpent) {
          retryTimeoutRef.current = setTimeout(() => {
            void resolveAndPlayRef.current(targetSeason, targetEpisode);
          }, RETRY_BASE_DELAY_MS);
        } else {
          if (playbackError.recoverable) {
            console.warn(
              `[WatchPage] giving up on "${movie.title}" after ${autoRetryRef.current} attempts`
            );
          }
          setStreamUnavailable(true);
        }
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [movie, resolved, isSeries, navigate, resolveWithRetry, recordTaste]
  );

  // The timer always calls the newest callback, so no stale closure can stall it.
  const resolveAndPlayRef = useRef(resolveAndPlay);
  useEffect(() => {
    resolveAndPlayRef.current = resolveAndPlay;
  }, [resolveAndPlay]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, []);

  // Single resolve trigger, keyed so a title/episode resolves once and an
  // episode change resolves again. Replaces the old `opened` ref, which locked
  // the page to the first episode it ever saw.
  const resolvedKeyRef = useRef("");
  useEffect(() => {
    if (!movie) return;
    if (isUpcoming(movie.releaseDate)) return;
    const key = `${movie.providerId}:${isSeries ? `${season}:${episode}` : "movie"}`;
    if (resolvedKeyRef.current === key) return;
    resolvedKeyRef.current = key;
    autoRetryRef.current = 0;
    autoRetryStartedRef.current = Date.now();
    void resolveAndPlayRef.current(season, episode);
  }, [movie, isSeries, season, episode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate("/");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate]);

  const handleClose = () => {
    cancelInFlightPrefetch();
    navigate("/");
  };

  const handleBackToDetails = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("/");
  };

  const handleShare = async () => {
    if (!movie) return;
    const shareUrl = absoluteUrl(`/watch/${movie.providerId}`);
    try {
      if (navigator.share) {
        await navigator.share({ title: movie.title, url: shareUrl });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied");
    } catch {
      /* cancelled share sheet or insecure-origin clipboard write */
    }
  };

  const progressCursorRef = useRef<{ key: string; seconds: number }>({ key: "", seconds: 0 });
  const remoteProgressAtRef = useRef(0);

  const handleProgress = useCallback(
    ({ seconds, durationSeconds }: { seconds: number; durationSeconds: number }) => {
      if (!movie) return;
      const mediaType: "movie" | "tv" = isSeries ? "tv" : "movie";
      const key = `${movie.providerId}:${mediaType}:${season}:${episode}`;

      const cursor = progressCursorRef.current;
      if (cursor.key !== key) progressCursorRef.current = { key, seconds: 0 };
      const last = progressCursorRef.current.seconds;
      const delta = seconds - last;
      progressCursorRef.current = { key, seconds };

      if (delta > 0) {
        recordWatch(
          progressKey(movie.providerId, mediaType, season, episode),
          delta,
          durationSeconds,
          {
            title: movie.title,
            poster: movie.poster ?? null,
            year: movie.year ?? null,
            mediaType,
            season,
            episode,
          }
        );
      }

      const now = Date.now();
      if (!authUser || now - remoteProgressAtRef.current < REMOTE_PROGRESS_MS) return;
      remoteProgressAtRef.current = now;
      apiHistoryAdd({
        movie_key: progressKey(movie.providerId, mediaType, season, episode),
        title: movie.title,
        year: movie.year ?? null,
        poster: movie.poster ?? null,
        backdrop: movie.backdrop ?? null,
        media_type: movie.mediaType ?? mediaType,
        progress_seconds: seconds,
        duration_seconds: durationSeconds,
        watched_at: now,
        profile_id: activeProfileId,
      }).catch(() => {});
    },
    [movie, isSeries, season, episode, authUser, activeProfileId]
  );

  const displayTitle =
    movie?.mediaType === "tv" && episodeDetails?.title
      ? `${movie.title} — ${episodeDetails.title}`
      : movie?.mediaType === "tv"
        ? `${movie.title} — S${season} E${episode}`
        : movie?.title || "Loading...";

  const DEFAULT_TAB_TITLE = "Stream Vy";
  useEffect(() => {
    document.title = movie?.title ? `${movie.title} — Stream Vy` : DEFAULT_TAB_TITLE;
    return () => {
      document.title = DEFAULT_TAB_TITLE;
    };
  }, [movie?.title]);

  useEffect(() => {
    if (resolved?.stream && movie) {
      addToHistory({
        id: movie.id,
        providerId: movie.providerId,
        title: movie.title,
        year: movie.year,
        poster: movie.poster,
        backdrop: movie.backdrop,
        mediaType: movie.mediaType,
        score: movie.score,
        watchedAt: Date.now(),
      });
    }
  }, [resolved?.stream, movie, addToHistory]);

  const recordedHistoryRef = useRef("");
  useEffect(() => {
    if (!movie || !authUser) return;
    const key = `${activeProfileId}:${movie.providerId}:${season}:${episode}`;
    if (recordedHistoryRef.current === key) return;
    recordedHistoryRef.current = key;
    apiHistoryAdd({
      movie_key: progressKey(
        movie.providerId,
        movie.mediaType === "tv" ? "tv" : "movie",
        season,
        episode
      ),
      title: movie.title,
      year: movie.year ?? null,
      poster: movie.poster ?? null,
      backdrop: movie.backdrop ?? null,
      media_type: movie.mediaType ?? "movie",
      progress_seconds: watchedSeconds,
      duration_seconds: 0,
      watched_at: Date.now(),
      profile_id: activeProfileId,
    }).catch(() => {});
  }, [movie, authUser, season, episode, watchedSeconds, activeProfileId]);

  const playableCandidates: string[] = useMemo(() => {
    const stream = resolved?.stream;
    if (!stream) return [];
    const urls = new Set<string>();
    for (const source of stream.sources ?? []) {
      if (source && !isEmbedSourceUrl(source)) urls.add(source);
    }
    if (stream.stream_url && !isEmbedSourceUrl(stream.stream_url)) urls.add(stream.stream_url);
    for (const mirror of stream.mirrors ?? []) {
      if (mirror.url && !isEmbedSourceUrl(mirror.url)) urls.add(mirror.url);
    }
    for (const variant of stream.streams ?? []) {
      if (variant.url && !isEmbedSourceUrl(variant.url)) urls.add(variant.url);
    }
    return orderDirectStreams(urls);
  }, [resolved]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [streamUnavailable, setStreamUnavailable] = useState(false);
  const fallbackAttemptsRef = useRef(0);
  const playerKeyRef = useRef(0);
  // Quality rung picked from the player's menu when the source is one URL per
  // rendition rather than a single adaptive ladder. `null` means "whatever the
  // resolver ranked first".
  const [selectedQuality, setSelectedQuality] = useState<string | null>(null);

  useEffect(() => {
    setStage("resolving_backend");
  }, [movie?.id, season, episode]);

  const [stage, setStage] = useState<StreamLoadStage>("idle");

  useEffect(() => {
    if (!resolved) return;
    // The player mounts the moment `resolved` carries a playable URL, which
    // happens while a follow-up playback-init request is still in flight.
    // Holding the loader up until `resolving` also flipped covered a player
    // that was already parsing its manifest — and playing audio — underneath
    // it, which is exactly the "spinner over live sound" glitch.
    if (!resolving || playableCandidates.length > 0) setStage("playing");
  }, [resolving, resolved, playableCandidates.length]);

  const autoCycling = sourceIndex > 0 && !reconnecting;

  const runStreamFallback = useCallback(async () => {
    const stream = resolved?.stream;
    if (!stream || reconnecting) return;
    const mediaType: "movie" | "tv" = isSeries ? "tv" : "movie";
    if (!mediaType) return;
    if (!/^\d+$/.test(stream.id)) {
      setStreamUnavailable(true);
      return;
    }
    if (fallbackAttemptsRef.current >= MAX_RETRY_ATTEMPTS) {
      setStreamUnavailable(true);
      return;
    }
    fallbackAttemptsRef.current += 1;

    setReconnecting(true);
    setStreamUnavailable(false);
    try {
      if (fallbackAttemptsRef.current > 1) {
        await new Promise(resolve => setTimeout(resolve, COLD_START_BACKOFF_MS));
      }
      const source = await getStreamSource({
        tmdbId: stream.id,
        mediaType,
        season: mediaType === "tv" ? season : undefined,
        episode: mediaType === "tv" ? episode : undefined,
        refresh: true,
      });
      if (source.language) setDetectedLanguage(source.language);

      if (source.isEmbed || isEmbedSourceUrl(source.url)) {
        // There is no embed player any more, so an embed answer is not a
        // source this app can play. It counts as another miss rather than as a
        // fallback the viewer is expected to sit through.
        console.warn("[stream] resolver returned an embed source; ignoring it");
      } else if (source.url) {
        setResolved(prev =>
          prev
            ? {
                exact: prev.exact,
                stream: {
                  ...prev.stream,
                  stream_url: source.url,
                  sources: source.sources,
                  mirrors: source.mirrors,
                  is_embed: false,
                  ...(source.subtitles ? { subtitles: source.subtitles } : {}),
                },
              }
            : prev
        );
        setSourceIndex(0);
        fallbackAttemptsRef.current = 0;
      }
    } catch (err) {
      if (err instanceof StreamExhaustedError) {
        console.warn("[stream] every provider was exhausted", err.providerAttempts);
        setStreamUnavailable(true);
        return;
      }
      if (err instanceof StreamTimeoutError) {
        console.warn(
          `[stream] resolver cold start, attempt ${fallbackAttemptsRef.current}/${MAX_RETRY_ATTEMPTS}`
        );
      }
      if (fallbackAttemptsRef.current >= MAX_RETRY_ATTEMPTS) setStreamUnavailable(true);
    } finally {
      setReconnecting(false);
    }
  }, [resolved, reconnecting, isSeries, season, episode]);

  useEffect(() => {
    if (
      !resolved ||
      playableCandidates.length > 0 ||
      reconnecting ||
      streamUnavailable
    ) {
      return;
    }
    const timer = setTimeout(() => {
      void runStreamFallback();
    }, 1200);
    return () => clearTimeout(timer);
  }, [
    resolved,
    playableCandidates,
    reconnecting,
    streamUnavailable,
    runStreamFallback,
  ]);

  useEffect(() => {
    setSourceIndex(0);
    setReconnecting(false);
    setStreamUnavailable(false);
    setSelectedQuality(null);
    fallbackAttemptsRef.current = 0;
  }, [resolved]);

  const handleSourceError = useCallback(() => {
    if (sourceIndex + 1 < playableCandidates.length) {
      playerKeyRef.current += 1;
      setSourceIndex(prev => Math.min(prev + 1, playableCandidates.length - 1));
    } else if (!reconnecting && !streamUnavailable) {
      fallbackAttemptsRef.current = 0;
      void runStreamFallback();
    }
  }, [sourceIndex, playableCandidates.length, reconnecting, streamUnavailable, runStreamFallback]);

  const tvSeasons = useMemo<SeasonInfo[]>(() => {
    const manifest = resolved?.stream?.episodes ?? [];
    if (manifest.length) {
      const counts = new Map<number, number>();
      for (const ep of manifest) {
        counts.set(ep.season, Math.max(counts.get(ep.season) ?? 0, ep.number));
      }
      return Array.from(counts.entries())
        .map(([season_number, episode_count]) => ({ season_number, episode_count }))
        .sort((a, b) => a.season_number - b.season_number);
    }
    if (movie?.mediaType === "tv") {
      const total = movie.seasons ?? 1;
      const perSeason = movie.episodes_per_season ?? 12;
      return Array.from({ length: total }, (_, i) => ({
        season_number: i + 1,
        episode_count: perSeason,
      }));
    }
    return [];
  }, [resolved, movie]);

  const currentSeasonEpisodes = useMemo<StreamEpisode[]>(() => {
    const manifest = resolved?.stream?.episodes ?? [];
    const fromManifest = manifest
      .filter(ep => ep.season === season)
      .sort((a, b) => a.number - b.number);
    if (fromManifest.length) return fromManifest;

    const info = tvSeasons.find(s => s.season_number === season);
    if (!info) return [];
    return Array.from({ length: info.episode_count }, (_, i) => ({
      season,
      number: i + 1,
      title: `Episode ${i + 1}`,
    }));
  }, [resolved, season, tvSeasons]);

  const handleSelectEpisode = useCallback(
    (nextSeason: number, nextEpisode: number) => {
      setSeason(nextSeason);
      setEpisode(nextEpisode);
      setSourceIndex(0);
      setStreamUnavailable(false);
      const qs = new URLSearchParams({
        season: String(nextSeason),
        episode: String(nextEpisode),
        type: "tv",
      });
      navigate(`/watch/${tmdbId}?${qs.toString()}`);
    },
    [navigate, tmdbId]
  );

  const qualityVariants: StreamVariant[] = useMemo(() => {
    if (!resolved?.stream?.streams) return [];
    return resolved.stream.streams
      .filter(s => s.url && !isEmbedSourceUrl(s.url))
      .map(s => {
        let streamType: "hls" | "dash" | "mp4" = "hls";
        try {
          const pathname = new URL(s.url, window.location.origin).pathname.toLowerCase();
          if (pathname.endsWith("/proxy/dash") || pathname.endsWith(".mpd"))
            streamType = "dash";
          else if (pathname.endsWith("/proxy/manifest") || pathname.endsWith(".m3u8"))
            streamType = "hls";
          else streamType = "mp4";
        } catch {
          /* relative handle */
        }
        return { quality: s.quality ?? null, url: s.url, type: streamType };
      });
  }, [resolved]);

  const streamSubtitles = useMemo(
    () => sanitizeSubtitles(resolved?.stream?.subtitles),
    [resolved?.stream?.subtitles]
  );

  // The URL the player is actually opened on: the chosen quality rung when
  // the viewer picked one, otherwise the resolver's top-ranked candidate.
  const currentStreamUrl = useMemo(() => {
    if (selectedQuality) {
      const match = qualityVariants.find(v => v.quality === selectedQuality);
      if (match?.url) return match.url;
    }
    return playableCandidates[sourceIndex] ?? "";
  }, [selectedQuality, qualityVariants, playableCandidates, sourceIndex]);

  const { settings } = useAppSettings();
  const preferredTrackLanguage = useMemo(() => {
    if (!settings.autoSelectAudioSubtitles) return null;
    const chosen =
      settings.preferredLanguage !== DEFAULT_PREFERRED_LANGUAGE
        ? settings.preferredLanguage
        : null;
    return chosen ?? detectedLanguage;
  }, [settings, detectedLanguage]);

  const upcoming = isUpcoming(movie?.releaseDate);

  const [asideTab, setAsideTab] = useState<"episodes" | "trailers" | "more">("trailers");
  const [playingTrailer, setPlayingTrailer] = useState(false);
  // The embed takes a beat to produce its first frame. The thumbnail and a
  // spinner hold the slot until the iframe reports ready, so a trailer click
  // never drops to a black rectangle.
  const [trailerFrameLoaded, setTrailerFrameLoaded] = useState(false);

  useEffect(() => {
    setAsideTab(movie?.mediaType === "tv" ? "episodes" : "trailers");
    setPlayingTrailer(false);
  }, [movie?.id]);

  const resolvedTrailer = useMemo(() => resolveTrailer(trailer, { controls: true }), [trailer]);
  const trailerThumb = useMemo(() => trailerThumbnail(trailer), [trailer]);

  useEffect(() => {
    setTrailerFrameLoaded(false);
  }, [playingTrailer, resolvedTrailer?.src]);

  const [similar, setSimilar] = useState<CatalogItem[]>([]);
  const genreKey = movie?.genre?.join(",") ?? "";
  useEffect(() => {
    if (!movie) return;
    const seedGenres = (movie.genre ?? []).slice(0, 3);
    if (seedGenres.length === 0) {
      setSimilar([]);
      return;
    }
    let active = true;
    const seed = new Set(seedGenres.map(g => g.toLowerCase()));
    Promise.allSettled(
      seedGenres.map(genre =>
        fetchDiscover({ media_type: isSeries ? "tv" : "movie", genre, per_page: 12 })
      )
    ).then(results => {
      if (!active) return;
      const currentKey = String(movie.providerId ?? movie.id);
      const seen = new Set<string>();
      const merged: CatalogItem[] = [];
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const item of result.value.items) {
          const key = String(item.tmdb_id ?? item.id);
          if (key === currentKey || seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
      }
      const overlap = (item: CatalogItem) =>
        (item.genres ?? []).reduce(
          (count, g) => (seed.has(g.toLowerCase()) ? count + 1 : count),
          0
        );
      merged.sort(
        (a, b) => overlap(b) - overlap(a) || (b.popularity ?? 0) - (a.popularity ?? 0)
      );
      setSimilar(merged.slice(0, 8));
    });
    return () => {
      active = false;
    };
  }, [movie?.id, movie?.providerId, isSeries, genreKey]);

  if (movieLoading) {
    return (
      <div className="min-h-screen text-white">
        <main className="pt-16 pb-12 px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1560px]">
            <div className="flex flex-wrap items-start gap-10">
              <div className="min-w-0 flex-1 basis-[640px]">
                <div className="relative">
                  <div aria-hidden className={PLAYER_GLOW_CLASS} />
                  <div className={PLAYER_FRAME_CLASS}>
                    <StreamLoader />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!movie) {
    return (
      <div className="min-h-screen text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/70">{titleUnavailable}</p>
          <button onClick={() => navigate("/")} className="mt-4 text-white underline">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const streamPoster = movie.backdrop
    ? getImageUrl(movie.backdrop, "original")
    : movie.poster
      ? getImageUrl(movie.poster, "w780")
      : "";

  const castLine = movie.cast.length ? movie.cast.slice(0, 3).join(", ") : "";
  const detailPairs: { label: string; value: string }[] = (
    movie.mediaType === "tv"
      ? [
          { label: "Creator", value: movie.director ?? "" },
          { label: "Cast", value: castLine },
          { label: "Language", value: movie.language ?? "" },
          { label: "First aired", value: movie.releaseDate ? formatReleaseDate(movie.releaseDate) : "" },
        ]
      : [
          { label: "Director", value: movie.director ?? "" },
          { label: "Cast", value: castLine },
          { label: "Country", value: movie.country ?? "" },
          { label: "Language", value: movie.language ?? "" },
        ]
  ).filter(pair => pair.value);

  const asideTabs = [
    ...(movie.mediaType === "tv" ? [{ id: "episodes" as const, label: "Episodes" }] : []),
    { id: "trailers" as const, label: "Trailers" },
    { id: "more" as const, label: "More like this" },
  ];
  const activeTab =
    movie.mediaType !== "tv" && asideTab === "episodes" ? "trailers" : asideTab;

  const metaLine = [
    movie.year,
    movie.runtime != null ? formatRuntime(movie.runtime) : null,
    movie.genre.slice(0, 3).join(" / "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="min-h-screen text-white">
      <main className="pt-16 pb-12 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1560px]">
          <div className="flex flex-wrap items-start gap-10">
            <div className="min-w-0 flex-1 basis-[640px]">
              <div className="relative">
                <div aria-hidden className={PLAYER_GLOW_CLASS} />
                <div className={PLAYER_FRAME_CLASS}>
                  <div className="absolute top-[18px] left-[18px] z-20">
                    <button
                      onClick={handleBackToDetails}
                      aria-label="Back"
                      className="grid h-10 w-10 place-items-center rounded-full border border-white/[0.18] bg-[rgba(8,11,20,0.4)] text-[#f1f3f8] backdrop-blur-md transition hover:bg-white/10"
                    >
                      <ArrowLeft className="h-[18px] w-[18px]" />
                    </button>
                  </div>

                  {upcoming && !resolved ? (
                    <>
                      {streamPoster ? (
                        <img
                          src={streamPoster}
                          alt=""
                          aria-hidden
                          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-2xl"
                        />
                      ) : null}
                      <div aria-hidden className="absolute inset-0" style={HERO_GLOW_STYLE} />
                      <div className="absolute inset-0 z-10 flex items-center justify-center px-6">
                        <ReleaseCountdown movie={movie} />
                      </div>
                    </>
                  ) : playingTrailer && resolvedTrailer ? (
                    /* Trailer frame. The attribute set is the fix: no
                       `allow-same-origin` in a sandbox makes the origin opaque
                       and the player cannot read its own storage or fetch
                       segments, which is exactly the black "won't play". */
                    <>
                      {trailerThumb ? (
                        <img
                          key="trailer-thumb"
                          src={trailerThumb}
                          alt=""
                          aria-hidden
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : null}
                      {!trailerFrameLoaded ? (
                        <div className="absolute inset-0 z-10 flex items-center justify-center">
                          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                        </div>
                      ) : null}
                      <iframe
                        key={resolvedTrailer.src}
                        src={resolvedTrailer.src}
                        title={`${movie.title} — ${resolvedTrailer.label}`}
                        allow={FRAME_ALLOW}
                        sandbox={FRAME_SANDBOX}
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                        onLoad={() => setTrailerFrameLoaded(true)}
                        className={`absolute inset-0 h-full w-full border-0 transition-opacity duration-300 ${
                          trailerFrameLoaded ? "opacity-100" : "opacity-0"
                        }`}
                      />
                    </>
                  ) : resolved ? (
                    <>
                      {currentStreamUrl && !streamUnavailable ? (
                        <VideoPlayer
                          key={playerKeyRef.current}
                          streamUrl={currentStreamUrl}
                          title={displayTitle}
                          poster={streamPoster}
                          onClose={handleClose}
                          variants={qualityVariants}
                          subtitles={streamSubtitles}
                          currentQuality={selectedQuality ?? "Auto"}
                          onQualityChange={quality => {
                            // A per-rendition source swap, not an in-player
                            // level switch: bump the key so the player remounts
                            // cleanly on the chosen URL.
                            playerKeyRef.current += 1;
                            setSelectedQuality(quality);
                          }}
                          autoCycling={autoCycling}
                          onSourceError={handleSourceError}
                          onProgress={handleProgress}
                          preferredLanguage={preferredTrackLanguage}
                          hideCloseButton
                        />
                      ) : null}
                    </>
                  ) : null}

                  {stage === "resolving_backend" || stage === "testing_candidate" ? (
                    <StreamLoader
                      className="z-30"
                      poster={streamPoster}
                      title={displayTitle}
                      stage={stage}
                    />
                  ) : null}

                  {streamUnavailable ? (
                    <div className="absolute inset-0 z-30 flex items-center justify-center">
                      <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                        <img
                          src={streamPoster}
                          alt=""
                          aria-hidden
                          className="absolute inset-0 w-full h-full object-cover opacity-40 blur-2xl scale-110"
                        />
                        <div className="relative z-20 rounded-xl px-8 py-6 text-center">
                          <p className="text-lg font-semibold text-white">{titleUnavailable}</p>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="pt-7">
                <h1 className="m-0 text-[clamp(24px,2.3vw,32px)] font-bold leading-[1.1] tracking-[-0.02em] text-white">
                  {movie.title}
                </h1>

                <p className="mt-2.5 text-sm text-[#8f99b0]">
                  {metaLine}
                  {movie.score != null && movie.score > 0 ? (
                    <span className="ml-2 inline-flex items-center gap-1 align-middle text-amber-400">
                      <Star className="h-3.5 w-3.5 fill-current" aria-hidden />
                      {movie.score}
                    </span>
                  ) : null}
                </p>

                {movie.synopsis ? (
                  <p className="mt-4 max-w-[600px] text-[15px] leading-[1.65] text-[#c3cadb]">
                    {movie.synopsis}
                  </p>
                ) : null}

                <div className="mt-5 flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    className={WATCH_GHOST_BUTTON}
                    aria-pressed={isInMyList(movie.id)}
                    onClick={() => {
                      if (!authUser) {
                        navigate("/login");
                        return;
                      }
                      const wasInList = isInMyList(movie.id);
                      toggleMyList(movie);
                      toast.success(wasInList ? "Removed from your list" : "Added to your list!");
                      if (wasInList) {
                        void pushRemoveToRemote(Number(movie.providerId ?? movie.id ?? 0));
                        recordTaste("save", movie, { weight: -0.5 });
                      } else {
                        recordTaste("save", movie, { weight: 1 });
                        void pushToggleToRemote({
                          id: Number(movie.providerId ?? movie.id),
                          mediaType: movie.mediaType,
                          title: movie.title,
                          poster: movie.poster,
                        });
                      }
                    }}
                  >
                    {isInMyList(movie.id) ? (
                      <Check className="h-4 w-4" aria-hidden />
                    ) : (
                      <Plus className="h-4 w-4" aria-hidden />
                    )}
                    {isInMyList(movie.id) ? "In My List" : "My List"}
                  </button>

                  {!upcoming && !streamUnavailable ? (
                    <DownloadButton
                      title={movie.title}
                      year={movie.year}
                      variants={resolved?.stream?.streams ?? []}
                    />
                  ) : null}

                  <button
                    type="button"
                    className={WATCH_GHOST_ICON_BUTTON}
                    onClick={() => void handleShare()}
                    aria-label="Share this title"
                  >
                    <Share2 className="h-[18px] w-[18px]" aria-hidden />
                  </button>
                </div>

                {detailPairs.length ? (
                  <dl
                    className="mt-8 grid gap-5 border-t border-white/[0.08] pt-6"
                    style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
                  >
                    {detailPairs.map(pair => (
                      <div key={pair.label}>
                        <dt className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-[#7f8aa3]">
                          {pair.label}
                        </dt>
                        <dd className="m-0 text-sm text-[#dfe3ee]">{pair.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </div>
            </div>

            <aside className="min-w-[280px] flex-1 basis-[340px] lg:w-[340px] lg:flex-none">
              <div className="flex items-end gap-6 border-b border-white/10">
                {asideTabs.map(tab => {
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setAsideTab(tab.id)}
                      aria-current={active ? "page" : undefined}
                      className={
                        "-mb-px border-b-2 px-0 pt-2 pb-3 text-sm transition " +
                        (active
                          ? "border-[var(--sv-violet)] font-medium text-[#f1f3f8]"
                          : "border-transparent text-[#7f8aa3] hover:text-[#cfd5e4]")
                      }
                    >
                      {tab.label}
                    </button>
                  );
                })}
                <div className="flex-1" />
              </div>

              <div className="pt-3">
                {activeTab === "episodes" && movie.mediaType === "tv" ? (
                  <WatchTVControls
                    currentSeason={season}
                    currentEpisode={episode}
                    seasons={tvSeasons}
                    episodes={currentSeasonEpisodes}
                    onSelectEpisode={handleSelectEpisode}
                  />
                ) : activeTab === "trailers" ? (
                  trailer && resolvedTrailer ? (
                    <button
                      type="button"
                      onClick={() => setPlayingTrailer(was => !was)}
                      className={
                        "flex w-full items-center gap-3.5 rounded-xl p-2.5 text-left text-[#f1f3f8] transition " +
                        (playingTrailer ? "bg-white/[0.05]" : "hover:bg-white/[0.05]")
                      }
                    >
                      <div className="relative w-[112px] shrink-0 overflow-hidden rounded-lg bg-[linear-gradient(135deg,#1c2338,#0b0f1b)]">
                        {trailerThumb ? (
                          <img
                            src={trailerThumb}
                            alt=""
                            aria-hidden
                            className="aspect-video w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="grid aspect-video w-full place-items-center text-[#cfd5e4]">
                            <Play className="h-4 w-4 fill-current" aria-hidden />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{trailer.title || "Trailer"}</p>
                        <p className="mt-1 text-xs text-[#7f8aa3]">
                          {playingTrailer ? "Now playing" : "Play trailer"}
                        </p>
                      </div>
                    </button>
                  ) : (
                    <p className="px-2.5 py-4 text-sm text-[#7f8aa3]">No trailers yet.</p>
                  )
                ) : similar.length ? (
                  <div className="space-y-1">
                    {similar.map(item => {
                      const similarId = Number(item.tmdb_id ?? 0);
                      return (
                        <button
                          key={String(item.tmdb_id ?? item.id)}
                          type="button"
                          disabled={isNaN(similarId) || similarId <= 0}
                          onClick={() => {
                            if (isNaN(similarId) || similarId <= 0) return;
                            navigate(
                              buildWatchPath(similarId, {
                                mediaType: item.media_type === "tv" ? "tv" : "movie",
                              })
                            );
                          }}
                          className="flex w-full items-center gap-3.5 rounded-xl p-2.5 text-left text-[#f1f3f8] transition hover:bg-white/[0.05] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                        >
                          <div className="w-12 shrink-0 overflow-hidden rounded-md bg-zinc-800">
                            {item.poster_url ? (
                              <img
                                src={item.poster_url}
                                alt=""
                                aria-hidden
                                className="aspect-[2/3] w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="grid aspect-[2/3] w-full place-items-center text-xs text-white/40">
                                {item.title.slice(0, 1)}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{item.title}</p>
                            <p className="mt-0.5 text-xs text-[#7f8aa3]">{item.year ?? ""}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="px-2.5 py-4 text-sm text-[#7f8aa3]">
                    Nothing similar in the catalogue yet.
                  </p>
                )}
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}