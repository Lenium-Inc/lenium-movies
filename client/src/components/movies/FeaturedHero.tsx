import { Bookmark, Star } from "lucide-react";
import type { Movie } from "./types";

interface FeaturedHeroProps {
  movie: Movie;
  onSelect: () => void;
  onSave: () => void;
}

/** Large edge-to-edge backdrop hero for the single featured movie on home. */
export function FeaturedHero({ movie, onSelect, onSave }: FeaturedHeroProps) {
  return (
    <section className="relative mt-5 h-[270px] overflow-hidden rounded-xl border border-white/10 bg-[#151519] sm:h-[315px] lg:h-[350px]">
      {movie.backdrop && (
        <img
          loading="eager"
          fetchPriority="high"
          src={movie.backdrop}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-50"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-[#0b0b0e] via-[#0b0b0e]/80 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0e]/80 via-transparent to-transparent" />
      <div className="relative flex h-full max-w-xl flex-col justify-end p-5 pb-6 sm:p-8">
        <span className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#d7d7d3]">
          Featured from TMDB
        </span>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {movie.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#d0d0cc]">
          <span>{movie.year ?? "Year unavailable"}</span>
          <span>·</span>
          <span>{movie.runtime}</span>
          <span>·</span>
          <span>{movie.genre.join(" · ")}</span>
          {movie.score !== null && (
            <span className="flex items-center gap-1 text-[#d7d7d3]">
              <Star className="h-3.5 w-3.5 fill-current" />
              {movie.score}
            </span>
          )}
        </div>
        <p className="mt-2 line-clamp-2 max-w-lg text-sm leading-5 text-[#c0c0bd]">
          {movie.synopsis}
        </p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={onSelect}
            className="flex items-center gap-2 rounded-md bg-[#d7d7d3] px-4 py-2.5 text-xs font-bold text-[#0b0b0e] hover:bg-white"
          >
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-current text-[9px]">
              i
            </span>
            Details
          </button>
          <button
            onClick={onSave}
            className="flex items-center gap-2 rounded-md border border-white/20 px-4 py-2.5 text-xs font-semibold hover:bg-white/10"
          >
            <Bookmark className="h-3.5 w-3.5" /> My List
          </button>
        </div>
      </div>
    </section>
  );
}
