import { X, ChevronDown, ChevronUp, Film, ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { useState } from "react";
import { navItems, type NavItem, type View, genreFilterOptions } from "./navigation";

interface SidebarProps {
  view: View;
  onNavigate: (view: View) => void;
  open: boolean;
  onClose: () => void;
  activeGenre: string;
  onGenreChange: (genre: string) => void;
}

function RailButton({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  if (item.id === "profile") {
    return (
      <Link
        href="/profile"
        aria-label={item.label}
        title={item.label}
        className={`group relative grid h-10 w-10 place-items-center rounded-full transition ${
          active
            ? "bg-white text-black shadow-[0_0_22px_rgba(255,255,255,0.35)]"
            : "text-[#8a8a8e] hover:bg-white/[0.08] hover:text-white"
        }`}
      >
        <Icon className="h-[18px] w-[18px]" />
        <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded bg-[#1c1c20] px-2 py-1 text-[10px] font-semibold text-white opacity-0 shadow-lg ring-1 ring-white/15 transition group-hover:opacity-100">
          {item.label}
        </span>
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={item.label}
      title={item.label}
      aria-current={active ? "page" : undefined}
      className={`group relative grid h-10 w-10 place-items-center rounded-full transition ${
        active
          ? "bg-white text-black shadow-[0_0_22px_rgba(255,255,255,0.35)]"
          : "text-[#8a8a8e] hover:bg-white/[0.08] hover:text-white"
      }`}
    >
      <Icon className="h-[18px] w-[18px]" />
      <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded bg-[#1c1c20] px-2 py-1 text-[10px] font-semibold text-white opacity-0 shadow-lg ring-1 ring-white/15 transition group-hover:opacity-100">
        {item.label}
      </span>
    </button>
  );
}

/**
 * Navigation.
 *
 * Collapsible sidebar that defaults to closed (icon-only rail).
 * Expands on hover or click to show labels and genre filters.
 * Non-intrusive design that doesn't crowd content.
 */
export function Sidebar({ view, onNavigate, open, onClose, activeGenre, onGenreChange }: SidebarProps) {
  const navigate = (next: View) => {
    onNavigate(next);
    onClose();
  };

  const [expanded, setExpanded] = useState(false);
  const [genreExpanded, setGenreExpanded] = useState(false);

  return (
    <>
      {/* Collapsible sidebar rail — desktop only */}
      <aside
        className={`fixed left-4 top-1/2 z-40 -translate-y-1/2 flex-col items-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.05] px-2.5 py-4 shadow-[0_16px_48px_rgba(0,0,0,0.55)] backdrop-blur-[16px] lg:flex transition-all duration-300 ease-out ${
          expanded ? "w-56" : "w-14"
        }`}
        aria-label="Primary navigation"
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
      >
        {/* Nav items */}
        <div className="flex flex-col items-center gap-1.5 w-full">
          {navItems.map(item => (
            <RailButton
              key={item.id}
              item={item}
              active={view === item.id}
              onClick={() => navigate(item.id)}
            />
          ))}
        </div>

        {/* Genre Filters Section - only visible when expanded */}
        {expanded && (
          <div className="w-full mt-6 pt-6 border-t border-white/10 animate-in slide-in-from-left-2 duration-200">
            <button
              type="button"
              onClick={() => setGenreExpanded(!genreExpanded)}
              className="flex w-full items-center justify-between px-2 py-2 text-left text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90] transition hover:text-white"
              aria-expanded={genreExpanded}
              aria-controls="sidebar-genres"
            >
              <span className="flex items-center gap-2">
                <Film className="h-3.5 w-3.5" />
                Genres
              </span>
              {genreExpanded ? (
                <ChevronUp className="h-3.5 w-3.5 transition-transform" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 transition-transform" />
              )}
            </button>
            {genreExpanded && (
              <div id="sidebar-genres" className="mt-2 flex flex-col gap-1 animate-in slide-in-from-top-2 duration-150">
                {genreFilterOptions.map(genre => (
                  <button
                    key={genre}
                    onClick={() => onGenreChange(genre)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition ${
                      activeGenre === genre
                        ? "bg-white/10 text-white"
                        : "text-[#8a8a8e] hover:bg-white/[0.05] hover:text-white"
                    }`}
                    aria-current={activeGenre === genre ? "page" : undefined}
                  >
                    <span className="flex-1 text-left">{genre}</span>
                    {activeGenre === genre && <Film className="h-3.5 w-3.5 text-[#d7d7d3]" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Expand/Collapse toggle button at bottom */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-auto flex w-full items-center justify-center gap-2 rounded-lg px-2 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90] transition hover:text-white hover:bg-white/[0.05]"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        >
          {expanded ? (
            <>
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Collapse</span>
            </>
          ) : (
            <>
              <ChevronRight className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Menu</span>
            </>
          )}
        </button>
      </aside>

      {/* Slide-in drawer — mobile only */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[62px] flex-col items-center border-r border-white/10 bg-[#0A0A0C]/95 py-4 backdrop-blur-2xl transition-transform duration-200 lg:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Primary navigation"
      >
        <button
          onClick={onClose}
          className="grid h-9 w-9 place-items-center rounded-md text-[#8e8e92] hover:bg-white/10 hover:text-white"
          aria-label="Close menu"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mt-8 flex flex-col items-center gap-1">
          {navItems.map(item => (
            <RailButton
              key={item.id}
              item={item}
              active={view === item.id}
              onClick={() => navigate(item.id)}
            />
          ))}
        </div>

        {/* Mobile Genre Filters */}
        <div className="w-full mt-6 pt-6 border-t border-white/10 px-2">
          <button
            type="button"
            onClick={() => setGenreExpanded(!genreExpanded)}
            className="flex w-full items-center justify-between px-2 py-2 text-left text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b8b90] transition hover:text-white"
            aria-expanded={genreExpanded}
            aria-controls="sidebar-genres-mobile"
          >
            <span className="flex items-center gap-2">
              <Film className="h-3.5 w-3.5" />
              Genres
            </span>
            {genreExpanded ? (
              <ChevronUp className="h-3.5 w-3.5 transition-transform" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 transition-transform" />
            )}
          </button>
          {genreExpanded && (
            <div id="sidebar-genres-mobile" className="mt-2 flex flex-col gap-1 animate-in slide-in-from-top-2 duration-150">
              {genreFilterOptions.map(genre => (
                <button
                  key={genre}
                  onClick={() => {
                    onGenreChange(genre);
                    onClose();
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition ${
                    activeGenre === genre
                      ? "bg-white/10 text-white"
                      : "text-[#8a8a8e] hover:bg-white/[0.05] hover:text-white"
                  }`}
                  aria-current={activeGenre === genre ? "page" : undefined}
                >
                  <span className="flex-1 text-left">{genre}</span>
                  {activeGenre === genre && <Film className="h-3.5 w-3.5 text-[#d7d7d3]" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {open && (
        <button
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          aria-label="Close menu overlay"
        />
      )}
    </>
  );
}