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

/** An alternative playable embed/web source served by the backend's
 * `/api/get-stream` contract (`mirrors`). The player lets the viewer switch
 * between `stream_url` and these mirrors at runtime. */
export interface StreamMirror {
  name: string;
  url: string;
}

export interface StreamEpisode {
  season: number;
  number: number;
  title: string;
  overview?: string;
  still_path?: string;
  still_url?: string;
  air_date?: string;
  runtime?: number;
  vote_average?: number;
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
  /** Whether the payload is a feature film or a TV series. */
  media_type?: "movie" | "tv";
  /** Season count for TV payloads (drives the episode matrix). */
  seasons?: number;
  /** Episodes-per-season count for TV payloads (drives the episode matrix). */
  episodes_per_season?: number;
  /** Season the returned `stream_url` targets (TV payloads). */
  season?: number;
  /** Episode the returned `stream_url` targets (TV payloads). */
  episode?: number;
  /** Alternate embed sources returned by `/api/get-stream`. */
  mirrors?: StreamMirror[];
  /** Backdrop image URL from TMDB (original size). */
  backdrop_url?: string;
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

/**
 * Live search against the movie backend's updated search endpoint (`/api/search`).
 * The backend merges local playable-catalog matches with TMDB results, so every
 * returned title already carries a baked `stream_url` (embeds for TV wire the
 * default S1E1) and — for TV entries — `seasons`/`episodes_per_season` that
 * drive the episode matrix in the details view.
 *
 * Returns an empty array for an empty query and throws when the backend is
 * unreachable so callers can fall back to their metadata provider.
 */
export async function searchCatalog(query: string): Promise<StreamMovie[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Movie backend returned an unexpected search payload shape");
  }
  return data.filter(isStreamMovie);
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

/** Normalize the year the backend reports (string when it came from TMDB). */
function toStreamYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The resolve response movie is embed-oriented: it always carries an id,
 * title, and `stream_url`, but only sometimes a `poster_url` (resolved TV
 * entries and bare TMDB matches omit it) and reports `year` as a string when
 * it came from TMDB. This guard + normalizer keep the resolve contract happy
 * with the shape the updated backend actually returns.
 */
function isResolveMovie(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.stream_url === "string"
  );
}

function normalizeResolvedMovie(
  value: unknown
): StreamMovie | null {
  if (!isResolveMovie(value)) return null;
  const mediaType = value.media_type === "tv" ? "tv" : "movie";
  return {
    id: String(value.id),
    title: String(value.title),
    poster_url: typeof value.poster_url === "string" ? value.poster_url : "",
    stream_url: String(value.stream_url),
    year: toStreamYear(value.year),
    media_type: mediaType,
    season:
      typeof value.season === "number"
        ? value.season
        : Number(value.season) || 1,
    episode:
      typeof value.episode === "number"
        ? value.episode
        : Number(value.episode) || 1,
    seasons:
      typeof value.seasons === "number"
        ? value.seasons
        : Number(value.seasons) || 1,
    episodes_per_season:
      typeof value.episodes_per_season === "number"
        ? value.episodes_per_season
        : Number(value.episodes_per_season) || 1,
    ...(value.mirrors && Array.isArray(value.mirrors)
      ? {
          mirrors: value.mirrors.filter(
            (mirror): mirror is StreamMirror =>
              Boolean(
                mirror &&
                  typeof (mirror as StreamMirror).name === "string" &&
                  typeof (mirror as StreamMirror).url === "string"
              )
          ),
        }
      : {}),
  };
}

function isResolvePayload(value: unknown): value is {
  movie: StreamMovie;
  exact: boolean;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Boolean(normalizeResolvedMovie(record.movie)) &&
    typeof record.exact === "boolean"
  );
}

/** Optional media targeting for stream resolution (TV series playback). */
export interface StreamResolveOptions {
  /** Season of a series to resolve (ignored for movies). */
  season?: number;
  /** Episode of a series to resolve (ignored for movies). */
  episode?: number;
}

/**
 * Resolve playback for a metadata title through the movie backend. The backend
 * matches against its catalog and, when nothing is found, scrapes a playable
 * source on demand and adds it to the platform before returning it. Only
 * confident matches play — a same-named film with a different year (or a
 * look-alike title) is never served.
 *
 * For TV series pass `options.season`/`options.episode` so the backend bakes
 * the exact episode into the returned embed URL.
 *
 * @param title metadata title from the catalog
 * @param year release year, used to reject same-name-but-different-film matches
 * @param options episode targeting, used for series playback
 * @throws `StreamNotFoundError` when no playable title exists, or an `Error`
 * when the backend is unreachable.
 */
export async function resolveStream(
  title: string,
  year?: number | null,
  options?: StreamResolveOptions
): Promise<ResolvedStream> {
  const body: Record<string, unknown> = year ? { title, year } : { title };
  if (options) {
    if (options.season) body.season = options.season;
    if (options.episode) body.episode = options.episode;
  }
  const response = await fetch(`${MOVIE_API_BASE_URL}/api/movies/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 404) throw new StreamNotFoundError(title);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isResolvePayload(payload)) {
    throw new Error("Movie backend returned an unexpected payload shape");
  }
  const movie = normalizeResolvedMovie(
    (payload as { movie: unknown }).movie
  ) as StreamMovie;
  return { stream: movie, exact: payload.exact };
}

/** An id-based direct stream source returned by `/api/get-stream`. */
export interface StreamSource {
  /** Primary embed/web URL (`activeSource`). */
  url: string;
  /** Alternate servers the player can switch between. */
  mirrors: StreamMirror[];
}

export interface GetStreamRequest {
  /** TMDB id (also accepts the backend's numeric `id` parameter). */
  tmdbId: string;
  mediaType: "movie" | "tv";
  /** Season to target (TV only; defaults to 1 on the backend). */
  season?: number;
  /** Episode to target (TV only; defaults to 1 on the backend). */
  episode?: number;
}

function isGetStreamPayload(value: unknown): value is {
  success: boolean;
  activeSource: string;
  mirrors: StreamMirror[];
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const mirrors = Array.isArray(record.mirrors)
    ? record.mirrors.filter(
        (mirror): mirror is StreamMirror =>
          Boolean(
            mirror &&
              typeof (mirror as StreamMirror).name === "string" &&
              typeof (mirror as StreamMirror).url === "string"
          )
      )
    : [];
  return record.success === true && typeof record.activeSource === "string";
}

/**
 * Resolve a direct playable source for an already-known TMDB title through the
 * backend's `/api/get-stream` endpoint. The backend returns an `activeSource`
 * (the URL the player boots on) plus a `mirrors` list of alternate servers.
 *
 * For TV entries pass the selected `season`/`episode` so the baked embed URL —
 * and every mirror — targets the exact episode the viewer picked.
 *
 * @throws `Error` when the backend is unreachable or returns an unexpected shape.
 */
export async function getStreamSource(
  input: GetStreamRequest
): Promise<StreamSource> {
  const params = new URLSearchParams();
  params.set("tmdb_id", input.tmdbId);
  params.set("media_type", input.mediaType);
  if (input.mediaType === "tv") {
    params.set("season", String(input.season ?? 1));
    params.set("episode", String(input.episode ?? 1));
  }
  const response = await fetch(`/api/get-stream?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isGetStreamPayload(payload)) {
    throw new Error("Movie backend returned an unexpected get-stream shape");
  }
  const mirrors = Array.isArray(payload.mirrors) ? payload.mirrors : [];
  return { url: payload.activeSource, mirrors };
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
  const params = new URLSearchParams();
  params.set("title", title);
  if (year) params.set("year", String(year));
  const response = await fetch(`/api/movies/trailer?${params.toString()}`);
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

/**
 * Fetch detailed episode metadata (synopsis, still, air date, etc.) from the backend.
 * The backend queries TMDB for the specific episode details.
 */
export async function fetchEpisodeDetails(
  tmdbId: string,
  season: number,
  episode: number
): Promise<StreamEpisode | null> {
  const params = new URLSearchParams();
  params.set("tmdb_id", tmdbId);
  params.set("season", String(season));
  params.set("episode", String(episode));
  const response = await fetch(`/api/episodes?${params.toString()}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isEpisodeDetailPayload(payload)) return null;
  return payload.episode;
}

function isEpisodeDetailPayload(value: unknown): value is { episode: StreamEpisode } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.episode === "object" && record.episode !== null;
}

export interface SearchSuggestion {
  id: string;
  title: string;
  poster_url: string;
  year?: string;
  media_type: "movie" | "tv";
}

/**
 * Fetch live search autocomplete suggestions from the backend.
 */
export async function searchSuggest(query: string): Promise<SearchSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) return [];
  const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(trimmed)}`);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Movie backend returned an unexpected suggest payload shape");
  }
  return data.filter(isSuggestion);
}

function isSuggestion(value: unknown): value is SearchSuggestion {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.poster_url === "string" &&
    (record.media_type === "movie" || record.media_type === "tv")
  );
}

// Simple in-memory cache for API responses
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const apiCache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = apiCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    apiCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  apiCache.set(key, { data, timestamp: Date.now() });
}

/**
 * Fetch trending movies/TV from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface TrendingParams {
  time_window?: "day" | "week";
  media_type?: "all" | "movie" | "tv";
}

export async function fetchTrending(params: TrendingParams = {}): Promise<StreamMovie[]> {
  const cacheKey = `trending:${params.time_window || "week"}:${params.media_type || "all"}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  if (params.time_window) query.set("time_window", params.time_window);
  if (params.media_type) query.set("media_type", params.media_type);
  const response = await fetch(`/api/movies/trending?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Movie backend returned an unexpected trending payload shape");
  }
  const result = data.filter(isStreamMovie);
  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch popular movies/TV from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface PopularParams {
  media_type?: "movie" | "tv";
  page?: number;
}

export async function fetchPopular(params: PopularParams = {}): Promise<StreamMovie[]> {
  const cacheKey = `popular:${params.media_type || "movie"}:${params.page || 1}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  if (params.media_type) query.set("media_type", params.media_type);
  if (params.page) query.set("page", String(params.page));
  const response = await fetch(`/api/movies/popular?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Movie backend returned an unexpected popular payload shape");
  }
  const result = data.filter(isStreamMovie);
  setCache(cacheKey, result);
  return result;
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
