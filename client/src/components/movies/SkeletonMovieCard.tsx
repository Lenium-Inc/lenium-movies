/**
 * Skeleton placeholder matching the MovieCard layout.
 * Used for initial catalog load, genre switching, and search loading states.
 *
 * The card is the poster alone now -- the caption is overlaid on the artwork
 * rather than sitting in a block beneath it -- so the skeleton is a bare 2:3
 * tile at the same radius. The old two grey bars here stood in for a title
 * block that no longer exists and made the grid jump on load.
 */
export function SkeletonMovieCard() {
  return (
    <article className="movie-card">
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-[#1a1a1f]">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a1f] to-[#121214] animate-pulse" />
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
