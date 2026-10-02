/**
 * The key a watch-progress record is stored under.
 *
 * A film is keyed by its TMDB id. A series is keyed by the episode, because
 * "where was I" is a question about an episode: one record per show means
 * starting S01E02 overwrites S01E01, the resume bar on the shelf describes a
 * title the viewer is not watching, and finishing one episode marks the whole
 * series as seen.
 *
 * The episode lives in the key rather than in new columns. `watch_history` is
 * `UNIQUE (user_id, profile_id, movie_key)` over a TEXT column, so a composite
 * string is addressable today with no migration and no change to the backend --
 * and a viewer's existing film records keep resolving, because a bare numeric id
 * is still a valid key under this scheme.
 *
 * Encoding, not parsing, is the asymmetry worth noting: `progressKey` is the only
 * thing allowed to invent a key, and `parseProgressKey` has to accept every key
 * ever written, including bare ids from before this existed.
 */

export type ProgressMediaType = "movie" | "tv";

export interface ProgressKeyParts {
  /** TMDB id as a string. Numeric ids are the only addressable kind. */
  id: string;
  season?: number;
  episode?: number;
}

function positive(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 1 ? value : null;
}

/** `1396` for a film, `1396:s1e2` for an episode. */
export function progressKey(
  tmdbId: string | number,
  mediaType: ProgressMediaType,
  season?: number,
  episode?: number,
): string {
  const id = String(tmdbId).trim();
  if (mediaType !== "tv") return id;
  const s = positive(season);
  const e = positive(episode);
  // No episode in hand: fall back to the show-level key rather than inventing
  // S01E01. Defaulting would overwrite the viewer's real position in S01E02 the
  // first time they opened the show page before choosing an episode.
  if (s === null || e === null) return id;
  return `${id}:s${s}e${e}`;
}

/**
 * Split a stored key back into its parts, or `null` when it is not one.
 *
 * `null` means "unaddressable" rather than "malformed": the shelf cannot build a
 * watch route from it, so the caller drops it instead of linking to a title that
 * will not resolve.
 */
export function parseProgressKey(key: string): ProgressKeyParts | null {
  const value = (key ?? "").trim();
  if (!value) return null;

  const match = /^(\d+)(?::s(\d+)e(\d+))?$/i.exec(value);
  if (!match) return null;

  const [, id, season, episode] = match;
  const parts: ProgressKeyParts = { id };
  if (season !== undefined && episode !== undefined) {
    const s = Number(season);
    const e = Number(episode);
    if (s >= 1 && e >= 1) {
      parts.season = s;
      parts.episode = e;
    }
  }
  return parts;
}

export default progressKey;