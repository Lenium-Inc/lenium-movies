import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { genreFilterOptions, useCatalog } from "@/hooks/useCatalog";
import { BottomNav } from "@/components/layout/BottomNav";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { CatalogEmptyState, SearchStatusBar } from "@/components/movies/CatalogEmptyState";
import { Details } from "@/components/movies/Details";
import { DiscoverDialog, GenreChips } from "@/components/movies/DiscoverDialog";
import { FeaturedHero } from "@/components/movies/FeaturedHero";
import { MovieRow } from "@/components/movies/MovieRow";
import type { Movie } from "@/components/movies/types";

const moodActions: Array<{ mood: string; genre?: string; search?: string }> = [
  { mood: "Something funny", genre: "Comedy" },
  { mood: "Something scary", genre: "Horror" },
  { mood: "Something romantic", genre: "Romance" },
  { mood: "Something intense", genre: "Crime" },
  { mood: "Something epic", genre: "Action" },
  { mood: "Something family-friendly", genre: "Family" },
];

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
    filtered,
    rows,
    setView,
    setSection,
    setSearch,
    setGenre,
    toggleSave,
  } = useCatalog();

  const [menuOpen, setMenuOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [selected, setSelected] = useState<Movie | null>(null);

  const featured = filtered[0];
  const isClientSearch = search.trim().length > 0;

  /** Map a DiscoverDialog mood to an actual genre filter and return to movies. */
  const applyMood = (action: (typeof moodActions)[number]) => {
    if (action.genre) setGenre(action.genre);
    if (action.search !== undefined) setSearch(action.search);
    setView("movies");
    setDiscoverOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#0b0b0e] text-[#f1f1ee]">
      <Sidebar
        view={view}
        onNavigate={setSection}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
      <div className="lg:pl-[232px]">
        <div className="border-b border-white/10 bg-[#d7d7d3] px-4 py-1.5 text-center text-[9px] font-bold uppercase tracking-[0.16em] text-[#0b0b0e]">
          Live metadata mode · TMDB source · Playback and rights are separate capabilities
        </div>
        <Header
          view={view}
          search={search}
          onSearchChange={(value) => {
            setSearch(value);
            setView("movies");
          }}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <main className="mx-auto max-w-[1480px] px-4 pb-20 sm:px-6 lg:px-8">
          {view === "collections" ? (
            <section className="py-12">
              <h1 className="text-2xl font-bold">Collections</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#99999d]">
                Curated collections will appear when real collection records are imported and
                approved. No placeholder collections are shown.
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
                  .filter((item) => item !== "All")
                  .map((item) => (
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
              {view === "home" && featured ? (
                <FeaturedHero
                  movie={featured}
                  onSelect={() => setSelected(featured)}
                  onSave={() => toggleSave(featured)}
                />
              ) : (
                <CatalogEmptyState loading={loading} configured={configured} />
              )}
              {isClientSearch && <SearchStatusBar query={search} onClear={() => setSearch("")} />}
              <section className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <GenreChips
                  genres={genreFilterOptions}
                  active={genre}
                  onSelect={(item) => {
                    setGenre(item);
                    setView("movies");
                  }}
                />
                <button
                  onClick={() => setDiscoverOpen(true)}
                  className="flex shrink-0 items-center justify-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-[#c4c4c0] hover:bg-white/10"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" /> Discover
                </button>
              </section>
              <DiscoverDialog
                open={discoverOpen}
                actions={moodActions}
                onClose={() => setDiscoverOpen(false)}
                onApply={applyMood}
              />
              <div className="mt-8">
                {rows.map((row, index) => (
                  <MovieRow
                    key={row.title}
                    title={row.title}
                    items={row.items}
                    savedIds={savedIds}
                    onSelect={setSelected}
                    onSave={toggleSave}
                    eyebrow={index === 0 && view === "home" ? "Find something worth watching" : undefined}
                  />
                ))}
              </div>
            </>
          )}
        </main>
        <BottomNav view={view} searching={isClientSearch} onNavigate={setSection} />
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