/**
 * The canonical origin, in one place.
 *
 * `sitemap.ts`, `robots.ts` and the root layout all need it, and each of them
 * needs it to be *identical*: a sitemap served from one host while the layout
 * advertises another is the classic way to get a site indexed twice, or not at
 * all.
 *
 * Overridable per environment so a preview deploy does not emit canonical tags,
 * a sitemap and a robots.txt pointing at production. Without this, every
 * branch builds a sitemap for `streamvy.me`, and a crawler that follows one from
 * a staging URL has no way to tell the two apart.
 */
const DEFAULT_SITE_URL = "https://streamvy.me";

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL
).replace(/\/+$/, "");

/** Absolute URL for a site-relative path. `path` must start with `/`. */
export function absolute(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export const SITE_NAME = "Stream Vy";
export const SITE_DESCRIPTION =
  "A high-end minimalist VOD streaming platform. Stream films and series, keep a personal list, and pick up exactly where you left off.";
