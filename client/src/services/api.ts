/**
 * HTTP client for the external movie pipeline.
 *
 * The Python scraper/backend (Flask/FastAPI) exposes `GET /api/movies` and
 * returns a JSON array in this shape, with `stream_url` pointing at an actual
 * playable video file or stream (MP4/HLS) — never a third-party embed. The
 * base URL is configurable through `VITE_MOVIE_API_BASE_URL` and defaults to
 * the local development server.
 */
export type StreamQuality =
  | "4K"
  | "1080p"
  | "720p"
  | "480p"
  | "320p";

export interface StreamVariant {
  quality: StreamQuality;
  url: string;
  width: number;
  height: number;
  size: number;
}

export interface StreamSubtitle {
  label: string;
  lang: string;
  url: string;
}

export interface StreamEpisode {
  season: number;
  number: number;
  title: string;
}

export interface StreamMovie {
  id: string;
  title: string;
  poster_url: string;
  stream_url: string;
  streams?: StreamVariant[];
  subtitles?: StreamSubtitle[];
  episodes?: StreamEpisode[];
  year?: number | null;
  topics?: string[];
  _downloads?: number;
  _addeddate?: string;
}

/** Order of quality tiers, best -> worst. */
export const STREAM_QUALITY_ORDER: StreamQuality[] = [
  "4K",
  "1080p",
  "720p",
  "480p",
  "320p",
];

/**
 * Return the movie's requested quality variant, preferring the largest tier no
 * higher than the player's preload budget. Falls back to `stream_url` (the
 * backend's default, generally the fastest-start tier).
 */
export function pickStreamVariant(
  movie: StreamMovie,
  quality?: StreamQuality
): { variant?: StreamVariant; url: string } {
  if (movie.streams?.length) {
    if (quality) {
      const found = movie.streams.find(s => s.quality === quality);
      if (found) return { variant: found, url: found.url };
    }
    const best = movie.streams[0];
    return { variant: best, url: best.url };
  }
  return { url: movie.stream_url };
}

/** Same-origin relay URL for archive.org movie bytes (see /api/movies/stream). */
export function proxiedStreamUrl(url: string): string {
  return `${MOVIE_API_BASE_URL}/api/movies/stream?url=${encodeURIComponent(url)}`;
}

/** Base URL of the movie backend. In dev, Vite proxies /api to Flask. */
export const MOVIE_API_BASE_URL =
  import.meta.env.VITE_MOVIE_API_BASE_URL ?? "";

function isStreamMovie(value: unknown): value is StreamMovie {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.poster_url === "string" &&
    typeof record.stream_url === "string"
  );
}

/**
 * Fetch the movie catalog from the Python backend and normalize it to
 * `StreamMovie` objects. Throws on network or HTTP errors so callers can
 * surface a meaningful "backend unreachable" state instead of an empty grid.
 */
export async function fetchMovies(): Promise<StreamMovie[]> {
  const response = await fetch(`${MOVIE_API_BASE_URL}/api/movies`);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Movie backend returned an unexpected payload shape");
  }
  return data.filter(isStreamMovie);
}

/**
 * Session-scoped catalog cache. The catalog is fetched once and reused for
 * subsequent play requests so the Play button resolves streams without an
 * extra network call per movie.
 */
let moviesCache: Promise<StreamMovie[]> | null = null;

export async function getStreamCatalog(force = false): Promise<StreamMovie[]> {
  if (force || !moviesCache) {
    moviesCache = fetchMovies().catch(error => {
      moviesCache = null;
      throw error;
    });
  }
  return moviesCache;
}

export interface ResolvedStream {
  stream: StreamMovie;
  exact: boolean;
}

/** Thrown when the backend has no playable title for the requested search. */
export class StreamNotFoundError extends Error {
  constructor(title: string) {
    super(`No playable stream found for "${title}"`);
    this.name = "StreamNotFoundError";
  }
}

function isResolvePayload(value: unknown): value is {
  movie: StreamMovie;
  exact: boolean;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return isStreamMovie(record.movie) && typeof record.exact === "boolean";
}

/**
 * Resolve playback for a metadata title through the movie backend. The backend
 * matches against its catalog and, when nothing is found, scrapes a playable
 * source on demand and adds it to the platform before returning it. Only
 * confident matches play — a same-named film with a different year (or a
 * look-alike title) is never served.
 *
 * @param title metadata title from the catalog
 * @param year release year, used to reject same-name-but-different-film matches
 * @throws `StreamNotFoundError` when no playable title exists, or an `Error`
 * when the backend is unreachable.
 */
export async function resolveStream(
  title: string,
  year?: number | null
): Promise<ResolvedStream> {
  const response = await fetch(`${MOVIE_API_BASE_URL}/api/movies/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(year ? { title, year } : { title }),
  });
  if (response.status === 404) throw new StreamNotFoundError(title);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isResolvePayload(payload)) {
    throw new Error("Movie backend returned an unexpected payload shape");
  }
  return { stream: payload.movie, exact: payload.exact };
}

export interface MovieFeeds {
  featured: StreamMovie[];
  recent: StreamMovie[];
  popular: StreamMovie[];
}

function isFeedsPayload(value: unknown): value is MovieFeeds {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.featured) &&
    Array.isArray(record.recent) &&
    Array.isArray(record.popular)
  );
}

/**
 * Fetch the shelf feeds (featured / recent / popular) from the backend. Every
 * returned title is already verified-playable, so shelves built from these can
 * stream immediately on click.
 */
export async function fetchFeeds(): Promise<MovieFeeds> {
  const response = await fetch(`${MOVIE_API_BASE_URL}/api/movies/feeds`);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isFeedsPayload(payload)) {
    throw new Error("Movie backend returned an unexpected feeds shape");
  }
  return payload;
}

/** A preview trailer embed pointer returned by the movie backend. */
export interface TrailerInfo {
  provider: string;
  id: string;
  title?: string;
}

function isTrailerPayload(value: unknown): value is { trailer?: TrailerInfo } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { trailer?: unknown };
  if (!record.trailer) return true;
  const trailer = record.trailer as { provider?: unknown; id?: unknown };
  return (
    typeof trailer.provider === "string" && typeof trailer.id === "string"
  );
}

/**
 * Resolve the official preview trailer for a title through the movie backend.
 * The backend consults TMDB (year-qualified) so the preview always belongs to
 * the requested film. Returns null when no trailer exists — the caller then
 * falls back to backdrop artwork on hover.
 */
export async function fetchTrailer(
  title: string,
  year?: number | null
): Promise<TrailerInfo | null> {
  const url = new URL(`${MOVIE_API_BASE_URL}/api/movies/trailer`);
  url.searchParams.set("title", title);
  if (year) url.searchParams.set("year", String(year));
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isTrailerPayload(payload)) {
    throw new Error("Movie backend returned an unexpected trailer shape");
  }
  return payload.trailer ?? null;
}

/** Today's deterministic "Movie of the Day", or null when unavailable. */
export async function fetchTodaysPick(): Promise<StreamMovie | null> {
  const response = await fetch(`${MOVIE_API_BASE_URL}/api/movies/todays-pick`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  const record = payload as { movie?: unknown } | null;
  if (!record || !isStreamMovie(record.movie)) return null;
  return record.movie;
}
