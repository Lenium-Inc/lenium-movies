interface FilterBarProps {
  /** Regional origin tabs, e.g. ["All", "Hollywood", "Bollywood"]. */
  regions: readonly string[];
  /** Dynamic sub-genre pills, e.g. ["Sci-Fi", "Thriller", "Action", "Comedy"]. */
  genres: readonly string[];
  activeRegion: string;
  activeGenre: string;
  onRegionChange: (region: string) => void;
  onGenreChange: (genre: string) => void;
  regionLabel?: string;
  genreLabel?: string;
}

function chipClasses(active: boolean): string {
  return [
    "whitespace-nowrap transition duration-200",
    active
      ? "bg-white text-black shadow-[0_4px_18px_rgba(255,255,255,0.22)] ring-1 ring-inset ring-white/60"
      : "border border-white/10 text-[#8E8E93] hover:border-white/30 hover:bg-white/[0.06] hover:text-white",
  ].join(" ");
}

/**
 * Horizontally scrollable, responsive filter bar. Two groups — regional-origin
 * tabs and sub-genre pills — are separated by a thin vertical divider inside a
 * charcoal `#121212` surface with a 1px border. Active states are crisp white
 * chips with black text (high contrast interactive emphasis); inactive states
 * brighten on hover with an accent border. Every toggle fires synchronously
 * against the shared filtering engine.
 */
export function FilterBar({
  regions,
  genres,
  activeRegion,
  activeGenre,
  onRegionChange,
  onGenreChange,
  regionLabel = "Region",
  genreLabel = "Genre",
}: FilterBarProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-[#121212] shadow-[0_12px_34px_rgba(0,0,0,0.6)] no-scrollbar">
      <div className="flex min-w-max items-stretch gap-2 px-3 py-2.5">
        <div className="flex flex-col justify-center">
          <span className="px-1 pb-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[#4A4A50]">
            {regionLabel}
          </span>
          <div className="flex items-center gap-1.5">
            {regions.map(region => {
              const active = region === activeRegion;
              return (
                <button
                  key={region}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onRegionChange(region)}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${chipClasses(active)}`}
                >
                  {region}
                </button>
              );
            })}
          </div>
        </div>

        <span
          aria-hidden
          className="mx-1 my-1.5 w-px shrink-0 self-stretch bg-white/10"
        />

        <div className="flex flex-col justify-center">
          <span className="px-1 pb-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-[#4A4A50]">
            {genreLabel}
          </span>
          <div className="flex items-center gap-1.5">
            {genres.map(genreItem => {
              const active = genreItem === activeGenre;
              return (
                <button
                  key={genreItem}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onGenreChange(genreItem)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${chipClasses(active)}`}
                >
                  {genreItem}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
