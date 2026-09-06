import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Movie } from "@/components/movies/types";
import type { View } from "@/components/layout/navigation";
import { trpc } from "@/lib/trpc";

export const genreFilterOptions = [
  "All",
  "Action",
  "Adventure",
  "Comedy",
  "Crime",
  "Drama",
  "Family",
  "Mystery",
  "Romance",
  "Sci-fi",
  "Thriller",
];

interface CatalogRows {
  title: string;
  items: Movie[];
}

interface UseCatalog {
  view: View;
  search: string;
  genre: string;
  savedIds: number[];
  configured: boolean;
  loading: boolean;
  filtered: Movie[];
  rows: CatalogRows[];
  setView: (view: View) => void;
  setSection: (view: View) => void;
  setSearch: (value: string) => void;
  setGenre: (value: string) => void;
  toggleSave: (movie: Movie) => void;
}

/**
 * Central owner of the catalog page state: the active view, the live search
 * term, the genre filter, and the temporary "My List" selection.
 *
 * Prefer the server-driven "popular" query when there is no search term, and
 * the server-driven "search" query otherwise. All shelf rows are derived with
 * `useMemo` so they only recompute when their inputs change.
 */
export function useCatalog(): UseCatalog {
  const [view, setView] = useState<View>("home");
  const [search, setSearch] = useState("");
  const [genre, setGenre] = useState("All");
  const [savedIds, setSavedIds] = useState<number[]>([]);

  const status = trpc.catalog.status.useQuery();
  const configured = Boolean(status.data?.configured);

  const popular = trpc.catalog.popular.useQuery(
    { limit: 40 },
    { enabled: configured, retry: false }
  );
  const results = trpc.catalog.search.useQuery(
    { query: search.trim(), limit: 40 },
    { enabled: configured && search.trim().length > 0, retry: false }
  );

  const source = search.trim() ? (results.data ?? []) : (popular.data ?? []);

  const loading = useMemo(
    () =>
      status.isLoading ||
      (configured && popular.isLoading && !search.trim()) ||
      (configured && results.isLoading && Boolean(search.trim())),
    [status.isLoading, configured, popular.isLoading, results.isLoading, search]
  );

  /** Movies from `source` narrowed down by the selected genre chip. */
  const filtered = useMemo(
    () =>
      genre === "All"
        ? source
        : source.filter(movie => movie.genre.includes(genre)),
    [genre, source]
  );

  /**
   * Compose the shelf rows for the active view. The home view reuses the same
   * result set under different sortings; the "my-list" view reflects the
   * temporary in-memory saves until persistence is connected.
   */
  const rows: CatalogRows[] = useMemo(() => {
    const byYearDesc = [...filtered].sort(
      (a, b) => (b.year ?? 0) - (a.year ?? 0)
    );
    const byScoreDesc = [...filtered].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    );

    switch (view) {
      case "new":
        return [{ title: "Recently Added", items: byYearDesc }];
      case "popular":
        return [{ title: "Popular on LeNium", items: byScoreDesc }];
      case "my-list":
        return [
          {
            title: "My List",
            items: filtered.filter(movie => savedIds.includes(movie.id)),
          },
        ];
      default:
        return [
          { title: "Trending Now", items: filtered },
          { title: "Popular on LeNium", items: byScoreDesc },
          { title: "Recently Added", items: byYearDesc },
          { title: "Top Rated", items: byScoreDesc },
        ];
    }
  }, [view, filtered, savedIds]);

  /** Navigate to a view and reset the search + genre so the catalogue is fresh. */
  const setSection = useCallback((next: View) => {
    setView(next);
    setSearch("");
    setGenre("All");
  }, []);

  /** Toggle a movie in the in-memory "My List" selection. */
  const toggleSave = useCallback((movie: Movie) => {
    setSavedIds(current =>
      current.includes(movie.id)
        ? current.filter(id => id !== movie.id)
        : [...current, movie.id]
    );
    toast.info("My List persistence is not connected yet.", { duration: 2200 });
  }, []);

  return {
    view,
    search,
    genre,
    savedIds,
    configured,
    loading,
    filtered,
    rows,
    setView,
    setSection,
    setSearch,
    setGenre,
    toggleSave,
  };
}
