import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Movie } from "@/components/movies/types";
import type { View } from "@/components/layout/navigation";
import {
  searchCatalog,
  fetchTrending,
  fetchPopular,
  fetchDiscover,
  isRateLimited,
  type CatalogItem,
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

/**
 * Views rendered as an unbounded, infinite-scrolled grid. Scrolling near the
 * last tile asks the backend for `page + 1`; a skeleton grid renders while the
 * next batch is being fetched.
 */
export const INFINITE_VIEWS: ReadonlySet<View> = new Set<View>([
  "movies",
  "tv",
  "trending",
]);

/** Tiles a page of the aggregated catalog returns (backend default). */
export const DISCOVER_PAGE_SIZE = 24;

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
  discoverItems: Movie[];
  discoverPage: number;
  discoverHasMore: boolean;
  discoverLoading: boolean;
  discoverLoadingMore: boolean;
  discoverError: string | null;
  /** True when the feed was throttled by TMDB rather than genuinely broken. */
  discoverRateLimited: boolean;
  setView: (view: View) => void;
  setSection: (view: View) => void;
  setSearch: (value: string) => void;
  setGenre: (value: string) => void;
  toggleSave: (movie: Movie) => void;
  loadMoreDiscover: () => void;
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

/** Map a backend `CatalogItem` (unified, DB-cached card) to a catalog `Movie`. */
function toDiscoverMovie(item: CatalogItem): Movie {
  const mediaType: "movie" | "tv" = item.media_type === "tv" ? "tv" : "movie";
  const year =
    typeof item.year === "number" ? item.year : Number(item.year) || null;
  // Cards carrying a TMDB id stay watchable; non-TMDB providers fall back to
  // their own id (playback may not resolve for those exotic titles).
  const rawId =
    item.tmdb_id != null ? String(item.tmdb_id) : String(item.id ?? "");
  const genres = item.genres?.length
    ? item.genres
    : [mediaType === "tv" ? "Series" : "Movie"];
  return {
    id: stableId(rawId),
    providerId: rawId,
    title: item.title,
    year: Number.isFinite(year) ? year : null,
    runtime: typeof item.runtime === "number" ? item.runtime : null,
    rating: null,
    score: typeof item.vote_average === "number" ? item.vote_average : null,
    genre: genres,
    poster: item.poster_url || null,
    backdrop: item.backdrop_url || null,
    synopsis:
      item.overview ||
      "Browse the catalogue — pick a title to see full details.",
    director: item.director || null,
    cast: item.cast || [],
    country: item.country || null,
    language: item.language || null,
    releaseDate: item.release_date || null,
    source: "tmdb",
    mediaType,
    vote_average: item.vote_average ?? undefined,
    genres,
    popularity: item.popularity ?? undefined,
    overview: item.overview,
    backdrop_url: item.backdrop_url,
  };
}

/** Which media bucket an infinite-scroll view should request. */
function mediaTypeFor(view: View): "movie" | "tv" | "all" {
  if (view === "tv") return "tv";
  if (view === "movies") return "movie";
  return "all";
}

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

  // Infinite-scroll browse grid (Explore / Shows / Trending)
  const [discoverItems, setDiscoverItems] = useState<Movie[]>([]);
  const [discoverPage, setDiscoverPage] = useState(1);
  const [discoverHasMore, setDiscoverHasMore] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverLoadingMore, setDiscoverLoadingMore] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverRateLimited, setDiscoverRateLimited] = useState(false);
  const discoverInFlightRef = useRef(false);

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

  // Load the first page of the aggregated catalog whenever a browse view's
  // scope (view / genre) changes. Clearing search also snaps back to browse.
  useEffect(() => {
    if (search.trim()) return;
    if (!INFINITE_VIEWS.has(view)) return;
    let cancelled = false;
    const genreQuery = genre === "All" ? undefined : genre;
    setDiscoverLoading(true);
    setDiscoverLoadingMore(false);
    setDiscoverError(null);
    setDiscoverRateLimited(false);
    setDiscoverHasMore(true);
    setDiscoverItems([]);
    fetchDiscover({
      media_type: mediaTypeFor(view),
      page: 1,
      per_page: DISCOVER_PAGE_SIZE,
      genre: genreQuery,
    })
      .then(res => {
        if (cancelled) return;
        setDiscoverItems(res.items.map(toDiscoverMovie));
        setDiscoverPage(res.page);
        setDiscoverHasMore(res.has_more);
      })
      .catch(err => {
        if (cancelled) return;
        console.error("Discover failed:", err);
        setDiscoverItems([]);
        setDiscoverHasMore(false);
        // A TMDB rate limit is transient and self-inflicted, not a broken
        // backend -- say so instead of surfacing a raw status message.
        setDiscoverRateLimited(isRateLimited(err));
        setDiscoverError(
          isRateLimited(err)
            ? "Catching our breath — the movie database is rate-limiting us. This clears in a moment."
            : err instanceof Error
              ? err.message
              : String(err)
        );
      })
      .finally(() => {
        if (!cancelled) setDiscoverLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, genre, search]);

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
          { title: "Popular on Stream Vy", items: filtered.slice(0, cap) },
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

  /** Fetch the next page of the aggregated catalog for the active browse view. */
  const loadMoreDiscover = useCallback(() => {
    if (discoverInFlightRef.current || discoverLoadingMore || !discoverHasMore) {
      return;
    }
    discoverInFlightRef.current = true;
    setDiscoverLoadingMore(true);
    const nextPage = discoverPage + 1;
    const genreQuery = genre === "All" ? undefined : genre;
    fetchDiscover({
      media_type: mediaTypeFor(view),
      page: nextPage,
      per_page: DISCOVER_PAGE_SIZE,
      genre: genreQuery,
    })
      .then(res => {
        setDiscoverPage(res.page);
        setDiscoverHasMore(res.has_more);
        setDiscoverItems(prev => {
          const seen = new Set(prev.map(movie => movie.providerId));
          return [
            ...prev,
            ...res.items.map(toDiscoverMovie).filter(movie => !seen.has(movie.providerId)),
          ];
        });
      })
      .catch(err => {
        console.error("Discover page failed:", err);
        // A TMDB rate limit is transient and self-inflicted, not a broken
        // backend -- say so instead of surfacing a raw status message.
        setDiscoverRateLimited(isRateLimited(err));
        setDiscoverError(
          isRateLimited(err)
            ? "Catching our breath — the movie database is rate-limiting us. This clears in a moment."
            : err instanceof Error
              ? err.message
              : String(err)
        );
      })
      .finally(() => {
        discoverInFlightRef.current = false;
        setDiscoverLoadingMore(false);
      });
  }, [discoverPage, discoverHasMore, discoverLoadingMore, view, genre]);

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
    discoverItems,
    discoverPage,
    discoverHasMore,
    discoverLoading,
    discoverLoadingMore,
    discoverError,
    discoverRateLimited,
    loadMoreDiscover,
  };
}
