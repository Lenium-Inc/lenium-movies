import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Movie } from "@/components/movies/types";
import type { View } from "@/components/layout/navigation";
import {
  searchCatalog,
  fetchTrending,
  fetchPopular,
  type StreamMovie,
} from "@/services/api";
import { savedListIds, subscribeList, toggleListSave } from "@/services/lists";

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
  searchLoading: boolean;
  filtered: Movie[];
  rows: CatalogRows[];
  setView: (view: View) => void;
  setSection: (view: View) => void;
  setSearch: (value: string) => void;
  setGenre: (value: string) => void;
  toggleSave: (movie: Movie) => void;
}

const VIEWS_WITH_TV_FILTER: View[] = [
  "tv",
  "trending",
  "popular",
  "new",
  "my-list",
  "home",
];

/** Stable numeric fallback for non-TMDB (archive.org) ids in the backend search. */
function stableId(id: string): number {
  const parsed = Number(id);
  if (Number.isFinite(parsed)) return parsed;
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) || 1;
}

/** Map a backend `StreamMovie` (playable, embed-ready) to a catalog `Movie`. */
function toCatalogMovie(item: StreamMovie): Movie {
  const mediaType: "movie" | "tv" = item.media_type === "tv" ? "tv" : "movie";
  const year =
    typeof item.year === "number" ? item.year : Number(item.year) || null;
  return {
    id: stableId(item.id),
    providerId: item.id,
    title: item.title,
    year: Number.isFinite(year) ? year : null,
    runtime: null,
    rating: null,
    score: item.vote_average ?? null,
    genre: item.genres?.length
      ? item.genres
      : [mediaType === "tv" ? "Series" : "Movie"],
    poster: item.poster_url || null,
    backdrop: item.backdrop_url || null,
    synopsis:
      item.overview || "Playable right now — pick it to start watching.",
    director: null,
    cast: [],
    country: null,
    language: null,
    releaseDate: null,
    source: "tmdb",
    mediaType,
    vote_average: item.vote_average,
    genres: item.genres,
    seasons: item.seasons,
    episodes_per_season: item.episodes_per_season,
    backdrop_url: item.backdrop_url,
    overview: item.overview,
    popularity: item.popularity,
  };
}

const SEARCH_DEBOUNCE_MS = 300;

interface SearchCacheEntry {
  results: StreamMovie[];
  timestamp: number;
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function useCatalog(): UseCatalog {
  const [view, setView] = useState<View>("home");
  const [search, setSearch] = useState("");
  const [genre, setGenre] = useState("All");
  const [savedIds, setSavedIds] = useState<number[]>(() => savedListIds());

  useEffect(() => subscribeList(() => setSavedIds(savedListIds())), []);

  const [catalogItems, setCatalogItems] = useState<StreamMovie[]>([]);
  const [searchResults, setSearchResults] = useState<StreamMovie[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);

  // Search cache and in-flight request tracking
  const searchCacheRef = useRef<Map<string, SearchCacheEntry>>(new Map());
  const inflightSearchRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load initial catalog from trending + popular endpoints for diversity
  useEffect(() => {
    async function fetchCatalog() {
      try {
        setLoading(true);
        // Fetch trending (movies + TV) and popular movies for a diverse mix
        const [trending, popular] = await Promise.all([
          fetchTrending({ time_window: "week", media_type: "all" }),
          fetchPopular({ media_type: "movie" }),
        ]);

        // Combine and deduplicate by ID
        const combined = [...trending, ...popular];
        const seen = new Set<string>();
        const unique = combined.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });

        // Shuffle for variety on each load
        for (let i = unique.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [unique[i], unique[j]] = [unique[j], unique[i]];
        }

        setCatalogItems(unique.slice(0, 40));
      } catch (err) {
        console.error("Failed to fetch catalog from backend:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchCatalog();
  }, []);

  // Handle live searches against Flask backend with debounce and caching
  useEffect(() => {
    const query = search.trim();

    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    // Clear any pending debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Check cache first
    const cached = searchCacheRef.current.get(query);
    if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL_MS) {
      setSearchResults(cached.results);
      setSearchLoading(false);
      return;
    }

    // Set loading state immediately when we have a query and no cached result
    setSearchLoading(true);

    debounceTimerRef.current = setTimeout(() => {
      // Cancel any in-flight request
      if (inflightSearchRef.current) {
        inflightSearchRef.current.abort();
      }

      const controller = new AbortController();
      inflightSearchRef.current = controller;

      searchCatalog(query)
        .then(results => {
          if (!controller.signal.aborted) {
            searchCacheRef.current.set(query, {
              results,
              timestamp: Date.now(),
            });
            setSearchResults(results);
            setSearchLoading(false);
          }
        })
        .catch(err => {
          if (!controller.signal.aborted && err.name !== "AbortError") {
            console.error("Search failed:", err);
            setSearchResults([]);
            setSearchLoading(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (inflightSearchRef.current) {
        inflightSearchRef.current.abort();
      }
    };
  }, [search]);

  const searching = search.trim().length > 0;
  const activeStreamMovies = searching ? searchResults : catalogItems;
  const movies = useMemo(
    () => activeStreamMovies.map(toCatalogMovie),
    [activeStreamMovies]
  );

  const filtered = useMemo(() => {
    if (searching) return movies;
    let base =
      genre === "All"
        ? movies
        : movies.filter(movie => movie.genre.includes(genre));

    // Filter by media type for TV-specific views
    if (VIEWS_WITH_TV_FILTER.includes(view)) {
      if (view === "tv") {
        base = base.filter(movie => movie.mediaType === "tv");
      } else if (view === "trending") {
        // Trending shows both but prioritizes TV
        base = base.filter(
          movie =>
            movie.mediaType === "tv" ||
            (movie.popularity && movie.popularity > 50)
        );
      }
    }

    return base;
  }, [genre, movies, searching, view]);

  function dedupeMovies(movies: Movie[]): Movie[] {
  const seen = new Set<string>();
  return movies.filter((movie) => {
    const key = String(movie.providerId ?? movie.id ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

  const rows: CatalogRows[] = useMemo(() => {
    const byYearDesc = [...filtered].sort(
      (a, b) => (b.year ?? 0) - (a.year ?? 0)
    );
    const cap = 20;

    switch (view) {
      case "new":
        return [{ title: "Recently Added", items: byYearDesc.slice(0, cap) }];
      case "popular":
        return [
          { title: "Popular on FreeStream", items: filtered.slice(0, cap) },
        ];
      case "trending":
        return [{ title: "Trending Now", items: filtered.slice(0, cap) }];
      case "tv":
        return [{ title: "TV Series", items: filtered.slice(0, cap) }];
      case "my-list":
        return [
          {
            title: "My List",
            items: filtered.filter(movie => savedIds.includes(movie.id)),
          },
        ];
      case "downloads":
        return [{ title: "Downloads", items: filtered.slice(0, cap) }];
      default: {
        const trendingItems = filtered.slice(0, cap);
        const trendingIds = new Set(trendingItems.map(m => String(m.providerId ?? m.id ?? "")));
        const recentItems = byYearDesc.filter(m => !trendingIds.has(String(m.providerId ?? m.id ?? ""))).slice(0, cap);
        return [
          { title: "Trending Now", items: trendingItems },
          { title: "Recently Added", items: recentItems },
        ];
      }
    }
  }, [view, filtered, savedIds]);

  const setSection = useCallback((next: View) => {
    setView(next);
    setSearch("");
    setGenre("All");
  }, []);

  const toggleSave = useCallback((movie: Movie) => {
    toggleListSave(movie);
    setSavedIds(savedListIds());
  }, []);

  return {
    view,
    search,
    genre,
    savedIds,
    configured: true,
    loading,
    searchLoading,
    filtered,
    rows,
    setView,
    setSection,
    setSearch,
    setGenre,
    toggleSave,
  };
}
