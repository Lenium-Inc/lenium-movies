import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Play, Film, Tv } from "lucide-react";
import { Link, useLocation } from "wouter";
import type { Movie } from "@/components/movies/types";
import { fetchTrailer, type TrailerInfo } from "@/services/api";
import { TrailerEmbed } from "@/components/movies/MediaCard";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

interface HeroProps {
  items: readonly Movie[];
  savedIds?: ReadonlyArray<Movie["id"]>;
  onSave?: (movie: Movie) => void;
  rotateSeconds?: number;
}

function getBackdropUrl(backdrop: string | null | undefined): string | null {
  if (!backdrop) return null;
  if (backdrop.startsWith("http")) return backdrop;
  return `${TMDB_IMAGE_BASE_URL}/original${backdrop}`;
}

function formatRuntime(minutes: string | number | undefined): string {
  if (!minutes) return "";
  const mins =
    typeof minutes === "string" ? parseInt(minutes.replace("m", "")) : minutes;
  if (isNaN(mins)) return "";
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return hours > 0 ? `${hours}h ${remainingMins}m` : `${remainingMins}m`;
}

function formatRating(score: number | null): string {
  if (score === null || score === undefined) return "";
  return score.toFixed(1);
}

const EASE = [0.32, 0.72, 0, 1] as const;

export function Hero({
  items,
  savedIds = [],
  onSave,
  rotateSeconds = 8,
}: HeroProps) {
  const [, navigate] = useLocation();
  const count = items.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [trailerLoading, setTrailerLoading] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trailerCacheRef = useRef(
    new Map<string, Promise<TrailerInfo | null>>()
  );

  useEffect(() => {
    if (count === 0) return;
    if (index >= count) setIndex(0);
  }, [count, index]);

  useEffect(() => {
    if (count < 2 || paused || rotateSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setIndex(i => (i + 1) % count);
    }, rotateSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [count, paused, rotateSeconds]);

  const current: Movie | undefined = count > 0 ? items[index] : undefined;
  const saved = current ? savedIds.includes(current.id) : false;

  const backdropUrl = getBackdropUrl(current?.backdrop);

  const loadTrailer = useCallback(async (movie: Movie) => {
    if (!movie) return;
    let pending = trailerCacheRef.current.get(String(movie.id));
    if (!pending) {
      pending = fetchTrailer(movie.title, movie.year).catch(() => null);
      trailerCacheRef.current.set(String(movie.id), pending);
    }
    setTrailerLoading(true);
    try {
      const info = await pending;
      if (info) setTrailer(info);
    } finally {
      setTrailerLoading(false);
    }
  }, []);

  const handleMouseEnter = useCallback(
    (movie: Movie) => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = setTimeout(() => {
        loadTrailer(movie);
        setShowTrailer(true);
      }, 800);
    },
    [loadTrailer]
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setShowTrailer(false);
    setTrailer(null);
  }, []);

  const handlePlay = (movie: Movie) => {
    if (!movie.providerId) {
      console.warn("[Hero] No providerId for movie:", movie.title);
      return;
    }
    const tmdbId = parseInt(movie.providerId, 10);
    if (isNaN(tmdbId)) {
      console.warn("[Hero] Invalid TMDB ID:", movie.providerId);
      return;
    }
    navigate(`/watch/${tmdbId}`);
  };

  const goToPrevious = () => {
    setIndex(i => (i - 1 + count) % count);
    setShowTrailer(false);
    setTrailer(null);
  };

  const goToNext = () => {
    setIndex(i => (i + 1) % count);
    setShowTrailer(false);
    setTrailer(null);
  };

  return (
    <section
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="Featured spotlight"
      className="relative isolate -mx-4 h-[560px] w-[calc(100%+2rem)] overflow-hidden bg-[#050505] sm:-mx-6 sm:w-[calc(100%+3rem)] sm:h-[600px] lg:-mx-8 lg:w-[calc(100%+4rem)] lg:h-[660px]"
    >
      {/* Cross-fading media layer */}
      <div className="absolute inset-0">
        <div
          className="absolute inset-0 transition-opacity duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]"
          style={{ opacity: showTrailer && trailer ? 0 : 1 }}
        >
          {current ? (
            <div
              key={current.id}
              className="absolute inset-0 animate-[kenburns_20s_ease-in-out_infinite]"
            >
              {backdropUrl ? (
                <>
                  {/* Ambient Canvas Glow Effect - Netflix-style backdrop glow */}
                  <div
                    aria-hidden
                    className="absolute -inset-4 bg-gradient-to-r from-purple-600/30 via-pink-600/20 to-amber-500/30 rounded-3xl blur-3xl opacity-60 -z-10 pointer-events-none transition-all duration-700"
                  />
                  <img
                    src={backdropUrl}
                    alt=""
                    loading="eager"
                    fetchPriority="high"
                    className="h-full w-full object-cover object-[center_22%]"
                  />
                </>
              ) : (
                <div className="h-full w-full bg-[linear-gradient(160deg,#1B1B20_0%,#0A0A0A_55%,#050505_100%)]" />
              )}
            </div>
          ) : (
            <div className="absolute inset-0 bg-[linear-gradient(160deg,#1B1B20_0%,#0A0A0A_55%,#050505_100%)]" />
          )}
        </div>

        {/* Trailer overlay */}
        {showTrailer && trailer && (
          <div className="absolute inset-0 z-10 bg-black/90 flex items-center justify-center">
            <div className="relative w-full max-w-5xl h-[80vh] max-h-[600px]">
              <TrailerEmbed provider={trailer.provider} id={trailer.id} />
            </div>
          </div>
        )}
      </div>

      {/* Gradient architecture into void black */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_130%_110%_at_62%_-12%,transparent_0%,rgba(5,5,5,0.30)_40%,#050505_80%)]"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-[linear-gradient(90deg,#050505_0%,rgba(5,5,5,0.80)_44%,rgba(5,5,5,0.20)_72%,transparent_100%)]"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-48 bg-[linear-gradient(180deg,transparent_0%,#050505_92%)]"
      />

      {/* Side Chevron Navigation - Far left and right edges */}
      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous featured title"
            onClick={goToPrevious}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-20 grid h-12 w-12 place-items-center rounded-full border border-white/15 bg-black/40 text-white/70 backdrop-blur-md transition hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-95 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            aria-label="Next featured title"
            onClick={goToNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-20 grid h-12 w-12 place-items-center rounded-full border border-white/15 bg-black/40 text-white/70 backdrop-blur-md transition hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-95 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Cross-fading content block */}
      <div className="absolute inset-0 z-10 flex items-center px-5 pb-16 sm:px-8 lg:px-14">
        <div className="max-w-2xl w-full">
          {current ? (
            <div
              key={current.id}
              className="animate-[fadeInUp_0.5s_cubic-bezier(0.32,0.72,0,1)_forwards]"
            >
              {/* Title */}
              <h1 className="text-4xl font-black leading-[0.95] tracking-[-0.03em] text-[#FFFFFF] drop-shadow-[0_4px_24px_rgba(0,0,0,0.8)] sm:text-5xl lg:text-6xl xl:text-7xl">
                {current.title}
              </h1>

              {/* Consolidated Inline Metadata Row */}
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                {current.year ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                    {current.year}
                  </span>
                ) : null}
                {current.runtime && (
                  <>
                    <span className="text-[10px] text-white/40">·</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300 backdrop-blur-sm">
                      <Film className="h-3 w-3" />
                      {formatRuntime(current.runtime)}
                    </span>
                  </>
                )}
                {current.vote_average && current.vote_average > 0 && (
                  <>
                    <span className="text-[10px] text-white/40">·</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-bold text-amber-400 backdrop-blur-sm">
                      <Play className="h-3 w-3 fill-current" />
                      {formatRating(current.vote_average)}
                      <span className="text-white/50">TMDB</span>
                    </span>
                  </>
                )}
                {current.genres?.length && (
                  <>
                    <span className="text-[10px] text-white/40">·</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300 backdrop-blur-sm">
                      {current.genres.slice(0, 3).join(", ")}
                    </span>
                  </>
                )}
              </div>

              {/* Plot Overview / Synopsis */}
              {current.synopsis ? (
                <p className="mt-4 line-clamp-3 max-w-2xl text-base leading-7 text-zinc-300">
                  {current.synopsis}
                </p>
              ) : null}

              {/* Action Buttons - Only Play and My List */}
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => handlePlay(current)}
                  className="inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-sm font-semibold transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white bg-white font-black text-black ring-1 ring-inset ring-white/40 shadow-[0_16px_40px_rgba(0,0,0,0.6)] hover:bg-white/95 hover:shadow-[0_20px_48px_rgba(0,0,0,0.7)] active:scale-[0.97] active:shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                >
                  <Play className="h-5 w-5" />
                  Play
                </button>
                <button
                  type="button"
                  onClick={() => onSave?.(current)}
                  className="inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-sm font-semibold transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white border-2 border-white/20 bg-black/30 text-white backdrop-blur-md hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-[0.97] active:border-white/50"
                >
                  {saved ? (
                    <Film className="h-5 w-5 fill-current" />
                  ) : (
                    <Film className="h-5 w-5" />
                  )}
                  {saved ? "In My Library" : "My Library"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Rotation indicators */}
      {count > 1 && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5">
          {Array.from({ length: Math.min(count, 8) }, (_, dot) => {
            const active = count > 8 ? index % 8 === dot : index === dot;
            return (
              <button
                key={dot}
                type="button"
                aria-label={`Show slide ${dot + 1}`}
                onClick={() =>
                  setIndex(current =>
                    count > 8 ? current - (current % 8) + dot : dot
                  )
                }
                className={`h-1 rounded-full transition-all duration-300 ${
                  active
                    ? "w-6 bg-white"
                    : "w-1.5 bg-white/30 hover:bg-white/60"
                }`}
              />
            );
          })}
        </div>
      )}

      {/* Per-slide rotation progress */}
      {count > 1 && rotateSeconds > 0 && (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-10 h-[3px] bg-white/10"
        >
          <div
            key={index}
            className="fs-progress h-full bg-white"
            style={{
              animationDuration: `${rotateSeconds}s`,
              animationPlayState: paused ? "paused" : "running",
            }}
          />
        </div>
      )}
    </section>
  );
}
