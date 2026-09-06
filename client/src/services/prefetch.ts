/**
 * Per-movie browser cache for instant-feeling playback.
 *
 * The leading seconds of a movie are downloaded ahead of the Play click and
 * stored as an opaque blob in IndexedDB (random key, no extension — the bytes
 * aren't a plain readable file). Switching movies evicts the previous movie's
 * cache so the budget is never spent on a title nobody is watching.
 */
import {
  pickStreamVariant,
  proxiedStreamUrl,
  type StreamMovie,
  type StreamQuality,
  type StreamVariant,
} from "./api";
import { getSettings } from "./settings";

const DB_NAME = "freestream-prefetch";
const DB_VERSION = 1;
const STORE = "blobs";

/** Leading-bytes prefetch budget — the first seconds of the chosen tier. */
const LEADING_BYTES = 16 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

/** Opaque key: a random token so stored blobs carry no filename/source hint. */
function opaqueKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function putBlob(key: string, blob: Blob): Promise<void> {
  return openDb().then(
    db =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(blob, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function getBlob(key: string): Promise<Blob | null> {
  return openDb().then(
    db =>
      new Promise(resolve => {
        const tx = db.transaction(STORE, "readonly");
        const get = tx.objectStore(STORE).get(key);
        get.onsuccess = () => resolve((get.result as Blob) ?? null);
        get.onerror = () => resolve(null);
      })
  );
}

function deleteKeys(keys: string[]): Promise<void> {
  return openDb().then(
    db =>
      new Promise(resolve => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        keys.forEach(key => store.delete(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      })
  );
}

interface PrefetchRecord {
  movieId: string;
  key: string;
  quality: StreamQuality;
  variant: StreamVariant;
  byteLength: number;
}

let active: PrefetchRecord | null = null;
let activeController: AbortController | null = null;
const activeFetch = new WeakMap<AbortController, Promise<void>>();

export function currentPrefetch(): PrefetchRecord | null {
  return active;
}

/** True while a leading-bytes fetch is still running. */
export function prefetchPending(): boolean {
  return activeController !== null;
}

/**
 * The variant the viewer will most likely start with: their saved default
 * quality when a title offers it, otherwise the backend's fast-start tier.
 * Keeping prefetch and the player on the same variant makes the blob-first
 * handoff deterministic instead of a happy accident.
 */
function pickStartVariant(
  movie: StreamMovie
): { variant?: StreamVariant; url: string } {
  const pref = getSettings().quality;
  if (pref !== "auto") {
    const found = movie.streams?.find(s => s.quality === pref);
    if (found) return { variant: found, url: found.url };
  }
  return pickStreamVariant(movie);
}

/** Abort any in-flight prefetch (its partial bytes are discarded). */
export function cancelInFlightPrefetch(): void {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

/**
 * Prefetch the leading bytes of `variant` for `movie` and cache them under an
 * opaque key. Calling this evicts any previous movie's cached blob. Gated by a
 * size threshold so only one budgeted prefetch runs at a time.
 */
export async function prefetchMovie(
  movie: StreamMovie,
  variant: StreamVariant,
  url: string
): Promise<PrefetchRecord | null> {
  // Evict the previous movie so storage only ever holds the current one.
  if (active) {
    if (active.movieId === movie.id && active.quality === variant.quality) {
      return active;
    }
    await evict();
  }

  const controller = new AbortController();
  activeController = controller;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (received < LEADING_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    if (!received) return null;

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const blob = new Blob([merged], { type: "video/mp4" });
    const key = opaqueKey();
    await putBlob(key, blob);

    const record: PrefetchRecord = {
      movieId: movie.id,
      key,
      quality: variant.quality,
      variant,
      byteLength: received,
    };
    if (active && active.key !== key) await deleteKeys([active.key]);
    active = record;
    return record;
  } catch (error) {
    if ((error as Error).name === "AbortError") return null;
    return null;
  } finally {
    if (activeController === controller) activeController = null;
    activeFetch.delete(controller);
  }
}

/** Resolve the cached blob for a prefetch record, or null if it's gone. */
export function resolvePrefetched(record: PrefetchRecord): Promise<Blob | null> {
  return getBlob(record.key);
}

/** Remove the current movie's cache (called when switching movies). */
export async function evict(): Promise<void> {
  if (active) {
    await deleteKeys([active.key]).catch(() => {});
    active = null;
  }
}

/**
 * Fire-and-forget warm-up: cache the leading bytes of `movie`'s start variant
 * so Play starts instantly. Skips when the movie is already being cached.
 */
export function prefetchForPlayback(movie: StreamMovie): void {
  const { variant, url, started } = pickStart(movie);
  if (!variant || started) return;
  void prefetchMovie(movie, variant, proxiedStreamUrl(url));
}

/** Same warm-up, but for the silent pre-cache engine (modal open / hover). */
export function prefetchForOpen(movie: StreamMovie): void {
  prefetchForPlayback(movie);
}

/** Guarded variant pick: returns `started` when this movie is already hot. */
function pickStart(movie: StreamMovie): {
  variant?: StreamVariant;
  url: string;
  started: boolean;
} {
  if (!movie.streams?.length) return { url: "", started: true };
  const pre = currentPrefetch();
  if (pre && pre.movieId === movie.id) return { url: "", started: true };
  const { variant, url } = pickStartVariant(movie);
  if (!variant) return { url: "", started: true };
  return { variant, url, started: false };
}
