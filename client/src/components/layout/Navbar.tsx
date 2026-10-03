import { useEffect, useState } from "react";
import { Bookmark, Menu, X } from "lucide-react";
import { Link, useLocation } from "wouter";
import { BrandLockup } from "@/components/brand/Brand";
import type { View } from "@/components/layout/navigation";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import { NavbarSearch } from "@/components/layout/NavbarSearch";
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
          ? "sv-chrome border-b shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
          : "border-b border-transparent bg-gradient-to-b from-black/70 to-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-[1480px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <Link
          href="/"
          onClick={() => window.scrollTo({ top: 0 })}
          className="shrink-0 rounded-md text-white"
          aria-label="Stream Vy home"
        >
          <BrandLockup size="md" />
        </Link>

        {/* Core navigation (desktop) */}
        <nav className="ml-2 hidden items-center gap-5 lg:flex">
          {NAV_LINKS.map(link => {
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

        <div className="ml-auto flex min-w-0 items-center gap-2.5">
          {/*
            A real input, not a button that opens one. It used to be two
            separate controls -- a wide pill on desktop and an icon on mobile --
            both of which dispatched an event to a full-screen command palette
            behind an opaque backdrop. One inline field covers every viewport, and
            its results drop down underneath instead of taking over the page.
          */}
          <NavbarSearch />

          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen(open => !open)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/10 text-white/70 transition hover:bg-white/10 hover:text-white lg:hidden"
          >
            {menuOpen ? (
              <X className="h-4 w-4" />
            ) : (
              <Menu className="h-4 w-4" />
            )}
          </button>
          <div className="shrink-0">
            <ProfileMenu />
          </div>
        </div>
      </div>

      {/* Mobile menu panel */}
      {menuOpen && (
        <div className="sv-chrome border-t lg:hidden">
          <nav className="flex items-center gap-6 px-4 py-3">
            {NAV_LINKS.map(link => (
              <button
                key={link.id}
                type="button"
                onClick={() => handleNavigate(link.id)}
                className={`text-sm font-medium transition ${
                  view === link.id
                    ? "text-white"
                    : "text-white/60 hover:text-white"
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
