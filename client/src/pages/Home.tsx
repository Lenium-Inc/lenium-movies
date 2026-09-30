import { useEffect, useState } from "react";
import { Link } from "wouter";
import { genreFilterOptions, INFINITE_VIEWS, useCatalog } from "@/hooks/useCatalog";
import { Navbar } from "@/components/layout/Navbar";
import { APPLY_SEARCH_EVENT } from "@/components/layout/NavbarSearch";
import { tmdbImage } from "@/lib/tmdbImages";
import {
  CatalogEmptyState,
  SearchStatusBar,
} from "@/components/movies/CatalogEmptyState";
import { Details } from "@/components/movies/Details";
import { Spotlight } from "@/components/movies/Spotlight";
import { MovieRow } from "@/components/movies/MovieRow";
import { SkeletonMovieGrid } from "@/components/movies/SkeletonMovieCard";
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

  const heroBackdrop = heroActive?.backdrop;
  // `tmdbImage` rewrites the size segment. The `startsWith("http")` branch this
  // replaces matched every backend value and so handed back the stored w1280,
  // upscaled to fill an 80vh wash across the full viewport width.
  const heroArtUrl = heroBackdrop ? tmdbImage(heroBackdrop, "original") : null;

  return (
    <div className="min-h-screen bg-[#050505] text-[#FFFFFF]">
      <TopProgressBar isLoading={loading || searchLoading || discoverLoading} />
      {isHomeView && heroArtUrl ? (
        <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-0 h-[80vh] overflow-hidden">
          <img
            src={heroArtUrl}
            alt=""
            className="h-full w-full scale-110 object-cover opacity-70 blur-3xl"
          />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_90%_70%_at_50%_0%,transparent_20%,#050505_100%)]" />
        </div>
      ) : null}
      <div className="relative z-10">
        <Navbar view={view} onNavigate={setSection} />
      <main className="mx-auto max-w-[1480px] px-4 pb-24 sm:px-6 lg:px-8">
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
            {!isClientSearch && isHomeView && filtered.length > 0 ? (
              <div className="relative z-10 mx-auto mb-8 mt-4 w-full max-w-7xl">
                {/* Ambient aura. Sits at -z-10 inside this wrapper's stacking
                    context, so it spills around the card without escaping
                    behind the page. */}
                <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-zinc-900/70 shadow-2xl backdrop-blur-2xl">
                  <Spotlight
                    items={filtered}
                    savedIds={savedIds}
                    onSave={toggleSave}
                    onActiveChange={setHeroActive}
                  />
                </div>
              </div>
            ) : !isClientSearch && !isBrowseView && !loading && filtered.length === 0 ? (
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

            {/* What this product actually is, stated once, in the product's own
                voice. The home page previously opened straight into a grid with
                no explanation of the two things a viewer cannot infer from the
                shelves: that recommendations are built from their own history,
                and that watching is metered. Both are stated plainly here, and
                the limit is given the same number the server enforces so the
                promise on this page and the refusal at playback agree. */}
            {!isClientSearch && isHomeView && (
              <section
                aria-labelledby="what-is-stream-vy"
                className="mb-10 max-w-3xl border-l-2 border-white/10 pl-4"
              >
                <h2
                  id="what-is-stream-vy"
                  className="text-sm font-bold uppercase tracking-[0.18em] text-[#8b8b90]"
                >
                  What Stream Vy is
                </h2>
                <p className="mt-2 text-[13.5px] leading-relaxed text-zinc-400">
                  A shared shelf for the films you actually want to watch, with
                  separate profiles so everyone gets their own recommendations
                  instead of inheriting the last person&apos;s history. Pick
                  something you love and it is remembered; ignore what you
                  don&apos;t and the shelf gets sharper.
                </p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-zinc-500">
                  Free viewing is metered at 10 titles a day per profile, and
                  resets at midnight UTC. We don&apos;t host any films — every
                  copy lives on a third-party host, so availability varies by
                  title.{" "}
                  <Link href="/terms" className="underline underline-offset-4 hover:text-zinc-300">
                    Terms
                  </Link>
                </p>
              </section>
            )}
            <section className="mt-8 flex flex-wrap items-center justify-between gap-4">
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
                rows.map((row, index) => (
                  <MovieRow
                    key={row.title}
                    title={row.title}
                    items={row.items}
                    savedIds={savedIds}
                    onSelect={setSelected}
                    onSave={toggleSave}
                    eyebrow={
                      index === 0 && view === "home"
                        ? "Find something worth watching"
                        : undefined
                    }
                    grid
                    rowIndex={index}
                  />
                ))
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
            Public-domain and openly licensed film, streamed from
            third-party hosts. We don&apos;t host any of it — see the{" "}
            <a
              href="/terms"
              className="text-zinc-400 underline underline-offset-4 transition hover:text-zinc-200"
            >
              Terms of Service
            </a>
            .
          </p>
          <nav className="flex items-center gap-5 text-xs text-zinc-400">
            <a
              href="/terms"
              className="transition hover:text-white"
            >
              Terms
            </a>
            <a
              href="/privacy"
              className="transition hover:text-white"
            >
              Privacy
            </a>
            <a
              href="/dmca"
              className="transition hover:text-white"
            >
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
