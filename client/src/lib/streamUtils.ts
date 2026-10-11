import { EMBED_HOSTS } from "@/lib/embedSources";

/**
 * Hosts that serve a third-party iframe player rather than a media file.
 *
 * Derived from the provider manifest and nothing else. The hand-maintained
 * legacy block that used to sit here -- a dozen provider hosts no longer in
 * `movie-backend/stream_providers.py`, kept "in case a cached payload still
 * carried one" -- is gone: the backend cannot return a host it does not serve,
 * and a browser-side allowlist naming hosts the server has dropped is a second,
 * drifting source of truth about what may be framed. `embedSources.test.ts`
 * pins this list to the Python manifest so nothing can be added back here.
 *
 * A URL this function does not recognise is still classified by
 * `getStreamType` below, so dropping a host cannot reclassify a media file.
 */
export const EXTERNAL_EMBED_HOSTS: readonly string[] = Object.freeze([
  ...Array.from(new Set(EMBED_HOSTS)),
]);

/**
 * The tokenised playback legs `/api/v1/playback/init` mints, by path.
 *
 * The backend never returns a third-party URL: every downstream leg is one of
 * these same-origin routes carrying an opaque handle (`?token=...`). They are
 * matched on path alone so a build that ships a backend origin
 * (`VITE_MOVIE_API_BASE_URL`) classifies the identical handle exactly as a
 * same-origin dev build does.
 *
 * `frame` is an embed -- it 302s the browser to the provider's page, so an
 * `<iframe>` is what loads it. `manifest` and `media` are the two direct
 * relays, and must never be mistaken for an embed or they would be filtered
 * out of the player's candidate list and handed to the frame instead.
 */
const FRAME_HANDLE_PATH = "/api/v1/playback/frame";
const MANIFEST_HANDLE_PATH = "/api/proxy/manifest";
const MEDIA_HANDLE_PATH = "/api/v1/playback/media";

/**
 * A base for parsing, so a relative handle (`/api/...`) is readable without
 * pretending it is absolute. `url.invalid` is reserved by RFC 2606 and can
 * never collide with a real host.
 */
const PARSE_BASE = "https://url.invalid";

function pathnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, PARSE_BASE).pathname;
  } catch {
    return null;
  }
}

function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, PARSE_BASE).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `url` points at a host in the provider manifest (or a subdomain
 * of one). A raw third-party embed URL -- only ever present in a stale cache
 * or an older payload now, since `/api/v1/playback/init` answers with handles.
 */
export function isExternalEmbedUrl(url: string | null | undefined): boolean {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  return EXTERNAL_EMBED_HOSTS.some(
    host => hostname === host || hostname.endsWith(`.${host}`)
  );
}

/**
 * True when `url` is the backend's tokenised frame handle.
 *
 * This is the shape an embed actually arrives in: `/api/v1/playback/frame`
 * answers `302` to the provider page, so the browser frames the third-party
 * URL without that URL ever crossing the wire as data. Recognising it by path
 * is what keeps the player from feeding an `<iframe>` URL to `<video>` -- a
 * relative handle used to parse as "unknown", which read as a media file.
 */
export function isFrameHandle(url: string | null | undefined): boolean {
  return pathnameOf(url) === FRAME_HANDLE_PATH;
}

/**
 * True when this URL plays a third-party iframe player rather than a media
 * file, by either route the backend can express it: a tokenised frame handle
 * (the normal case) or a raw provider URL (an older payload).
 *
 * This is the predicate every failover and selector decision should use --
 * "does this belong in an `<iframe>`?" -- rather than a host allowlist alone.
 */
export function isEmbedSourceUrl(url: string | null | undefined): boolean {
  return isFrameHandle(url) || isExternalEmbedUrl(url);
}

export type StreamType = "hls" | "dash" | "mp4" | "embed";

export function getStreamType(url: string): StreamType {
  if (isEmbedSourceUrl(url)) return "embed";

  // The two direct relays carry no extension -- their path *is* the format
  // signal -- so they are read before the extension table. Without this a
  // tokenised HLS handle ranked as "unrecognised" and lost its place at the
  // head of the play order.
  const pathname = pathnameOf(url);
  if (pathname === MANIFEST_HANDLE_PATH) return "hls";
  if (pathname === MEDIA_HANDLE_PATH) return "mp4";

  if (pathname) {
    const lower = pathname.toLowerCase();
    if (lower.endsWith(".m3u8") || lower.endsWith(".m3u")) return "hls";
    if (lower.endsWith(".mpd")) return "dash";
    if (lower.endsWith(".mp4")) return "mp4";
  }
  return "embed";
}

/**
 * Play order for directly playable URLs, lowest first.
 *
 * 0. HLS (`.m3u8`, or the backend's manifest relay) -- the format the player
 *    owns end to end, through hls.js or native HLS. It never needs a
 *    third-party frame, so it is the only candidate that cannot pull an ad
 *    provider's scripts into the page.
 * 1. The other recognised media files (`.mp4`, `.mpd`, the media relay).
 * 2. Anything unrecognised: a URL whose host is not in the embed registry and
 *    whose path is not a media file is usually a raw third-party player page
 *    the backend handed back unlabelled. It is kept as a last resort rather
 *    than dropped -- the registry cannot know every provider -- but it must
 *    never outrank a real manifest, because handing it to `<video>` first
 *    costs a full stall-detection cycle before the good source is tried.
 *
 * Ties keep the order the resolver returned, so backend preference survives
 * within each tier.
 */
export function directStreamRank(url: string): number {
  const type = getStreamType(url);
  if (type === "hls") return 0;
  if (type === "mp4" || type === "dash") return 1;
  return 2;
}

/** `urls` stably re-ordered so backend HLS plays before anything else. */
export function orderDirectStreams(urls: Iterable<string>): string[] {
  return Array.from(urls).sort(
    (a, b) => directStreamRank(a) - directStreamRank(b)
  );
}
