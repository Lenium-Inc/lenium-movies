/**
 * Client-side download bookkeeping + actual file download through the
 * backend's `/api/movies/stream` relay (which streams Archive.org MP4s
 * range-request-safe behind CORS).
 *
 * Only direct, playable URLs (MP4/HLS non-embed) can be downloaded. Embed
 * sources are HTML pages and have nothing the browser could save as a file.
 */
import { getStreamType, isExternalEmbedUrl } from "@/lib/streamUtils";
import { proxiedStreamUrl } from "@/services/api";

export interface DownloadEntry {
  key: string;
  title: string;
  year: number | null;
  poster: string | null;
  quality: string | null;
  streamUrl: string;
  proxyUrl: string;
  addedAt: number;
  sizeBytes?: number;
  /** true while the transfer is being prepared/downloaded */
  pending?: boolean;
  error?: string | null;
}

const STORE_KEY = "lenium_downloads_v1";

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Subscribe to download-list changes; returns an unsubscribe function. */
export function subscribeDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function canDownload(streamUrl: string | null | undefined): boolean {
  if (!streamUrl) return false;
  if (isExternalEmbedUrl(streamUrl)) return false;
  return getStreamType(streamUrl) !== "embed";
}

export function getDownloads(): DownloadEntry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DownloadEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(entries: DownloadEntry[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
  } catch {
    /* storage unavailable */
  }
}

export function addDownload(entry: {
  key: string;
  title: string;
  year?: number | null;
  poster?: string | null;
  quality?: string | null;
  streamUrl: string;
}): void {
  const entries = getDownloads().filter((e) => e.key !== entry.key);
  const record: DownloadEntry = {
    key: entry.key,
    title: entry.title,
    year: entry.year ?? null,
    poster: entry.poster ?? null,
    quality: entry.quality ?? null,
    streamUrl: entry.streamUrl,
    proxyUrl: proxiedStreamUrl(entry.streamUrl),
    addedAt: Date.now(),
  };
  entries.unshift(record);
  persist(entries);
  notify();
}

export function removeDownload(key: string): void {
  persist(getDownloads().filter((e) => e.key !== key));
  notify();
}

export function clearDownloads(): void {
  persist([]);
  notify();
}

export function isDownloaded(key: string): boolean {
  return getDownloads().some((e) => e.key === key);
}

function triggerBrowserDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Download the file through the proxy relay. The full blob is fetched and
 * saved with a readable filename (matches the title + year + quality).
 *
 * Returns a Promise that resolves when the transfer has started.
 */
export async function downloadFile(
  entry: DownloadEntry,
  onProgress?: (percent: number) => void
): Promise<void> {
  const response = await fetch(entry.proxyUrl, {
    headers: { Range: "bytes=0-" },
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  const contentLength = Number(response.headers.get("Content-Length") ?? 0);
  const total = contentLength || 1e9;

  if (response.body && "getReader" in response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(Math.min(100, (received / total) * 100));
    }
    const blob = new Blob(chunks as unknown as BlobPart[], {
      type: response.headers.get("Content-Type") ?? "video/mp4",
    });
    const objectUrl = URL.createObjectURL(blob);
    const safeTitle = entry.title.replace(/[^\w\d\s-]/g, "").trim().replace(/\s+/g, "-");
    const quality = entry.quality ? `${entry.quality}-` : "";
    triggerBrowserDownload(objectUrl, `${safeTitle}-${entry.year ?? ""}-${quality}${entry.year ?? "movie"}.mp4`.replace(/-+/g, "-"));
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return;
  }

  // Fallback path (no streaming body support): save the relay URL directly.
  triggerBrowserDownload(entry.proxyUrl, `${entry.title}.mp4`);
}