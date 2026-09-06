import type { MetadataMovie } from "../../../../server/providers/tmdb";

/**
 * A movie as surfaced to the catalog UI. Mirrors the server-side
 * `MetadataMovie` shape so cards and detail views can render consistently.
 */
export type Movie = Omit<MetadataMovie, "source"> & { source: "tmdb" };
