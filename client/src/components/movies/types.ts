import type { MetadataMovie } from "../../../../server/providers/tmdb";

/**
 * A movie as surfaced to the catalog UI. Mirrors the server-side
 * `MetadataMovie` shape so cards and detail views can render consistently.
 * Extended with additional fields from the backend API (TMDB results).
 */
export type Movie = Omit<MetadataMovie, "source"> & { 
  source: "tmdb";
  /** TMDB vote average (0-10) */
  vote_average?: number;
  /** Genres array from TMDB (may differ from normalized `genre`) */
  genres?: string[];
  /** Director name if available */
  director?: string | null;
  /** Runtime in minutes as string (e.g., "120m") */
  runtime?: string;
};
