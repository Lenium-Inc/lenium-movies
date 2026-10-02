import { useState } from "react";
import { Star } from "lucide-react";
import { ErrorBoundary, ErrorFallback } from "@/components/ErrorBoundary";
import { MovieCard } from "./MovieCard";
import { RowScroller } from "./RowScroller";
import type { Movie } from "./types";

interface Top10RowProps {
  title: string;
  items: Movie[];
  savedIds?: number[];
  onSelect: (movie: Movie) => void;
  onSave?: (movie: Movie) => void;
  loading?: boolean;
}

/**
 * A ranked shelf: poster, then a numeral, then the title.
 *
 * The numeral is the reason this exists. On a plain shelf, ten cards in a row are
 * ten interchangeable tiles and the only thing distinguishing them is reading
 * every title; a rank that is rendered *before* each card turns the same ten
 * tiles into an ordered list you can read without the titles.
 *
 * The number is drawn as text with a stroke rather than as an image or a font
 * icon: it has to scale with the card, stay crisp at any zoom, and cost no
 * request. It sits outside the card's own click target, so the rank can never
 * intercept a tap meant for the film.
 */
export const Top10Row: React.FC<Top10RowProps> = ({
  title,
  items,
  savedIds = [],
  onSelect,
  onSave,
  loading = false,
}) => {
  if (loading) {
    return (
      <section>
        <h2 className="mb-3 px-1 text-lg font-semibold text-white">{title}</h2>
        <div className="flex gap-3 overflow-hidden" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-64 w-40 shrink-0 animate-pulse rounded-xl bg-white/5"
            />
          ))}
        </div>
      </section>
    );
  }

  if (!items.length) return null;

  return (
    <section>
      <h2 className="mb-3 px-1 text-lg font-semibold text-white">{title}</h2>
      <RowScroller label={title} className="catalog-row-top10">
        {items.slice(0, 10).map((movie, index) => (
          <RankedItem
            key={`${movie.id}-${index}`}
            rank={index + 1}
            movie={movie}
            saved={savedIds.includes(movie.id)}
            onPlay={() => onSelect(movie)}
            onSave={onSave}
          />
        ))}
      </RowScroller>
    </section>
  );
};

function RankedItem({
  rank,
  movie,
  saved,
  onPlay,
  onSave,
}: {
  rank: number;
  movie: Movie;
  saved: boolean;
  onPlay: () => void;
  onSave?: (movie: Movie) => void;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const score = movie.vote_average ?? movie.score ?? null;

  return (
    <div className="flex items-end">
      <span
        /* aria-hidden, because the rank is already conveyed by position: this is
           the third item in a list of ten, and a screen reader announces that
           without help. Exposing the numeral too would read a bare "3" before
           every title, which is noise dressed up as information. */
        className="mr-1 select-none pr-1 font-display text-[7rem] font-black leading-[0.72] tracking-tighter text-transparent [-webkit-text-stroke:2px_rgba(255,255,255,0.42)]"
        aria-hidden
      >
        {rank}
      </span>

      <ErrorBoundary
        key={retryKey}
        fallback={<ErrorFallback retry={() => setRetryKey(k => k + 1)} />}
      >
        <div className="w-40 shrink-0">
          <MovieCard
            movie={movie}
            saved={saved}
            onPlay={onPlay}
            onSave={onSave}
            variant="score"
          />
          {/* Text under the artwork, because a ranked card's title is part of the
              ranking: reading "1, 2, 3" only works if each numeral is paired with
              the name it belongs to. */}
          <h3 className="mt-2 line-clamp-2 text-xs font-medium leading-tight text-zinc-300">
            {movie.title}
          </h3>
          <p className="mt-1 flex items-center gap-2 text-[10px] font-medium text-zinc-500">
            {movie.year ? <span>{movie.year}</span> : null}
            {movie.genre?.[0] ? <span>{movie.genre[0]}</span> : null}
            {score != null ? (
              <span className="flex items-center gap-0.5 text-amber-400">
                <Star className="h-2.5 w-2.5 fill-current" />
                {score.toFixed(1)}
              </span>
            ) : null}
          </p>
        </div>
      </ErrorBoundary>
    </div>
  );
}

export default Top10Row;
