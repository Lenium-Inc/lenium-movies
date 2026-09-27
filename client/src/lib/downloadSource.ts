import { isExternalEmbedUrl } from "./streamUtils";

/**
 * Whether a resolved source can actually be saved as one file.
 *
 * "progressive" means a single self-contained file. Everything else is
 * deliberately reported as its own kind rather than collapsed into a failure,
 * because the caller's message to the viewer is different in each case: a
 * playlist is a real file but a useless download, and an embed is not a file at
 * all.
 */
export type DownloadKind = "progressive" | "hls" | "embed" | "unsupported";

export interface DownloadCandidate {
  kind: DownloadKind;
  url: string;
}

/**
 * Container extensions a browser can save and a desktop player can open.
 *
 * The key is the extension that may appear in the URL, the value the extension
 * the saved file should carry -- `.m4v` and `.mkv` variants are common on
 * Archive.org and should not be renamed.
 */
const DOWNLOADABLE_EXTENSIONS: Record<string, string> = {
  mp4: "mp4",
  m4v: "m4v",
  mkv: "mkv",
  webm: "webm",
  ogv: "ogv",
  ogg: "ogg",
  mov: "mov",
  avi: "avi",
};

const PLAYLIST_EXTENSIONS = [".m3u8", ".mpd"];

function extensionOf(pathname: string): string {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/**
 * Classify a single resolved URL for download.
 *
 * Ordering matters: an embed host is checked first because a third-party page
 * URL has no meaningful extension, and a playlist is checked before the
 * container table so a `.m3u8` is never mistaken for a saveable file.
 */
export function classifyDownloadUrl(url: string | null | undefined): DownloadCandidate {
  if (!url || typeof url !== "string" || !url.trim()) {
    return { kind: "unsupported", url: "" };
  }
  const candidate = url.trim();
  if (isExternalEmbedUrl(candidate)) {
    return { kind: "embed", url: candidate };
  }
  let pathname = "";
  try {
    pathname = new URL(candidate).pathname.toLowerCase();
  } catch {
    // A relative or unparseable URL cannot be classified as a container.
    return { kind: "unsupported", url: candidate };
  }
  if (PLAYLIST_EXTENSIONS.some(ext => pathname.endsWith(ext))) {
    return { kind: "hls", url: candidate };
  }
  const extension = extensionOf(pathname);
  if (extension && DOWNLOADABLE_EXTENSIONS[extension]) {
    return { kind: "progressive", url: candidate };
  }
  return { kind: "unsupported", url: candidate };
}

export interface DownloadSourceLike {
  title?: string;
  year?: number | string | null;
  stream_url?: string;
  streams?: { url?: string | null }[] | null;
}

/**
 * Choose the best candidate from a resolved title.
 *
 * `streams` is preferred over `stream_url` because the resolver lists the
 * progressive renditions first and the primary URL is frequently the HLS
 * playlist -- taking the primary unconditionally would make downloads
 * unavailable for titles that do have a saveable file.
 */
export function pickDownloadCandidate(movie: DownloadSourceLike | null | undefined): DownloadCandidate {
  if (!movie) return { kind: "unsupported", url: "" };
  const pool = [
    ...(Array.isArray(movie.streams) ? movie.streams : []).map(s => s?.url),
    movie.stream_url,
  ].filter((url): url is string => typeof url === "string" && url.length > 0);
  for (const kind of ["progressive", "hls", "embed"] as const) {
    const hit = pool.map(classifyDownloadUrl).find(c => c.kind === kind);
    if (hit) return hit;
  }
  return { kind: "unsupported", url: "" };
}

/** Replace characters a filesystem or header would reject, and collapse spaces. */
export function sanitizeFilenamePart(value: string): string {
  return (
    value
      // Reject control characters, quotes, and path separators. Written with
      // hex escapes so the source stays plain ASCII: a literal control byte in
      // a regex literal makes the file read as binary to some tooling.
      .replace(/[\x00-\x1f\x7f"\\/]/g, "")
      .replace(/\s+/g, " ")
      // Trim before stripping dots, not after: `^\.+` cannot match a leading
      // dot that is still behind whitespace, so " ..name.. " survived intact.
      .trim()
      .replace(/^\.+/, "")
      .replace(/\.+$/, "")
      .trim()
  );
}

/**
 * Build the saved filename from the title, so the file is recognisable in a
 * downloads folder rather than called `video` or a 40-character archive hash.
 *
 * The container extension comes from the URL when it is a real container, and
 * falls back to `mp4` only for a progressive source, so an HLS candidate never
 * gets mislabelled as an mp4.
 */
export function buildDownloadFilename(
  movie: DownloadSourceLike | null | undefined,
  candidate: DownloadCandidate
): string {
  const title = sanitizeFilenamePart(movie?.title || "video") || "video";
  const rawYear = movie?.year;
  const year =
    typeof rawYear === "number" && Number.isFinite(rawYear)
      ? String(Math.trunc(rawYear))
      : typeof rawYear === "string" && /^\d{4}$/.test(rawYear.trim())
        ? rawYear.trim()
        : "";
  const stem = [title, year].filter(Boolean).join(" ");
  if (candidate.kind !== "progressive") {
    // Keep the playlist's own extension so the file is still recognisable.
    let ext = "m3u8";
    try {
      const path = new URL(candidate.url).pathname.toLowerCase();
      if (path.endsWith(".mpd")) ext = "mpd";
    } catch {
      // keep m3u8
    }
    return `${sanitizeFilenamePart(stem) || "video"}.${ext}`;
  }
  let extension = "mp4";
  try {
    const found = extensionOf(new URL(candidate.url).pathname.toLowerCase());
    if (found && DOWNLOADABLE_EXTENSIONS[found]) extension = DOWNLOADABLE_EXTENSIONS[found];
  } catch {
    // keep mp4
  }
  return `${sanitizeFilenamePart(stem) || "video"}.${extension}`;
}

/** Human explanation for a candidate that cannot be saved as a file. */
export function downloadUnavailableReason(candidate: DownloadCandidate): string {
  switch (candidate.kind) {
    case "embed":
      return "This title only has a third-party embed source, which cannot be downloaded.";
    case "hls":
      return "This source is a streaming playlist. Saving it would only store the playlist, not the video.";
    default:
      return "No downloadable file was found for this title yet. Try another source.";
  }
}
