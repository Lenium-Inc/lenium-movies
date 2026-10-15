/**
 * Metadata for a title, without resolving anything playable.
 *
 * `/api/movies/meta` answers one TMDB details call (recommendations and
 * credits appended) into the catalog's own `Movie` plus a compact shelf of
 * neighbours. The details sheet, the watch page's header and the title page
 * all read it; none of them ever needed the provider-chain walk that
 * `/api/movies/resolve` performs -- which is why this lives apart from the
 * player code: importing metadata from `pages/Watch` dragged hls.js and
 * dash.js into every consumer's bundle, for a director's name.
 */

import { apiUrl, MOVIE_RESOLVE_TIMEOUT_MS } from "@/services/api";
import type {
  CastMember,
  Movie,
  SimilarItem,
} from "@/components/movies/types";

/** What `/api/movies/meta` answers: one title's full record plus the shelf
 *  of neighbours the window draws underneath it. */
export interface MovieMeta {
  movie: Movie;
  similar: SimilarItem[];
}

/** Retry statuses worth asking again: timeouts, rate limits, and the
 *  transient end of the server. A 400 is a decision and repeating it only
 *  spends the same 1.2s to hear the same answer. */
function isWorthRetrying(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

const RETRY_DELAY_MS = 1200;

/** The meta route answers untyped JSON, so every field is `unknown`. Coerce a
 *  value that is actually a string and treat anything else as absent, rather
 *  than letting a number or object flow into a `string | null` field. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

type MetaMovie = {
  id?: unknown;
  title?: unknown;
  year?: unknown;
  runtime?: unknown;
  rating?: unknown;
  vote_average?: unknown;
  genres?: unknown;
  director?: unknown;
  cast?: unknown;
  country?: unknown;
  language?: unknown;
  release_date?: unknown;
  media_type?: unknown;
  poster_url?: unknown;
  backdrop_url?: unknown;
  overview?: unknown;
  seasons?: unknown;
  episodes_per_season?: unknown;
  cast_members?: unknown;
};

/** Coerce the meta route's cast rows into linkable people. The same identity
 *  rule the wall uses applies: no id, no row -- a person the viewer cannot
 *  follow anywhere might as well not be in the credits. */
function mapCastMembers(value: unknown): CastMember[] {
  if (!Array.isArray(value)) return [];
  const members: CastMember[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== "object") continue;
    const raw = entry as {
      id?: unknown;
      name?: unknown;
      character?: unknown;
      profile_path?: unknown;
    };
    if (raw.id == null || typeof raw.name !== "string" || !raw.name) continue;
    members.push({
      id: String(raw.id),
      name: raw.name,
      character: typeof raw.character === "string" ? raw.character : "",
      profilePath:
        typeof raw.profile_path === "string" && raw.profile_path
          ? raw.profile_path
          : null,
    });
  }
  return members;
}

/** Map the meta route's record (the resolve payload's movie half, minus the
 *  stream fields) onto the catalog's `Movie`. */
function mapMetaMovie(m: MetaMovie): Movie {
  const mediaType = m.media_type === "tv" ? "tv" : "movie";
  const year = m.year ? parseInt(String(m.year), 10) : null;
  const runtime = typeof m.runtime === "number" ? m.runtime : null;
  const rating = asString(m.rating);
  const score = typeof m.vote_average === "number" ? m.vote_average : null;
  const genre = Array.isArray(m.genres) ? m.genres : [];
  const director = asString(m.director);
  const cast = Array.isArray(m.cast) ? m.cast : [];
  const country = asString(m.country);
  const language = asString(m.language);
  const releaseDate = asString(m.release_date);

  return {
    id: parseInt(String(m.id), 10),
    providerId: String(m.id),
    title: String(m.title ?? ""),
    year,
    runtime,
    rating,
    score,
    genre,
    poster: asString(m.poster_url),
    backdrop: asString(m.backdrop_url) || asString(m.poster_url),
    synopsis: asString(m.overview) ?? "",
    director,
    source: "tmdb",
    mediaType,
    cast,
    country,
    language,
    releaseDate,
    castMembers: mapCastMembers(m.cast_members),
    ...(typeof m.seasons === "number" ? { seasons: m.seasons } : {}),
    ...(typeof m.episodes_per_season === "number"
      ? { episodes_per_season: m.episodes_per_season }
      : {}),
  };
}

/** Map one wall entry. The poster stays a bare TMDB path: the surfaces that
 *  draw it own an image helper that re-splices any rendition into it. */
function mapSimilarItem(raw: {
  id?: unknown;
  title?: unknown;
  year?: unknown;
  media_type?: unknown;
  poster_path?: unknown;
  vote_average?: unknown;
  overview?: unknown;
}): SimilarItem | null {
  if (raw == null || raw.id == null || !raw.title) return null;
  const year =
    typeof raw.year === "number"
      ? raw.year
      : parseInt(String(raw.year ?? ""), 10) || null;
  return {
    providerId: String(raw.id),
    mediaType: raw.media_type === "tv" ? "tv" : "movie",
    title: String(raw.title),
    year,
    poster: typeof raw.poster_path === "string" && raw.poster_path
      ? raw.poster_path
      : null,
    score: typeof raw.vote_average === "number" ? raw.vote_average : null,
    synopsis: typeof raw.overview === "string" ? raw.overview : "",
  };
}

/**
 * Full metadata plus a similar-titles wall, without resolving a stream.
 *
 * This used to be `/api/movies/resolve` -- which walked every provider chain
 * behind a headless browser to answer a synopsis. The meta route answers the
 * same record (and the neighbours) from one cached TMDB call, so opening a
 * window or booting a page no longer queues a render that exists only to
 * decide *what* to play, not *whether* it can.
 */
export async function fetchMovieMeta(
  tmdbId: string,
  kind: "movie" | "tv" = "movie"
): Promise<MovieMeta | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOVIE_RESOLVE_TIMEOUT_MS);
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(apiUrl("/api/movies/meta"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tmdbId, media_type: kind }),
        signal: controller.signal,
      });
      if (response.ok || !isWorthRetrying(response.status)) break;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    if (!response?.ok) return null;
    const data = await response.json();
    if (!data.movie) return null;

    const similar: SimilarItem[] = Array.isArray(data.similar)
      ? data.similar.map(mapSimilarItem).filter((s: SimilarItem | null): s is SimilarItem => s !== null)
      : [];
    return { movie: mapMetaMovie(data.movie), similar };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Metadata only. Kept for callers that do not need the neighbours wall. */
export async function fetchMovieDetails(
  tmdbId: string,
  kind: "movie" | "tv" = "movie"
): Promise<Movie | null> {
  const meta = await fetchMovieMeta(tmdbId, kind);
  return meta ? meta.movie : null;
}
