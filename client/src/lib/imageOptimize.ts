import { Capacitor } from "@capacitor/core";
import { STREAMVY_PROXY_BASE_URL } from "@/services/streamvy";
import {
  POSTER_SIZES_ATTRIBUTE,
  isTmdbImageUrl,
  tmdbImage,
  tmdbImageAtSize,
  tmdbSrcSet,
  type TmdbImageSize,
} from "@/lib/tmdbImages";

/**
 * The one place that turns a stored artwork URL into a small, right-sized one.
 *
 * TMDB already publishes fixed renditions, so those URLs are rewritten to the
 * rendition the tile actually needs. The catalogue's other artwork host
 * (MovieBox's `aoneroom` CDN) does not: it hands back the original upload --
 * routinely 3840px and several megabytes -- no matter what `?w=` asks for. For
 * those URLs the browser is sent through `/api/image`, which downscales once
 * and lets the Vercel CDN keep the result.
 *
 * A helper rather than a component so a card, a hero and a continue-watching
 * row cannot disagree about which rendition a given width means.
 */

const CONFIGURED_PROXY_BASE = (
  import.meta.env.VITE_IMAGE_PROXY_BASE_URL || ""
)
  .trim()
  .replace(/\/+$/, "");

const IS_NATIVE = Capacitor.isNativePlatform();

/**
 * `/api` on the deployed web app; the absolute origin in the Capacitor shell
 * (where a relative path would resolve to the bundled localhost) and in local
 * dev (where Vite forwards `/api` to the Python API, which has no image route).
 */
export const IMAGE_PROXY_BASE_URL =
  CONFIGURED_PROXY_BASE ||
  (IS_NATIVE || import.meta.env.DEV
    ? STREAMVY_PROXY_BASE_URL
    : "/api");

/** Renditions offered for a portrait poster tile. */
export const POSTER_WIDTHS = [180, 342, 500] as const;

/** Renditions offered for a wide backdrop/hero. */
export const BACKDROP_WIDTHS = [640, 1280, 1920] as const;

/** `sizes` for a poster tile; re-exported so call sites stay in step. */
export const POSTER_IMAGE_SIZES = POSTER_SIZES_ATTRIBUTE;

/** `sizes` for a full-bleed backdrop. */
export const BACKDROP_IMAGE_SIZES = "100vw";

const PROXYABLE_HOST = /(^|\.)aoneroom\.com$/i;

/** A bare TMDB path such as `/abc.jpg`, which some callers still store. */
const BARE_IMAGE_PATH = /^\/[^/].*\.(?:jpe?g|png|webp)$/i;

function isBareImagePath(url: string): boolean {
  return BARE_IMAGE_PATH.test(url);
}

function isTransformable(url: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:")) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && PROXYABLE_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

function tmdbSizeForWidth(width: number): TmdbImageSize {
  if (width <= 92) return "w92";
  if (width <= 185) return "w185";
  if (width <= 342) return "w342";
  if (width <= 500) return "w500";
  if (width <= 780) return "w780";
  if (width <= 1280) return "w1280";
  return "original";
}

/** A URL for `width` CSS pixels. Non-image values pass through untouched. */
export function optimizedImage(
  url: string | null | undefined,
  width: number
): string {
  if (!url) return "";
  if (isBareImagePath(url)) {
    return tmdbImage(url, tmdbSizeForWidth(width));
  }
  if (isTmdbImageUrl(url)) {
    return tmdbImageAtSize(url, tmdbSizeForWidth(width));
  }
  if (!isTransformable(url)) return url;

  const rounded = Math.max(64, Math.min(2048, Math.round(width)));
  const query = new URLSearchParams({
    url,
    w: String(rounded),
    f: "webp",
    q: "72",
  });
  return `${IMAGE_PROXY_BASE_URL}/image?${query.toString()}`;
}

/** A `srcset` for a portrait poster, or undefined when there is no URL. */
export function posterSrcSet(
  url: string | null | undefined
): string | undefined {
  if (!url) return undefined;
  if (isBareImagePath(url)) {
    return (["w185", "w342", "w500"] as const)
      .map(size => `${tmdbImage(url, size)} ${size.slice(1)}w`)
      .join(", ");
  }
  if (isTmdbImageUrl(url)) {
    return tmdbSrcSet(url, ["w185", "w342", "w500"]);
  }
  if (!isTransformable(url)) return undefined;
  return POSTER_WIDTHS.map(
    width => `${optimizedImage(url, width)} ${width}w`
  ).join(", ");
}

/** A `srcset` for a wide backdrop/hero, or undefined when there is no URL. */
export function backdropSrcSet(
  url: string | null | undefined
): string | undefined {
  if (!url) return undefined;
  if (isBareImagePath(url)) {
    return (["w780", "w1280"] as const)
      .map(size => `${tmdbImage(url, size)} ${size.slice(1)}w`)
      .join(", ");
  }
  if (isTmdbImageUrl(url)) {
    return tmdbSrcSet(url, ["w780", "w1280"]);
  }
  if (!isTransformable(url)) return undefined;
  return BACKDROP_WIDTHS.map(
    width => `${optimizedImage(url, width)} ${width}w`
  ).join(", ");
}
