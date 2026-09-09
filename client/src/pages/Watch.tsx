import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { Bookmark, Check, ChevronDown, ChevronUp, Play, Star, X, MessageSquare, Clock, Tv, Film, Loader2 } from "lucide-react";
import { getRating, setRating, subscribeRatings } from "@/services/ratings";
import {
  fetchTrailer,
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
import type { Movie } from "@/components/movies/types";
import { TrailerEmbed } from "@/components/movies/MediaCard";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

function getImageUrl(path: string, size: string): string {
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

const RATE_AFTER_SECONDS = 15 * 60;

// Fetch full movie details from TMDB via backend resolve endpoint
async function fetchMovieDetails(tmdbId: string): Promise<Movie | null> {
  try {
    // Use resolve endpoint with the TMDB ID as title to get full metadata
    const response = await fetch(`/api/movies/resolve`, {
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
    
    return {
      id: parseInt(m.id),
      providerId: m.id,
      title: m.title,
      year,
      runtime: "",
      rating: "Rating unavailable",
      score: m.vote_average ?? null,
      genre: m.genres?.length ? m.genres : [mediaType === "tv" ? "Series" : "Movie"],
      poster: m.poster_url,
      backdrop: m.backdrop_url || m.poster_url,
      synopsis: m.overview || "Loading...",
      director: null,
      source: "tmdb",
      mediaType,
    };
  } catch {
    return null;
  }
}

export function WatchPage() {
  const [, navigate] = useLocation();
  const params = useParams();
  const location = useLocation();
  
  // Extract media info from URL: /watch/:id?season=1&episode=1&type=tv
  const tmdbId = params.id;
  const searchParams = new URLSearchParams(location.search);
  const urlSeason = parseInt(searchParams.get("season") || "1", 10);
  const urlEpisode = parseInt(searchParams.get("episode") || "1", 10);
  const urlType = searchParams.get("type") || "movie";
  
  const [movie, setMovie] = useState<Movie | null>(null);
  const [movieLoading, setMovieLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedStream | null>(null);
  const [resolving, setResolving] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
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

  // Fetch movie details on mount
  useEffect(() => {
    if (!tmdbId) return;
    setMovieLoading(true);
    fetchMovieDetails(tmdbId).then(m => {
      if (m) {
        setMovie(m);
        // Initialize rating from localStorage
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
  const fetchEpisodeInfo = useCallback(async (s: number, e: number) => {
    if (!resolved?.stream.id || !/^\d+$/.test(resolved.stream.id)) return;
    try {
      const details = await fetch(`/api/episodes?tmdb_id=${resolved.stream.id}&season=${s}&episode=${e}`);
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
  }, [resolved]);

  useEffect(() => {
    if (movie?.mediaType === "tv" && resolved?.stream.id) {
      fetchEpisodeInfo(season, episode);
    } else {
      setEpisodeDetails(null);
      setCurrentEpisodeTitle(movie?.title || "");
    }
  }, [season, episode, movie?.mediaType, resolved, fetchEpisodeInfo]);

  const resolveAndPlay = useCallback(
    async (targetSeason: number, targetEpisode: number) => {
      if (resolving || !movie) return;
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
              `[WatchPage] get-stream failed for "${base.title}" (S${targetSeason}E${targetEpisode}), using resolved source`,
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
        
        // Update URL without navigation
        const isSeries = playable.media_type === "tv";
        const newUrl = `/watch/${movie.providerId}${isSeries ? `?season=${targetSeason}&episode=${targetEpisode}&type=tv` : ""}`;
        navigate(newUrl, { replace: true });
      } catch (error) {
        const isNotFound = error instanceof StreamNotFoundError;
        console.error(
          `[WatchPage] could not resolve "${movie.title}" (${movie.year ?? "unknown year"})`,
          error
        );
        setPlayError(
          isNotFound
            ? `"${movie.title}" isn't available to stream yet.`
            : "We couldn't find a stream for this title just yet."
        );
      } finally {
        setResolving(false);
      }
    },
    [movie, resolved, resolving, navigate]
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
        const stream = await resolveStream(movie.title, movie.year, 
          movie.mediaType === "tv" ? { season, episode } : undefined
        );
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
  }, [movie?.id, movie?.title, movie?.year, movie?.mediaType, season, episode]);

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

  // Determine what to show as episode title
  const displayTitle = movie?.mediaType === "tv" && episodeDetails?.title 
    ? `${movie.title} — ${episodeDetails.title}` 
    : movie?.mediaType === "tv" 
      ? `${movie.title} — S${season} E${episode}`
      : movie?.title || "Loading...";

  // Show loading state
  if (movieLoading) {
    return (
      <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          <p className="text-white/80 font-medium text-sm tracking-wider">Loading movie...</p>
        </div>
      </div>
    );
  }

  if (!movie) {
    return (
      <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/60">Movie not found</p>
          <button onClick={() => navigate("/")} className="mt-4 text-white underline">Go Home</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      {/* Top Bar */}
      <div className="fixed top-0 left-0 right-0 z-40 h-16 bg-black/90 backdrop-blur-md border-b border-white/10 flex items-center justify-between px-4 sm:px-6">
        <button
          onClick={handleClose}
          aria-label="Close watch page"
          className="flex items-center justify-center w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="flex-1 flex items-center justify-center">
          <h1 className="text-lg font-semibold text-white truncate max-w-md px-4">{displayTitle}</h1>
        </div>
        <div className="w-10" />
      </div>

      <main className="pt-16 pb-12 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="grid lg:grid-cols-[1fr_320px] gap-6">
            {/* Main Content: Player + About */}
            <div className="lg:col-span-1 space-y-6">
              {/* Video Player */}
              <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black">
                {resolved && (
                  <VideoPlayer
                    title={displayTitle}
                    movie={resolved.stream}
                    onClose={handleClose}
                    streamUrl={resolved.stream.stream_url}
                    poster={movie.backdrop ? getImageUrl(movie.backdrop, "original") : movie.poster ? getImageUrl(movie.poster, "w780") : ""}
                    mirrors={resolved.stream.mirrors}
                    season={resolved.stream.season}
                    episode={resolved.stream.episode}
                    mediaType={resolved.stream.media_type}
                    onPlayEpisode={playEpisode}
                  />
                )}
                {!resolved && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="relative w-full h-full max-w-6xl max-h-[85vh] flex items-center justify-center">
                      <img
                        src={movie.backdrop ? getImageUrl(movie.backdrop, "original") : movie.poster ? getImageUrl(movie.poster, "w780") : ""}
                        alt={movie.title}
                        className="absolute inset-0 w-full h-full object-cover opacity-40 blur-sm"
                      />
                      <div className="relative z-20 flex flex-col items-center gap-4">
                        <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
                        <p className="text-white/80 font-medium text-sm tracking-wider">Loading stream...</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* About Section - Below Player */}
              <div className="space-y-4">
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
                  {movie.mediaType === "tv" && (
                    <span className="flex items-center gap-1 text-[#d7d7d3]">
                      <Tv className="h-3.5 w-3.5" />
                      {resolved?.stream.seasons || "?"} Seasons
                    </span>
                  )}
                </div>
                <p className="text-sm leading-6 text-[#c5c5c1]">{movie.synopsis}</p>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={play}
                  disabled={resolving}
                  className="flex-1 sm:flex-none flex items-center justify-center gap-2 rounded-md bg-[#d7d7d3] px-6 py-3 text-sm font-black text-[#0b0b0e] hover:bg-white disabled:opacity-60 transition-all active:scale-[0.98] shadow-lg shadow-[#d7d7d3]/20"
                >
                  <Play className="h-5 w-5 fill-current" />
                  {resolving ? "Loading Stream…" : "Play"}
                </button>
                <button
                  onClick={handleClose}
                  className="flex items-center gap-2 rounded-md border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
                >
                  <X className="h-4 w-4" />
                  <span>Close</span>
                </button>
                <button
                  className="flex items-center gap-2 rounded-md border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span>Comments</span>
                </button>
              </div>

              {/* Rating */}
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

              {/* Error Messages */}
              {playError && detailsLoaded && (
                <div className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs leading-5 text-[#c5c5c1]">
                  <p>{playError}</p>
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

              {/* Episode Matrix for TV Shows */}
              {resolved && resolved.stream.media_type === "tv" ? (
                <EpisodeMatrix
                  movie={resolved.stream}
                  onPlay={(ep) => playEpisode(ep.season, ep.number)}
                />
              ) : detailsLoaded ? null : (
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
              )}
            </div>

            {/* Sidebar: Season Selector + Episode Details */}
            <aside className="lg:col-span-1 hidden lg:block">
              <div className="sticky top-24 space-y-4">
                {/* Season Selector Panel */}
                {movie.mediaType === "tv" && resolved && (
                  <div className="rounded-xl border border-white/10 bg-[#121212] p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-white/80 flex items-center gap-2">
                        <Tv className="h-4 w-4" />
                        Seasons
                      </h3>
                      <button
                        onClick={() => setShowSeasonSelector(!showSeasonSelector)}
                        className="text-xs text-white/60 hover:text-white flex items-center gap-1"
                      >
                        {showSeasonSelector ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        {showSeasonSelector ? "Hide" : "Show"} All
                      </button>
                    </div>
                    
                    <div className={`space-y-2 max-h-96 overflow-y-auto transition-all duration-300 ${showSeasonSelector ? "" : "max-h-0 overflow-hidden"}`}>
                      {(() => {
                        if (!resolved.stream.episodes?.length) return [];
                        const episodes = resolved.stream.episodes;
                        const totalSeasons = resolved.stream.seasons ?? 1;
                        const perSeason = resolved.stream.episodes_per_season ?? 12;
                        const list: any[] = [];
                        if (episodes.length) {
                          episodes.forEach(ep => list.push(ep));
                        } else {
                          for (let s = 1; s <= totalSeasons; s++) {
                            for (let n = 1; n <= perSeason; n++) {
                              list.push({
                                season: s,
                                number: n,
                                title: `${resolved.stream.title} — S${s} E${n}`,
                              });
                            }
                          }
                        }
                        const grouped = new Map<number, any[]>();
                        for (const ep of list) {
                          const arr = grouped.get(ep.season) ?? [];
                          arr.push(ep);
                          grouped.set(ep.season, arr);
                        }
                        return Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]);
                      })().map(([seasonNum, list]) => (
                        <div key={seasonNum} className="space-y-1">
                          <button
                            type="button"
                            onClick={() => setShowSeasonSelector(true)}
                            className="w-full flex items-center justify-between px-3 py-2 text-left text-xs font-semibold text-white/80 hover:bg-white/5 rounded transition-colors"
                          >
                            <span>Season {seasonNum} ({list.length} episodes)</span>
                            <ChevronDown className="h-3 w-3" />
                          </button>
                          {showSeasonSelector && (
                            <ul className="ml-4 space-y-1 border-l border-white/10 pl-3 max-h-60 overflow-y-auto">
                              {list.map(ep => (
                                <li key={`${seasonNum}-${ep.number}`}>
                                  <button
                                    type="button"
                                    onClick={() => playEpisode(ep.season, ep.number)}
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors rounded ${
                                      ep.season === season && ep.number === episode
                                        ? "bg-white/10 text-white font-semibold"
                                        : "text-white/70 hover:text-white hover:bg-white/5"
                                    }`}
                                  >
                                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/15 text-[10px] font-bold tabular-nums text-white/60">
                                      {String(ep.number).padStart(2, "0")}
                                    </span>
                                    <span className="truncate">{ep.title || `Episode ${ep.number}`}</span>
                                    {ep.season === season && ep.number === episode && (
                                      <span className="ml-auto text-[10px] text-green-400">Playing</span>
                                    )}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Episode Details Panel */}
                {movie.mediaType === "tv" && episodeDetails && (
                  <div className="rounded-xl border border-white/10 bg-[#121212] p-5">
                    <h3 className="text-sm font-bold uppercase tracking-[0.18em] text-white/80 mb-4">
                      Episode Details
                    </h3>
                    {episodeDetails.still_url && (
                      <img
                        src={episodeDetails.still_url}
                        alt=""
                        className="w-full aspect-video rounded-lg object-cover mb-4 border border-white/10"
                      />
                    )}
                    {episodeDetails.overview && (
                      <p className="text-sm leading-6 text-[#c5c5c1] mb-4">{episodeDetails.overview}</p>
                    )}
                    <div className="flex flex-wrap gap-3 text-[11px] text-white/50">
                      {episodeDetails.air_date && (
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {episodeDetails.air_date}</span>
                      )}
                      {episodeDetails.runtime && (
                        <span className="flex items-center gap-1">⏱ {episodeDetails.runtime}min</span>
                      )}
                      {episodeDetails.vote_average && (
                        <span className="flex items-center gap-1"><Star className="h-3 w-3 fill-current" /> {episodeDetails.vote_average.toFixed(1)}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}