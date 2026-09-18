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
  /** Runtime string (e.g., "120m", "2h 30m") */
  runtime: string;
  /** Rating label (e.g., "PG-13", "TV-MA") */
  rating: string;
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
  /** Cast members (up to 3 for display) */
  cast?: string[];
  /** Country of origin */
  country?: string;
  /** Primary language */
  language?: string;
  /** Release date string */
  releaseDate?: string;
};
