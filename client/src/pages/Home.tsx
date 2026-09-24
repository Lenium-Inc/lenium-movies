import { useState, useRef } from "react";
import { genreFilterOptions, useCatalog } from "@/hooks/useCatalog";
import { BottomNav } from "@/components/layout/BottomNav";
import { GlassHeader } from "@/components/layout/GlassHeader";
import { Sidebar } from "@/components/layout/Sidebar";
import {
  CatalogEmptyState,
  SearchStatusBar,
} from "@/components/movies/CatalogEmptyState";
import { Details } from "@/components/movies/Details";
import { Spotlight } from "@/components/movies/Spotlight";
import { MovieRow } from "@/components/movies/MovieRow";
import { SkeletonMovieGrid } from "@/components/movies/SkeletonMovieCard";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import { DiscoverDropdown } from "@/components/DiscoverDropdown";
import { TopProgressBar } from "@/components/ui/TopProgressBar";
import type { Movie } from "@/components/movies/types";
import type { View } from "@/components/layout/navigation";

/**
 * Root catalog page: wires the sidebar, header, mobile nav, and all movie
 * shelves around the shared `useCatalog` state owner. Any modal/selection
 * state (menu, discovery, movie details) lives here, separate from the data
 * layer in the hook.
 */
export default function Home() {
  const {
    view,
    search,
    genre,
    savedIds,
    configured,
    loading,
    searchLoading,
    filtered,
    rows,
    setView,
    setSection,
    setSearch,
    setGenre,
    toggleSave,
  } = useCatalog();

  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState<Movie | null>(null);

  const isClientSearch = search.trim().length > 0;
  const isHomeView = view === "home" && !isClientSearch;

  return (
    <div className="min-h-screen bg-[#050505] text-[#FFFFFF]">
      <TopProgressBar isLoading={loading || searchLoading} />
      <Sidebar
        view={view}
        onNavigate={setSection}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        activeGenre={genre}
        onGenreChange={setGenre}
      />
      <GlassHeader
        search={search}
        onSearchChange={value => {
          setSearch(value);
          setView("movies");
        }}
        onOpenMenu={() => setMenuOpen(true)}
        profile={<ProfileMenu />}
      />
      <div className="lg:pl-[84px]">
        <main className="mx-auto max-w-[1480px] px-4 pb-20 sm:px-6 lg:pl-0 lg:pr-8">
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
              <section className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <DiscoverDropdown
                  genre={genre}
                  setGenre={setGenre}
                  setView={setView}
                  filteredCount={filtered.length}
                  isLoading={loading || searchLoading}
                />
              </section>
              {isClientSearch ? (
                <SearchStatusBar query={search} onClear={() => setSearch("")} />
              ) : null}
              {!isClientSearch && isHomeView && filtered.length > 0 ? (
                <Spotlight
                  items={filtered}
                  savedIds={savedIds}
                  onSave={toggleSave}
                />
              ) : !isClientSearch && !loading ? (
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
              <div className="mt-8">
                {loading ? (
                  <SkeletonMovieGrid count={12} />
                ) : searchLoading && isClientSearch ? (
                  <SkeletonMovieGrid count={12} />
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
            </>
          )}
        </main>
        <BottomNav
          view={view}
          searching={isClientSearch}
          onNavigate={setSection}
        />
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
