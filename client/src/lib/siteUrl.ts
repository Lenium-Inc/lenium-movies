/**
 * The origin of the deployment the viewer is on.
 *
 * Share links, the hero's copy-link action and the OAuth redirect all need an
 * absolute URL, and all three used to reach for `window.location.origin` on
 * their own. Three copies of that answer is three places to forget it, and the
 * one place that matters most — the OAuth `redirectUri` — is compared against
 * the callback's own origin when it comes back. A copy that drifts from the
 * browser is an origin mismatch, which reads as a failed login with no useful
 * error.
 *
 * The order is deliberate: what the browser says always wins, because that is
 * the host the viewer is actually on and the only one guaranteed to be right.
 * A build-time value is the fallback for rendering with no `window` at all
 * (prerender, or a test in the `node` environment); it is not a default that
 * quietly replaces a live origin.
 */

/** Build-time origin for non-browser rendering. Vite's `VITE_*` inlining. */
function configuredOrigin(): string {
  const raw = import.meta.env.VITE_SITE_URL;
  if (typeof raw !== "string") return "";
  // A trailing slash here would produce `https://host//watch/1` from
  // `absoluteUrl`, which is a different URL to every share service that
  // canonicalises paths.
  return raw.trim().replace(/\/+$/, "");
}

/**
 * The current origin, or `""` when there is nothing trustworthy to return.
 *
 * An empty string is not an error to paper over with a guessed host: it makes
 * `absoluteUrl` fall back to a relative path, which a browser resolves against
 * the page it is already on. A wrong hardcoded domain is worse than a relative
 * link, because it is confidently wrong.
 */
export function siteUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return configuredOrigin();
}

/**
 * An absolute URL for `path`, or `path` unchanged when no origin is available.
 *
 * `path` is expected to start with `/`. A full URL passed in by mistake is
 * returned as-is rather than concatenated onto the origin, so a caller holding an
 * already-absolute URL gets it back instead of `https://hosthttps://host`.
 */
export function absoluteUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  const origin = siteUrl();
  if (!origin) return path;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${suffix}`;
}

export default absoluteUrl;
