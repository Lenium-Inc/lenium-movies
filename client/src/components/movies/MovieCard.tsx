import { useEffect, useRef, useState } from "react";
import { Bookmark, Check, Play, Star } from "lucide-react";
import { fetchTrailer, type TrailerInfo } from "@/services/api";
import { getSettings } from "@/services/settings";
import { TrailerEmbed } from "./MediaCard";
import type { Movie } from "./types";

interface MovieCardProps {
  movie: Movie;
  saved: boolean;
  onSelect: () => void;
  onSave: () => void;
}

/**
 * Official trailers resolve at most once per title for the whole session and
 * are shared across every card instance, so repeated hovers never re-hit the
 * TMDB-backed endpoint.
 */
const trailerCache = new Map<string, Promise<TrailerInfo | null>>();

/**
 * Compact poster card shown inside a horizontally scrolling `MovieRow`.
 * Renders the poster (or a quiet title monogram when artwork is missing),
 * the score badge, and a bookmark toggle that is only revealed on hover.
 *
 * When the viewer's `autoplayPreviews` preference is enabled, hover is staged
 * with a 300ms timer: the poster cross-fades into the title's official looping
 * trailer (a preview, never the film itself) embedded via a privacy-safe
 * `youtube-nocookie`/Dailymotion iframe; without a trailer it falls back to a
 * gentle scale-zoom of the backdrop, then of the poster — so every card answers
 * hover identically, and nothing plays when the preference is off.
 */
export function MovieCard({ movie, saved, onSelect, onSave }: MovieCardProps) {
  const [peeked, setPeeked] = useState(false);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const timer = useRef<number | null>(null);
  const trailerRequested = useRef(false);

  const meta = [movie.year, movie.genre[0]].filter(Boolean).join(" · ");
  const cacheKey = movie.providerId ?? `${movie.source}-${movie.id}`;

  useEffect(() => {
    setPeeked(false);
    setTrailer(null);
    trailerRequested.current = false;
  }, [cacheKey]);

  useEffect(() => {
    if (!peeked || trailerRequested.current || trailer) return;
    trailerRequested.current = true;
    let alive = true;
    trailerCache
      .get(cacheKey)
      ?.then(info => {
        if (alive) setTrailer(info);
      })
      .catch(() => {
        /* keep the poster/backdrop fallback */
      });
    return () => {
      alive = false;
    };
  }, [peeked, trailer, cacheKey]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const handleEnter = () => {
    if (!getSettings().autoplayPreviews) return;
    if (timer.current !== null) return;
    const pending = trailerCache.get(cacheKey) ?? fetchTrailer(movie.title, movie.year);
    trailerCache.set(cacheKey, pending);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setPeeked(true);
    }, 300);
  };

  const handleLeave = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setPeeked(false);
  };

  return (
    <article className="catalog-card group" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button onClick={onSelect} className="relative block w-full text-left">
        <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-[#1a1a1f]">
          {movie.poster ? (
            <img
              loading="lazy"
              decoding="async"
              src={movie.poster}
              alt={movie.title}
              className={`h-full w-full object-cover transition-[opacity,transform] duration-200 ${
                peeked ? "opacity-0" : "group-hover:scale-[1.04]"
              }`}
            />
          ) : (
            <div className="grid h-full place-items-center text-3xl font-black text-white/15">
              {movie.title.charAt(0).toUpperCase()}
            </div>
          )}
          {peeked && trailer ? (
            <TrailerEmbed provider={trailer.provider} id={trailer.id} />
          ) : null}
          {peeked && !trailer && movie.backdrop ? (
            <img
              src={movie.backdrop.replace("/w780/", "/w1280/")}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
          {movie.score !== null && (
            <span className="absolute bottom-2 left-2 flex items-center gap-1 text-[10px] font-bold text-white">
              <Star className="h-3 w-3 fill-[#d7d7d3] text-[#d7d7d3]" />
              {movie.score}
            </span>
          )}
          <span className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white opacity-0 transition group-hover:opacity-100">
            <Play className="h-3 w-3 fill-current" />
          </span>
        </div>
        <h3 className="mt-2 line-clamp-1 text-xs font-semibold text-[#eeeeeb]">
          {movie.title}
        </h3>
        {meta && <p className="mt-1 text-[10px] text-[#89898e]">{meta}</p>}
      </button>
      <button
        onClick={onSave}
        aria-label={
          saved ? `Remove ${movie.title}` : `Add ${movie.title} to My List`
        }
        className={`absolute right-2 top-2 rounded-full p-1.5 backdrop-blur transition ${
          saved
            ? "bg-[#d7d7d3] text-[#0b0b0e]"
            : "bg-black/55 text-white opacity-0 group-hover:opacity-100"
        }`}
      >
        {saved ? (
          <Check className="h-3 w-3" />
        ) : (
          <Bookmark className="h-3 w-3" />
        )}
      </button>
    </article>
  );
}