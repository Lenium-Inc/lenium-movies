import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Check, Play, Star, X, MessageSquare, Clock } from "lucide-react";
import { getRating, setRating, subscribeRatings } from "@/services/ratings";
import {
  fetchTrailer,
  getStreamCatalog,
  getStreamSource,
  resolveStream,
  StreamNotFoundError,
  type ResolvedStream,
  type StreamMovie,
  type TrailerInfo,
} from "@/services/api";
import { VideoPlayer } from "@/components/stream/VideoPlayer";
import { EpisodeMatrix } from "@/components/movies/EpisodeMatrix";
import {
  cancelInFlightPrefetch,
  prefetchForOpen,
} from "@/services/prefetch";
import { attemptPlay } from "@/services/capGate";
import {
  getProgress,
  progressForTitle,
  subscribeStats,
} from "@/services/stats";
import type { Movie } from "./types";
import { TrailerEmbed } from "./MediaCard";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

function getImageUrl(path: string, size: string): string {
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

const WORDS = /[a-z0-9]+/g;

const RATE_AFTER_SECONDS = 15 * 60;

/** Title similarity used to rank fallback suggestions (0..1, 1 = identical). */
function titleOverlap(a: string, b: string): number {
  const wa = a.toLowerCase().match(WORDS) ?? [];
  const wb = b.toLowerCase().match(WORDS) ?? [];
  if (!wa.length || !wb.length) return 0;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let overlap = 0;
  for (const word of Array.from(sa)) if (sb.has(word)) overlap += 1;
  return overlap / Math.max(sa.size, sb.size);
}

let catalogPromise: Promise<StreamMovie[]> | null = null;
const loadCatalog = () => {
  catalogPromise ??= getStreamCatalog();
  return catalogPromise;
};

interface DetailsProps {
  movie: Movie;
  onClose: () => void;
  onSave: () => void;
  saved: boolean;
}

/**
 * Bottom-sheet style modal that opens instantly with skeleton placeholders.
 * Loads full metadata and stream resolution in the background.
 */
export function Details({ movie, onClose, onSave, saved }: DetailsProps) {
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [suggestions, setSuggestions] = useState<StreamMovie[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [myRating, setMyRating] = useState<number>(() => getRating(movie.id) ?? 0);
  const [watchedSeconds, setWatchedSeconds] = useState(0);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);

  useEffect(
    () =>
      subscribeRatings(() => {
        setMyRating(getRating(movie.id) ?? 0);
      }),
    [movie.id]
  );

  useEffect(() => {
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
  }, [movie.id, movie.title, resolved]);

  const canRate = watchedSeconds >= RATE_AFTER_SECONDS;

  // Fetch trailer in background
  useEffect(() => {
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
  }, [movie.title, movie.year]);

  // When a title has no playable stream, offer sibling films from the archive
  const suggestFor = useCallback(async (title: string) => {
    setSuggestionsLoading(true);
    try {
      const catalog = await loadCatalog();
      setSuggestions(
        [...catalog]
          .map(item => ({ item, score: titleOverlap(item.title, title) }))
          .filter(entry => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map(entry => entry.item)
      );
    } catch {
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  /**
   * Build the playable stream for the selected title/episode and open the player.
   */
  const resolveAndPlay = async (
    targetSeason: number,
    targetEpisode: number
  ) => {
    if (resolving) return;
    if (!attemptPlay()) return;
    setResolving(true);
    setPlayError(null);
    try {
      let base = resolved?.stream ?? null;
      if (!base) {
        const stream = await resolveStream(movie.title, movie.year);
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
            `[Details] get-stream failed for "${base.title}" (S${targetSeason}E${targetEpisode}), using resolved source`,
            error
          );
          if (mediaType === "tv") {
            const stream = await resolveStream(movie.title, movie.year, {
              season: targetSeason,
              episode: targetEpisode,
            });
            playable = {
              ...stream.stream,
              season: targetSeason,
              episode: targetEpisode,
            };
          }
        }
      }

      setResolved({ stream: playable, exact: true });
      prefetchForOpen(playable);
      setPlayerOpen(true);
    } catch (error) {
      const isNotFound = error instanceof StreamNotFoundError;
      console.error(
        `[Details] could not resolve "${movie.title}" (${movie.year ?? "unknown year"})`,
        error
      );
      setPlayError(
        isNotFound
          ? `"${movie.title}" isn't available to stream yet.`
          : "We couldn't find a stream for this title just yet."
      );
      if (isNotFound) void suggestFor(movie.title);
    } finally {
      setResolving(false);
    }
  };

  const play = async () => {
    if (resolving) return;
    if (!attemptPlay()) return;
    if (resolved) {
      const isSeries = resolved.stream.media_type === "tv";
      await resolveAndPlay(isSeries ? season : 1, isSeries ? episode : 1);
      return;
    }
    await resolveAndPlay(1, 1);
  };

  const showMainPlayButton = !resolved?.stream.media_type || resolved.stream.media_type !== "tv";

  const playEpisode = (targetSeason: number, targetEpisode: number) => {
    void resolveAndPlay(targetSeason, targetEpisode);
  };

  const pickSuggestion = (item: StreamMovie) => {
    if (!attemptPlay()) return;
    cancelInFlightPrefetch();
    prefetchForOpen(item);
    setResolved({ stream: item, exact: true });
    setSeason(1);
    setEpisode(1);
    setPlayerOpen(true);
    setPlayError(null);
  };

  // Pre-cache engine: the moment the sheet opens, silently resolve the title
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    let disposed = false;
    
    // Mark details as loaded after a brief moment for smooth UX
    const loadTimer = setTimeout(() => {
      if (!disposed) setDetailsLoaded(true);
    }, 100);

    void (async () => {
      try {
        const stream = await resolveStream(movie.title, movie.year);
        if (disposed) return;
        setResolved(stream);
        prefetchForOpen(stream.stream);
      } catch (error) {
        console.warn(
          `[Details] warm resolve skipped for "${movie.title}"`,
          error
        );
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(loadTimer);
    };
  }, [movie.id, movie.title, movie.year]);

  // Skeleton placeholder for metadata
  const SkeletonMetadata = () => (
    <div className="space-y-3 animate-pulse">
      <div className="flex flex-wrap items-center gap-2">
        <div className="h-4 w-16 bg-white/10 rounded" />
        <div className="h-4 w-4 bg-white/10 rounded-full" />
        <div className="h-4 w-24 bg-white/10 rounded" />
        <div className="h-4 w-20 bg-white/10 rounded" />
      </div>
      <div className="h-4 w-full bg-white/10 rounded" />
      <div className="h-4 w-3/4 bg-white/10 rounded" />
      <div className="h-4 w-1/2 bg-white/10 rounded" />
    </div>
  );

  // Skeleton placeholder for action buttons
  const SkeletonActions = () => (
    <div className="flex flex-wrap gap-2 animate-pulse">
      <div className="h-10 w-28 bg-white/10 rounded-md" />
      <div className="h-10 w-32 bg-white/10 rounded-md border border-white/10" />
    </div>
  );

  // Skeleton placeholder for EpisodeMatrix
  const SkeletonEpisodes = () => (
    <section className="mt-8 rounded-xl border border-white/10 bg-[#121212] p-5 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-4 w-32 bg-white/10 rounded" />
      </div>
      <div className="mt-3 space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
            <div className="h-8 w-8 rounded-full border border-white/10" />
            <div className="flex-1">
              <div className="h-4 w-3/4 bg-white/10 rounded" />
              <div className="mt-1 h-3 w-24 bg-white/10 rounded" />
            </div>
            <div className="h-9 w-9 rounded-full bg-white/10" />
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${movie.title} details`}
      onClick={onClose}
    >
      <div
        onClick={event => event.stopPropagation()}
        className="max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-t-xl border border-white/10 bg-[#151519] shadow-2xl sm:rounded-xl"
      >
        <div className="relative h-44 overflow-hidden sm:h-56">
          {trailer ? (
            <TrailerEmbed provider={trailer.provider} id={trailer.id} />
          ) : movie.backdrop ? (
            <img
              src={getImageUrl(movie.backdrop, "original")}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : null}
          <div className="absolute inset-0 bg-black/45" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#151519] to-transparent" />
          <button
            onClick={onClose}
            aria-label="Close details"
            className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white"
          >
            <X className="h-4 w-4" />
          </button>
          <h2 className="absolute bottom-5 left-5 text-2xl font-bold sm:text-3xl">
            {movie.title}
          </h2>
        </div>
        <div className="p-5">
          {detailsLoaded ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#aaa9ae]">
                {movie.year && <span>{movie.year}</span>}
                {movie.runtime && (
                  <>
                    <span>·</span>
                    <span>{movie.runtime}</span>
                  </>
                )}
                <span>·</span>
                <span>{movie.genre.join(" · ")}</span>
                {movie.score !== null && (
                  <span className="flex items-center gap-1 text-[#d7d7d3]">
                    <Star className="h-3.5 w-3.5 fill-current" />
                    {movie.score}
                  </span>
                )}
              </div>
              <p className="mt-4 text-sm leading-6 text-[#c5c5c1]">
                {movie.synopsis}
              </p>
            </>
          ) : (
            <SkeletonMetadata />
          )}
          
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {showMainPlayButton && (
              <button
                onClick={play}
                disabled={resolving}
                className="flex-1 sm:flex-none flex items-center justify-center gap-2 rounded-md bg-[#d7d7d3] px-6 py-3 text-sm font-black text-[#0b0b0e] hover:bg-white disabled:opacity-60 transition-all active:scale-[0.98] shadow-lg shadow-[#d7d7d3]/20"
              >
                <Play className="h-5 w-5 fill-current" />
                {resolving ? "Loading Stream…" : "Play"}
              </button>
            )}
            <button
              onClick={onSave}
              className="flex items-center gap-2 rounded-md border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
            >
              {saved ? (
                <Check className="h-4 w-4" />
              ) : (
                <Bookmark className="h-4 w-4" />
              )}
              <span>{saved ? "In My List" : "Add to My List"}</span>
            </button>
            <button
              className="flex items-center gap-2 rounded-md border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
            >
              <MessageSquare className="h-4 w-4" />
              <span>Comments</span>
            </button>
          </div>
          
          {canRate && detailsLoaded && (
            <div className="mt-4 flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/40">
                Your rating
              </span>
              <span className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    type="button"
                    aria-label={`Rate ${star} out of 5`}
                    disabled={!canRate}
                    onClick={() => {
                      setRating(movie, star === myRating ? 0 : star);
                      setMyRating(star === myRating ? 0 : star);
                    }}
                    className="p-0.5 text-white transition hover:scale-110"
                  >
                    <Star
                      className={`h-4 w-4 ${
                        star <= myRating ? "fill-[#d7d7d3] text-[#d7d7d3]" : "text-white/30"
                      }`}
                    />
                  </button>
                ))}
              </span>
              {myRating > 0 && (
                <span className="text-[11px] tabular-nums text-white/50">
                  {myRating}/5
                </span>
              )}
            </div>
          )}
          
          {playError && detailsLoaded && (
            <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs leading-5 text-[#c5c5c1]">
              <p>{playError}</p>
              {suggestionsLoading && (
                <p className="mt-2 text-[#8E8E93]">
                  Finding similar films that do stream…
                </p>
              )}
              {!suggestionsLoading && suggestions.length > 0 && (
                <>
                  <p className="mt-2 text-white/60">
                    Sibling films from the playable archive:
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {suggestions.map(item => (
                      <button
                        key={item.id}
                        onClick={() => pickSuggestion(item)}
                        className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1.5 text-white hover:bg-white/10"
                      >
                        <Play className="h-3 w-3 fill-current" />
                        {item.title}
                        {item.year ? (
                          <span className="text-white/50">{item.year}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          
          {resolved && !resolved.exact && detailsLoaded && (
            <p className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs leading-5 text-[#c5c5c1]">
              Closest matching archive film:{" "}
              <span className="font-semibold text-white">
                {resolved.stream.title}
              </span>
            </p>
          )}
          
          {resolved && resolved.stream.media_type === "tv" ? (
            <EpisodeMatrix
              movie={resolved.stream}
              onPlay={ep => playEpisode(ep.season, ep.number)}
            />
          ) : detailsLoaded ? null : (
            <SkeletonEpisodes />
          )}
        </div>
      </div>
      {playerOpen && resolved && (
        <VideoPlayer
          title={resolved.stream.title}
          movie={resolved.stream}
          onClose={() => setPlayerOpen(false)}
        />
      )}
    </div>
  );
}