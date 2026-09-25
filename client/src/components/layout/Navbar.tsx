import { useEffect, useState } from "react";
import { Menu, Play, Search, X } from "lucide-react";
import { Link } from "wouter";
import type { View } from "@/components/layout/navigation";
import { ProfileMenu } from "@/components/layout/ProfileMenu";

interface NavbarProps {
  view: View;
  onNavigate: (view: View) => void;
  search: string;
  onSearchChange: (value: string) => void;
}

const NAV_LINKS: { id: View; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "movies", label: "Explore" },
  { id: "trending", label: "Trending" },
  { id: "tv", label: "Shows" },
];

/**
 * Netflix-style sticky top navigation: transparent over the hero, turning
 * translucent dark once the page scrolls. Four core destinations, global
 * search, and the profile entry on the right.
 */
export function Navbar({ view, onNavigate, search, onSearchChange }: NavbarProps) {
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const renderInput = (options: { autoFocus?: boolean } = {}) => (
    <input
      type="search"
      value={search}
      onChange={(event) => onSearchChange(event.target.value)}
      placeholder="Search movies, shows, genres"
      aria-label="Search the catalogue"
      autoFocus={options.autoFocus}
      className="w-full bg-transparent text-xs text-white outline-none placeholder:text-[#6E6E74]"
    />
  );

  const handleNavigate = (next: View) => {
    setMenuOpen(false);
    onNavigate(next);
    const hero = window.scrollY > 0;
    window.scrollTo({ top: 0, behavior: hero ? "smooth" : "auto" });
  };

  return (
    <header
      className={`sticky top-0 z-40 transition-all duration-300 ${
        scrolled
          ? "border-b border-white/10 bg-[#050505]/85 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-[18px]"
          : "border-b border-transparent bg-gradient-to-b from-black/70 to-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-[1480px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <Link
          href="/"
          onClick={() => window.scrollTo({ top: 0 })}
          className="flex shrink-0 items-center gap-1.5 text-white"
          aria-label="Stream Vy home"
        >
          <Play className="h-5 w-5" />
          <span className="text-lg font-black tracking-tight">Stream Vy</span>
        </Link>

        {/* Core navigation (desktop) */}
        <nav className="ml-2 hidden items-center gap-5 lg:flex">
          {NAV_LINKS.map((link) => {
            const active = view === link.id;
            return (
              <button
                key={link.id}
                type="button"
                onClick={() => handleNavigate(link.id)}
                className={`text-sm font-medium transition ${
                  active ? "text-white" : "text-white/60 hover:text-white"
                }`}
              >
                {link.label}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
          {/* Desktop search */}
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3.5 py-2 transition focus-within:border-violet-500/60 sm:flex">
            <Search className="h-3.5 w-3.5 text-white/50" />
            {renderInput()}
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-px text-[9px] font-semibold text-white/40">
              /
            </kbd>
          </div>

          {/* Mobile: search + menu toggles */}
          <button
            type="button"
            aria-label={searchOpen ? "Close search" : "Search titles"}
            onClick={() => setSearchOpen((open) => !open)}
            className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white/80 transition hover:bg-white/15 sm:hidden"
          >
            {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
          </button>
          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 text-white/70 transition hover:bg-white/10 hover:text-white lg:hidden"
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <ProfileMenu />
        </div>
      </div>

      {/* Mobile panels */}
      {(searchOpen || menuOpen) && (
        <div className="border-t border-white/10 bg-[#050505]/85 backdrop-blur-[18px] lg:hidden">
          {searchOpen && (
            <div className="flex items-center gap-2 px-4 py-3">
              <Search className="h-3.5 w-3.5 shrink-0 text-white/50" />
              <div className="min-w-0 flex-1">{renderInput({ autoFocus: true })}</div>
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  onSearchChange("");
                  setSearchOpen(false);
                }}
                className="shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold text-white/60 hover:bg-white/10"
              >
                Clear
              </button>
            </div>
          )}
          {menuOpen && (
            <nav className="flex items-center gap-6 px-4 py-3">
              {NAV_LINKS.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  onClick={() => handleNavigate(link.id)}
                  className={`text-sm font-medium transition ${
                    view === link.id ? "text-white" : "text-white/60 hover:text-white"
                  }`}
                >
                  {link.label}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}
    </header>
  );
}