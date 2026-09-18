import { useMemo, useState } from "react";

/**
 * Shared constants for the two-tier (region × genre) filtering engine.
 * The literal "All" sentinels mean the two filter groups switch independently
 * and in real time — every toggle recomputes the visible set on the next
 * render with no network round trip.
 */
export const ALL_REGION = "All";
export const ALL_GENRE = "All";

export interface MovieFilters<TItem extends { id: string | number }> {
  regions: readonly string[];
  genres: readonly string[];
  region: string;
  genre: string;
  setRegion: (region: string) => void;
  setGenre: (genre: string) => void;
  /** Items matching both active filters, memoized against the input list. */
  filtered: TItem[];
  activeCount: number;
  total: number;
}

interface UseMovieFiltersOptions<TItem extends { id: string | number }> {
  items: TItem[];
  regions: readonly string[];
  genres: readonly string[];
  /** Must be referentially stable (define at module scope). */
  regionOf?: (item: TItem) => string | null | undefined;
  /** Must be referentially stable (define at module scope). */
  genresOf?: (item: TItem) => readonly string[] | string | null | undefined;
  initialRegion?: string;
  initialGenre?: string;
}

/**
 * The synchronized, real-time filtering engine. Both filter dimensions live in
 * one state object and derive the visible grid via a single `useMemo`, so the
 * FilterBar and the MovieGrid can never disagree about what is shown — toggling
 * any pill updates the grid in the same render cycle.
 */
export function useMovieFilters<TItem extends { id: string | number }>({
  items,
  regions,
  genres,
  regionOf,
  genresOf,
  initialRegion = ALL_REGION,
  initialGenre = ALL_GENRE,
}: UseMovieFiltersOptions<TItem>): MovieFilters<TItem> {
  const [region, setRegion] = useState(initialRegion);
  const [genre, setGenre] = useState(initialGenre);

  const filtered = useMemo(
    () =>
      items.filter(item => {
        const regionOk =
          region === ALL_REGION || (regionOf?.(item) ?? null) === region;
        const itemGenres = genresOf?.(item) ?? [];
        const genreValues = Array.isArray(itemGenres)
          ? itemGenres
          : itemGenres
            ? [itemGenres]
            : [];
        const genreOk = genre === ALL_GENRE || genreValues.includes(genre);
        return regionOk && genreOk;
      }),
    [items, region, genre, regionOf, genresOf]
  );

  return {
    regions,
    genres,
    region,
    genre,
    setRegion,
    setGenre,
    filtered,
    activeCount: filtered.length,
    total: items.length,
  };
}
