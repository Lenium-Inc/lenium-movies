/**
 * Skeleton placeholder matching the MovieCard layout.
 * Used for initial catalog load, genre switching, and search loading states.
 *
 * The card is the poster alone now -- the caption is overlaid on the artwork
 * rather than sitting in a block beneath it -- so the skeleton is a bare 2:3
 * tile at the same radius. The old two grey bars here stood in for a title
 * block that no longer exists and made the grid jump on load.
 *
 * `skeleton-sheen` rather than `animate-pulse`: a pulsing block only tells you
 * something is loading, while a sheen travelling across the tile tells you the
 * *shape* of what is coming, so the grid does not reflow when real posters
 * replace it. The class is the one `MediaCard` already uses for its own
 * skeleton, which is what keeps every loading state on this page identical
 * instead of each row inventing its own animation.
 */
export function SkeletonMovieCard() {
  return (
    <article className="movie-card" aria-hidden="true">
      <div className="skeleton-sheen relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-[#1a1a1f]" />
    </article>
  );
}

/**
 * Skeleton grid with configurable count for loading states.
 *
 * The breakpoints mirror `MovieGrid` exactly. Two grids that disagree by one
 * column are the whole reason a loading state ends up visibly wider than the
 * loaded state and the page jumps on the transition.
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
    <div className="catalog-row" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonMovieCard key={i} />
      ))}
    </div>
  );
}

/**
 * Skeleton for a grouped episode column -- a 16:9 still under a one-line title,
 * which is what `EpisodeCard` renders. Without this the "New Episodes" shelf
 * simply did not exist while its request was in flight, so the page appeared to
 * have no such category and then grew one underneath the viewer.
 */
export function SkeletonEpisodeColumn() {
  return (
    <div className="w-64 shrink-0" aria-hidden="true">
      <div className="skeleton-sheen mb-2 h-3 w-28 rounded-full bg-[#1a1a1f]" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-sheen relative aspect-video w-full overflow-hidden rounded-lg bg-[#1a1a1f]"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A whole grouped shelf's worth of episode columns.
 *
 * Three columns rather than one because the real shelf shows several shows
 * side by side; one would land and then fan out, which is the jump this is
 * supposed to prevent.
 */
export function SkeletonEpisodeShelf({ columns = 3 }: { columns?: number }) {
  return (
    <div className="catalog-row" aria-hidden="true">
      {Array.from({ length: columns }).map((_, i) => (
        <SkeletonEpisodeColumn key={i} />
      ))}
    </div>
  );
}
