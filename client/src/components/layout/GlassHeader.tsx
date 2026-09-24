import { CirclePlay, Menu, Search, UserRound, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";

interface GlassHeaderProps {
  search?: string;
  onSearchChange?: (value: string) => void;
  /** Show the mobile menu button; wires into a page-level drawer/sidebar. */
  onOpenMenu?: () => void;
  /** Right-side user profile control (profile panel lives on the page). */
  profile?: ReactNode;
}

/**
 * The single, unified top bar: brand, global search, and profile control.
 * Destination navigation lives exclusively in the sidebar.
 *
 * The search term is fully controlled by the caller (`search` + `onSearchChange`),
 * so typing here updates the shared `useCatalog()` state immediately. On mobile
 * the field expands behind the search icon so the same input stays mounted.
 *
 * The strict monochrome treatment (void-black glass over `#050505`, thin
 * `border-white/10`) keeps it legible above any hero with no color accents.
 */
export function GlassHeader({
  search = "",
  onSearchChange,
  onOpenMenu,
  profile,
}: GlassHeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const renderInput = (options: { autoFocus?: boolean } = {}) => (
    <input
      type="search"
      value={search}
      onChange={event => onSearchChange?.(event.target.value)}
      placeholder="Search movies, shows, genres"
      aria-label="Search the catalogue"
      autoFocus={options.autoFocus}
      className="w-full sm:w-44 lg:w-64 bg-transparent text-xs text-white outline-none placeholder:text-[#6E6E74]"
    />
  );

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#050505]/70 backdrop-blur-[16px]">
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3 px-3 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onOpenMenu}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 text-white/70 transition hover:bg-white/10 hover:text-white lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>

        <Link
          href="/"
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.06] py-2 pl-3 pr-3.5 transition hover:border-white/25 hover:bg-white/10"
        >
          <CirclePlay className="h-4 w-4 text-white" />
          <span className="text-sm font-black tracking-tight text-white">
            Stream Vy
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2.5">
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3.5 py-2 transition focus-within:border-white/40 sm:flex">
            <Search className="h-3.5 w-3.5 text-white/50" />
            {renderInput()}
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-px text-[9px] font-semibold text-white/40">
              /
            </kbd>
          </div>
          <button
            type="button"
            aria-label={mobileOpen ? "Close search" : "Search titles"}
            onClick={() => setMobileOpen(open => !open)}
            className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white/80 transition hover:bg-white/15 sm:hidden"
          >
            {mobileOpen ? (
              <X className="h-4 w-4" />
            ) : (
              <Search className="h-4 w-4" />
            )}
          </button>
          {profile ?? (
            <button
              type="button"
              aria-label="Profile"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-white/[0.08] text-white transition hover:bg-white/20"
            >
              <UserRound className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {mobileOpen && (
        <div className="flex items-center gap-2 border-t border-white/10 bg-[#050505]/70 px-3 py-2 backdrop-blur-[16px] sm:hidden">
          <Search className="h-3.5 w-3.5 shrink-0 text-white/50" />
          <div className="min-w-0 flex-1">
            {renderInput({ autoFocus: true })}
          </div>
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onSearchChange?.("");
              setMobileOpen(false);
            }}
            className="shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold text-white/60 hover:bg-white/10"
          >
            Clear
          </button>
        </div>
      )}
    </header>
  );
}
