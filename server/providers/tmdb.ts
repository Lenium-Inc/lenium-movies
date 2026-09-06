import { ENV } from "../_core/env";

export type MetadataMovie = {
  id: number;
  providerId: string;
  title: string;
  year: number | null;
  runtime: string;
  rating: string;
  score: number | null;
  genre: string[];
  poster: string | null;
  backdrop: string | null;
  synopsis: string;
  director: string | null;
  source: "tmdb";
};

type TmdbMovie = {
  id: number;
  title?: string;
  release_date?: string;
  vote_average?: number;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  runtime?: number | null;
  genres?: Array<{ id: number; name: string }>;
};

type TmdbResponse = { results?: TmdbMovie[] };

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const genreNames: Record<number, string> = {
  12: "Adventure",
  14: "Fantasy",
  16: "Animation",
  18: "Drama",
  27: "Horror",
  28: "Action",
  35: "Comedy",
  36: "History",
  37: "Western",
  53: "Thriller",
  80: "Crime",
  99: "Documentary",
  878: "Sci-fi",
  9648: "Mystery",
  10402: "Music",
  10749: "Romance",
  10751: "Family",
  10752: "War",
  10770: "TV",
};

export class MetadataProviderUnavailableError extends Error {
  constructor() {
    super("Movie metadata provider is not configured");
    this.name = "MetadataProviderUnavailableError";
  }
}

export function isTmdbConfigured() {
  return Boolean(ENV.tmdbApiKey);
}

function imageUrl(path: string | null | undefined, size: "w342" | "w780") {
  return path ? `${TMDB_IMAGE_BASE_URL}/${size}${path}` : null;
}

function normalizeMovie(movie: TmdbMovie): MetadataMovie {
  const year = movie.release_date
    ? Number(movie.release_date.slice(0, 4))
    : null;
  const genres =
    movie.genres?.map(genre => genre.name) ??
    movie.genre_ids?.map(id => genreNames[id]).filter(Boolean) ??
    [];
  return {
    id: movie.id,
    providerId: String(movie.id),
    title: movie.title?.trim() || "Untitled",
    year: Number.isFinite(year) ? year : null,
    runtime: movie.runtime
      ? `${Math.floor(movie.runtime / 60)}h ${movie.runtime % 60}m`
      : "Runtime unavailable",
    rating: "Rating unavailable",
    score:
      typeof movie.vote_average === "number" && movie.vote_average > 0
        ? Number(movie.vote_average.toFixed(1))
        : null,
    genre: genres.length ? genres : ["Uncategorized"],
    poster: imageUrl(movie.poster_path, "w342"),
    backdrop: imageUrl(movie.backdrop_path, "w780"),
    synopsis: movie.overview?.trim() || "Synopsis unavailable.",
    director: null,
    source: "tmdb",
  };
}

/**
 * Build a URL for the TMDB REST API with the API key and defaults applied.
 *
 * All query params are appended through `URLSearchParams`, which percent-encodes
 * values so search terms with spaces or special characters arrive intact.
 */
function buildTmdbUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  url.searchParams.set("api_key", ENV.tmdbApiKey);
  url.searchParams.set("language", "en-US");
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value)
  );
  return url;
}

async function tmdbFetch<T>(
  path: string,
  params: Record<string, string> = {}
): Promise<T> {
  if (!ENV.tmdbApiKey) throw new MetadataProviderUnavailableError();
  const response = await fetch(buildTmdbUrl(path, params), {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`TMDB request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}

/**
 * Fetch the currently popular movies from TMDB.
 *
 * @param limit - Maximum number of results to return (defaults to 20).
 * @returns An empty array if the provider returns no results.
 */
export async function getPopularMovies(limit = 20) {
  const payload = await tmdbFetch<TmdbResponse>("/movie/popular", {
    page: "1",
  });
  return (payload.results ?? []).slice(0, limit).map(normalizeMovie);
}

/**
 * Search TMDB for movies matching `query` and normalize the results.
 *
 * The search hits the dedicated `/search/movie` discovery-adjacent endpoint and
 * passes the raw query to `URLSearchParams` for correct encoding. An empty or
 * whitespace-only query returns an empty list rather than hitting the API.
 *
 * @param query - Raw user search string. Trimmed and URL-encoded internally.
 * @param limit - Maximum number of results to return (defaults to 20).
 * @returns Normalized movies, or an empty array when there are no matches.
 */
export async function searchMovies(query: string, limit = 20) {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const payload = await tmdbFetch<TmdbResponse>("/search/movie", {
    query: trimmed,
    page: "1",
    include_adult: "false",
  });
  return (payload.results ?? []).slice(0, limit).map(normalizeMovie);
}

export async function getMovieById(id: number) {
  const movie = await tmdbFetch<TmdbMovie>(`/movie/${id}`);
  return normalizeMovie(movie);
}

export type VideoAssetCandidate = {
  movieId: string;
  provider: "youtube";
  providerVideoId: string;
  type: string;
  name: string;
  official: boolean;
  language: string | null;
  country: string | null;
  thumbnailUrl: string;
  publishedAt: Date | null;
  duration: number | null;
  embedUrl: string;
  sourceUrl: string;
};

type TmdbVideo = {
  key?: string;
  name?: string;
  site?: string;
  type?: string;
  official?: boolean;
  iso_639_1?: string | null;
  iso_3166_1?: string | null;
  published_at?: string | null;
};

type TmdbVideosResponse = { results?: TmdbVideo[] };

const videoPriority: Record<string, number> = {
  Trailer: 0,
  Teaser: 1,
  Featurette: 2,
  Clip: 3,
};

function normalizeVideo(
  movieId: string,
  video: TmdbVideo
): VideoAssetCandidate | null {
  if (!video.key || video.site !== "YouTube" || !video.name || !video.type)
    return null;
  return {
    movieId,
    provider: "youtube",
    providerVideoId: video.key,
    type: video.type,
    name: video.name,
    official: Boolean(video.official),
    language: video.iso_639_1 ?? null,
    country: video.iso_3166_1 ?? null,
    thumbnailUrl: `https://i.ytimg.com/vi/${encodeURIComponent(video.key)}/hqdefault.jpg`,
    publishedAt: video.published_at ? new Date(video.published_at) : null,
    duration: null,
    embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.key)}?rel=0&modestbranding=1`,
    sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.key)}`,
  };
}

export function selectOfficialVideo(videos: VideoAssetCandidate[]) {
  return (
    videos
      .filter(video => video.official)
      .sort(
        (a, b) =>
          (videoPriority[a.type] ?? 99) - (videoPriority[b.type] ?? 99) ||
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)
      )[0] ?? null
  );
}

export async function getMovieVideos(movieId: number) {
  const payload = await tmdbFetch<TmdbVideosResponse>(
    `/movie/${movieId}/videos`
  );
  return (payload.results ?? [])
    .map(video => normalizeVideo(String(movieId), video))
    .filter((video): video is VideoAssetCandidate => Boolean(video));
}

export async function getOfficialMovieVideo(movieId: number) {
  return selectOfficialVideo(await getMovieVideos(movieId));
}
