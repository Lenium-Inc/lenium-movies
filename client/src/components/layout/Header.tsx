import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { CirclePlay, Menu, Search, UserRound } from "lucide-react";
import { navItems, type View } from "./navigation";

interface HeaderProps {
  view: View;
  search: string;
  onSearchChange: (value: string) => void;
  onOpenMenu: () => void;
}

/**
 * Sticky top bar containing the mobile menu / logo, the current view label,
 * the global search input, and the sign-in / account controls.
 */
export function Header({
  view,
  search,
  onSearchChange,
  onOpenMenu,
}: HeaderProps) {
  const { user, isAuthenticated, logout } = useAuth();
  const currentLabel =
    view === "home" ? "Home" : navItems.find(item => item.id === view)?.label;

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0b0b0e]/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1480px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          onClick={onOpenMenu}
          className="grid h-9 w-9 place-items-center rounded-md border border-white/10 text-[#aaa9a5] hover:text-white lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 items-center gap-2 lg:hidden">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[#d7d7d3] text-[#0b0b0e]">
            <CirclePlay className="h-4 w-4 fill-current" />
          </span>
          <span className="text-base font-bold">
            LeNium<span className="text-[#d7d7d3]">.</span>
          </span>
        </div>
        <div className="hidden text-sm font-semibold text-[#d4d4d0] lg:block">
          {currentLabel}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-[#aaa9a5] focus-within:border-white/30">
            <Search className="h-3.5 w-3.5" />
            <input
              value={search}
              onChange={event => onSearchChange(event.target.value)}
              placeholder="Search movies, people, genres"
              className="w-[min(42vw,280px)] bg-transparent text-xs text-white outline-none placeholder:text-[#77777d]"
            />
          </div>
          {isAuthenticated ? (
            <button
              onClick={() => logout()}
              className="hidden items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-[#ddd] hover:bg-white/10 sm:flex"
            >
              <UserRound className="h-3.5 w-3.5" />
              {user?.name?.split(" ")[0] ?? "Account"}
            </button>
          ) : (
            <button
              onClick={() => startLogin()}
              className="rounded-md bg-[#d7d7d3] px-3 py-2 text-xs font-bold text-[#0b0b0e] hover:bg-white"
            >
              Sign in
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
