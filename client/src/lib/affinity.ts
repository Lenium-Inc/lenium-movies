/**
 * Deterministic, session-scoped viewing affinity.
 *
 * Personalisation here is entirely local: signals live in `sessionStorage` for
 * the tab's lifetime and are never sent anywhere as an identifier. The same
 * interactions always produce the same ordering -- there is no randomness, so
 * paging through the feed does not reshuffle titles the user already saw.
 *
 * The feed itself is ranked by the upstream catalogue (TMDB), so ranking only
 * ever *promotes* matching titles; everything else keeps its upstream position.
 */

export type MediaSignals = {
  /** `Movie` exposes `genre`; some payloads carry TMDB's `genres`. Accept both. */
  genre?: readonly string[] | null;
  genres?: readonly string[] | null;
  cast?: readonly string[] | null;
  director?: string | null;
};

/** The subset of `Movie` the affinity model reads. */
export type SignalSource = {
  genre?: readonly string[] | null;
  genres?: readonly string[] | null;
  cast?: readonly string[] | null;
  director?: string | null;
};

/** Shared by the catalogue feed and the watch page so both score the same way. */
export function signalsFrom(source: SignalSource): MediaSignals {
  return {
    genre: source.genre ?? source.genres,
    cast: source.cast,
    director: source.director,
  };
}

function genreList(signals: MediaSignals): readonly string[] {
  return signals.genre ?? signals.genres ?? [];
}

export type Affinity = {
  genres: Record<string, number>;
  people: Record<string, number>;
};

/**
 * A cast or director mention is a far stronger signal than a genre, which
 * every title in a genre shares.
 */
const GENRE_WEIGHT = 1;
const CAST_WEIGHT = 1.5;
const DIRECTOR_WEIGHT = 2;

/** Each new interaction discounts what came before, so recent taste dominates. */
const DECAY = 0.6;

const MAX_GENRES = 8;
const MAX_PEOPLE = 12;

/** Below this a signal is noise and gets dropped rather than carried forever. */
const MIN_WEIGHT = 0.05;

export function emptyAffinity(): Affinity {
  return { genres: {}, people: {} };
}

function normaliseKey(value: string): string {
  return value.trim().toLowerCase();
}

function topEntries(
  weights: Record<string, number>,
  limit: number,
): Record<string, number> {
  const entries = Object.entries(weights).filter(
    ([, w]) => w >= MIN_WEIGHT,
  );
  // Sort by weight, then key, so the retained set never depends on insertion
  // order -- two equivalent affinity states always trim to the same shape.
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return Object.fromEntries(entries.slice(0, limit));
}

export function decayAffinity(affinity: Affinity): Affinity {
  return {
    genres: Object.fromEntries(
      Object.entries(affinity.genres).map(([k, v]) => [k, v * DECAY]),
    ),
    people: Object.fromEntries(
      Object.entries(affinity.people).map(([k, v]) => [k, v * DECAY]),
    ),
  };
}

/**
 * Fold one interaction into the affinity state, discounting prior signals.
 * `weight` lets a stronger action (playing a title) outrank a weaker one
 * (opening its details sheet).
 */
export function recordInteraction(
  affinity: Affinity,
  signals: MediaSignals,
  weight = 1,
): Affinity {
  const next = decayAffinity(affinity);

  for (const genre of genreList(signals)) {
    const key = normaliseKey(genre);
    if (!key) continue;
    next.genres[key] = (next.genres[key] ?? 0) + GENRE_WEIGHT * weight;
  }
  for (const person of signals.cast ?? []) {
    const key = normaliseKey(person);
    if (!key) continue;
    next.people[key] = (next.people[key] ?? 0) + CAST_WEIGHT * weight;
  }
  if (signals.director) {
    const key = normaliseKey(signals.director);
    if (key) next.people[key] = (next.people[key] ?? 0) + DIRECTOR_WEIGHT * weight;
  }

  return { genres: topEntries(next.genres, MAX_GENRES), people: topEntries(next.people, MAX_PEOPLE) };
}

/** How strongly a candidate matches the accumulated affinity. */
export function scoreCandidate(
  signals: MediaSignals,
  affinity: Affinity,
): number {
  let score = 0;
  for (const genre of genreList(signals)) {
    score += affinity.genres[normaliseKey(genre)] ?? 0;
  }
  for (const person of signals.cast ?? []) {
    score += affinity.people[normaliseKey(person)] ?? 0;
  }
  if (signals.director) {
    score += affinity.people[normaliseKey(signals.director)] ?? 0;
  }
  return score;
}

/**
 * Promote matching titles while leaving everything else exactly where the
 * upstream catalogue put it. Sorting on the original index as the tiebreaker
 * is what makes this stable across pages.
 */
export function rankByAffinity<T>(
  items: readonly T[],
  affinity: Affinity,
  signalsOf: (item: T) => MediaSignals,
): T[] {
  const hasSignal =
    Object.keys(affinity.genres).length > 0 ||
    Object.keys(affinity.people).length > 0;
  if (!hasSignal) return [...items];

  return items
    .map((item, index) => ({ item, index, score: scoreCandidate(signalsOf(item), affinity) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.item);
}

/** Compact query values, so upstream can use them without a schema change. */
export function affinityQueryParams(affinity: Affinity): {
  affinity_genres: string;
  affinity_people: string;
} {
  return {
    affinity_genres: Object.keys(affinity.genres).join(","),
    affinity_people: Object.keys(affinity.people).join(","),
  };
}

export const AFFINITY_STORAGE_KEY = "streamvy.affinity.v1";

/**
 * Session-scoped by design: the tab forgets on close, and nothing here is an
 * identifier that could follow the user around.
 */
/** Parse stored affinity, treating anything unexpected as no affinity. */
export function parseAffinity(raw: string | null | undefined): Affinity {
  if (!raw) return emptyAffinity();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyAffinity();
    const { genres, people } = parsed as Partial<Affinity>;
    const clean = (value: unknown): Record<string, number> => {
      if (typeof value !== "object" || value === null) return {};
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      );
    };
    return { genres: clean(genres), people: clean(people) };
  } catch {
    return emptyAffinity();
  }
}

export function readAffinity(): Affinity {
  if (typeof sessionStorage === "undefined") return emptyAffinity();
  try {
    return parseAffinity(sessionStorage.getItem(AFFINITY_STORAGE_KEY));
  } catch {
    return emptyAffinity();
  }
}

export function writeAffinity(affinity: Affinity): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(AFFINITY_STORAGE_KEY, JSON.stringify(affinity));
  } catch {
    // A full or blocked sessionStorage must never break playback.
  }
}
