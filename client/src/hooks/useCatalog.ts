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
import { useActiveProfile } from "@/context/ActiveProfileContext";
import { useTasteFeed, useTasteRecorder } from "@/hooks/useTaste";
import { useContinueWatching } from "@/hooks/useContinueWatching";
import { toMovie } from "@/lib/media";
import {
  affinityQueryParams,
  emptyAffinity,
  rankByAffinity,
  readAffinity,
  recordInteraction,
  signalsFrom,
  writeAffinity,
  type Affinity,
} from "@/lib/affinity";

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

export type CatalogSort = "trending" | "rating" | "year" | "popularity";
export type MediaTypeFilter = "all" | "movie" | "tv";

export const CATALOG_SORT_OPTIONS: readonly {
  value: CatalogSort;
  label: string;
}[] = [
  { value: "trending", label: "Trending" },
  { value: "rating", label: "Top Rated" },
  { value: "year", label: "Release Year" },
  { value: "popularity", label: "Most Popular" },
];

export const MEDIA_TYPE_OPTIONS: readonly {
  value: MediaTypeFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "movie", label: "Movie" },
  { value: "tv", label: "TV Show" },
];

/**
 * Order a set of titles by the chosen sort.
 *
 * "Trending" is deliberately the identity function: the upstream order is
 * already rank-ordered by the backend, and re-sorting it here by popularity
 * would quietly turn a trending shelf into a popularity chart while the heading
 * still said "Trending Now".
 */
function applySort(items: Movie[], sort: CatalogSort): Movie[] {
  if (sort === "trending") return items;
  const out = [...items];
  switch (sort) {
    case "rating":
      // Unrated titles sort last instead of first: TMDB leaves `vote_average`
      // at 0 for catalogue entries with no votes yet, and 0 would otherwise
      // top a rating list.
      return out.sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
    case "year":
      return out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    case "popularity":
      return out.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  }
}

function applyMediaType(items: Movie[], mediaType: MediaTypeFilter): Movie[] {
  if (mediaType === "all") return items;
  return items.filter(movie => movie.mediaType === mediaType);
}

/** How a row presents itself. Presentation only -- never which items it holds. */
export type RowKind = "default" | "score" | "top10";

interface CatalogRows {
  title: string;
  items: Movie[];
  kind?: RowKind;
}

interface UseCatalog {
  view: View;
  search: string;
  genre: string;
  /** Active sort order for both shelf views and the paged browse grid. */
  sort: CatalogSort;
  /** Active media-type narrowing; "all" means no narrowing. */
  mediaType: MediaTypeFilter;
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
  /**
   * Fold a title the user engaged with into their taste profile.
   *
   * Recorded in the session cache for an instant re-rank and on the server for
   * durability and cross-device consistency.
   */
  recordAffinity: (movie: Movie, weight?: number) => void;
  /**
   * Server-ranked picks for the active profile, or `null` when there is nothing
   * personalised to show (signed out, or no history yet).
   */
  forYou: Movie[] | null;
  /**
   * The Continue Watching shelf, exposed so the episode shelf can read resume
   * fractions off the same per-episode records instead of subscribing to watch
   * history a second time.
   */
  continueWatching: Movie[];
  setView: (view: View) => void;
  setSection: (view: View) => void;
  setSearch: (value: string) => void;
  setGenre: (value: string) => void;
  setSort: (value: CatalogSort) => void;
  setMediaType: (value: MediaTypeFilter) => void;
  toggleSave: (movie: Movie) => void;
  loadMoreDiscover: () => void;
}

const VIEWS_WITH_TV_FILTER: View[] = [
  "movies",
  "tv",
  "trending",
  "popular",
  "new",
  "my-list",
  "home",
];

/** Long enough that typing a title does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/** How many titles a numbered shelf shows. Also its title. */
const TOP_ROW_SIZE = 10;

/**
 * Popularity floor for the Top 10, on TMDB's 0-100+ scale.
 *
 * Low enough that a decent catalogue still fills the chart, high enough that a
 * title rated 10.0 by a handful of people who found it first does not take
 * rank one.
 */
const MIN_POPULARITY_FOR_RANKING = 20;

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
  // The server is the source of truth for taste; the session cache below stays
  // so a click re-ranks the visible grid immediately instead of after a
  // round trip.
  // Read the active profile from the shared context rather than calling
  // `useProfiles()` again. Three independent instances of that hook each kept
  // their own copy of the list and their own `activeId`, so selecting a profile
  // in the switcher updated one of them and not the others -- which is exactly
  // the drift the context was introduced to remove.
  const { activeProfile } = useActiveProfile();
  const activeProfileId = activeProfile ? String(activeProfile.id) : null;
  const recordTaste = useTasteRecorder(activeProfileId);
  // No profile means nothing to rank, so the "For You" row is never requested
  // rather than fetched and discarded.
  const { data: tasteFeed } = useTasteFeed(
    activeProfileId ? activeProfileId : null,
    { limit: 20 }
  );

  const [view, setView] = useState<View>("home");
  const [search, setSearch] = useState("");
  const [genre, setGenre] = useState("All");
  // Sort and media type used to live in DiscoverDropdown as local state that
  // only ever reached `setGenre`, so picking "Top Rated" or "TV Show" changed
  // the highlighted chip and nothing else. They are catalog state now, applied
  // to `filtered` and to the paged browse grid alike.
  const [sort, setSort] = useState<CatalogSort>("trending");
  const [mediaType, setMediaType] = useState<MediaTypeFilter>("all");
  const [savedIds, setSavedIds] = useState<number[]>(() => savedListIds());

  useEffect(() => subscribeList(() => setSavedIds(savedListIds())), []);

  // The one shelf that is not the catalog: what this viewer has already
  // started. Kept out of `filtered` on purpose so it survives browse filters.
  const { items: continueItems } = useContinueWatching();

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
  // Read through a ref so paging callbacks never need affinity in their deps
  // and therefore never re-create (and re-trigger the observer) on a new signal.
  const affinityRef = useRef<Affinity>(
    typeof window === "undefined" ? emptyAffinity() : readAffinity()
  );

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
      ...affinityQueryParams(affinityRef.current),
    })
      .then(res => {
        if (cancelled) return;
        setDiscoverItems(
          rankByAffinity(
            res.items.map(toMovie),
            affinityRef.current,
            signalsFrom
          )
        );
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
    () => activeStreamMovies.map(toMovie),
    [activeStreamMovies]
  );

  const filtered = useMemo(() => {
    if (searching) {
      const searchType =
        mediaType !== "all"
          ? mediaType
          : view === "movies"
            ? "movie"
            : view === "tv"
              ? "tv"
              : "all";
      return applySort(applyMediaType(movies, searchType), sort);
    }
    let base =
      genre === "All"
        ? movies
        : movies.filter(movie => movie.genre.includes(genre));

    // Filter by media type for TV-specific views
    if (VIEWS_WITH_TV_FILTER.includes(view)) {
      if (view === "movies") {
        base = base.filter(movie => movie.mediaType !== "tv");
      } else if (view === "tv") {
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

    // An explicit media-type choice from the filter panel wins over the view's
    // own TV bias, but is never additive: asking for "Movie" while on the TV
    // shelf would otherwise intersect to nothing.
    if (view !== "movies" && view !== "tv" && mediaType !== "all") {
      base = applyMediaType(base, mediaType);
    }

    return applySort(base, sort);
  }, [genre, movies, searching, view, sort, mediaType]);

  function dedupeMovies(movies: Movie[]): Movie[] {
    const seen = new Set<string>();
    return movies.filter(movie => {
      const key = String(movie.providerId ?? movie.id ?? "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Server-ranked picks, or `null` when there is nothing to show.
   *
   * `personalised` is checked rather than assumed: a profile with no history
   * gets the untouched upstream list back, and rendering that under a "For You"
   * heading would be claiming personalisation that did not happen. Deduplicated
   * against the rest of the page so a title is not offered twice.
   */
  const forYou: Movie[] | null = useMemo(() => {
    if (!tasteFeed?.personalised) return null;
    const raw = tasteFeed.results as CatalogItem[];
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const seen = new Set(filtered.map(m => String(m.providerId ?? m.id ?? "")));
    const out: Movie[] = [];
    for (const item of raw) {
      const movie = toMovie(item);
      const key = String(movie.providerId ?? movie.id ?? "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(movie);
    }
    return out.length > 0 ? out : null;
  }, [tasteFeed, filtered]);

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
        /*
         * The home page is artwork, in this order and nothing in front of it:
         * pick up where you left off, then something to start tonight, then
         * something to commit to a series of. "Recently Added" used to sit
         * between the last two, which is the one shelf nobody browses by.
         */
        const cap2 = cap;
        // Every catalog item is typed on the way in, so this partition is
        // exhaustive: a title lands on exactly one of the two shelves.
        const movies = filtered.filter(movie => movie.mediaType !== "tv");
        const series = filtered.filter(movie => movie.mediaType === "tv");
        const out: CatalogRows[] = [];
        if (continueItems.length) {
          out.push({ title: "Continue Watching", items: continueItems });
        }
        out.push({
          title: "Trending Movies",
          items: movies.slice(0, cap),
          // Rated-first cards, because this shelf is ordered by what people are
          // watching and the rating is the only quality signal on a tile.
          kind: "score",
        });

        /*
         * Top 10, ranked rather than sliced.
         *
         * The obvious implementation -- `movies.slice(0, 10)` -- is the same ten
         * posters as the shelf above it wearing a number, which is worse than no
         * shelf: it looks like a ranking and ranks nothing. So this ranks on
         * `vote_average`, with popularity as the tiebreak, behind a floor that
         * keeps titles nobody has seen out of a chart of what is good.
         *
         * `vote_count` is not carried by the catalogue, so the floor is
         * popularity rather than a real vote count. That is the honest limit of
         * this data: it can rank by reception, and it cannot claim to rank by
         * significance.
         */
        const onOtherShelves = new Set(
          out.flatMap(row => row.items.map(movie => movie.providerId))
        );
        const ranked = movies
          .filter(
            movie =>
              typeof movie.score === "number" &&
              movie.score > 0 &&
              (movie.popularity ?? 0) >= MIN_POPULARITY_FOR_RANKING
          )
          .sort(
            (a, b) =>
              (b.score ?? 0) - (a.score ?? 0) ||
              (b.popularity ?? 0) - (a.popularity ?? 0)
          )
          .filter(movie => !onOtherShelves.has(movie.providerId))
          .slice(0, TOP_ROW_SIZE);
        // A chart with three entries is a broken chart, so the row is omitted
        // rather than topped up with titles that did not qualify.
        if (ranked.length >= Math.min(6, movies.length)) {
          out.push({ title: "Top 10 Rated", items: ranked, kind: "top10" });
        }

        // No cross-shelf dedupe is needed below this point: the rows are
        // partitioned by media type, so they cannot name the same title.
        out.push({ title: "Popular Series", items: series.slice(0, cap) });
        // Last, and only when the server actually ranked it. An empty "For You"
        // row reads as a broken feature, so it is omitted rather than padded.
        if (forYou)
          out.push({ title: "For You", items: forYou.slice(0, cap2) });
        return out;
      }
    }
  }, [view, filtered, savedIds, forYou, continueItems]);

  const setSection = useCallback((next: View) => {
    setView(next);
    setSearch("");
    setGenre("All");
  }, []);

  /** Fetch the next page of the aggregated catalog for the active browse view. */
  const loadMoreDiscover = useCallback(() => {
    if (
      discoverInFlightRef.current ||
      discoverLoadingMore ||
      !discoverHasMore
    ) {
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
      ...affinityQueryParams(affinityRef.current),
    })
      .then(res => {
        setDiscoverPage(res.page);
        setDiscoverHasMore(res.has_more);
        setDiscoverItems(prev => {
          const seen = new Set(prev.map(movie => movie.providerId));
          const fresh = res.items
            .map(toMovie)
            .filter(movie => !seen.has(movie.providerId));
          return [
            ...prev,
            ...rankByAffinity(fresh, affinityRef.current, signalsFrom),
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

  const recordAffinity = useCallback(
    (movie: Movie, weight = 1) => {
      // Session cache first so the grid re-ranks on the same tick...
      const next = recordInteraction(
        affinityRef.current,
        signalsFrom(movie),
        weight
      );
      affinityRef.current = next;
      writeAffinity(next);
      // ...then the durable copy. The recorder is a no-op when signed out and
      // never rejects, so this cannot interfere with the click that triggered it.
      recordTaste(
        // A negative weight is a rejection ("removed this from my list"). The
        // server folds it as a subtraction, so `save` with a negative weight now
        // pulls the title's features down instead of being dropped. It used to
        // be discarded by the model's `base <= 0` guard, which meant the
        // rejection was recorded in the event log and changed nothing about the
        // feed.
        weight > 0 ? "play" : "save",
        { genre: movie.genre, cast: movie.cast, director: movie.director },
        { weight }
      );
    },
    [recordTaste]
  );

  const toggleSave = useCallback((movie: Movie) => {
    toggleListSave(movie);
    setSavedIds(savedListIds());
  }, []);

  return {
    view,
    search,
    genre,
    sort,
    mediaType,
    savedIds,
    configured: true,
    loading,
    searchLoading,
    filtered,
    rows,
    continueWatching: continueItems,
    setView,
    setSection,
    setSearch,
    setGenre,
    setSort,
    setMediaType,
    toggleSave,
    // Sort and media type are applied here as well as to `filtered`, so the
    // paged browse grid honours them. Previously the filter panel looked
    // identical on every view but only moved anything on the shelf views.
    discoverItems: applySort(applyMediaType(discoverItems, mediaType), sort),
    discoverPage,
    discoverHasMore,
    discoverLoading,
    discoverLoadingMore,
    discoverError,
    discoverRateLimited,
    recordAffinity,
    forYou,
    loadMoreDiscover,
  };
}
