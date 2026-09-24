export const EXTERNAL_EMBED_HOSTS = [
  "vidsrc.me",
  "vidsrc.sh",
  "vidsrc.cc",
  "embed.su",
  "goojara.to",
  "vidlink.org",
  "vidstream.pro",
  "autoembed.cc",
  "2embed.cc",
  "multiembed.mov",
] as const;

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