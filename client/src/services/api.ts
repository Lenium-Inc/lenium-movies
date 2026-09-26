/**
 * HTTP client for the external movie pipeline.
 *
 * The Python scraper/backend (Flask/FastAPI) exposes `GET /api/movies` and
 * returns a JSON array in this shape, with `stream_url` pointing at an actual
 * playable video file or stream (MP4/HLS) — never a third-party embed. The
 * base URL is configurable through `VITE_MOVIE_API_BASE_URL` and defaults to
 * the local development server.
 */
export type StreamQuality = "4K" | "1080p" | "720p" | "480p" | "320p";

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
  /** Ordered playable source candidates (primary first) for auto-cycling. */
  sources?: string[];
  /** Backdrop image URL from TMDB (original size). */
  backdrop_url?: string;
  /** TMDB overview/synopsis. */
  overview?: string;
  /** TMDB vote average (0-10). */
  vote_average?: number;
  /** TMDB popularity score. */
  popularity?: number;
  /** TMDB genre names. */
  genres?: string[];
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

/**
 * Base URL of the movie backend.
 *
 * Local dev: empty, so every request is a relative `/api/...` call that Vite
 * proxies to the Flask process on :5000.
 *
 * Dev: unset, and Vite proxies /api to http://localhost:5000 (vite.config.ts).
 *
 * Deployed: the Vercel deployment serves only this SPA and hosts no API of its
 * own, so a relative `/api/...` call resolves against Vercel and comes back as
 * the HTML shell -- which surfaces as a cryptic `Unexpected token '<'` JSON
 * parse error and an empty catalogue, not as an obvious configuration error.
 *
 * Vite inlines VITE_MOVIE_API_BASE_URL at build time, and a variable that is
 * present but blank is not the same as an absent one: that is the shape
 * .env.example ships, and what you get from pasting that line into a dashboard.
 * So production falls back to the deployed backend rather than silently
 * pointing at the SPA's own /api/*. `warnUsingFallbackOrigin` below reports
 * whenever that fallback is what got used.
 *
 * Two things to know about the fallback. It is the origin every user's
 * `Authorization: Bearer` token is sent to (auth.ts), and *.onrender.com is a
 * reclaimable namespace: deleting the Render project frees the name for
 * someone else to register, after which tokens for this app are POSTed to
 * whoever answers. Putting a custom domain on the backend closes that off, and
 * setting VITE_MOVIE_API_BASE_URL overrides the fallback entirely -- including
 * setting it to "/" to deliberately ship same-origin behind a proxy.
 */
const CONFIGURED_BACKEND_ORIGIN = (
  import.meta.env.VITE_MOVIE_API_BASE_URL || import.meta.env.VITE_API_URL || ""
).trim();

const FALLBACK_BACKEND_ORIGIN = "https://vy-e721.onrender.com";

export const MOVIE_API_BASE_URL = (
  CONFIGURED_BACKEND_ORIGIN ||
  (import.meta.env.PROD ? FALLBACK_BACKEND_ORIGIN : "")
).replace(/\/+$/, "");

function warnUsingFallbackOrigin() {
  if (!import.meta.env.PROD || CONFIGURED_BACKEND_ORIGIN) return;
  console.warn(
    "[config] VITE_MOVIE_API_BASE_URL was absent or empty at build time, so " +
      `this build is using the hardcoded fallback ${FALLBACK_BACKEND_ORIGIN}. ` +
      "If that is not expected, set the variable in Vercel under the scope " +
      "matching this deployment (Preview builds do not read Production values) " +
      "and redeploy -- Vite inlines it, so a rebuild is required."
  );
}

warnUsingFallbackOrigin();

/** Build a full API URL for the movie backend. */
export function apiUrl(path: string): string {
  return `${MOVIE_API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

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
 * An HTTP-level failure from the movie backend, carrying the status code.
 *
 * Feed callers need to tell a TMDB rate limit (429) apart from a genuine
 * outage, and previously could only match on the message text.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, context: string) {
    super(`${context} failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when the backend refused because we exceeded TMDB's rate limit. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

/**
 * Live search against the movie backend's TMDB search endpoint (`/api/search`).
 * Returns TMDB results with baked `stream_url` (embeds for TV wire the
 * default S1E1) and — for TV entries — `seasons`/`episodes_per_season` that
 * drive the episode matrix in the details view.
 *
 * Returns an empty array for an empty query and throws when the backend is
 * unreachable so callers can fall back to their metadata provider.
 */
export async function searchCatalog(query: string): Promise<StreamMovie[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/search?q=${encodeURIComponent(trimmed)}`
  );
  if (!response.ok) {
    throw new ApiError(response.status, "Search");
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(
      "Movie backend returned an unexpected search payload shape"
    );
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

function normalizeResolvedMovie(value: unknown): StreamMovie | null {
  if (!isResolveMovie(value)) return null;
  const mediaType = value.media_type === "tv" ? "tv" : "movie";
  return {
    id: String(value.id),
    title: String(value.title),
    poster_url: typeof value.poster_url === "string" ? value.poster_url : "",
    backdrop_url:
      typeof value.backdrop_url === "string" ? value.backdrop_url : "",
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
    overview: typeof value.overview === "string" ? value.overview : "",
    vote_average:
      typeof value.vote_average === "number" ? value.vote_average : undefined,
    popularity:
      typeof value.popularity === "number" ? value.popularity : undefined,
    genres: Array.isArray(value.genres) ? value.genres : [],
    ...(value.episodes && Array.isArray(value.episodes)
      ? { episodes: value.episodes }
      : {}),
    ...(value.mirrors && Array.isArray(value.mirrors)
      ? {
          mirrors: value.mirrors.filter((mirror): mirror is StreamMirror =>
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
  /** TMDB ID for direct resolution (preferred over title/year search). */
  tmdbId?: string;
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
 * Pass `options.tmdbId` for direct resolution by TMDB ID (more reliable than
 * title/year search).
 *
 * @param title metadata title from the catalog
 * @param year release year, used to reject same-name-but-different-film matches
 * @param options episode targeting and optional TMDB ID, used for series playback
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
    if (options.tmdbId) body.id = options.tmdbId;
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
  /** Ordered list of candidate source URLs (primary first) for auto-cycling. */
  sources?: string[];
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
  /**
   * Bypasses the backend's direct-source cache and forces a fresh scrape.
   * Used by the player's stream-fallback loop while it polls for a playable
   * source.
   */
  refresh?: boolean;
}

function isGetStreamPayload(value: unknown): value is {
  success: boolean;
  activeSource: string;
  sources?: string[];
  mirrors: StreamMirror[];
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.success === true && typeof record.activeSource === "string";
}

/**
 * Stream resolution is the slowest call in the app. A Render free-tier
 * instance that has scaled to zero needs 15-20s to boot before it answers
 * /api/get-stream, and `fetch` has no default timeout, so a cold start was
 * indistinguishable from a hung request -- the resolver had no way to say "still
 * waiting" and the UI had nothing to show but the generic spinner.
 *
 * 30s clears the cold-start window while still bounding a genuinely dead
 * backend. Catalog and metadata calls are left alone: they answer in under a
 * second and a long timeout there would only delay an honest error.
 */
export const STREAM_RESOLVE_TIMEOUT_MS = 30_000;

/** Distinguishes "the resolver is still booting" from a real failure. */
export class StreamTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stream resolver did not respond within ${timeoutMs / 1000}s`);
    this.name = "StreamTimeoutError";
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // Only the timer aborts this controller, so a rejection here is a timeout
    // rather than a genuine network failure. Callers retry the former silently
    // and surface the latter.
    if (controller.signal.aborted) throw new StreamTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a direct playable source for an already-known TMDB title through the
 * backend's `/api/get-stream` endpoint. The backend returns an `activeSource`
 * (the URL the player boots on) plus a `mirrors` list of alternate servers.
 *
 * For TV entries pass the selected `season`/`episode` so the baked embed URL —
 * and every mirror — targets the exact episode the viewer picked.
 *
 * @throws `StreamTimeoutError` if the backend does not answer within
 * `STREAM_RESOLVE_TIMEOUT_MS`, which usually means a cold start rather than a
 * dead service. @throws `Error` when the backend is unreachable or returns an
 * unexpected shape.
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
  if (input.refresh) params.set("refresh", "1");
  const response = await fetchWithTimeout(
    `${MOVIE_API_BASE_URL}/api/get-stream?${params.toString()}`,
    {},
    STREAM_RESOLVE_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isGetStreamPayload(payload)) {
    throw new Error("Movie backend returned an unexpected get-stream shape");
  }
  const mirrors = Array.isArray(payload.mirrors) ? payload.mirrors : [];
  const rawSources =
    Array.isArray(payload.sources) && payload.sources.length > 0
      ? payload.sources
      : [payload.activeSource, ...mirrors.map((m) => m.url)];
  const sources = Array.from(
    new Set(rawSources.filter((url): url is string => typeof url === "string" && url.length > 0))
  );
  return { url: payload.activeSource, sources, mirrors };
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
  return typeof trailer.provider === "string" && typeof trailer.id === "string";
}

/**
 * Fetch the official preview trailer for a title through the movie backend.
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
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/movies/trailer?${params.toString()}`
  );
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
 * Fetch trailer by TMDB ID directly from TMDB via backend.
 * Uses append_to_response=videos to get YouTube trailer key.
 */
export async function fetchTrailerByTmdbId(
  tmdbId: string | number
): Promise<TrailerInfo | null> {
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/catalog/movieTrailer?id=${tmdbId}`
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data = await response.json();
  if (data && typeof data === "string") {
    return { provider: "youtube", id: data };
  }
  return null;
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
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/episodes?${params.toString()}`
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isEpisodeDetailPayload(payload)) return null;
  return payload.episode;
}

function isEpisodeDetailPayload(
  value: unknown
): value is { episode: StreamEpisode } {
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
export async function searchSuggest(
  query: string
): Promise<SearchSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) return [];
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/search/suggest?q=${encodeURIComponent(trimmed)}`
  );
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(
      "Movie backend returned an unexpected suggest payload shape"
    );
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

export async function fetchTrending(
  params: TrendingParams = {}
): Promise<StreamMovie[]> {
  const cacheKey = `trending:${params.time_window || "week"}:${params.media_type || "all"}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  if (params.time_window) query.set("time_window", params.time_window);
  if (params.media_type) query.set("media_type", params.media_type);
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/movies/trending?${query.toString()}`
  );
  if (!response.ok) {
    throw new ApiError(response.status, "Trending");
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(
      "Movie backend returned an unexpected trending payload shape"
    );
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

export async function fetchPopular(
  params: PopularParams = {}
): Promise<StreamMovie[]> {
  const cacheKey = `popular:${params.media_type || "movie"}:${params.page || 1}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  if (params.media_type) query.set("media_type", params.media_type);
  if (params.page) query.set("page", String(params.page));
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/movies/popular?${query.toString()}`
  );
  if (!response.ok) {
    throw new ApiError(response.status, "Popular");
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(
      "Movie backend returned an unexpected popular payload shape"
    );
  }
  const result = data.filter(isStreamMovie);
  setCache(cacheKey, result);
  return result;
}

/**
 * Fetch currently playing movies from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface NowPlayingParams {
  page?: number;
}

export async function fetchNowPlaying(
  params: NowPlayingParams = {}
): Promise<StreamMovie[]> {
  const cacheKey = `now_playing:${params.page || 1}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/movies/now_playing?${query.toString()}`
  );
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(
      "Movie backend returned an unexpected now_playing payload shape"
    );
  }
  const result = data.filter(isStreamMovie);
  setCache(cacheKey, result);
  return result;
}

/** A unified catalog card returned by `/api/catalog/discover`. */
export interface CatalogItem {
  /** Namespaced provider id (e.g. `tmdb-123`, `omdb-tt…`). */
  id: string;
  /** TMDB id when the title has one (drives `/watch/:id`). */
  tmdb_id?: string | number | null;
  imdb_id?: string;
  title: string;
  media_type?: "movie" | "tv";
  year?: number | null;
  poster_url?: string;
  backdrop_url?: string;
  overview?: string;
  vote_average?: number | null;
  popularity?: number | null;
  genres?: string[];
  runtime?: number | null;
  director?: string | null;
  cast?: string[];
  country?: string | null;
  language?: string | null;
  release_date?: string | null;
  source?: string;
}

export interface DiscoverResult {
  items: CatalogItem[];
  page: number;
  per_page: number;
  total: number;
  has_more: boolean;
  source: "cache" | "live";
}

export interface DiscoverParams {
  media_type?: "movie" | "tv" | "all";
  page?: number;
  per_page?: number;
  genre?: string;
  /**
   * Session-local taste signals. The client ranks results on its own either
   * way; these are sent so the catalogue can use them if it chooses to.
   */
  affinity_genres?: string;
  affinity_people?: string;
}

function isDiscoverResult(value: unknown): value is DiscoverResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.items) &&
    typeof record.page === "number" &&
    typeof record.per_page === "number" &&
    typeof record.has_more === "boolean"
  );
}

/**
 * Fetch a paginated, aggregated catalog page from the backend's DB-first
 * discover endpoint. The backend serves its seeded database and falls back to
 * a live multi-source aggregation (persisted) when a page isn't cached yet.
 */
export async function fetchDiscover(
  params: DiscoverParams = {}
): Promise<DiscoverResult> {
  const query = new URLSearchParams();
  query.set("media_type", params.media_type || "movie");
  query.set("page", String(params.page || 1));
  if (params.per_page && params.per_page !== 24) {
    query.set("per_page", String(params.per_page));
  }
  if (params.genre) query.set("genre", params.genre);
  if (params.affinity_genres) query.set("affinity_genres", params.affinity_genres);
  if (params.affinity_people) query.set("affinity_people", params.affinity_people);
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/catalog/discover?${query.toString()}`
  );
  if (!response.ok) {
    throw new ApiError(response.status, "Discover");
  }
  const data: unknown = await response.json();
  if (!isDiscoverResult(data)) {
    throw new Error(
      "Movie backend returned an unexpected discover payload shape"
    );
  }
  return data;
}

/**
 * Fetch currently airing TV shows from TMDB via backend.
 * Cached for 5 minutes to avoid redundant requests.
 */
export interface OnTheAirParams {
  page?: number;
}

export async function fetchOnTheAir(
  params: OnTheAirParams = {}
): Promise<StreamMovie[]> {
  const cacheKey = `on_the_air:${params.page || 1}`;
  const cached = getCached<StreamMovie[]>(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  const response = await fetch(
    `${MOVIE_API_BASE_URL}/api/movies/on_the_air?${query.toString()}`
  );
  if (!response.ok) {
    throw new Error(`Movie backend responded with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(
      "Movie backend returned an unexpected on_the_air payload shape"
    );
  }
  const result = data.filter(isStreamMovie);
  setCache(cacheKey, result);
  return result;
}
