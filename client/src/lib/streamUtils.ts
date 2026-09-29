import { EMBED_HOSTS } from "@/lib/embedSources";

/**
 * Hosts that serve a third-party iframe player rather than a media file.
 *
 * Derived from the provider registry so it cannot drift: the previous
 * hand-maintained list was missing three of the five hosts the registry itself
 * emitted (`vidsrc.to`, `autoembed.to`, `mycima.tv`, `2embed.org`), which meant
 * `isExternalEmbedUrl` returned false for them. Such a URL was then admitted
 * into the native player's candidate list and handed to `<video>`/hls.js as if
 * it were an MP4, where it cannot play -- costing a full stall-detection cycle
 * and a mirror rotation per occurrence.
 *
 * The historical entries that no longer appear in the registry are kept below:
 * the backend's own hardcoded embeds, and providers a cached/older resolve
 * payload can still carry.
 */
const LEGACY_EMBED_HOSTS = [
  "vidsrc.sh",
  "embed.su",
  "goojara.to",
  "vidlink.org",
  "vidstream.pro",
  "autoembed.cc",
  "2embed.cc",
] as const;

export const EXTERNAL_EMBED_HOSTS: readonly string[] = Object.freeze([
  ...Array.from(new Set([...EMBED_HOSTS, ...LEGACY_EMBED_HOSTS])),
]);

export function isExternalEmbedUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return EXTERNAL_EMBED_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
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
