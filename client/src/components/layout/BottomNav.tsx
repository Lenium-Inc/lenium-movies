import { Film, Home as HomeIcon, List, Search } from "lucide-react";
import { useRef } from "react";
import type { View } from "./navigation";

interface BottomNavButtonProps {
  label: string;
  icon: typeof HomeIcon;
  active: boolean;
  onClick: () => void;
}

function BottomNavButton({ label, icon: Icon, active, onClick }: BottomNavButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-1 py-1 text-[10px] font-semibold ${
        active ? "text-[#f1f1ee]" : "text-[#77777d]"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

interface BottomNavProps {
  view: View;
  searching: boolean;
  onNavigate: (view: View) => void;
}

/**
 * Mobile-only tab bar. The Search tab focuses the header search input
 * instead of navigating, so users can keep their current place.
 */
export function BottomNav({ view, searching, onNavigate }: BottomNavProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const focusSearch = () => {
    const input = searchInputRef.current ?? document.querySelector<HTMLInputElement>("header input");
    input?.focus();
  };

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-white/10 bg-[#101014]/95 px-2 py-2 backdrop-blur-xl lg:hidden">
      <BottomNavButton
        label="Home"
        icon={HomeIcon}
        active={view === "home"}
        onClick={() => onNavigate("home")}
      />
      <BottomNavButton
        label="Movies"
        icon={Film}
        active={view === "movies"}
        onClick={() => onNavigate("movies")}
      />
      <BottomNavButton
        label="Search"
        icon={Search}
        active={searching}
        onClick={focusSearch}
      />
      <BottomNavButton
        label="My List"
        icon={List}
        active={view === "my-list"}
        onClick={() => onNavigate("my-list")}
      />
    </nav>
  );
}