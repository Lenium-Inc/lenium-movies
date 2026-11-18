/**
 * Direct TMDB catalogue fallback for the browser.
 *
 * ## Why this exists
 *
 * Every shelf in the app is normally served by the media API, which owns the
 * MovieBox catalogue. When that API is unreachable the home page has nothing to
 * render -- no hero, no shelves, no browse grid -- even though TMDB, the source
 * of the artwork and ratings the app already displays, is still available.
 *
 * This module is the emergency path: it talks to TMDB directly from the browser
 * so the catalogue keeps showing titles while the media API is down. It is a
 * *display* fallback only -- playback still needs the media API, so a title
 * opened from here will fail to play until the backend returns.
 *
 * ## The key is public
 *
 * `VITE_TMDB_API_KEY` is inlined into the client bundle at build time, which
 * means anyone can read it from the shipped JavaScript. That is acceptable for
 * a read-only TMDB key (TMDB's own docs describe the v3 key as public), but it
 * must never be a key with write access. Unset means the fallback is off and the
 * app keeps its normal "service unavailable" behaviour.
 */

import type { StreamMovie } from "@/services/api";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const TMDB_TIMEOUT_MS = 8_000;

/** Movie genre ids, keyed by the names the app filters on. */
const MOVIE_GENRES: Record<number, string> = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Sci-Fi",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
};

/** TV genre ids. TMDB numbers them differently from the movie list. */
const TV_GENRES: Record<number, string> = {
  10759: "Action & Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  10762: "Kids",
  9648: "Mystery",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi",
  10766: "Soap",
  10767: "Talk",
  10768: "War",
  37: "Western",
};

/** Reverse lookup used by the discover fallback's genre filter. */
const MOVIE_GENRE_IDS: Record<string, number> = {
  action: 28,
  adventure: 12,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 14,
  history: 36,
  horror: 27,
  music: 10402,
  mystery: 9648,
  romance: 10749,
  "sci-fi": 878,
  "science-fiction": 878,
  thriller: 53,
  war: 10752,
  western: 37,
};

const TV_GENRE_IDS: Record<string, number> = {
  action: 10759,
  adventure: 10759,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  kids: 10762,
  mystery: 9648,
  news: 10763,
  reality: 10764,
  "sci-fi": 10765,
  "science-fiction": 10765,
  fantasy: 10765,
  soap: 10766,
  talk: 10767,
  war: 10768,
  western: 37,
};

/** One result object as TMDB's list endpoints return it. */
interface TmdbItem {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  runtime?: number;
  number_of_seasons?: number;
  number_of_episodes?: number;
  genres?: { id?: number; name?: string }[];
  credits?: {
    cast?: { name?: string; character?: string }[];
    crew?: { name?: string; job?: string }[];
  };
}

interface TmdbListResponse {
  page?: number;
  results?: TmdbItem[];
  total_pages?: number;
  total_results?: number;
}

/**
 * The key or read token, read lazily.
 *
 * Lazily rather than at module load so tests can set the environment and so a
 * build that changes the variable at runtime (a dev server restart) is picked
 * up without re-importing.
 */
export function tmdbApiKey(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  return (env.VITE_TMDB_API_KEY || env.VITE_TMDB_READ_TOKEN || "").trim();
}

/** True when a browser-side TMDB fallback is configured. */
export function tmdbEnabled(): boolean {
  return tmdbApiKey().length > 0;
}

/**
 * One GET against TMDB.
 *
 * A v3 API key travels as `api_key`; a v4 read access token is a JWT and travels
 * as a bearer header. Both are accepted because either is what someone is
 * likely to paste into the environment.
 */
async function tmdbGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const key = tmdbApiKey();
  if (!key) throw new Error("TMDB fallback is not configured");

  const url = new URL(
    `${TMDB_API_BASE}${path.startsWith("/") ? path : `/${path}`}`
  );
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(name, String(value));
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${key}`;
  } else {
    url.searchParams.set("api_key", key);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`TMDB request failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function genreName(id: number, mediaType: "movie" | "tv"): string | undefined {
  return mediaType === "tv"
    ? (TV_GENRES[id] ?? MOVIE_GENRES[id])
    : MOVIE_GENRES[id];
}

function yearFromDate(date: string | undefined): number | null {
  if (!date || !/^\d{4}/.test(date)) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * TMDB's own record as the app's catalogue card.
 *
 * `fallbackType` is used for the endpoints that do not carry `media_type` (a
 * movie-specific list has no need to repeat that every entry is a film).
 */
export function tmdbItemToStreamMovie(
  item: TmdbItem,
  fallbackType: "movie" | "tv"
): StreamMovie | null {
  if (
    typeof item.id !== "number" ||
    !Number.isFinite(item.id) ||
    item.id <= 0
  ) {
    return null;
  }
  // Search and trending can include people and collections; they have no card.
  if (item.media_type === "person") return null;

  const title = (item.title ?? item.name ?? "").trim();
  if (!title) return null;

  const mediaType: "movie" | "tv" =
    item.media_type === "tv" || (!item.media_type && fallbackType === "tv")
      ? "tv"
      : "movie";
  const genres = (item.genre_ids ?? [])
    .map(id => genreName(id, mediaType))
    .filter((name): name is string => Boolean(name));
  const date = item.release_date || item.first_air_date || "";

  return {
    id: String(item.id),
    title,
    poster_url: item.poster_path
      ? `${TMDB_IMAGE_BASE}/w500${item.poster_path}`
      : "",
    backdrop_url: item.backdrop_path
      ? `${TMDB_IMAGE_BASE}/original${item.backdrop_path}`
      : "",
    stream_url: "",
    year: yearFromDate(date),
    media_type: mediaType,
    overview: (item.overview ?? "").trim(),
    genres,
    ...(typeof item.vote_average === "number" && item.vote_average > 0
      ? { vote_average: item.vote_average }
      : {}),
    ...(typeof item.popularity === "number"
      ? { popularity: item.popularity }
      : {}),
  };
}

interface TmdbListPage {
  movies: StreamMovie[];
  page: number;
  totalPages: number;
  totalResults: number;
}

async function tmdbListPage(
  path: string,
  params: Record<string, string | number | undefined>,
  fallbackType: "movie" | "tv"
): Promise<TmdbListPage> {
  const payload = await tmdbGet<TmdbListResponse>(path, {
    language: "en-US",
    ...params,
  });
  const movies = (Array.isArray(payload.results) ? payload.results : [])
    .map(item => tmdbItemToStreamMovie(item, fallbackType))
    .filter((movie): movie is StreamMovie => movie !== null);

  return {
    movies,
    page:
      typeof payload.page === "number"
        ? payload.page
        : Number(params.page) || 1,
    totalPages:
      typeof payload.total_pages === "number" ? payload.total_pages : 1,
    totalResults:
      typeof payload.total_results === "number"
        ? payload.total_results
        : movies.length,
  };
}

export interface TmdbHomeSection {
  name: string;
  mediaType: "movie" | "tv";
  genres: string[];
  movies: StreamMovie[];
}

function unionGenres(movies: StreamMovie[]): string[] {
  const seen = new Set<string>();
  for (const movie of movies) {
    for (const genre of movie.genres ?? []) seen.add(genre);
  }
  return [...seen];
}

/**
 * The shelves that stand in for `/home`.
 *
 * Names are chosen to match the regexes the existing feed helpers already use:
 * "Trending" and "Popular" feed the trending/popular rows, "New Releases" feeds
 * now-playing, and "Popular Series" gives the TV rows something to show.
 */
async function buildHomeSections(): Promise<TmdbHomeSection[]> {
  const definitions: {
    name: string;
    mediaType: "movie" | "tv";
    request: [string, Record<string, string | number | undefined>];
  }[] = [
    {
      name: "Trending Movies",
      mediaType: "movie",
      request: ["/trending/movie/week", {}],
    },
    {
      name: "Popular Movies",
      mediaType: "movie",
      request: ["/movie/popular", { page: 1 }],
    },
    {
      name: "Popular Series",
      mediaType: "tv",
      request: ["/tv/popular", { page: 1 }],
    },
    {
      name: "New Releases",
      mediaType: "movie",
      request: ["/movie/now_playing", { page: 1 }],
    },
    {
      name: "Top Rated Movies",
      mediaType: "movie",
      request: ["/movie/top_rated", { page: 1 }],
    },
  ];

  const results = await Promise.allSettled(
    definitions.map(definition =>
      tmdbListPage(
        definition.request[0],
        definition.request[1],
        definition.mediaType
      )
    )
  );

  const sections: TmdbHomeSection[] = [];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled" || result.value.movies.length === 0) {
      return;
    }
    const definition = definitions[index];
    sections.push({
      name: definition.name,
      mediaType: definition.mediaType,
      genres: unionGenres(result.value.movies),
      movies: result.value.movies,
    });
  });

  if (sections.length === 0) {
    throw new Error("TMDB did not return a catalogue");
  }
  return sections;
}

const HOME_TTL_MS = 5 * 60 * 1000;
let homeCache: { at: number; promise: Promise<TmdbHomeSection[]> } | null =
  null;

/** Cached fallback shelves, shared by every caller in a five-minute window. */
export function tmdbHomeSections(): Promise<TmdbHomeSection[]> {
  const now = Date.now();
  if (homeCache && now - homeCache.at < HOME_TTL_MS) return homeCache.promise;

  const promise = buildHomeSections();
  homeCache = { at: now, promise };
  promise.catch(() => {
    if (homeCache?.promise === promise) homeCache = null;
  });
  return promise;
}

function normalizeGenre(name: string | undefined): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function genreIdFor(
  name: string | undefined,
  mediaType: "movie" | "tv"
): number | undefined {
  const key = normalizeGenre(name);
  if (!key) return undefined;
  return mediaType === "tv" ? TV_GENRE_IDS[key] : MOVIE_GENRE_IDS[key];
}

export interface TmdbDiscoverPage {
  movies: StreamMovie[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
}

function interleave(a: StreamMovie[], b: StreamMovie[]): StreamMovie[] {
  const out: StreamMovie[] = [];
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index]) out.push(a[index]);
    if (b[index]) out.push(b[index]);
  }
  return out;
}

function discoverParams(
  page: number,
  genre: string | undefined,
  mediaType: "movie" | "tv"
): Record<string, string | number | undefined> {
  const genreId = genreIdFor(genre, mediaType);
  return {
    page,
    sort_by: "popularity.desc",
    ...(genreId ? { with_genres: genreId } : {}),
  };
}

/**
 * A paginated browse page straight from TMDB.
 *
 * `all` merges the movie and TV discover endpoints, which is the only way to
 * keep both the genre filter and real pagination without a backend to blend
 * them.
 */
export async function tmdbDiscover(
  params: {
    mediaType?: "movie" | "tv" | "all";
    page?: number;
    perPage?: number;
    genre?: string;
  } = {}
): Promise<TmdbDiscoverPage> {
  const page =
    typeof params.page === "number" && params.page > 0
      ? Math.floor(params.page)
      : 1;
  const perPage =
    typeof params.perPage === "number" && params.perPage > 0
      ? Math.floor(params.perPage)
      : 24;
  const mediaType = params.mediaType ?? "movie";

  if (mediaType === "movie" || mediaType === "tv") {
    const result = await tmdbListPage(
      `/discover/${mediaType}`,
      discoverParams(page, params.genre, mediaType),
      mediaType
    );
    return {
      movies: result.movies,
      page,
      perPage,
      total: result.totalResults,
      hasMore: page < result.totalPages,
    };
  }

  const [moviePage, tvPage] = await Promise.all([
    tmdbListPage(
      "/discover/movie",
      discoverParams(page, params.genre, "movie"),
      "movie"
    ),
    tmdbListPage(
      "/discover/tv",
      discoverParams(page, params.genre, "tv"),
      "tv"
    ),
  ]);

  return {
    movies: interleave(moviePage.movies, tvPage.movies),
    page,
    perPage,
    total: moviePage.totalResults + tvPage.totalResults,
    hasMore: page < Math.max(moviePage.totalPages, tvPage.totalPages),
  };
}

/** Search movies and series through TMDB's multi-search endpoint. */
export async function tmdbSearch(
  query: string,
  page = 1
): Promise<StreamMovie[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const payload = await tmdbGet<TmdbListResponse>("/search/multi", {
    query: trimmed,
    page,
    include_adult: "false",
    language: "en-US",
  });
  return (Array.isArray(payload.results) ? payload.results : [])
    .map(item => tmdbItemToStreamMovie(item, "movie"))
    .filter((movie): movie is StreamMovie => movie !== null);
}

/** One title's full record, for the details page's fallback path. */
export interface TmdbTitleDetails {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  overview: string;
  poster_url: string;
  backdrop_url: string;
  year: number | null;
  runtime: number | null;
  score: number | null;
  genres: string[];
  cast: string[];
  director: string | null;
  release_date: string | null;
  seasons?: number;
  episodes_per_season?: number;
}

/**
 * Fetch a title by TMDB id.
 *
 * Only numeric ids below ten digits are accepted: the media API's subject ids
 * are ~19 digits, so a slug or a subject id can never be mistaken for a TMDB id
 * and sent here by accident.
 */
export async function tmdbTitleDetails(
  id: string,
  kind: "movie" | "tv" = "movie"
): Promise<TmdbTitleDetails | null> {
  const numeric = id.trim();
  if (!/^\d{1,10}$/.test(numeric)) return null;

  const mediaType = kind === "tv" ? "tv" : "movie";
  const payload = await tmdbGet<TmdbItem>(`/${mediaType}/${numeric}`, {
    language: "en-US",
    append_to_response: "credits",
  });

  const title = (payload.title ?? payload.name ?? "").trim();
  if (!title) return null;

  const date = payload.release_date || payload.first_air_date || "";
  const genres = (payload.genres ?? [])
    .map(genre => genre?.name?.trim())
    .filter((name): name is string => Boolean(name));
  const cast = (payload.credits?.cast ?? [])
    .map(member => member.name?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 20);
  const director =
    (payload.credits?.crew ?? [])
      .find(member => member.job === "Director")
      ?.name?.trim() || null;

  return {
    id: payload.id ?? Number(numeric),
    mediaType,
    title,
    overview: (payload.overview ?? "").trim(),
    poster_url: payload.poster_path
      ? `${TMDB_IMAGE_BASE}/w500${payload.poster_path}`
      : "",
    backdrop_url: payload.backdrop_path
      ? `${TMDB_IMAGE_BASE}/original${payload.backdrop_path}`
      : "",
    year: yearFromDate(date),
    runtime:
      mediaType === "movie" &&
      typeof payload.runtime === "number" &&
      payload.runtime > 0
        ? payload.runtime
        : null,
    score:
      typeof payload.vote_average === "number" && payload.vote_average > 0
        ? payload.vote_average
        : null,
    genres,
    cast,
    director,
    release_date: date || null,
    ...(mediaType === "tv"
      ? {
          seasons:
            typeof payload.number_of_seasons === "number"
              ? payload.number_of_seasons
              : 1,
          episodes_per_season:
            typeof payload.number_of_episodes === "number"
              ? payload.number_of_episodes
              : 1,
        }
      : {}),
  };
}
