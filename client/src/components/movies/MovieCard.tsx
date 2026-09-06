import { Bookmark, Check, Play, Star } from "lucide-react";
import type { Movie } from "./types";

interface MovieCardProps {
  movie: Movie;
  saved: boolean;
  onSelect: () => void;
  onSave: () => void;
}

/**
 * Compact poster card shown inside a horizontally scrolling `MovieRow`.
 * Renders the poster (or an "artwork unavailable" placeholder), the score
 * badge, and a bookmark toggle that is only revealed on hover.
 */
export function MovieCard({ movie, saved, onSelect, onSave }: MovieCardProps) {
  return (
    <article className="catalog-card group">
      <button onClick={onSelect} className="relative block w-full text-left">
        <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-[#1a1a1f]">
          {movie.poster ? (
            <img
              loading="lazy"
              decoding="async"
              src={movie.poster}
              alt={movie.title}
              className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.04]"
            />
          ) : (
            <div className="grid h-full place-items-center p-3 text-center text-xs text-[#77777d]">
              Artwork unavailable
            </div>
          )}
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
        <p className="mt-1 text-[10px] text-[#89898e]">
          {movie.year ?? "Year unavailable"} ·{" "}
          {movie.genre[0] ?? "Genre unavailable"}
        </p>
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
