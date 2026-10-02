import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  Star,
  X,
  MessageSquare,
  Clock,
  Tv,
  Film,
  WifiOff,
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
  MOVIE_RESOLVE_TIMEOUT_MS,
  resolveStream,
  sanitizeSubtitles,
  StreamNotFoundError,
  StreamExhaustedError,
  StreamTimeoutError,
  type ResolvedStream,
  type StreamMovie,
  type TrailerInfo,
} from "@/services/api";
import {
  VideoPlayer,
  type StreamVariant,
} from "@/components/stream/VideoPlayer";
import { EmbedPlayer } from "@/components/stream/EmbedPlayer";
import { ServerSelector } from "@/components/stream/ServerSelector";
import { StreamLoader } from "@/components/stream/StreamLoader";
import { formatRuntime } from "@/lib/format";
import { titleUnavailable } from "@/lib/playbackCopy";
import {
  WatchTVControls,
  type SeasonInfo,
} from "@/components/stream/WatchTVControls";
import { cancelInFlightPrefetch, prefetchForOpen } from "@/services/prefetch";
import { useLocalSession } from "@/context/LocalSessionContext";
import {
  getProgress,
  progressForTitle,
  recordWatch,
  subscribeStats,
} from "@/services/stats";
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
import { isExternalEmbedUrl, orderDirectStreams } from "@/lib/streamUtils";
import { resolveEmbedSources } from "@/lib/embedSources";
import { tmdbImage, type TmdbImageSize } from "@/lib/tmdbImages";
import { useAuth } from "@/context/AuthContext";
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { apiHistoryAdd } from "@/services/auth";
import { pushRemoveToRemote, pushToggleToRemote } from "@/services/lists";
import { toast } from "sonner";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

/** Delegates to `tmdbImage` so the requested rendition actually takes effect.
 *  The old `startsWith("http")` early return matched every backend-supplied
 *  value, so the `original` calls below were silently served the stored w780. */
function getImageUrl(path: string, size: TmdbImageSize): string {
  if (path?.startsWith("http")) return tmdbImage(path, size);
  return path ? `${TMDB_IMAGE_BASE_URL}/${size}${path}` : "";
}

const RATE_AFTER_SECONDS = 15 * 60;

/**
 * Floor on how often watch position is written to the account's history.
 * The player samples locally every few seconds; this is the network half.
 */
const REMOTE_PROGRESS_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Backoff between automatic resolver attempts. Without it the three attempts
 * fire back to back, so a cold backend absorbs all of them while still booting
 * and the viewer lands on the error screen without the service ever having had a
 * fair chance. A manual "Retry source" skips the wait.
 */
const COLD_START_BACKOFF_MS = 4000;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Ceiling on the automatic resolve retry loop, in wall-clock time.
 *
 * The loop re-schedules itself 1s after any failure the classifier calls
 * recoverable, and a cold or misbehaving backend produces those indefinitely.
 * Counting attempts alone is not enough because a single attempt can burn its
 * own 45s budget, so there is also a time limit: whatever the attempt count,
 * the page stops retrying after this long and reports the failure.
 */
const MAX_AUTO_RETRY_WINDOW_MS = 2 * 60 * 1000;

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
      message:
        "The streaming provider is currently unavailable. Trying alternative sources...",
      recoverable: true,
      retryCount: 0,
    };
  }

  // A backend that fails outside its own handlers returns an HTML error page.
  // Reading that as JSON throws "Unexpected token '<'", which matches no branch
  // above and used to fall through to "unknown / recoverable" -- so a single
  // server-side error page produced an endless 1Hz retry loop with nothing shown.
  // It is a server fault rather than a transient viewer-side condition, so it is
  // reported instead of retried forever.
  if (
    lowerMessage.includes("unexpected token") ||
    lowerMessage.includes("non-json") ||
    lowerMessage.includes("unexpected payload shape")
  ) {
    return {
      type: "server_error",
      message: "The movie service returned an error. Please try again.",
      // Still `recoverable`, because a 500 is often a transient blip and the
      // viewer should be able to ask again. What must not happen is retrying
      // forever without telling anyone, and that is now the retry budget's job
      // rather than this flag's: at most MAX_RETRY_ATTEMPTS within
      // MAX_AUTO_RETRY_WINDOW_MS, then a terminal error card. Setting this false
      // would have stopped the loop just as effectively while also removing the
      // user's own "Try again", since handleRetry gates on the same flag.
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
  // Bounded and abortable. This pointed at the resolve endpoint, which can
  // scrape Archive.org for minutes server-side, and `fetch` has no default
  // timeout -- so a slow resolve pinned the page on its skeleton with no error
  // and no way to cancel when the user navigated away.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOVIE_RESOLVE_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl("/api/movies/resolve"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tmdbId }),
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

export function WatchPage() {
  const [location, navigate] = useLocation();
  const params = useParams();

  const tmdbId = params.id;
  const searchParams = useMemo(
    () => new URLSearchParams(String(location.search ?? "")),
    [location.search]
  );
  const urlSeason = parseInt(searchParams.get("season") || "1", 10);
  const urlEpisode = parseInt(searchParams.get("episode") || "1", 10);
  const urlType = searchParams.get("type") || "movie";

  const [movie, setMovie] = useState<Movie | null>(null);
  const [movieLoading, setMovieLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  const [resolving, setResolving] = useState(false);
  const [playError, setPlayError] = useState<ReturnType<
    typeof classifyError
  > | null>(null);
  const [season, setSeason] = useState(urlSeason);
  const [episode, setEpisode] = useState(urlEpisode);

  // The URL is the source of truth. Keep local state aligned with it so browser
  // back/forward and shared links select the right episode.
  useEffect(() => {
    setSeason(urlSeason);
    setEpisode(urlEpisode);
  }, [urlSeason, urlEpisode]);

  /**
   * Authoritative media type for this title.
   *
   * Our own TMDB-backed metadata wins over the external stream resolver's
   * `media_type`, which has been observed to report some films as series.
   * Trusting it wrote a bogus `?type=tv&season=1&episode=1` into the URL, after
   * which every resolve hunted for an episode of a film and the stream failed.
   * Falls back to the URL only while local metadata is still loading.
   */
  const isSeries = useMemo<boolean>(
    () =>
      resolveMediaType({
        localMediaType: movie?.mediaType,
        resolverMediaType: resolved?.stream?.media_type,
        urlType,
      }) === "tv",
    [movie, resolved?.stream?.media_type, urlType]
  );

  // A film must never carry season/episode. Once local metadata says "movie",
  // force them to 1 so a stale, shared or hand-edited ?type=tv URL cannot make
  // the resolver look for an episode that does not exist.
  useEffect(() => {
    if (
      movie &&
      movie.mediaType === "movie" &&
      (season !== 1 || episode !== 1)
    ) {
      setSeason(1);
      setEpisode(1);
    }
  }, [movie, season, episode]);
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
  // Budget for the self-rescheduling resolve loop, reset only by an explicit
  // user action so an automatic failure can never buy itself a fresh budget.
  const autoRetryRef = useRef(0);
  const autoRetryStartedRef = useRef(Date.now());

  // Cache for resolveStream results to avoid duplicate API calls
  const resolveCacheRef = useRef<Map<string, ResolvedStream>>(new Map());

  // Local session for My List and History
  const { isInMyList, toggleMyList, addToHistory } = useLocalSession();

  const { user: authUser } = useAuth();
  // Server-backed profile, so history and recommendations follow the viewer
  // rather than the account.
  // From the shared context, so the profile selected here is the same one the
  // home feed and the switcher are using -- a second `useProfiles()` instance
  // held its own copy of the list and drifted out of sync with this one.
  const { activeProfile } = useActiveProfile();
  const activeProfileId = activeProfile ? String(activeProfile.id) : null;
  const recordTaste = useTasteRecorder(activeProfileId);

  // Fetch movie details on mount
  useEffect(() => {
    if (!tmdbId) return;
    setMovieLoading(true);
    fetchMovieDetails(tmdbId).then(m => {
      if (m) {
        setMovie(m);
        setMyRating(getRating(m.id) ?? 0);
        /*
         * Publish for the document head. Until this runs the page is noindex --
         * a title page with no title would otherwise be submitted with a
         * placeholder, which is worse than being submitted late.
         */
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
  }, [tmdbId]);

  // Subscribe to rating changes
  useEffect(() => {
    if (!movie) return;
    return subscribeRatings(() => {
      setMyRating(getRating(movie.id) ?? 0);
    });
  }, [movie?.id]);

  // Subscribe to watch progress
  //
  // Three sources, because progress has been written under three keys over the
  // life of this feature: the catalog id, the resolver's own id, and the title.
  // The first is read episode-qualified for series, because that is the key
  // `handleProgress` writes; a per-show read here would report the position in
  // S01E01 while the viewer is opening S01E02.
  useEffect(() => {
    if (!movie) return;
    const mediaType = isSeries ? "tv" : "movie";
    const key = progressKey(
      movie.providerId ?? movie.id,
      mediaType,
      season,
      episode
    );
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
  }, [
    movie?.id,
    movie?.providerId,
    movie?.title,
    resolved,
    isSeries,
    season,
    episode,
  ]);

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
          apiUrl(
            `/api/episodes?tmdb_id=${resolved.stream.id}&season=${s}&episode=${e}`
          )
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
      /*
       * No gate here any more.
       *
       * Every open used to `POST /api/allowance/claim` first and, on a 429,
       * silently return without playing, without an error, and without a
       * spinner -- a black rectangle that looked like a broken player. The
       * claim was also the only thing that recorded anything, so a refusal
       * meant no watch history, no resume point and no taste signal, all of
       * which silently poisoned Continue Watching and the recommendations for
       * anyone who hit the cap.
       *
       * The server still enforces whatever policy it has; the client no longer
       * decides whether a viewer is allowed to watch something they opened, and
       * no viewer-facing copy on the page describes a limit.
       */
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
          // Starting playback is the strongest taste signal there is. It goes
          // to the server so the same profile ranks the same on every device;
          // the recorder is a no-op when signed out, and never throws.
          recordTaste("play", movie, { weight: 1 });
          base = stream.stream;
        }
        setSeason(targetSeason);
        setEpisode(targetEpisode);

        let playable: StreamMovie = base;
        const mediaType: "movie" | "tv" = isSeries ? "tv" : "movie";

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
              sources: source.sources,
              mirrors: source.mirrors,
              // The backend's chain may have settled on an embed provider.
              // Carrying that decision through means the page renders the
              // source it was actually given instead of re-deriving "is this
              // playable natively?" from the host.
              ...(source.isEmbed ? { is_embed: true } : {}),
              // /api/get-stream reports the tracks for the source it just
              // picked. Dropping them here left the player with subtitles only
              // when the resolve call happened to be the one that won.
              ...(source.subtitles ? { subtitles: source.subtitles } : {}),
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
        const newUrl = buildWatchPath(movie.providerId, {
          mediaType: isSeries ? "tv" : "movie",
          season: targetSeason,
          episode: targetEpisode,
        });
        navigate(newUrl, { replace: true });
      } catch (error) {
        const playbackError = classifyError(error);
        console.error(
          `[WatchPage] could not resolve "${movie.title}" (${movie.year ?? "unknown year"})`,
          error
        );
        setPlayError(playbackError);

        // This used to re-schedule itself every second with no cap and no time
        // budget, and the captured closure always had `resolving === false`, so
        // the guard at the top could not stop the re-entry. A backend that fails
        // in a way the classifier calls "recoverable" therefore produced an
        // endless 1Hz retry loop: the Play button flickering, "Preparing
        // stream..." spinning forever, and no error ever shown -- because
        // `playError` is only rendered once a URL is in hand.
        //
        // A retry budget bounds it. When it is spent the failure becomes
        // terminal, and `streamUnavailable` is what actually reaches the screen
        // even though nothing is resolved yet.
        autoRetryRef.current += 1;
        const budgetSpent =
          autoRetryRef.current >= MAX_RETRY_ATTEMPTS ||
          Date.now() - autoRetryStartedRef.current >= MAX_AUTO_RETRY_WINDOW_MS;

        if (playbackError.recoverable && !budgetSpent) {
          const delay = RETRY_BASE_DELAY_MS;
          retryTimeoutRef.current = setTimeout(() => {
            resolveAndPlay(targetSeason, targetEpisode);
          }, delay);
        } else {
          if (playbackError.recoverable) {
            console.warn(
              `[WatchPage] giving up on "${movie.title}" after ${autoRetryRef.current} attempts`
            );
          }
          setStreamUnavailable(true);
        }
      } finally {
        setResolving(false);
      }
    },
    [movie, resolved, resolving, navigate, resolveWithRetry]
  );

  const playEpisode = useCallback(
    (targetSeason: number, targetEpisode: number) => {
      autoRetryRef.current = 0;
      autoRetryStartedRef.current = Date.now();
      setStreamUnavailable(false);
      void resolveAndPlay(targetSeason, targetEpisode);
    },
    [resolveAndPlay]
  );

  // Retry handler for playback errors
  const handleRetry = useCallback(() => {
    if (playError?.recoverable) {
      setPlayError(null);
      // A deliberate retry is a fresh budget, otherwise the loop that ran out
      // of attempts would refuse the user's own second attempt.
      autoRetryRef.current = 0;
      autoRetryStartedRef.current = Date.now();
      setStreamUnavailable(false);
      if (isSeries) {
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
  }, [
    movie?.id,
    movie?.title,
    movie?.year,
    movie?.mediaType,
    movie?.providerId,
    season,
    episode,
  ]);

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
    // Prefer the browser history so users land exactly where they were
    // (e.g. the details sheet). Fall back to home for direct deep links,
    // since `/details/:id` has no route of its own.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate("/");
    }
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
      // A cancelled share sheet and a clipboard write on an insecure origin
      // both land here; neither is worth an error toast.
    }
  };

  /*
   * Watch progress.
   *
   * The player reports its position every few seconds, and this is the only
   * place anything was written down about it. Nothing did: `recordWatch` and
   * `recordPlay` had no callers in the whole app, so the local Continue Watching
   * queue could never contain a title that had actually been watched, and every
   * shelf built from it rendered empty forever. The player also owns its own
   * `onProgress` sampling, so this only has to turn a position into a delta.
   */
  const progressCursorRef = useRef<{ key: string; seconds: number }>({
    key: "",
    seconds: 0,
  });
  const remoteProgressAtRef = useRef(0);

  const handleProgress = useCallback(
    ({
      seconds,
      durationSeconds,
    }: {
      seconds: number;
      durationSeconds: number;
    }) => {
      if (!movie) return;
      const mediaType: "movie" | "tv" = isSeries ? "tv" : "movie";
      const key = `${movie.providerId}:${mediaType}:${season}:${episode}`;

      // A new title, episode, or a seek backwards all rebase the cursor:
      // `recordWatch` accumulates, so feeding it a position as though it were a
      // delta would inflate the total by the whole runtime on every seek.
      const cursor = progressCursorRef.current;
      if (cursor.key !== key) {
        progressCursorRef.current = { key, seconds: 0 };
      }
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

      // The account's history gets an absolute position and the real runtime,
      // because that is the only way the server -- or another device -- can
      // compute how far in the viewer is. Throttled well above the player's own
      // sampling: this is a network write per title, not per tick.
      const now = Date.now();
      if (!authUser || now - remoteProgressAtRef.current < REMOTE_PROGRESS_MS)
        return;
      remoteProgressAtRef.current = now;
      apiHistoryAdd({
        // The episode-qualified key, matching the local record above. The
        // server stores `movie_key` as opaque TEXT, so this needs no migration
        // and the two stores cannot disagree about which episode a row belongs
        // to.
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

  // Determine what to show as episode title
  const displayTitle =
    movie?.mediaType === "tv" && episodeDetails?.title
      ? `${movie.title} — ${episodeDetails.title}`
      : movie?.mediaType === "tv"
        ? `${movie.title} — S${season} E${episode}`
        : movie?.title || "Loading...";

  const DEFAULT_TAB_TITLE = "Stream Vy";
  useEffect(() => {
    document.title = movie?.title
      ? `${movie.title} — Stream Vy`
      : DEFAULT_TAB_TITLE;
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

  // Record per-account history on the backend when signed in, scoped to the
  // active profile so two viewers in one home keep separate progress.
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

  // Ordered list of directly playable (non-embed) URLs. Embeds are never
  // shown or linked anywhere — every movie plays inline or shows a native
  // stream state instead.
  //
  // Ordering is part of the contract, not incidental: backend HLS comes first,
  // then the other media files, then anything the registry could not classify.
  // The resolver returns its chain in provider order, and that order can put a
  // raw third-party player page ahead of a manifest, which would hand the ad
  // provider's scripts a `<video>` slot they cannot fill while the working
  // stream waits behind them.
  const playableCandidates: string[] = useMemo(() => {
    const stream = resolved?.stream;
    if (!stream) return [];
    const urls = new Set<string>();
    for (const source of stream.sources ?? []) {
      if (source && !isExternalEmbedUrl(source)) urls.add(source);
    }
    if (stream.stream_url && !isExternalEmbedUrl(stream.stream_url)) {
      urls.add(stream.stream_url);
    }
    for (const mirror of stream.mirrors ?? []) {
      if (mirror.url && !isExternalEmbedUrl(mirror.url)) urls.add(mirror.url);
    }
    for (const variant of stream.streams ?? []) {
      if (variant.url && !isExternalEmbedUrl(variant.url))
        urls.add(variant.url);
    }
    return orderDirectStreams(urls);
  }, [resolved]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [streamUnavailable, setStreamUnavailable] = useState(false);
  /**
   * True once the resolver has settled on a third-party embed provider.
   *
   * The backend walks its whole provider chain before answering, so reaching
   * this state means the direct catalog had nothing and an embed did. It is a
   * rendering decision, not a user choice: the page loads the source it was
   * given. Previously this was an opt-in behind a "Try another source" button,
   * which meant every title outside the direct catalog dead-ended on an error
   * card with a button, even though a working embed URL had been in hand the
   * whole time.
   */
  const [usingEmbedProvider, setUsingEmbedProvider] = useState(false);
  /**
   * The embed provider the viewer is on, so the selector below the player and
   * the frame itself can never disagree. The player owns failover (it rotates
   * past a source that will not render) and writes its decision back here, which
   * is why this is state and not a one-way prop.
   */
  const [embedSourceId, setEmbedSourceId] = useState<string | null>(null);
  const fallbackAttemptsRef = useRef(0);
  const playerKeyRef = useRef(0);

  const currentStreamUrl = playableCandidates[sourceIndex] ?? "";

  /**
   * The resolved source is a third-party embed and there is no directly playable
   * URL for it -- either the resolver settled on an embed provider, or it handed
   * back an embed URL and nothing native.
   *
   * Both cases now render the embed player rather than an error card. The old
   * code made this an error state on purpose, reasoning that re-scraping for a
   * direct source could not succeed, but it still had to show the viewer a
   * button: the backend had no failover, so switching providers was something
   * the viewer had to do. It is now a rendering decision the resolver makes.
   */
  const embedOnlyStream = useMemo(() => {
    const streamUrl = resolved?.stream?.stream_url;
    if (!streamUrl) return false;
    return isExternalEmbedUrl(streamUrl) && playableCandidates.length === 0;
  }, [resolved, playableCandidates]);

  // Every embed provider is keyed on the TMDB id, so only a purely numeric id
  // is addressable. Anything else renders the "no sources" state instead.
  const embedTargetId = useMemo(() => {
    const id = resolved?.stream?.id ?? movie?.providerId ?? "";
    return /^\d+$/.test(String(id)) ? String(id) : null;
  }, [resolved?.stream?.id, movie?.providerId]);

  /**
   * The provider chain to hand the embed player.
   *
   * Every entry is keyed on the title's own TMDB id, so the registry supplies
   * the chain whether or not the backend listed mirrors: the ids are the same
   * ones the server hands out, and the URL patterns are its URL patterns. A
   * backend mirror that names one of these providers is matched to that
   * provider's entry, so a server-side decision about order or availability is
   * respected rather than overwritten; anything unrecognised is appended as a
   * last-resort frame.
   */
  const embedChain = useMemo(() => {
    const local = resolveEmbedSources({
      tmdbId: embedTargetId,
      mediaType: isSeries ? "tv" : "movie",
      season,
      episode,
    });
    const mirrors = (resolved?.stream?.mirrors ?? []).filter(
      mirror => mirror?.url && isExternalEmbedUrl(mirror.url)
    );
    if (!mirrors.length) return local;

    const matched: typeof local = [];
    const extras: typeof local = [];
    for (const mirror of mirrors) {
      const host = safeHost(mirror.url);
      const known = local.find(source => source.host === host);
      if (known) {
        // The server's own URL wins over the registry's: it may carry the
        // season, episode or referrer the provider needs.
        matched.push({ ...known, url: mirror.url });
      } else {
        extras.push({
          id: `server-${mirrors.indexOf(mirror)}`,
          label: mirror.name || "Alternate server",
          title: mirror.name || "Alternate server",
          host,
          url: mirror.url,
          quality: null,
          type: "embed",
        });
      }
    }
    const used = new Set(matched.map(source => source.id));
    return [
      ...matched,
      ...extras,
      ...local.filter(source => !used.has(source.id)),
    ];
  }, [resolved?.stream?.mirrors, embedTargetId, isSeries, season, episode]);

  // A new title/episode drops any earlier embed decision, so the loader shows
  // while the resolver walks the chain again -- and the provider selection goes
  // with it, because "Server A" on one episode says nothing about another.
  useEffect(() => {
    setUsingEmbedProvider(false);
    setEmbedSourceId(null);
  }, [movie?.id, season, episode]);

  // When the player is advancing through alternate sources on its own the
  // switch is kept silent: no buffering spinner, just the ambient poster
  // canvas while the next candidate hands it to the player.
  const autoCycling = sourceIndex > 0 && !reconnecting;

  /**
   * Re-ask the resolver for a playable source.
   *
   * This no longer drives provider failover -- the backend walks its whole chain
   * before answering, so a single call already tried every provider. What it
   * still covers is the resolver itself being unable to answer: a cold start or
   * a transient 5xx.
   *
   * A 503 is deliberately not retried. It means the backend already walked the
   * entire chain and every provider came back empty or unreachable, so asking
   * again can only re-walk providers that just failed. That is a decision, not
   * an outage, and the terminal state is the honest response to it.
   *
   * `refresh` bypasses the backend's direct-source cache so a retry can pick up
   * a title the first attempt missed, rather than replaying the same cached
   * "no direct source" answer. The backend benches a direct miss for five
   * minutes, so a refresh storm cannot multiply the Archive.org scrape.
   */
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
      // Let a booting backend finish booting before spending an attempt.
      if (fallbackAttemptsRef.current > 1) {
        await new Promise(resolve =>
          setTimeout(resolve, COLD_START_BACKOFF_MS)
        );
      }
      const source = await getStreamSource({
        tmdbId: stream.id,
        mediaType,
        season: mediaType === "tv" ? season : undefined,
        episode: mediaType === "tv" ? episode : undefined,
        refresh: true,
      });

      if (source.isEmbed || isExternalEmbedUrl(source.url)) {
        // The chain settled on a third-party provider. Render it; this is a
        // playback state, not a failure.
        setUsingEmbedProvider(true);
        setResolved(prev =>
          prev
            ? {
                exact: prev.exact,
                stream: {
                  ...prev.stream,
                  stream_url: source.url,
                  sources: source.sources,
                  mirrors: source.mirrors,
                  is_embed: true,
                  ...(source.subtitles ? { subtitles: source.subtitles } : {}),
                },
              }
            : prev
        );
        setSourceIndex(0);
        fallbackAttemptsRef.current = 0;
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
                  ...(source.subtitles ? { subtitles: source.subtitles } : {}),
                },
              }
            : prev
        );
        setSourceIndex(0);
        fallbackAttemptsRef.current = 0;
      }
    } catch (err) {
      // The whole chain came back exhausted. That is the resolver's final
      // answer, so it goes straight to the terminal state without spending
      // the remaining attempts on a question that is already answered.
      if (err instanceof StreamExhaustedError) {
        console.warn(
          "[stream] every provider was exhausted",
          err.providerAttempts
        );
        setStreamUnavailable(true);
        return;
      }
      // A timeout means the resolver is still waking up, so it costs an
      // attempt but must not surface as "unavailable" on its own -- the loop
      // retries and only the final attempt decides.
      if (err instanceof StreamTimeoutError) {
        console.warn(
          `[stream] resolver cold start, attempt ${fallbackAttemptsRef.current}/${MAX_RETRY_ATTEMPTS}`
        );
      }
      if (fallbackAttemptsRef.current >= MAX_RETRY_ATTEMPTS) {
        setStreamUnavailable(true);
      }
    } finally {
      setReconnecting(false);
    }
  }, [resolved, reconnecting, isSeries, season, episode]);

  // Ask the resolver again whenever a resolved title has no directly playable
  // source (only media with a TMDB-backed id can be re-queried; catalog entries
  // without one just surface the native state).
  //
  // The delay exists so a warm resolve that lands a moment later is not raced.
  // It is not a stall window: the loader is what the viewer sees throughout, so
  // this is invisible rather than a dead beat.
  //
  // An embed that is already playing is excluded: it is a resolved source, and
  // without this guard the timer would fire a redundant second resolver call
  // underneath a perfectly good frame.
  useEffect(() => {
    if (
      !resolved ||
      playableCandidates.length > 0 ||
      reconnecting ||
      streamUnavailable ||
      usingEmbedProvider
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
    usingEmbedProvider,
    runStreamFallback,
  ]);

  /**
   * An embed-only resolve renders the embed player, not an error.
   *
   * This used to be a terminal "unavailable" state, on the reasoning that
   * hunting for a direct source would be futile. True, but the wrong
   * conclusion: the embed URL was already in hand, and the page had no way to
   * use it without a button, so every title outside the direct catalog reached
   * a dead end. The backend now picks a provider on its own, so an embed is
   * simply the source that plays.
   */
  useEffect(() => {
    if (embedOnlyStream && !usingEmbedProvider) {
      setUsingEmbedProvider(true);
    }
  }, [embedOnlyStream, usingEmbedProvider]);

  // Reset source/failure state whenever a fresh resolve lands.
  useEffect(() => {
    setSourceIndex(0);
    setReconnecting(false);
    setStreamUnavailable(false);
    fallbackAttemptsRef.current = 0;
  }, [resolved]);

  // Advance to the next candidate mirror, or hand off to the backend
  // fallback loop when the current source fails mid-play. Source swaps are
  // silent — the backing poster canvas keeps the surface alive, and the
  // player remounts on the bumped key to reset its HLS/dash state.
  const handleSourceError = useCallback(() => {
    if (sourceIndex + 1 < playableCandidates.length) {
      playerKeyRef.current += 1;
      setSourceIndex(prev => Math.min(prev + 1, playableCandidates.length - 1));
    } else if (!reconnecting && !streamUnavailable) {
      fallbackAttemptsRef.current = 0;
      void runStreamFallback();
    }
  }, [
    sourceIndex,
    playableCandidates.length,
    reconnecting,
    streamUnavailable,
    runStreamFallback,
  ]);

  // Season + episode data for the TV controls, taken from the resolved
  // manifest when the backend supplies one and synthesised from the season
  // counts when it does not (same fallback EpisodeMatrix uses).
  const tvSeasons = useMemo<SeasonInfo[]>(() => {
    const manifest = resolved?.stream?.episodes ?? [];
    if (manifest.length) {
      const counts = new Map<number, number>();
      for (const ep of manifest) {
        counts.set(ep.season, Math.max(counts.get(ep.season) ?? 0, ep.number));
      }
      return Array.from(counts.entries())
        .map(([season_number, episode_count]) => ({
          season_number,
          episode_count,
        }))
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

  // Selecting an episode rewrites the query string client-side (no reload) and
  // resets the mirror cursor so the new episode starts from the primary source.
  const handleSelectEpisode = useCallback(
    (nextSeason: number, nextEpisode: number) => {
      setSeason(nextSeason);
      setEpisode(nextEpisode);
      setSourceIndex(0);
      setStreamUnavailable(false);
      setUsingEmbedProvider(false);
      setPlayError(null);
      const qs = new URLSearchParams({
        season: String(nextSeason),
        episode: String(nextEpisode),
        type: "tv",
      });
      navigate(`/watch/${tmdbId}?${qs.toString()}`);
    },
    [navigate, tmdbId]
  );

  // Determine quality variants for direct streams
  const qualityVariants: StreamVariant[] = useMemo(() => {
    if (!resolved?.stream?.streams) return [];
    return resolved.stream.streams
      .filter(s => s.url && !isExternalEmbedUrl(s.url))
      .map(s => {
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

  // WebVTT tracks for the source currently in the player. Subtitle selection
  // lives inside the player, so the list is keyed off the resolved source and
  // is swapped whenever a new source is adopted.
  const streamSubtitles = useMemo(
    () => sanitizeSubtitles(resolved?.stream?.subtitles),
    [resolved?.stream?.subtitles]
  );

  // Metadata is still arriving, so there is no poster to show yet. The same
  // wordless full-screen loader is used here and for stream resolution: both
  // are the same wait from the viewer's side, and a skeleton with a label
  // ("Loading movie details...") that then swaps to a differently-labelled
  // spinner reads as two unrelated waits.
  if (movieLoading) {
    return (
      /* The shell owns the background colour; see the note in `Home`. */
      <div className="relative min-h-screen">
        <StreamLoader />
      </div>
    );
  }

  // No metadata and no title: nothing to wait for and nothing to show. Kept
  // distinct from the loader so a genuinely missing title is not reported as a
  // slow one.
  if (!movie) {
    return (
      <div className="min-h-screen text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/70">{titleUnavailable}</p>
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

  /**
   * Host of a provider URL, for labelling the server tabs.
   *
   * Falls back to the provider's own host when the URL is unparseable rather
   * than rendering an empty tab, so a malformed entry from the backend is
   * still selectable and still fails over on its own terms.
   */
  function safeHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  return (
    <div className="min-h-screen text-white">
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

                    {/*
                      Player surface, in strict precedence order:

                      1. a directly playable source -> <VideoPlayer>
                      2. the chain settled on an embed provider -> <EmbedPlayer>
                      3. every provider exhausted -> "Title unavailable"
                      4. anything else -> the wordless loader

                      Steps 1 and 2 are not error recovery. The backend picks a
                      provider before answering, so whichever of the two the
                      resolver chose is simply the source that plays. Step 4 is
                      the wait, and it deliberately carries no technical copy: a
                      viewer waiting on provider failover has no use for a
                      description of which stage it is on, and the stage labels
                      it replaced ("Optimizing high-definition stream…",
                      "Resolving playback sources…") described retries that had
                      nothing to do with the stated activity.

                      The order between 1 and 2 is absolute, not a preference:
                      a payload that carries both a manifest and an embed URL
                      plays the manifest (HLS first, see `orderDirectStreams`)
                      and never mounts the frame, because the embed is the only
                      one of the two that pulls a third-party ad provider's
                      scripts into the page.
                    */}
                    {currentStreamUrl && !streamUnavailable ? (
                      <VideoPlayer
                        key={playerKeyRef.current}
                        streamUrl={currentStreamUrl}
                        title={displayTitle}
                        poster={streamPoster}
                        onClose={handleClose}
                        variants={qualityVariants}
                        subtitles={streamSubtitles}
                        currentQuality={
                          qualityVariants.find(v => v.quality)?.quality ||
                          "Auto"
                        }
                        onQualityChange={q => {}}
                        isLoading={resolving}
                        autoCycling={autoCycling}
                        playbackError={playError?.message || null}
                        onRetry={() => {
                          if (playError) {
                            handleRetry();
                          } else {
                            handleSourceError();
                          }
                        }}
                        onSourceError={handleSourceError}
                        onProgress={handleProgress}
                        hideCloseButton
                      />
                    ) : usingEmbedProvider ? (
                      <EmbedPlayer
                        key={playerKeyRef.current}
                        sources={embedChain}
                        title={displayTitle}
                        poster={streamPoster}
                        activeSourceId={embedSourceId ?? undefined}
                        onActiveSourceIdChange={setEmbedSourceId}
                      />
                    ) : streamUnavailable ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                          <img
                            src={streamPoster}
                            alt=""
                            aria-hidden
                            className="absolute inset-0 w-full h-full object-cover opacity-40 blur-2xl scale-110"
                          />
                          <div className="relative z-20 rounded-xl px-8 py-6 text-center">
                            <p className="text-lg font-semibold text-white">
                              {titleUnavailable}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <StreamLoader
                        poster={streamPoster}
                        title={displayTitle}
                      />
                    )}
                  </>
                )}
                {/*
                  Before the first resolve lands there is no `resolved` to
                  render the player surface for. The same loader covers it, so
                  opening a title is one continuous wait rather than a labelled
                  skeleton that swaps to a differently-labelled spinner.
                */}
                {!resolved && (
                  <StreamLoader poster={streamPoster} title={movie.title} />
                )}
              </div>

              {/*
                The source choice, directly under the frame.

                      It was a row of "Server 1 / Server 2" tabs painted over
                      the top-left of the player, which sat on top of the
                      provider's own controls and read as a broken strip rather
                      than a choice. It is a proper selector below the video now,
                      and it is the same list the player renders -- no "this is
                      the server you are watching" caption needed, because the
                      active one is marked as active.
                    */}
              {usingEmbedProvider && !streamUnavailable ? (
                <ServerSelector
                  tmdbId={embedTargetId ?? movie.providerId}
                  mediaType={isSeries ? "tv" : "movie"}
                  season={isSeries ? season : undefined}
                  episode={isSeries ? episode : undefined}
                  sources={embedChain}
                  selectedId={embedSourceId ?? undefined}
                  onSelect={setEmbedSourceId}
                  // The real player is the <EmbedPlayer> above this picker.
                  showPlayer={false}
                  title={displayTitle}
                  className="mt-4"
                />
              ) : null}

              {/* Season/episode navigation, directly below the player */}
              {movie.mediaType === "tv" ? (
                <WatchTVControls
                  currentSeason={season}
                  currentEpisode={episode}
                  seasons={tvSeasons}
                  episodes={currentSeasonEpisodes}
                  onSelectEpisode={handleSelectEpisode}
                />
              ) : null}
            </div>

            {/*
              RIGHT PANEL: the details, synopsis, My List action and, for a
              series, the episode list. `sv-surface` is the standard pane from
              the design system, so this column is the same glass as the hero
              card on the home page rather than a second surface treatment.
            */}
            <aside className="sv-surface lg:sticky lg:top-24 max-h-[calc(100vh-6rem)] space-y-6 overflow-y-auto rounded-2xl p-5 pr-3">
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
                        {formatRuntime(movie.runtime)}
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

                {/* Synopsis. Omitted entirely when the catalogue has none,
                    rather than padded with placeholder prose. */}
                {movie.synopsis ? (
                  <p className="text-sm leading-6 text-[#c5c5c1] line-clamp-4">
                    {movie.synopsis}
                  </p>
                ) : null}

                {/* Action Buttons */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="flex items-center gap-2 px-4 py-3 focus-visible:ring-violet-600/50"
                    onClick={() => {
                      if (!authUser) {
                        navigate("/login");
                        return;
                      }
                      const wasInList = isInMyList(movie.id);
                      toggleMyList(movie);
                      toast.success(
                        wasInList
                          ? "Removed from your list"
                          : "Added to your list!"
                      );
                      if (wasInList) {
                        void pushRemoveToRemote(
                          Number(movie.providerId ?? movie.id ?? 0)
                        );
                        // Removing is a negative signal, not a neutral one: it
                        // is the clearest statement a viewer makes about a title
                        // they were told they might want.
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
                    aria-pressed={isInMyList(movie.id)}
                  >
                    {isInMyList(movie.id) ? (
                      <Check className="h-5 w-5" />
                    ) : (
                      <Plus className="h-5 w-5" />
                    )}
                    <span className="hidden sm:inline">
                      {isInMyList(movie.id) ? "✓ In My List" : "Add to My List"}
                    </span>
                  </Button>

                  {/*
                    Share, next to Add to My List rather than floating over the
                    video.

                    It used to sit in the player's top-right corner, which is
                    where a viewer's hand already goes to reach the provider's own
                    fullscreen and settings controls, and it meant the only way to
                    share a title was to have the player open. Both of those
                    actions are decisions taken after reading the synopsis, so the
                    button belongs with the other one.
                  */}
                  <Button
                    variant="outline"
                    className="flex items-center gap-2 px-4 py-3 focus-visible:ring-violet-600/50"
                    onClick={() => void handleShare()}
                    aria-label="Share this title"
                  >
                    <Share2 className="h-5 w-5" />
                    <span className="hidden sm:inline">Share</span>
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
                          <p className="text-white font-medium">
                            {movie.director}
                          </p>
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
                          <p className="text-white font-medium">
                            {movie.country}
                          </p>
                        </div>
                      )}
                      {movie.language && (
                        <div>
                          <p className="text-white/50">Language</p>
                          <p className="text-white font-medium">
                            {movie.language}
                          </p>
                        </div>
                      )}
                      {movie.releaseDate && (
                        <div>
                          <p className="text-white/50">Release Date</p>
                          <p className="text-white font-medium">
                            {movie.releaseDate}
                          </p>
                        </div>
                      )}
                      {movie.runtime != null && (
                        <div>
                          <p className="text-white/50">Runtime</p>
                          <p className="text-white font-medium">
                            {formatRuntime(movie.runtime)}
                          </p>
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
