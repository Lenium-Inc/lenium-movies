/**
 * Tagged "My List" store. Each saved title carries a curation tag
 * (Plan to Watch / Favorites / Watched) that the profile hub sorts on.
 * Uses the canonical localSession store under `freestream-list-v1`.
 */
import {
  getMyList as coreGetMyList,
  toggleMyList as coreToggleMyList,
  removeFromMyList as coreRemoveFromMyList,
  addToMyList as coreAddToMyList,
  isInMyList as coreIsInMyList,
  setEntryTag as coreSetEntryTag,
  type MovieSummary,
  type ListTag,
  LIST_TAGS,
} from "@/lib/localSession";

export type { ListTag, MovieSummary };
export { LIST_TAGS };

import { subscribe } from "@/lib/localSession";

export function savedListIds(): number[] {
  return coreGetMyList().map(m => Number(m.id));
}

export function isSaved(id: number): boolean {
  return coreIsInMyList(id);
}

export function entryTag(id: number): ListTag | undefined {
  const list = coreGetMyList();
  const item = list.find(m => getMovieKey(m) === String(id));
  return item?.tag;
}

export function isEmptyList(): boolean {
  return coreGetMyList().length === 0;
}

/** Toggle a title in the list, defaulting to "Plan to Watch" on add. */
export function toggleListSave(entry: {
  id: number;
  title: string;
  year: number | null;
  poster: string | null;
  providerId?: string;
  backdrop?: string | null;
  mediaType?: "movie" | "tv";
  score?: number | null;
}): { saved: boolean; tag: ListTag } {
  const movie = {
    id: entry.id,
    providerId: entry.providerId ?? String(entry.id),
    title: entry.title,
    year: entry.year,
    poster: entry.poster,
    backdrop: entry.backdrop,
    mediaType: entry.mediaType,
    score: entry.score,
  };
  const saved = coreToggleMyList(movie);
  return { saved, tag: saved ? "plan" : "plan" };
}

export function setEntryTag(id: number, tag: ListTag): void {
  coreSetEntryTag(id, tag);
}

export function removeFromList(id: number): void {
  coreRemoveFromMyList(id);
}

/** Saved titles newest-first, with the picked tag or a default. */
export function sortedEntries(filter: ListTag | "all" = "all"): MovieSummary[] {
  const list = coreGetMyList();
  return list
    .filter(e => filter === "all" || e.tag === filter)
    .sort((a, b) => {
      const aTime = a.addedAt ? new Date(a.addedAt).getTime() : 0;
      const bTime = b.addedAt ? new Date(b.addedAt).getTime() : 0;
      return bTime - aTime;
    });
}

export function subscribeList(listener: () => void): () => void {
  return subscribe(listener);
}

// ---------------------------------------------------------------------------
// Postgres-backed saved_media sync (best-effort when a session token exists)
// ---------------------------------------------------------------------------

import {
  getToken,
  apiSavedMedia,
  apiSavedMediaAdd,
  apiSavedMediaRemove,
} from "@/services/auth";

export function hasRemoteSession(): boolean {
  return Boolean(getToken());
}

/** Pull the account's `saved_media` and merge it into the local list. */
export async function syncSavedFromRemote(): Promise<void> {
  if (!getToken()) return;
  try {
    const remote = await apiSavedMedia();
    for (const item of remote) {
      if (coreIsInMyList(item.media_id)) continue;
      coreAddToMyList({
        id: item.media_id,
        providerId: String(item.media_id),
        title: item.title || "Untitled",
        year: null,
        poster: item.poster_path,
        backdrop: null,
        mediaType: item.media_type === "tv" ? "tv" : "movie",
        score: null,
        tag: "plan",
      });
    }
  } catch {
    // The deployed backend may predate /api/auth/my-list — degrade to local-only.
  }
}

/** Mirror a local save to the account when signed in. Returns handled: boolean. */
export async function pushToggleToRemote(movie: {
  id: number;
  mediaType?: "movie" | "tv";
  title?: string;
  poster?: string | null;
}): Promise<boolean> {
  if (!getToken()) return false;
  try {
    return await apiSavedMediaAdd({
      media_id: movie.id,
      media_type: movie.mediaType,
      title: movie.title,
      poster_path: movie.poster,
    });
  } catch {
    return false;
  }
}

/** Mirror a local removal to the account when signed in. */
export async function pushRemoveToRemote(id: number): Promise<void> {
  if (!getToken()) return;
  try {
    await apiSavedMediaRemove(id);
  } catch {
    /* best-effort */
  }
}

function getMovieKey(movie: {
  id?: string | number | null;
  providerId?: string | number | null;
}): string {
  return String(movie.providerId ?? movie.id ?? "");
}
