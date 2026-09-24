/**
 * Available catalog views. The public navigation is simplified to four core
 * destinations (Home, Explore, Trending, Shows); the extra views are internal
 * row modes kept for the catalogue engine.
 */
export type View =
  | "home"
  | "movies"
  | "tv"
  | "trending"
  | "my-list"
  | "new"
  | "popular"
  | "genres"
  | "collections";