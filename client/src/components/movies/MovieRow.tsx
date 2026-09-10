import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Movie } from "./types";
import { MovieCard } from "./MovieCard";
import { MovieGrid } from "./MovieGrid";
import { SkeletonMovieCard } from "./SkeletonMovieCard";
import { useInView } from "@/hooks/useInView";
import { ErrorBoundary, ErrorFallback } from "@/components/ErrorBoundary";

interface MovieRowProps {
  title: string;
  items: Movie[];
  savedIds: number[];
  onSelect: (movie: Movie) => void;
  onSave: (movie: Movie) => void;
  eyebrow?: string;
  /** If true, render as responsive grid instead of horizontal scroll */
  grid?: boolean;
  /** Row index for staggered loading */
  rowIndex?: number;
}

function MovieCardWrapper({
  movie,
  saved,
  onPlay,
  onSave,
}: {
  movie: Movie;
  saved: boolean;
  onPlay: () => void;
  onSave: () => void;
}) {
  const [retryKey, setRetryKey] = useState(0);

  return (
    <ErrorBoundary
      key={retryKey}
      fallback={<ErrorFallback retry={() => setRetryKey(k => k + 1)} />}
    >
      <MovieCard movie={movie} saved={saved} onPlay={onPlay} onSave={onSave} />
    </ErrorBoundary>
  );
}

/**
 * A titled shelf of `MovieCard`s with lazy loading via Intersection Observer.
 * Rows below the fold load only when they enter the viewport.
 * Each card is wrapped in an ErrorBoundary to prevent cascade failures.
 */
export function MovieRow({
  title,
  items,
  savedIds,
  onSelect,
  onSave,
  eyebrow,
  grid = false,
  rowIndex = 0,
}: MovieRowProps) {
  if (!items?.length) return null;

  const { ref, isInView } = useInView({
    threshold: 0.1,
    rootMargin: "200px",
    triggerOnce: true,
  });

  // Show skeleton while not in view, real content when in view
  const renderContent = () => {
    if (grid) {
      return (
        <MovieGrid>
          {items.map((movie, index) => (
            <MovieCardWrapper
              key={`${title}-${movie.id}-${index}`}
              movie={movie}
              saved={savedIds?.includes(movie.id) ?? false}
              onPlay={() => onSelect(movie)}
              onSave={() => onSave(movie)}
            />
          ))}
        </MovieGrid>
      );
    }

    return (
      <div className="catalog-row">
        {items.map((movie, index) => (
          <MovieCardWrapper
            key={`${title}-${movie.id}-${index}`}
            movie={movie}
            saved={savedIds?.includes(movie.id) ?? false}
            onPlay={() => onSelect(movie)}
            onSave={() => onSave(movie)}
          />
        ))}
      </div>
    );
  };

  const renderSkeleton = () => {
    if (grid) {
      return (
        <MovieGrid>
          {items.map((_, index) => (
            <SkeletonMovieCard key={`${title}-skeleton-${index}`} />
          ))}
        </MovieGrid>
      );
    }

    return (
      <div className="catalog-row">
        {items.map((_, index) => (
          <SkeletonMovieCard key={`${title}-skeleton-${index}`} />
        ))}
      </div>
    );
  };

  return (
    <section ref={ref} className="mb-10 lg:mb-12">
      <div className="mb-4 flex items-end justify-between px-2 sm:px-0">
        <div>
          {eyebrow && (
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90]">
              {eyebrow}
            </p>
          )}
          <h2 className="text-lg font-bold tracking-tight text-[#f1f1ee] sm:text-xl">
            {title}
          </h2>
        </div>
        {!grid && (
          <button className="hidden items-center gap-1 text-xs font-semibold text-[#99999e] hover:text-white sm:flex">
            View all <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {isInView ? renderContent() : renderSkeleton()}
    </section>
  );
}
