import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
import {
  Bookmark,
  ChevronDown,
  ChevronUp,
  Play,
  Star,
  X,
  MessageSquare,
  Clock,
  Tv,
  Film,
  Loader2,
  RefreshCw,
  WifiOff,
  Server,
  Zap,
  Wifi,
  Settings,
  ChevronDown as ChevronDownIcon,
  ArrowLeft,
  Share2,
  Heart,
  Plus,
  User,
  MapPin,
  Globe,
  Calendar,
} from "lucide-react";
import { getRating, setRating, subscribeRatings } from "@/services/ratings";
import {
  apiUrl,
  fetchTrailer,
  getStreamSource,
  resolveStream,
  StreamNotFoundError,
  type ResolvedStream,
  type StreamMovie,
  type TrailerInfo,
} from "@/services/api";
import { VideoPlayer, type StreamVariant } from "@/components/stream/VideoPlayer";
import { EpisodeMatrix } from "@/components/movies/EpisodeMatrix";
import { cancelInFlightPrefetch, prefetchForOpen } from "@/services/prefetch";
import { attemptPlay } from "@/services/capGate";
import { useLocalSession } from "@/context/LocalSessionContext";
import {
  getProgress,
  progressForTitle,
  subscribeStats,
} from "@/services/stats";
import type { Movie, ResolvedStream as ResolvedStreamType, StreamVariant as StreamVariantType } from "@/components/movies/types";
import { TrailerEmbed } from "@/components/movies/MediaCard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isExternalEmbedUrl } from "@/lib/streamUtils";
import { useAuth } from "@/context/AuthContext";
import { apiHistoryAdd } from "@/services/auth";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

function getImageUrl(path: string, size: string): string {
  if (path?.startsWith("http")) return path;
  return path ? `${TMDB_IMAGE_BASE_URL}/${size}${path}` : "";
}

const RATE_AFTER_SECONDS = 15 * 60;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function classifyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (error instanceof StreamNotFoundError) {
    return {
      type: "not_found",
      message: `"${error.message.replace('No playable stream found for "', "").replace('"', "")}" isn't available to stream yet.`,
      recoverable: false,
      retryCount: 0,
    };
  }

  if (lowerMessage.includes("404") || lowerMessage.includes("not found")) {
    return {
      type: "not_found",
      message: "This title isn't available to stream.",
      recoverable: false,
      retryCount: 0,
    };
  }

  if (
    lowerMessage.includes("403") ||
    lowerMessage.includes("forbidden") ||
    lowerMessage.includes("geo") ||
    lowerMessage.includes("region")
  ) {
    return {
      type: "geo_blocked",
      message: "This content is not available in your region.",
      recoverable: false,
      retryCount: 0,
    };
  }

  if (
    lowerMessage.includes("429") ||
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("too many requests")
  ) {
    return {
      type: "rate_limited",
      message: "Too many requests. Please wait a moment and try again.",
      recoverable: true,
      retryCount: 0,
    };
  }

  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("fetch") ||
    lowerMessage.includes("connection") ||
    lowerMessage.includes("timeout")
  ) {
    return {
      type: "network",
      message: "Network error. Please check your connection and try again.",
      recoverable: true,
      retryCount: 0,
    };
  }

  if (
    lowerMessage.includes("embed") ||
    lowerMessage.includes("provider") ||
    lowerMessage.includes("source")
  ) {
    return {
      type: "provider_unavailable",
      message: "The streaming provider is currently unavailable. Trying alternative sources...",
      recoverable: true,
      retryCount: 0,
    };
  }

  return {
    type: "unknown",
    message: "We couldn't load this stream. Please try again.",
    recoverable: true,
    retryCount: 0,
  };
}

// Fetch full movie details from TMDB via backend resolve endpoint
async function fetchMovieDetails(tmdbId: string): Promise<Movie | null> {
  try {
    const response = await fetch(apiUrl("/api/movies/resolve"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tmdbId }),
    });
    if (!response.ok) return null;
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
  }
}

export function WatchPage() {
  const [location, navigate] = useLocation();
  const params = useParams();

  const tmdbId = params.id;
  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );
  const urlSeason = parseInt(searchParams.get("season") || "1", 10);
  const urlEpisode = parseInt(searchParams.get("episode") || "1", 10);
  const urlType = searchParams.get("type") || "movie";

  const [movie, setMovie] = useState<Movie | null>(null);
  const [movieLoading, setMovieLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  const [resolving, setResolving] = useState(false);
  const [playError, setPlayError] = useState<ReturnType<typeof classifyError> | null>(null);
  const [season, setSeason] = useState(urlSeason);
  const [episode, setEpisode] = useState(urlEpisode);
  const [myRating, setMyRating] = useState<number>(0);
  const [watchedSeconds, setWatchedSeconds] = useState(0);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [showSeasonSelector, setShowSeasonSelector] = useState(false);
  const [showEpisodeDetails, setShowEpisodeDetails] = useState(false);
  const [episodeDetails, setEpisodeDetails] = useState<any>(null);
  const [currentEpisodeTitle, setCurrentEpisodeTitle] = useState("");

  // Refs for retry logic
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cache for resolveStream results to avoid duplicate API calls
  const resolveCacheRef = useRef<Map<string, ResolvedStream>>(new Map());

  // Local session for My List and History
  const { isInMyList, toggleMyList, addToHistory } = useLocalSession();

  const { user: authUser } = useAuth();

  // Fetch movie details on mount
  useEffect(() => {
    if (!tmdbId) return;
    setMovieLoading(true);
    fetchMovieDetails(tmdbId).then(m => {
      if (m) {
        setMovie(m);
        setMyRating(getRating(m.id) ?? 0);
      }
      setMovieLoading(false);
    });
  }, [tmdbId]);

  // Subscribe to rating changes
  useEffect(() => {
    if (!movie) return;
    return subscribeRatings(() => {
      setMyRating(getRating(movie.id) ?? 0);
    });
  }, [movie?.id]);

  // Subscribe to watch progress
  useEffect(() => {
    if (!movie) return;
    const refresh = () =>
      setWatchedSeconds(
        Math.max(
          getProgress(String(movie.id)),
          resolved ? getProgress(resolved.stream.id) : 0,
          progressForTitle(movie.title)
        )
      );
    refresh();
    return subscribeStats(refresh);
  }, [movie?.id, movie?.title, resolved]);

  const canRate = watchedSeconds >= RATE_AFTER_SECONDS;

  // Fetch trailer
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

  // Fetch episode details when season/episode changes
  const fetchEpisodeInfo = useCallback(
    async (s: number, e: number) => {
      if (!resolved?.stream.id || !/^\d+$/.test(resolved.stream.id)) return;
      try {
        const details = await fetch(
          apiUrl(`/api/episodes?tmdb_id=${resolved.stream.id}&season=${s}&episode=${e}`)
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
    [resolved]
  );

  useEffect(() => {
    if (movie?.mediaType === "tv" && resolved?.stream.id) {
      fetchEpisodeInfo(season, episode);
    } else {
      setEpisodeDetails(null);
      setCurrentEpisodeTitle(movie?.title || "");
    }
  }, [season, episode, movie?.mediaType, resolved, fetchEpisodeInfo]);

  // Helper to resolve stream with retry logic and caching
  const resolveWithRetry = useCallback(
    async (
      title: string,
      year?: number | null,
      options?: { season?: number; episode?: number; tmdbId?: string },
      attempt = 1
    ): Promise<ResolvedStream> => {
      const cacheKey = options?.tmdbId ?? title;

      // Check cache first
      const cached = resolveCacheRef.current.get(cacheKey);
      if (cached) {
        return cached;
      }

      try {
        const stream = await resolveStream(title, year, options);
        // Cache successful result
        resolveCacheRef.current.set(cacheKey, stream);
        return stream;
      } catch (error) {
        const playbackError = classifyError(error);

        if (!playbackError.recoverable || attempt >= MAX_RETRY_ATTEMPTS) {
          throw error;
        }

        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));

        return resolveWithRetry(title, year, options, attempt + 1);
      }
    },
    []
  );

  const resolveAndPlay = useCallback(
    async (targetSeason: number, targetEpisode: number) => {
      if (resolving || !movie) return;
      if (!attemptPlay()) return;
      setResolving(true);
      setPlayError(null);

      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }

      try {
        let base = resolved?.stream ?? null;
        if (!base) {
          const stream = await resolveWithRetry(movie.title, movie.year, {
            tmdbId: movie.providerId,
          });
          setResolved(stream);
          base = stream.stream;
        }
        setSeason(targetSeason);
        setEpisode(targetEpisode);

        let playable: StreamMovie = base;
        const mediaType: "movie" | "tv" | null =
          base.media_type === "movie" || base.media_type === "tv"
            ? base.media_type
            : null;

        // Try to get stream source from backend
        if (mediaType && /^\d+$/.test(base.id)) {
          try {
            const source = await getStreamSource({
              tmdbId: base.id,
              mediaType,
              season: mediaType === "tv" ? targetSeason : undefined,
              episode: mediaType === "tv" ? targetEpisode : undefined,
            });

            playable = {
              ...base,
              stream_url: source.url,
              mirrors: source.mirrors,
              season: targetSeason,
              episode: targetEpisode,
            };
          } catch (error) {
            console.warn(
              `[WatchPage] get-stream failed for "${base.title}" (S${targetSeason}E${targetEpisode}), using resolved stream`,
              error
            );
          }
        }

        setResolved({ stream: playable, exact: true });
        prefetchForOpen(playable);

        // Update URL without navigation
        const isSeries = playable.media_type === "tv";
        const newUrl = `/watch/${movie.providerId}${isSeries ? `?season=${targetSeason}&episode=${targetEpisode}&type=tv` : ""}`;
        navigate(newUrl, { replace: true });
      } catch (error) {
        const playbackError = classifyError(error);
        console.error(
          `[WatchPage] could not resolve "${movie.title}" (${movie.year ?? "unknown year"})`,
          error
        );
        setPlayError(playbackError);

        if (playbackError.recoverable) {
          const delay = RETRY_BASE_DELAY_MS;
          retryTimeoutRef.current = setTimeout(() => {
            resolveAndPlay(targetSeason, targetEpisode);
          }, delay);
        }
      } finally {
        setResolving(false);
      }
    },
    [movie, resolved, resolving, navigate, resolveWithRetry]
  );

  const play = useCallback(async () => {
    if (resolving || !movie) return;
    if (!attemptPlay()) return;
    if (resolved) {
      const isSeries = resolved.stream.media_type === "tv";
      await resolveAndPlay(isSeries ? season : 1, isSeries ? episode : 1);
      return;
    }
    await resolveAndPlay(1, 1);
  }, [resolving, resolved, season, episode, resolveAndPlay, movie]);

  const playEpisode = useCallback(
    (targetSeason: number, targetEpisode: number) => {
      void resolveAndPlay(targetSeason, targetEpisode);
    },
    [resolveAndPlay]
  );

  // Retry handler for playback errors
  const handleRetry = useCallback(() => {
    if (playError?.recoverable) {
      setPlayError(null);
      if (resolved?.stream.media_type === "tv") {
        resolveAndPlay(season, episode);
      } else {
        resolveAndPlay(1, 1);
      }
    }
  }, [playError, resolved, season, episode, resolveAndPlay]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  // Initial warm resolve
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !movie) return;
    opened.current = true;
    let disposed = false;

    const loadTimer = setTimeout(() => {
      if (!disposed) setDetailsLoaded(true);
    }, 100);

    void (async () => {
      try {
        const cacheKey = movie.providerId;
        let stream = resolveCacheRef.current.get(cacheKey);
        if (!stream) {
          stream = await resolveStream(movie.title, movie.year, {
            tmdbId: movie.providerId,
            ...(movie.mediaType === "tv" ? { season, episode } : {}),
          });
          resolveCacheRef.current.set(cacheKey, stream);
        }
        if (disposed) return;
        setResolved(stream);
        prefetchForOpen(stream.stream);
      } catch (error) {
        console.warn(
          `[WatchPage] warm resolve skipped for "${movie.title}"`,
          error
        );
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(loadTimer);
    };
  }, [movie?.id, movie?.title, movie?.year, movie?.mediaType, movie?.providerId, season, episode]);

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
    if (movie) navigate(`/details/${movie.providerId}`);
  };

  const handleShare = async () => {
    if (!movie) return;
    const shareUrl = `${window.location.origin}/watch/${movie.providerId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      prompt("Copy link:", shareUrl);
    }
  };

  // Determine what to show as episode title
  const displayTitle =
    movie?.mediaType === "tv" && episodeDetails?.title
      ? `${movie.title} — ${episodeDetails.title}`
      : movie?.mediaType === "tv"
        ? `${movie.title} — S${season} E${episode}`
        : movie?.title || "Loading...";

  const DEFAULT_TAB_TITLE = "Lenium Movies";
  useEffect(() => {
    document.title = movie?.title ? `${movie.title} — Lenium` : DEFAULT_TAB_TITLE;
    return () => {
      document.title = DEFAULT_TAB_TITLE;
    };
  }, [movie?.title]);

  // Add to watch history when movie resolves and starts playing
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

  // Record per-account history on the backend when signed in
  const recordedHistoryRef = useRef("");
  useEffect(() => {
    if (!movie || !authUser) return;
    const key = `${movie.providerId}:${season}:${episode}`;
    if (recordedHistoryRef.current === key) return;
    recordedHistoryRef.current = key;
    apiHistoryAdd({
      movie_key: String(movie.providerId),
      title: movie.title,
      year: movie.year ?? null,
      poster: movie.poster ?? null,
      backdrop: movie.backdrop ?? null,
      media_type: movie.mediaType ?? "movie",
      progress_seconds: watchedSeconds,
      duration_seconds: 0,
      watched_at: Date.now(),
    }).catch(() => {});
  }, [movie, authUser, season, episode, watchedSeconds]);

  // Ordered list of directly playable (non-embed) URLs. Embeds are never
  // shown or linked anywhere — every movie plays inline or shows a native
  // stream state instead.
  const playableCandidates: string[] = useMemo(() => {
    const stream = resolved?.stream;
    if (!stream) return [];
    const urls = new Set<string>();
    if (stream.stream_url && !isExternalEmbedUrl(stream.stream_url)) {
      urls.add(stream.stream_url);
    }
    for (const mirror of stream.mirrors ?? []) {
      if (mirror.url && !isExternalEmbedUrl(mirror.url)) urls.add(mirror.url);
    }
    for (const variant of stream.streams ?? []) {
      if (variant.url && !isExternalEmbedUrl(variant.url)) urls.add(variant.url);
    }
    return Array.from(urls);
  }, [resolved]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [streamUnavailable, setStreamUnavailable] = useState(false);
  const fallbackAttemptsRef = useRef(0);
  const playerKeyRef = useRef(0);

  const currentStreamUrl = playableCandidates[sourceIndex] ?? "";

  // Poll the backend stream endpoint until a playable direct source comes
  // back. `refresh` bypasses the backend cache so every attempt is a fresh
  // scrape instead of the same cached "no direct source" result.
  const runStreamFallback = useCallback(
    async (manual: boolean) => {
      const stream = resolved?.stream;
      if (!stream || reconnecting) return;
      const mediaType: "movie" | "tv" | undefined =
        stream.media_type === "movie" || stream.media_type === "tv"
          ? stream.media_type
          : undefined;
      if (mediaType && !/^\d+$/.test(stream.id)) {
        setStreamUnavailable(true);
        return;
      }
      if (!mediaType) return;

      if (manual) {
        fallbackAttemptsRef.current = 0;
      } else if (fallbackAttemptsRef.current >= MAX_RETRY_ATTEMPTS) {
        setStreamUnavailable(true);
        return;
      }
      fallbackAttemptsRef.current += 1;

      setReconnecting(true);
      setStreamUnavailable(false);
      try {
        const source = await getStreamSource({
          tmdbId: stream.id,
          mediaType,
          season: mediaType === "tv" ? season : undefined,
          episode: mediaType === "tv" ? episode : undefined,
          refresh: true,
        });
        if (source.url && !isExternalEmbedUrl(source.url)) {
          setResolved((prev) =>
            prev
              ? {
                  exact: prev.exact,
                  stream: {
                    ...prev.stream,
                    stream_url: source.url,
                    mirrors: source.mirrors,
                  },
                }
              : prev
          );
          setSourceIndex(0);
          fallbackAttemptsRef.current = 0;
        } else if (
          fallbackAttemptsRef.current >= MAX_RETRY_ATTEMPTS ||
          manual
        ) {
          setStreamUnavailable(true);
        }
      } catch {
        if (fallbackAttemptsRef.current >= MAX_RETRY_ATTEMPTS || manual) {
          setStreamUnavailable(true);
        }
      } finally {
        setReconnecting(false);
      }
    },
    [resolved, reconnecting, season, episode]
  );

  // Automatically start the stream-fallback loop whenever a resolved title has
  // no directly playable source yet (only media with a TMDB-backed id can be
  // re-queried; catalog entries without one just surface the native state).
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
      void runStreamFallback(false);
    }, 1200);
    return () => clearTimeout(timer);
  }, [
    resolved,
    playableCandidates,
    reconnecting,
    streamUnavailable,
    runStreamFallback,
  ]);

  // Reset source/failure state whenever a fresh resolve lands.
  useEffect(() => {
    setSourceIndex(0);
    setReconnecting(false);
    setStreamUnavailable(false);
    fallbackAttemptsRef.current = 0;
  }, [resolved]);

  // Advance to the next candidate mirror, or hand off to the backend
  // fallback loop when the current source fails mid-play.
  const handleSourceError = useCallback(() => {
    if (sourceIndex + 1 < playableCandidates.length) {
      setSourceIndex((prev) => Math.min(prev + 1, playableCandidates.length - 1));
      setReconnecting(true);
      window.setTimeout(() => setReconnecting(false), 1000);
    } else if (!reconnecting && !streamUnavailable) {
      fallbackAttemptsRef.current = 0;
      void runStreamFallback(false);
    }
  }, [
    sourceIndex,
    playableCandidates.length,
    reconnecting,
    streamUnavailable,
    runStreamFallback,
  ]);

  // Determine quality variants for direct streams
  const qualityVariants: StreamVariant[] = useMemo(() => {
    if (!resolved?.stream?.streams) return [];
    return resolved.stream.streams
      .filter((s) => s.url && !isExternalEmbedUrl(s.url))
      .map((s) => {
        let streamType: "hls" | "dash" | "mp4" = "hls";
        try {
          const pathname = new URL(s.url).pathname.toLowerCase();
          if (pathname.endsWith(".mpd")) streamType = "dash";
          else if (pathname.endsWith(".mp4")) streamType = "mp4";
        } catch {
          // ignore
        }
        return {
          quality: s.quality ?? null,
          url: s.url,
          type: streamType,
        };
      });
  }, [resolved]);

  // Show loading state with skeleton
  if (movieLoading) {
    return (
      <div className="min-h-screen bg-[#050505] text-white">
        <div className="fixed top-0 left-0 right-0 z-40 h-16 bg-black/90 backdrop-blur-md border-b border-white/10 flex items-center justify-between px-4 sm:px-6">
          <div className="w-10 h-10 rounded-full bg-white/5 animate-pulse" />
          <div className="flex-1 flex items-center justify-center">
            <div className="h-5 w-48 bg-white/10 rounded animate-pulse" />
          </div>
          <div className="w-10" />
        </div>

        <main className="pt-16 pb-12 px-4 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="relative w-full h-[70vh] sm:h-[75vh] max-h-[800px] rounded-2xl overflow-hidden bg-black animate-pulse">
              <div className="absolute inset-0 bg-gradient-to-r from-white/5 via-white/10 to-white/5 bg-[length:200%_100%] animate-shimmer" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative z-20 flex flex-col items-center gap-4">
                  <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
                  <p className="text-white/80 font-medium text-sm tracking-wider">
                    Loading movie details...
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 text-center animate-pulse">
              <div className="h-8 w-64 bg-white/10 rounded mx-auto" />
            </div>

            <div className="mt-4 flex items-center justify-center gap-3 animate-pulse">
              <div className="w-48 md:w-64 h-10 bg-white/10 rounded" />
            </div>

            <div className="mt-8 space-y-4 text-center max-w-3xl mx-auto animate-pulse">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <div className="h-4 w-20 bg-white/10 rounded" />
                <div className="h-4 w-4 bg-white/10 rounded" />
                <div className="h-4 w-32 bg-white/10 rounded" />
              </div>
              <div className="h-4 w-full bg-white/10 rounded" />
              <div className="h-4 w-3/4 bg-white/10 rounded" />
              <div className="h-4 w-1/2 bg-white/10 rounded" />
            </div>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 animate-pulse">
              <div className="flex-1 sm:flex-none h-12 bg-white/10 rounded-md" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!movie) {
    return (
      <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/60">Movie not found</p>
          <button
            onClick={() => navigate("/")}
            className="mt-4 text-white underline"
          >
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

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <main className="pt-16 pb-12 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1400px]">
          {/* Split Layout: Player (2/3) | Sidebar (1/3) */}
          <div className="grid lg:grid-cols-[2fr_1fr] gap-6">
            {/* LEFT PANEL: Video Player - Theater Mode */}
            <div className="relative">
              {/* Ambient Canvas Glow Effect - Netflix-style backdrop glow behind player */}
              <div
                aria-hidden
                className="absolute -inset-4 bg-gradient-to-r from-purple-600/30 via-pink-600/20 to-amber-500/30 rounded-3xl blur-3xl opacity-60 -z-10 pointer-events-none transition-all duration-700"
              />
              <div className="relative w-full max-w-6xl mx-auto aspect-video rounded-2xl overflow-hidden bg-black shadow-[0_20px_80px_rgba(0,0,0,0.8)] border border-white/10 group">
                {resolved && (
                  <>
                    {/* Top-left overlay: Back button */}
                    <div className="absolute top-4 left-4 z-20">
                      <button
                        onClick={handleBackToDetails}
                        aria-label="Back to details"
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-black/60 hover:bg-white/10 border border-white/10 backdrop-blur-md text-white transition-colors"
                      >
                        <ArrowLeft className="h-5 w-5" />
                      </button>
                    </div>

                    {/* Top-right overlay: Share button */}
                    <div className="absolute top-4 right-4 z-20">
                      <button
                        onClick={handleShare}
                        aria-label="Share link"
                        className="flex items-center justify-center w-10 h-10 rounded-full bg-black/60 hover:bg-white/10 border border-white/10 backdrop-blur-md text-white transition-colors"
                      >
                        <Share2 className="h-5 w-5" />
                      </button>
                    </div>

                    {resolved && currentStreamUrl && !reconnecting ? (
                      <VideoPlayer
                        key={playerKeyRef.current}
                        streamUrl={currentStreamUrl}
                        title={displayTitle}
                        poster={streamPoster}
                        onClose={handleClose}
                        variants={qualityVariants}
                        currentQuality={qualityVariants.find(v => v.quality)?.quality || "Auto"}
                        onQualityChange={(q) => {}}
                        isLoading={resolving}
                        playbackError={playError?.message || null}
                        onRetry={() => {
                          if (playError) {
                            handleRetry();
                          } else {
                            handleSourceError();
                          }
                        }}
                        onSourceError={handleSourceError}
                        hideCloseButton
                      />
                    ) : resolved && streamUnavailable ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                          <img
                            src={streamPoster}
                            alt={movie.title}
                            className="absolute inset-0 w-full h-full object-cover opacity-40 blur-2xl scale-110"
                          />
                          <div className="relative z-20 rounded-2xl bg-black/50 px-8 py-6 text-center backdrop-blur-md max-w-lg">
                            <p className="text-lg font-semibold text-white">
                              Stream currently unavailable. Click to retry source.
                            </p>
                            <button
                              type="button"
                              onClick={() => void runStreamFallback(true)}
                              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-white/10 border border-white/20 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"
                            >
                              <RefreshCw className="h-4 w-4" />
                              Retry source
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : resolved ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                          <img
                            src={streamPoster}
                            alt={movie.title}
                            className="absolute inset-0 w-full h-full object-cover opacity-40 blur-2xl scale-110"
                          />
                          <div className="relative z-20 flex flex-col items-center gap-4 rounded-2xl bg-black/45 px-8 py-6 text-center backdrop-blur-md">
                            <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
                            <p className="text-white/90 font-medium text-sm tracking-wider">
                              Reconnecting to stream server...
                            </p>
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => {
                                  if (playableCandidates.length > 0) {
                                    playerKeyRef.current += 1;
                                    setReconnecting(false);
                                  } else {
                                    void runStreamFallback(true);
                                  }
                                }}
                                className="inline-flex items-center gap-2 rounded-xl bg-white/10 border border-white/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
                              >
                                <RefreshCw className="h-4 w-4" />
                                Retry
                              </button>
                              <button
                                type="button"
                                onClick={handleSourceError}
                                className="inline-flex items-center gap-2 rounded-xl bg-white/10 border border-white/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
                              >
                                <Server className="h-4 w-4" />
                                Switch Server
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                          <img
                            src={streamPoster}
                            alt={movie.title}
                            className="absolute inset-0 w-full h-full object-cover opacity-40 blur-2xl scale-110"
                          />
                          <div className="relative z-20 flex flex-col items-center gap-4">
                            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
                            <p className="text-white/80 font-medium text-sm tracking-wider">
                              Preparing stream...
                            </p>
                            {resolving && (
                              <p className="text-xs text-white/50 flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Resolving playback sources...
                              </p>
                            )}
                            <button
                              type="button"
                              onClick={() => play()}
                              disabled={resolving || !movie}
                              className="inline-flex items-center gap-2 rounded-xl bg-violet-500 px-6 py-3 text-sm font-medium text-white transition hover:bg-violet-400 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Play className="h-5 w-5" />
                              Play
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {!resolved && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                      <img
                        src={
                          movie.backdrop
                            ? getImageUrl(movie.backdrop, "original")
                            : movie.poster
                            ? getImageUrl(movie.poster, "w780")
                            : ""
                        }
                        alt={movie.title}
                        className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm"
                      />
                      <div className="relative z-20 flex flex-col items-center gap-4">
                        <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
                        <p className="text-white/80 font-medium text-sm tracking-wider">
                          Preparing stream...
                        </p>
                        {resolving && (
                          <p className="text-xs text-white/50 flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Resolving playback sources...
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => play()}
                          disabled={resolving || !movie}
                          className="inline-flex items-center gap-2 rounded-xl bg-violet-500 px-6 py-3 text-sm font-medium text-white transition hover:bg-violet-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Play className="h-5 w-5" />
                          Play
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT PANEL: Episode List / Details Sidebar */}
            <aside className="lg:sticky lg:top-24 space-y-6 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2">
              {/* Show/Movie Title & Metadata */}
              <div className="space-y-4">
                <h1 className="text-xl sm:text-2xl font-bold text-white truncate">
                  {movie.title}
                </h1>

                <div className="flex flex-wrap items-center gap-2 text-xs text-[#aaa9ae]">
                  {movie.year && (
                    <span className="px-2 py-1 bg-white/5 border border-white/10 rounded">
                      {movie.year}
                    </span>
                  )}
                  {movie.runtime != null && (
                    <>
                      <span>·</span>
                      <span className="px-2 py-1 bg-white/5 border border-white/10 rounded">
                        {movie.runtime} min
                      </span>
                    </>
                  )}
                  <span>·</span>
                  <span className="px-2 py-1 bg-white/5 border border-white/10 rounded">
                    {movie.genre.slice(0, 3).join(" · ")}
                  </span>
                  {movie.score !== null && (
                    <span className="flex items-center gap-1 px-2 py-1 bg-amber-500/20 border border-amber-500/30 rounded text-amber-400">
                      <Star className="h-3.5 w-3.5 fill-current" />
                      {movie.score}
                    </span>
                  )}
                  {movie.mediaType === "tv" && resolved && (
                    <span className="px-2 py-1 bg-blue-500/20 border border-blue-500/30 rounded text-blue-400 flex items-center gap-1">
                      <Tv className="h-3.5 w-3.5" />
                      {resolved.stream.seasons || "?"} Seasons
                    </span>
                  )}
                </div>

                {/* Synopsis */}
                <p className="text-sm leading-6 text-[#c5c5c1] line-clamp-4">
                  {movie.synopsis}
                </p>

                {/* Action Buttons */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="flex items-center gap-2 px-4 py-3"
                    onClick={() => toggleMyList(movie)}
                    aria-pressed={isInMyList(movie.id)}
                  >
                    <Plus className="h-5 w-5" />
                    <span className="hidden sm:inline">
                      {isInMyList(movie.id) ? "In My List" : "Add to My List"}
                    </span>
                  </Button>
                </div>
              </div>

              {/* Divider */}
              <Separator className="border-white/10" />

              {/* TV Shows: Season Selector + Episode List */}
              {movie.mediaType === "tv" && resolved ? (
                <div className="space-y-4">
                  {/* Season Selector */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">
                        Season
                      </h2>
                      <Select
                        value={season.toString()}
                        onValueChange={value => {
                          const newSeason = parseInt(value, 10);
                          if (newSeason !== season) {
                            setSeason(newSeason);
                            setEpisode(1);
                            playEpisode(newSeason, 1);
                          }
                        }}
                      >
                        <SelectTrigger className="w-[140px] bg-white/5 border border-white/10 text-white/80 text-xs">
                          <SelectValue placeholder="Select season" />
                        </SelectTrigger>
                        <SelectContent className="bg-zinc-900 border border-white/10 text-white">
                          {Array.from(
                            { length: resolved.stream.seasons || 1 },
                            (_, i) => i + 1
                          ).map(s => (
                            <SelectItem key={s} value={s.toString()}>
                              Season {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Episode List */}
                    <div className="space-y-1 max-h-[50vh] overflow-y-auto">
                      {resolved.stream.episodes
                        ?.filter((ep: any) => ep.season === season)
                        .map((ep: any) => (
                          <button
                            key={`${ep.season}-${ep.number}`}
                            onClick={() => playEpisode(ep.season, ep.number)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                              ep.season === season && ep.number === episode
                                ? "bg-white/10 text-white border border-white/20"
                                : "text-white/80 hover:bg-white/5 hover:text-white hover:border-white/10 border border-transparent"
                            }`}
                          >
                            <span className="flex-shrink-0 w-8 text-center text-xs font-mono font-semibold text-white/50">
                              E{String(ep.number).padStart(2, "0")}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">
                                {ep.title || `Episode ${ep.number}`}
                              </p>
                              <p className="text-xs text-white/50 flex items-center gap-2">
                                {ep.runtime && `${ep.runtime}m`}
                                {ep.air_date && ep.air_date}
                                {ep.vote_average && (
                                  <span className="flex items-center gap-1 text-amber-400">
                                    <Star className="h-3 w-3 fill-current" />
                                    {ep.vote_average.toFixed(1)}
                                  </span>
                                )}
                              </p>
                            </div>
                            {ep.season === season && ep.number === episode && (
                              <span className="text-xs text-green-400 font-medium">
                                Playing
                              </span>
                            )}
                          </button>
                        ))}
                    </div>
                  </div>
                </div>
              ) : (
                // Movie: Show details in sidebar
                <div className="space-y-6">
                  {/* Details - only show rows with data */}
                  <div className="space-y-4">
                    <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">
                      Details
                    </h2>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      {movie.director && (
                        <div>
                          <p className="text-white/50">Director</p>
                          <p className="text-white font-medium">{movie.director}</p>
                        </div>
                      )}
                      {movie.cast.length > 0 && (
                        <div>
                          <p className="text-white/50">Cast</p>
                          <p className="text-white font-medium line-clamp-1">
                            {movie.cast.slice(0, 3).join(", ")}
                          </p>
                        </div>
                      )}
                      {movie.country && (
                        <div>
                          <p className="text-white/50">Country</p>
                          <p className="text-white font-medium">{movie.country}</p>
                        </div>
                      )}
                      {movie.language && (
                        <div>
                          <p className="text-white/50">Language</p>
                          <p className="text-white font-medium">{movie.language}</p>
                        </div>
                      )}
                      {movie.releaseDate && (
                        <div>
                          <p className="text-white/50">Release Date</p>
                          <p className="text-white font-medium">{movie.releaseDate}</p>
                        </div>
                      )}
                      {movie.runtime != null && (
                        <div>
                          <p className="text-white/50">Runtime</p>
                          <p className="text-white font-medium">{movie.runtime} min</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}