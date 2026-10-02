/**
 * The domain boundary: backend payloads in, catalog `Movie` out.
 *
 * Why this module exists
 * ----------------------
 * Three backend shapes reach the UI -- `StreamMovie` (playable, embed-ready),
 * `CatalogItem` (unified DB-cached card) and TMDB's own series/movie records --
 * and each one was being translated to a `Movie` by its own mapper. Three mappers
 * meant three places for the same rule to be written and two of them to disagree
 * with each other, which is exactly how a card started showing one field's
 * fallback copy while its sibling showed another's.
 *
 * The one mapper below is the whole translation. Where a source has no value for
 * a field, the field is `null` and the *component* decides what to render: a null
 * score is not the same as a zero score, and baking "Playable right now" into
 * the data made every unrated card read like an advertisement.
 *
 * Ids
 * ---
 * `Movie.id` is numeric because the My List, ratings and history stores are keyed
 * by it, but the backend also carries non-TMDB ids (archive.org). Those are folded
 * to a stable hash here rather than at each call site, so the same exotic title
 * always lands on the same key. `providerId` keeps the original string, because
 * that is what the resolver has to be handed.
 */

import type { Movie } from "@/components/movies/types";

/** The subset every backend card shape satisfies. */
export interface MediaSource {
  id?: string | number | null;
  tmdb_id?: string | number | null;
  media_type?: string | null;
  title?: string | null;
  name?: string | null;
  year?: number | string | null;
  release_date?: string | null;
  overview?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number | null;
  popularity?: number | null;
  genres?: string[] | null;
  runtime?: number | null;
  director?: string | null;
  cast?: string[] | null;
  country?: string | null;
  language?: string | null;
  seasons?: number | null;
  episodes_per_season?: number | null;
}

/**
 * Stable numeric fallback for non-TMDB ids.
 *
 * FNV-1a rather than `String.length`: a one-character title and a nine-character
 * title both hash to 9 under length, which collides the first time two such
 * titles share a My List.
 */
export function stableId(id: string): number {
  const parsed = Number(id);
  if (Number.isFinite(parsed)) return parsed;
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) || 1;
}

function mediaTypeOf(item: MediaSource): "movie" | "tv" {
  return item.media_type === "tv" ? "tv" : "movie";
}

function yearOf(item: MediaSource): number | null {
  if (typeof item.year === "number")
    return Number.isFinite(item.year) ? item.year : null;
  if (typeof item.year === "string") {
    const parsed = Number(item.year);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (item.release_date) {
    const year = Number(item.release_date.slice(0, 4));
    return Number.isFinite(year) ? year : null;
  }
  return null;
}

function genreList(item: MediaSource): string[] {
  const genres = item.genres?.filter(Boolean) ?? [];
  // A card with no genres still needs *a* label, and the honest one is its type:
  // inventing a genre is what made filtered views disagree with this card.
  return genres.length
    ? genres
    : [mediaTypeOf(item) === "tv" ? "Series" : "Movie"];
}

/**
 * The id playback is resolved against.
 *
 * A TMDB id is preferred and kept verbatim; anything else falls back to the
 * provider's own id, which may or may not resolve downstream but is the only
 * handle there is.
 */
export function playbackId(item: MediaSource): string {
  if (item.tmdb_id != null && String(item.tmdb_id).trim() !== "") {
    return String(item.tmdb_id).trim();
  }
  return String(item.id ?? "").trim();
}

/** Map any backend card shape to the catalog's `Movie`. */
export function toMovie(item: MediaSource): Movie {
  const mediaType = mediaTypeOf(item);
  const rawId = playbackId(item);
  const poster = item.poster_url || item.poster_path || null;
  const backdrop = item.backdrop_url || item.backdrop_path || null;

  return {
    id: stableId(rawId),
    providerId: rawId,
    title: item.title || item.name || "Untitled",
    year: yearOf(item),
    runtime: typeof item.runtime === "number" ? item.runtime : null,
    rating: null,
    score: typeof item.vote_average === "number" ? item.vote_average : null,
    genre: genreList(item),
    poster,
    backdrop,
    // No invented copy. An empty synopsis is a fact about the data; a friendly
    // sentence is a lie the UI would have to be trusted to repeat everywhere.
    synopsis: item.overview || "",
    director: item.director || null,
    cast: item.cast || [],
    country: item.country || null,
    language: item.language || null,
    releaseDate: item.release_date || null,
    source: "tmdb",
    mediaType,
    vote_average: item.vote_average ?? undefined,
    genres: item.genres ?? undefined,
    popularity: item.popularity ?? undefined,
    overview: item.overview || undefined,
    backdrop_url: backdrop ?? undefined,
    seasons: item.seasons ?? undefined,
    episodes_per_season: item.episodes_per_season ?? undefined,
  };
}

export default toMovie;
