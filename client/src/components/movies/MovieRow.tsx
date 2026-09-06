import { ChevronRight } from "lucide-react";
import type { Movie } from "./types";
import { MovieCard } from "./MovieCard";

interface MovieRowProps {
  title: string;
  items: Movie[];
  savedIds: number[];
  onSelect: (movie: Movie) => void;
  onSave: (movie: Movie) => void;
  eyebrow?: string;
}

/**
 * A titled, horizontally scrollable shelf of `MovieCard`s. Renders nothing
 * when the shelf has no movies, so empty catalog views stay clean.
 */
export function MovieRow({
  title,
  items,
  savedIds,
  onSelect,
  onSave,
  eyebrow,
}: MovieRowProps) {
  if (!items.length) return null;
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-end justify-between">
        <div>
          {eyebrow && (
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90]">
              {eyebrow}
            </p>
          )}
          <h2 className="text-lg font-bold tracking-tight text-[#f1f1ee] sm:text-xl">
            {title}
          </h2>
        </div>
        <button className="hidden items-center gap-1 text-xs font-semibold text-[#99999e] hover:text-white sm:flex">
          View all <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="catalog-row">
        {items.map(movie => (
          <MovieCard
            key={`${title}-${movie.id}`}
            movie={movie}
            saved={savedIds.includes(movie.id)}
            onSelect={() => onSelect(movie)}
            onSave={() => onSave(movie)}
          />
        ))}
      </div>
    </section>
  );
}
