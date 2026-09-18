/**
 * Skeleton placeholder matching the MovieCard layout.
 * Used for initial catalog load, genre switching, and search loading states.
 */
export function SkeletonMovieCard() {
  return (
    <article className="catalog-card group">
      <div className="relative aspect-[2/3] overflow-hidden rounded-md bg-[#1a1a1f]">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a1f] to-[#121214] animate-pulse" />
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="h-3 w-3/4 bg-[#1a1a1f] rounded animate-pulse" />
        <div className="h-2 w-1/2 bg-[#1a1a1f] rounded animate-pulse" />
      </div>
    </article>
  );
}

/**
 * Skeleton grid with configurable count for loading states.
 */
export function SkeletonMovieGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonMovieCard key={i} />
      ))}
    </div>
  );
}

/**
 * Skeleton row for horizontal scrolling shelves.
 */
export function SkeletonMovieRow({ count = 8 }: { count?: number }) {
  return (
    <div className="catalog-row">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonMovieCard key={i} />
      ))}
    </div>
  );
}
