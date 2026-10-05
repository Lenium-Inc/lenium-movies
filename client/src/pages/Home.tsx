import { useEffect, useMemo, useState } from "react";
import {
  genreFilterOptions,
  INFINITE_VIEWS,
  useCatalog,
} from "@/hooks/useCatalog";
import { Navbar } from "@/components/layout/Navbar";
import { APPLY_SEARCH_EVENT } from "@/components/layout/NavbarSearch";
import { tmdbImage } from "@/lib/tmdbImages";
import {
  CatalogEmptyState,
  SearchStatusBar,
} from "@/components/movies/CatalogEmptyState";
import { Details } from "@/components/movies/Details";
import { EpisodeCard } from "@/components/movies/EpisodeCard";
import { RowScroller } from "@/components/movies/RowScroller";
import { Spotlight } from "@/components/movies/Spotlight";
import { Top10Row } from "@/components/movies/Top10Row";
import { useEpisodeResume, useNewEpisodes } from "@/hooks/useNewEpisodes";
import { buildWatchPath } from "@/lib/watchRoute";
import { MovieRow } from "@/components/movies/MovieRow";
import {
  SkeletonEpisodeShelf,
  SkeletonMovieGrid,
} from "@/components/movies/SkeletonMovieCard";
import { InfiniteMovieGrid } from "@/components/movies/InfiniteMovieGrid";
import { DiscoverDropdown } from "@/components/DiscoverDropdown";
import { TopProgressBar } from "@/components/ui/TopProgressBar";
import type { Movie } from "@/components/movies/types";
import type { View } from "@/components/layout/navigation";

/**
 * Root catalog page: wires the Netflix-style top navigation, all movie
 * shelves, and the details modal around the shared `useCatalog` state owner.
 * Any modal/selection state (menu, discovery, movie details) lives here,
 * separate from the data layer in the hook.
 */
export default function Home() {
  const {
    view,
    search,
    genre,
    sort,
    mediaType,
    savedIds,
    configured,
    loading,
    searchLoading,
    filtered,
    rows,
    continueWatching: continueWatchingItems,
    discoverItems,
    discoverHasMore,
    discoverLoading,
    discoverLoadingMore,
    discoverError,
    discoverRateLimited,
    recordAffinity,
    setView,
    setSection,
    setSearch,
    setGenre,
    setSort,
    setMediaType,
    toggleSave,
    loadMoreDiscover,
  } = useCatalog();

  const [selected, setSelected] = useState<Movie | null>(null);

  const [heroActive, setHeroActive] = useState<Movie | null>(null);

  // The navbar search can push a plain query back into the catalog
  // grid ("Show all results") — apply it to the shared search state.
  useEffect(() => {
    const onApply = (event: Event) => {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query;
      if (typeof query === "string" && query.trim()) {
        setSearch(query.trim());
        setView("movies");
      }
    };
    window.addEventListener(APPLY_SEARCH_EVENT, onApply);
    return () => window.removeEventListener(APPLY_SEARCH_EVENT, onApply);
  }, [setSearch, setView]);

  const isClientSearch = search.trim().length > 0;
  const isHomeView = view === "home" && !isClientSearch;
  const isBrowseView = INFINITE_VIEWS.has(view) && !isClientSearch;
  const heroItems = useMemo(
    () => filtered.filter(movie => movie.mediaType !== "tv"),
    [filtered]
  );

  /*
   * The episode shelf is fed by the shows already on this page rather than by a
   * list of its own: a show that is trending *now* is a show with something new
   * to watch *now*, and reusing `filtered` means the shelf costs no extra
   * catalogue request to populate.
   *
   * Home view only. On a browse grid the viewer asked for one specific list, and
   * quietly mounting a shelf that issues six season requests underneath their
   * filter would spend bandwidth on something they did not ask for.
   */
  const { episodes: newEpisodeItems } = useNewEpisodes(
    isHomeView ? filtered : []
  );
  const newEpisodes = useEpisodeResume(newEpisodeItems, continueWatchingItems);

  /*
   * One column per show. `useNewEpisodes` returns a flat list ordered newest
   * first, which is right for a "latest" shelf and wrong here: interleaving two
   * shows puts S3E1 of one show directly above S7E2 of another and the grouping
   * falls apart. Episodes are still grouped in the order their shows first
   * appear in that list, so the most recently active show leads.
   */
  const episodeColumns = useMemo(() => {
    const byShow = new Map<
      string,
      { showId: string; showName: string; items: typeof newEpisodes }
    >();
    for (const item of newEpisodes) {
      // `number` null means TMDB listed the episode without one; there is no
      // route to open for it, so it is left off the shelf rather than opening
      // S{season}E0.
      if (item.episode.number == null) continue;
      const existing = byShow.get(item.showId);
      if (existing) {
        // At most three per column: a long-running show would otherwise make
        // one column three times the height of the shelf's neighbours and push
        // every other show off screen.
        if (existing.items.length < 3) existing.items.push(item);
        continue;
      }
      byShow.set(item.showId, {
        showId: item.showId,
        showName: item.showName,
        items: [item],
      });
    }
    return Array.from(byShow.values());
  }, [newEpisodes]);
  // A hero with nothing in it is a 70vh rectangle of empty gradient, so it is
  // only rendered when the home view actually has titles to feature.
  const showHero = isHomeView && heroItems.length > 0 && !loading;

  const heroBackdrop = heroActive?.backdrop;
  // `tmdbImage` rewrites the size segment. The `startsWith("http")` branch this
  // replaces matched every backend value and so handed back the stored w1280,
  // upscaled to fill an 80vh wash across the full viewport width.
  const heroArtUrl = heroBackdrop ? tmdbImage(heroBackdrop, "original") : null;

  return (
    /*
     * `bg-[#050505]` was a hand-picked near-black that matched nothing else in
     * the app: the palette, the cards and every surface token resolved to
     * `#0b0c10` / slate, so this one wrapper read as a slightly different black
     * behind the shelves. The shell owns the background now.
     */
    <div className="min-h-screen text-[#FFFFFF]">
      <TopProgressBar isLoading={loading || searchLoading || discoverLoading} />
      {isHomeView && heroArtUrl ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[80vh] overflow-hidden"
        >
          <img
            src={heroArtUrl}
            alt=""
            className="h-full w-full scale-110 object-cover opacity-70 blur-3xl"
          />
          {/* Fades the blurred art back into the base colour. `transparent`
              is used deliberately: a named base here would paint a visible
              ellipse edge over the shell's own gradient. */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_90%_70%_at_50%_0%,transparent_20%,var(--sv-base)_100%)]" />
        </div>
      ) : null}
      <div className="relative z-10">
        <Navbar view={view} onNavigate={setSection} />

        {/* The hero is a sibling of <main>, not a child of it, because <main>
            is the page's 1480px content column and the whole point of a
            full-bleed hero is that it ignores that column. It sits directly under
            the nav and runs the full width of the viewport, and its own text is
            re-aligned to the same gutter in Spotlight so the title still lines up
            with the shelves underneath instead of drifting to the screen edge. */}
        {showHero ? (
          <div className="relative">
            <Spotlight
              items={heroItems}
              onActiveChange={setHeroActive}
              onMoreInfo={setSelected}
            />
          </div>
        ) : null}

        {/* `relative z-10` plus a negative top margin is what makes the first
            shelf sit *on* the hero instead of below it. The negative margin alone
            would slide the content behind the hero, because the hero is painted
            later in document order and both are in the same stacking context --
            `z-10` is what puts the shelves back in front. Overlap is capped so the
            hero's title, copy and buttons are never covered by a shelf. */}
        <main className="relative z-10 mx-auto mt-8 max-w-[1480px] px-4 pb-24 sm:px-6 lg:px-8">
          {view === "collections" ? (
            <section className="py-12">
              <h1 className="text-2xl font-bold">Collections</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#99999d]">
                Curated collections will appear when real collection records are
                imported and approved. No placeholder collections are shown.
              </p>
            </section>
          ) : view === "genres" ? (
            <section className="py-8">
              <div className="mb-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90]">
                  Browse the real catalogue
                </p>
                <h1 className="mt-1 text-2xl font-bold">Genres</h1>
              </div>
              <div className="flex flex-wrap gap-2">
                {genreFilterOptions
                  .filter(item => item !== "All")
                  .map(item => (
                    <button
                      key={item}
                      onClick={() => {
                        setGenre(item);
                        setView("movies");
                      }}
                      className="rounded-md border border-white/10 px-4 py-3 text-sm font-semibold text-[#d0d0cc] hover:border-white/30 hover:bg-white/[0.05]"
                    >
                      {item}
                    </button>
                  ))}
              </div>
            </section>
          ) : (
            <>
              {isClientSearch ? (
                <SearchStatusBar query={search} onClear={() => setSearch("")} />
              ) : null}
              {!isClientSearch &&
              !isBrowseView &&
              !loading &&
              filtered.length === 0 ? (
                <CatalogEmptyState loading={false} configured={configured} />
              ) : null}
              {isClientSearch &&
                filtered.length === 0 &&
                !loading &&
                !searchLoading && (
                  <CatalogEmptyState
                    loading={false}
                    configured={true}
                    query={search}
                    searchLoading={searchLoading}
                  />
                )}

              {/*
              Nothing here on purpose.

              The home page used to open with a "What Lenium is" block
              restating what the product does and, underneath it, the daily
              viewing allowance in the same words the server refuses with. It sat
              between the featured title and the shelves, so the two things a
              visitor came for -- pick something to watch, resume something --
              were separated by a paragraph of policy. A shelf does not need to
              explain itself.
            */}

              {/*
              Browse controls. On the home view the heading is dropped and only
              the filter row remains: with the shelves underneath now named
              (Continue Watching / Trending Movies / Popular Series), a
              "Browse the catalogue" heading in front of them labels the hero's
              own output rather than a separate destination.
            */}
              <section className="mt-12 flex flex-wrap items-center justify-between gap-4">
                {isHomeView ? null : (
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90]">
                      Browse the catalogue
                    </p>
                    {/* An h2, not an h1: the spotlight above already owns the
                      page's h1 with the featured title. Two h1s on one page
                      splits the document outline and leaves assistive tech
                      announcing the featured film twice. */}
                    <h2 className="mt-1 text-2xl font-bold">Discover</h2>
                  </div>
                )}
                <DiscoverDropdown
                  genre={genre}
                  setGenre={setGenre}
                  sort={sort}
                  setSort={setSort}
                  mediaType={mediaType}
                  setMediaType={setMediaType}
                  setView={setView}
                  filteredCount={
                    isBrowseView ? discoverItems.length : filtered.length
                  }
                  isLoading={loading || searchLoading || discoverLoading}
                />
              </section>
              <div className="mt-8">
                {loading ? (
                  <SkeletonMovieGrid count={12} />
                ) : searchLoading && isClientSearch ? (
                  <SkeletonMovieGrid count={12} />
                ) : isBrowseView ? (
                  <InfiniteMovieGrid
                    items={discoverItems}
                    savedIds={savedIds}
                    onSelect={movie => {
                      recordAffinity(movie, 0.5);
                      setSelected(movie);
                    }}
                    onSave={movie => {
                      recordAffinity(movie, 0.8);
                      toggleSave(movie);
                    }}
                    onLoadMore={loadMoreDiscover}
                    hasMore={discoverHasMore}
                    initialLoading={discoverLoading}
                    loadingMore={discoverLoadingMore}
                    error={discoverError}
                    rateLimited={discoverRateLimited}
                  />
                ) : (
                  <>
                    {/*
                    New Episodes sits above every catalogue row and below the
                    hero: an episode that aired this week is the freshest thing
                    on the page, and burying it under Trending would make the
                    shelf's whole reason for existing unmissable only if you
                    happened to scroll.

                    Grouped by show, in columns: the question this shelf answers
                    is "what has my show been doing", which cannot be answered by
                    eighteen unrelated stills in a single line. Each column is one
                    show's newest episodes, so the shelf reads like a contents
                    page for what you are already following. Columns come from
                    different shows, so nothing is repeated within the shelf.
                    */}
                    {isHomeView &&
                      (episodeColumns.length ? (
                        <section className="mb-8">
                          <h2 className="mb-3 px-1 text-lg font-semibold text-white">
                            New Episodes
                          </h2>
                          <RowScroller label="New Episodes">
                            {episodeColumns.map(column => (
                              <div
                                key={column.showId}
                                className="w-64 shrink-0"
                              >
                                <h3 className="mb-2 line-clamp-1 text-xs font-semibold text-zinc-400">
                                  {column.showName}
                                </h3>
                                <div className="flex flex-col gap-3">
                                  {column.items.map(item => (
                                    <EpisodeCard
                                      key={`${item.showId}-${item.episode.season}-${item.episode.number}`}
                                      episode={item.episode}
                                      showName={item.showName}
                                      resume={item.resume}
                                      onPlay={() => {
                                        // Same route contract as every other TV
                                        // link on the site: the episode travels in
                                        // the query string, never in the path
                                        // segment.
                                        window.location.href = buildWatchPath(
                                          item.showId,
                                          {
                                            mediaType: "tv",
                                            season: item.episode.season,
                                            episode: item.episode.number ?? 1,
                                          }
                                        );
                                      }}
                                    />
                                  ))}
                                </div>
                              </div>
                            ))}
                          </RowScroller>
                        </section>
                      ) : /*
                         A loading placeholder rather than nothing. This shelf used
                         to render only once its columns existed, so for the length
                         of the request the page appeared to have no such
                         category -- and then grew one underneath the viewer,
                         pushing every row below it down. The heading is rendered
                         too, for the same reason: a category that arrives with its
                         own title reads as loaded, where a block of shimmer
                         appearing from nowhere reads as a glitch.
                       */ loading ? (
                        <section className="mb-8" aria-busy="true">
                          <h2 className="mb-3 px-1 text-lg font-semibold text-white">
                            New Episodes
                          </h2>
                          <RowScroller label="New Episodes">
                            <SkeletonEpisodeShelf />
                          </RowScroller>
                        </section>
                      ) : null)}
                    {rows.map((row, index) =>
                      row.kind === "top10" ? (
                        <Top10Row
                          key={row.title}
                          title={row.title}
                          items={row.items}
                          savedIds={savedIds}
                          onSelect={movie => {
                            recordAffinity(movie, 0.5);
                            setSelected(movie);
                          }}
                          onSave={movie => {
                            recordAffinity(movie, 0.8);
                            toggleSave(movie);
                          }}
                        />
                      ) : (
                        <MovieRow
                          key={row.title}
                          title={row.title}
                          items={row.items}
                          savedIds={savedIds}
                          onSelect={setSelected}
                          onSave={toggleSave}
                          variant={row.kind === "score" ? "score" : "poster"}
                          grid
                          rowIndex={index}
                        />
                      )
                    )}
                  </>
                )}
              </div>

              {/* TMDB attribution. Their terms require a visible credit wherever
                their metadata and imagery appear, and every poster, backdrop,
                synopsis, rating and cast list in this catalogue comes from
                there. It was missing entirely. */}
              <p className="mt-10 text-[11px] leading-5 text-zinc-600">
                This product uses the TMDB API but is not endorsed or certified
                by TMDB.{" "}
                <a
                  href="https://www.themoviedb.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 transition hover:text-zinc-400"
                >
                  Movie metadata &amp; artwork by TMDB
                </a>
                .
              </p>
            </>
          )}
        </main>

        <footer className="border-t border-white/5 px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-xs leading-5 text-zinc-500">
              Public-domain and openly licensed film, streamed from third-party
              hosts. We don&apos;t host any of it — see the{" "}
              <a
                href="/terms"
                className="text-zinc-400 underline underline-offset-4 transition hover:text-zinc-200"
              >
                Terms of Service
              </a>
              .
            </p>
            <nav className="flex items-center gap-5 text-xs text-zinc-400">
              <a href="/terms" className="transition hover:text-white">
                Terms
              </a>
              <a href="/privacy" className="transition hover:text-white">
                Privacy
              </a>
              <a href="/dmca" className="transition hover:text-white">
                Copyright &amp; DMCA
              </a>
              {/*
              Honeypot. Present in the DOM, hidden from people and from the
              accessibility tree, and harmless if followed. A crawler that
              treats the page as a link graph to walk lands here and is recorded
              as weak evidence of automated traffic. It is one signal among
              several and never blocks on its own.
            */}
              <a
                href="/api/hp/asset-manifest.json"
                aria-hidden="true"
                tabIndex={-1}
                className="sr-only pointer-events-none select-none"
              >
                Sitemap
              </a>
            </nav>
          </div>
        </footer>
      </div>
      {selected && (
        <Details
          movie={selected}
          onClose={() => setSelected(null)}
          onSave={() => toggleSave(selected)}
          saved={savedIds.includes(selected.id)}
        />
      )}
    </div>
  );
}
