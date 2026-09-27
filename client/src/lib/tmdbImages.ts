/**
 * TMDB serves one rendition per URL and encodes which one in a path segment:
 *
 *   https://image.tmdb.org/t/p/w500/<hash>.jpg
 *
 * The backend bakes a fixed size into the string it stores, so every call site
 * that wants a *different* rendition has to rewrite that segment. The old
 * guard for this was `if (url.startsWith("http")) return url`, which is always
 * true for backend data -- so the "upgrade the hero to `original`" branches
 * never ran and the landing image silently rendered at the stored w1280. That
 * is the softness these helpers exist to remove.
 */

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export type TmdbImageSize =
  | "w92"
  | "w154"
  | "w185"
  | "w342"
  | "w500"
  | "w780"
  | "w1280"
  | "original";

/** Matches a fully-qualified TMDB image URL, capturing everything after the
 *  size segment (leading slash included) so it can be re-spliced. */
const TMDB_IMAGE_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/[a-z0-9_]+(\/.*)$/i;

/** Intrinsic width of each fixed rendition, used as the `w` descriptor in a
 *  srcset. `original` is deliberately absent: its width is unknown until the
 *  image is fetched, and a srcset descriptor has to be a real pixel count, so
 *  it belongs in `src` rather than in the candidate list. */
const TMDB_IMAGE_WIDTH: Record<Exclude<TmdbImageSize, "original">, number> = {
  w92: 92,
  w154: 154,
  w185: 185,
  w342: 342,
  w500: 500,
  w780: 780,
  w1280: 1280,
};

export function isTmdbImageUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && TMDB_IMAGE_URL.test(value);
}

/**
 * Re-point an existing TMDB URL at a different rendition. Anything that is not
 * a TMDB image (an Archive.org `__ia_thumb.jpg`, a placeholder service) is
 * returned untouched, because those have no size segment to swap.
 */
export function tmdbImageAtSize(
  url: string | null | undefined,
  size: TmdbImageSize
): string {
  if (!url) return "";
  const match = TMDB_IMAGE_URL.exec(url);
  if (!match) return url;
  return `${TMDB_IMAGE_BASE}/${size}${match[1]}`;
}

/**
 * Normalise either a bare TMDB path ("/abc.jpg", which some callers still
 * hold) or a full URL into a full URL at the requested rendition.
 */
export function tmdbImage(
  value: string | null | undefined,
  size: TmdbImageSize
): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return tmdbImageAtSize(value, size);
  if (value.startsWith("/")) return `${TMDB_IMAGE_BASE}/${size}${value}`;
  return value;
}

/**
 * Build a srcset so the browser can pick the smallest rendition that still
 * covers the real painted size at the device's pixel ratio. A catalogue tile
 * is ~150-240 CSS px wide, so w342 is enough at 1x and w780 at 3x -- asking for
 * `original` unconditionally would ship a full-resolution poster for a
 * thumbnail and is the difference between a snappy grid and a stalled one.
 *
 * Returns undefined for non-TMDB URLs, which lets the caller omit the
 * attribute entirely instead of emitting a srcset with a single candidate.
 */
export function tmdbSrcSet(
  url: string | null | undefined,
  sizes: readonly Exclude<TmdbImageSize, "original">[]
): string | undefined {
  if (!isTmdbImageUrl(url) || sizes.length === 0) return undefined;
  return sizes
    .map(size => `${tmdbImageAtSize(url, size)} ${TMDB_IMAGE_WIDTH[size]}w`)
    .join(", ");
}

/** Poster renditions offered to the grid, ascending. */
export const POSTER_SRCSET_SIZES = ["w342", "w500", "w780"] as const;

/**
 * The `sizes` attribute matching `MovieGrid`'s breakpoints
 * (`grid-cols-2 sm:3 md:4 lg:5 xl:6` inside a `max-w-[1480px]` container with
 * `px-4 sm:px-6 lg:px-8`). A tile is remarkably stable at ~180-240px across
 * every breakpoint, which is why three renditions cover the whole range.
 */
export const POSTER_SIZES_ATTRIBUTE =
  "(min-width: 1280px) 240px, (min-width: 1024px) 220px, (min-width: 768px) 210px, (min-width: 640px) 215px, 180px";
