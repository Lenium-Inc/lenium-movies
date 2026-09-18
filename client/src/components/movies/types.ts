/**
 * A movie/TV show as surfaced to the catalog UI.
 * Mirrors the backend API StreamMovie shape so cards and detail views can render consistently.
 * Extended with additional fields for UI rendering.
 */
export type Movie = {
  /** Stable numeric ID for React keys and lists */
  id: number;
  /** Original provider ID (TMDB ID as string) */
  providerId: string;
  /** Display title */
  title: string;
  /** Release year (null if unknown) */
  year: number | null;
  /** Runtime in minutes (null if unknown) */
  runtime: number | null;
  /** Rating label (e.g., "PG-13", "TV-MA") */
  rating: string | null;
  /** TMDB vote average 0-10 (null if unavailable) */
  score: number | null;
  /** Genres array (e.g., ["Action", "Sci-Fi"]) */
  genre: string[];
  /** Poster image URL (w342 or w500) */
  poster: string | null;
  /** Backdrop image URL (w780 or w1280) */
  backdrop: string | null;
  /** Synopsis/overview text */
  synopsis: string;
  /** Director name if available */
  director: string | null;
  /** Cast members */
  cast: string[];
  /** Country of origin */
  country: string | null;
  /** Primary language */
  language: string | null;
  /** Release date string (YYYY-MM-DD) */
  releaseDate: string | null;
  /** Source identifier */
  source: "tmdb";
  /** Whether the entry is a feature film or a TV series */
  mediaType: "movie" | "tv";
  /** TMDB vote average (0-10) - alias for score */
  vote_average?: number;
  /** Genres array from TMDB (may differ from normalized `genre`) */
  genres?: string[];
  /** Number of seasons (TV only) */
  seasons?: number;
  /** Episodes per season (TV only) */
  episodes_per_season?: number;
  /** Backdrop URL from TMDB (original size) */
  backdrop_url?: string;
  /** Overview from TMDB */
  overview?: string;
  /** Popularity score from TMDB */
  popularity?: number;
};

/** A verified direct quality variant from the backend */
export type StreamVariant = {
  quality: string | null;
  url: string;
  type: "hls" | "dash" | "mp4" | "embed";
};

/** Resolved stream response from backend */
export type ResolvedStream = {
  id: string;
  title: string;
  media_type: "movie" | "tv";
  stream_url: string | null;
  streams?: StreamVariant[];
  mirrors?: Array<{
    name: string;
    url: string;
  }>;
  source_type?: "hls" | "dash" | "mp4" | "embed";
  is_embed?: boolean;
};
