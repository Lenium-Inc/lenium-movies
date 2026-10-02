import { EMBED_HOSTS } from "@/lib/embedSources";

/**
 * Hosts that serve a third-party iframe player rather than a media file.
 *
 * Derived from the provider registry so it cannot drift: the previous
 * hand-maintained list was missing three of the five hosts the registry itself
 * emitted, which meant `isExternalEmbedUrl` returned false for them. Such a
 * URL was then admitted into the native player's candidate list and handed to
 * `<video>`/hls.js as if it were an MP4, where it cannot play -- costing a full
 * stall-detection cycle and a mirror rotation per occurrence.
 *
 * The historical entries that no longer appear in the registry are kept below:
 * providers the current manifest dropped, and hosts a cached or older resolve
 * payload can still carry. Dropping one from the manifest does not un-frame it,
 * and a URL that is no longer recognised as an embed is a URL handed to the
 * native player as though it were a media file.
 */
const LEGACY_EMBED_HOSTS = [
  "vidsrc.me",
  "vidsrc.to",
  "vidsrc.sh",
  "autoembed.to",
  "autoembed.cc",
  "mycima.tv",
  "2embed.org",
  "2embed.cc",
  "multiembed.mov",
  "goojara.to",
  "vidlink.org",
  "vidstream.pro",
] as const;

export const EXTERNAL_EMBED_HOSTS: readonly string[] = Object.freeze([
  ...Array.from(new Set([...EMBED_HOSTS, ...LEGACY_EMBED_HOSTS])),
]);

export function isExternalEmbedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return EXTERNAL_EMBED_HOSTS.some(
      host => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

export type StreamType = "hls" | "dash" | "mp4" | "embed";

export function getStreamType(url: string): StreamType {
  if (isExternalEmbedUrl(url)) return "embed";
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".m3u8")) return "hls";
    if (pathname.endsWith(".mpd")) return "dash";
    if (pathname.endsWith(".mp4")) return "mp4";
  } catch {
    // ignore
  }
  return "embed";
}

/**
 * Play order for directly playable URLs, lowest first.
 *
 * 0. HLS (`.m3u8`) -- the format the player owns end to end, through hls.js
 *    or native HLS. It never needs a third-party frame, so it is the only
 *    candidate that cannot pull an ad provider's scripts into the page.
 * 1. The other recognised media files (`.mp4`, `.mpd`).
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
