import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CloudOff } from "lucide-react";
import type { Movie } from "./types";
import { MovieCard } from "./MovieCard";
import { MovieGrid } from "./MovieGrid";
import { SkeletonMovieGrid } from "./SkeletonMovieCard";
import { DISCOVER_PAGE_SIZE } from "@/hooks/useCatalog";
import { ErrorBoundary, ErrorFallback } from "@/components/ErrorBoundary";

interface InfiniteMovieGridProps {
  items: Movie[];
  savedIds: number[];
  onSelect: (movie: Movie) => void;
  onSave: (movie: Movie) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  /** First page still loading (grid not initialized yet). */
  initialLoading: boolean;
  /** Next page being fetched — renders the skeleton loader at the bottom. */
  loadingMore: boolean;
  error?: string | null;
  /** The feed was throttled upstream, which is not a failure state. */
  rateLimited?: boolean;
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
 * The infinite-scroll media grid backing Explore / Shows / Trending.
 *
 * A sentinel div sits after the last tile and is watched by an Intersection
 * Observer: as soon as it nears the viewport the next catalog page is fetched
 * and appended, so the shelf keeps growing as the user scrolls. While the next
 * page is in flight a skeleton grid renders at the bottom, keeping the list
 * visually continuous with zero layout jumps.
 */
export function InfiniteMovieGrid({
  items,
  savedIds,
  onSelect,
  onSave,
  onLoadMore,
  hasMore,
  initialLoading,
  loadingMore,
  error,
  rateLimited,
}: InfiniteMovieGridProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || initialLoading || loadingMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onLoadMoreRef.current();
      },
      { root: null, rootMargin: "700px 0px 400px 0px", threshold: 0.01 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, initialLoading, loadingMore, items.length]);

  if (initialLoading && items.length === 0) {
    return <SkeletonMovieGrid count={DISCOVER_PAGE_SIZE} />;
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-6 py-16 text-center">
        {rateLimited ? (
          <CloudOff className="h-6 w-6 text-white/30" />
        ) : (
          <AlertTriangle className="h-6 w-6 text-white/30" />
        )}
        <p className="text-sm text-[#99999d]">
          {error ||
            (rateLimited
              ? "Catching our breath — the movie database is rate-limiting us. This clears in a moment."
              : "Nothing to show for this filter yet.")}
        </p>
      </div>
    );
  }

  return (
    <div aria-busy={loadingMore}>
      <MovieGrid>
        {items.map((movie, index) => (
          <MovieCardWrapper
            key={`${movie.id}-${movie.providerId}-${index}`}
            movie={movie}
            saved={savedIds?.includes(movie.id) ?? false}
            onPlay={() => onSelect(movie)}
            onSave={() => onSave(movie)}
          />
        ))}
      </MovieGrid>

      {/* Continuous skeleton row rendered while the next batch is fetched */}
      {loadingMore && (
        <div className="mt-8">
          <SkeletonMovieGrid count={DISCOVER_PAGE_SIZE} />
        </div>
      )}

      {hasMore && !loadingMore ? (
        <div ref={sentinelRef} aria-hidden className="h-px" />
      ) : null}

      {!hasMore && (
        <p className="mt-12 text-center text-xs font-medium uppercase tracking-[0.18em] text-white/25">
          You've reached the end of the catalogue
        </p>
      )}
    </div>
  );
}