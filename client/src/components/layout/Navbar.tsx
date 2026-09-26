import { useEffect, useState } from "react";
import { Bookmark, Menu, Play, Search, X } from "lucide-react";
import { Link, useLocation } from "wouter";
import type { View } from "@/components/layout/navigation";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import { OPEN_SEARCH_EVENT } from "@/components/CommandPalette";
import { savedListIds, subscribeList } from "@/services/lists";

interface NavbarProps {
  view: View;
  onNavigate: (view: View) => void;
}

const NAV_LINKS: { id: View; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "movies", label: "Explore" },
  { id: "trending", label: "Trending" },
  { id: "tv", label: "Shows" },
];

function openSearchPalette() {
  window.dispatchEvent(new Event(OPEN_SEARCH_EVENT));
}

/**
 * "My List" is a route (`/my-list`), not one of the single-page `View` modes,
 * so it needs a real link rather than a NAV_LINKS entry -- routing it through
 * `onNavigate` would have landed on `/?view=my-list` and rendered nothing.
 *
 * It was previously reachable only from a share-invite or a shared-list page,
 * which is why a saved list looked like it had vanished.
 */
function MyListLink({ className }: { className: string }) {
  const [location] = useLocation();
  const [count, setCount] = useState(0);

  useEffect(() => {
    const refresh = () => setCount(savedListIds().length);
    refresh();
    return subscribeList(refresh);
  }, []);

  const active = location === "/my-list";
  return (
    <Link
      href="/my-list"
      className={`inline-flex items-center gap-1.5 transition ${className} ${
        active ? "text-white" : "text-white/60 hover:text-white"
      }`}
      aria-current={active ? "page" : undefined}
    >
      <Bookmark className="h-4 w-4" />
      My List
      {count > 0 ? (
        <span className="rounded-full bg-white/15 px-1.5 text-[11px] font-semibold tabular-nums text-white/80">
          {count}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Netflix-style sticky top navigation: transparent over the hero, turning
 * translucent dark once the page scrolls. Four core destinations, a global
 * command-palette search trigger (⌘K / "/"), and the profile entry.
 */
export function Navbar({ view, onNavigate }: NavbarProps) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
          <MyListLink className="text-sm font-medium" />
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
          {/* Desktop search trigger -> command palette */}
          <button
            type="button"
            onClick={openSearchPalette}
            aria-label="Open search (Ctrl/⌘ K)"
            className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3.5 py-2 text-xs text-white/50 transition hover:border-white/25 hover:bg-white/10 hover:text-white/80 sm:flex"
          >
            <Search className="h-3.5 w-3.5 text-white/50" />
            <span className="min-w-[120px] text-left">Search titles…</span>
            <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-px text-[9px] font-semibold text-white/40">
              ⌘K
            </kbd>
          </button>

          {/* Mobile: search + menu toggles */}
          <button
            type="button"
            aria-label="Search titles"
            onClick={openSearchPalette}
            className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white/80 transition hover:bg-white/15 sm:hidden"
          >
            <Search className="h-4 w-4" />
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

      {/* Mobile menu panel */}
      {menuOpen && (
        <div className="border-t border-white/10 bg-[#050505]/85 backdrop-blur-[18px] lg:hidden">
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
            <MyListLink className="text-sm font-medium" />
          </nav>
        </div>
      )}
    </header>
  );
}