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

/** Toggle a title in the list, defaulting to "Plan to Watch" on add.
 *
 * When a session token exists the change is also mirrored to the account.
 *
 * This used to be local-only, which meant the four "Add to My List" buttons on
 * the home page (MovieCard, Details, Spotlight) saved to localStorage and
 * nothing else, while only the Watch page pushed to the backend. The result was
 * a list that looked account-backed but was not: signing in on one device and
 * opening the site on another lost every title added from a card, and the
 * Share feature shared an empty Postgres row. Mirroring here rather than in each
 * component fixes all four call sites at once and cannot be forgotten by the
 * fifth. The push is deliberately not awaited: the toggle is optimistic and the
 * UI must not wait on the network for a button press.
 */
export function toggleListSave(entry: {
  id: number;
  title: string;
  year: number | null;
  poster: string | null;
  providerId?: string;
  backdrop?: string | null;
  mediaType?: "movie" | "tv";
  score?: number | null;
}): { saved: boolean } {
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
  if (getToken()) {
    // The account row is keyed on the provider (TMDB) id, not `Movie.id`,
    // which is only a stable local number for React keys. The local list is
    // keyed the same way, via getMovieKey, so using `entry.id` here would
    // create a row that syncSavedFromRemote could never match back up.
    const remoteId = Number(entry.providerId ?? entry.id);
    if (Number.isFinite(remoteId) && remoteId > 0) {
      if (saved) {
        void pushToggleToRemote({
          id: remoteId,
          mediaType: entry.mediaType,
          title: entry.title,
          poster: entry.poster,
        });
      } else {
        void pushRemoveToRemote(remoteId);
      }
    }
  }
  // No `tag` here on purpose: an add persists "plan" (see coreToggleMyList)
  // and a remove leaves no entry at all, so there is no meaningful tag to
  // return. MyList reads the tag off the stored entry, and setEntryTag is the
  // only way to change it. Returning a hardcoded "plan" for both branches was
  // the actual bug here -- a caller branching on it could never see a
  // "favorites" or "watched" result.
  return { saved };
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

// ---------------------------------------------------------------------------
// Embed consent
//
// The CookieBanner offers a real "essential only" choice, and this is where
// that choice has to actually take effect -- otherwise the banner is just
// text. When consent is not "accepted", no third-party embed frame may load.
//
// Undecided is treated as "not yet accepted" (consent by opt-in), which is the
// correct default for a third-party frame that can set its own cookies. The
// direct-source path is untouched, so declining costs the viewer embed
// playback and nothing else.
// ---------------------------------------------------------------------------

const EMBED_CONSENT_KEY = "freestream-consent-v1";

export type EmbedConsent = "accepted" | "essential" | "undecided";

/**
 * Tri-state on purpose: the banner has to distinguish "declined" (stay hidden)
 * from "never asked" (show it). A boolean cannot do both, and collapsing them
 * would either nag forever or silently grant consent on first visit.
 */
export function readEmbedConsent(): EmbedConsent {
  try {
    const raw = window.localStorage.getItem(EMBED_CONSENT_KEY);
    return raw === "accepted" || raw === "essential" ? raw : "undecided";
  } catch {
    // Storage blocked. Treat as undecided so the banner still appears and the
    // viewer gets the essential-only path.
    return "undecided";
  }
}

export function hasEmbedConsent(): boolean {
  return readEmbedConsent() === "accepted";
}

export function setEmbedConsent(choice: "accepted" | "essential"): void {
  try {
    window.localStorage.setItem(EMBED_CONSENT_KEY, choice);
  } catch {
    /* choice still applies in memory for this page view */
  }
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
