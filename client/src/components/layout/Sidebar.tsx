import { X, Film as FilmIcon, UserRound } from "lucide-react";
import { Link } from "wouter";
import { useState } from "react";
import { navItems, type NavItem, type View, genreFilterOptions } from "./navigation";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface SidebarProps {
  view: View;
  onNavigate: (view: View) => void;
  open: boolean;
  onClose: () => void;
  activeGenre: string;
  onGenreChange: (genre: string) => void;
  /** Hide the sidebar (e.g., on watch pages for full-width viewport) */
  hidden?: boolean;
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
  const iconColor = item.color || "#d7d7d3";
  
  if (item.id === "profile") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/profile"
              aria-label={item.label}
              className={`group relative grid h-12 w-12 place-items-center rounded-xl transition ${
                active
                  ? "bg-white text-black shadow-[0_0_24px_rgba(255,255,255,0.4)] scale-105"
                  : "hover:bg-white/[0.08] hover:scale-105"
              }`}
            >
              <Icon className="h-6 w-6" style={{ color: active ? "#000" : iconColor }} />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" align="center" className="bg-[#1c1c20] text-white text-xs font-medium px-2 py-1 rounded border border-white/10 shadow-lg">
            {item.label}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            className={`group relative grid h-12 w-12 place-items-center rounded-xl transition ${
              active
                ? "bg-white text-black shadow-[0_0_24px_rgba(255,255,255,0.4)] scale-105"
                : "hover:bg-white/[0.08] hover:scale-105"
            }`}
          >
            <Icon className="h-6 w-6" style={{ color: active ? "#000" : iconColor }} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" className="bg-[#1c1c20] text-white text-xs font-medium px-2 py-1 rounded border border-white/10 shadow-lg">
          {item.label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Left Floating Glass Dock — Glassmorphism panel on far left side.
 * Clean icon-only navigation with tooltip labels on hover.
 * Positioned as a floating vertical panel on the left edge of the screen.
 */
export function Sidebar({ view, onNavigate, open, onClose, activeGenre, onGenreChange, hidden = false }: SidebarProps) {
  const navigate = (next: View) => {
    onNavigate(next);
    onClose();
  };

  if (hidden) return null;

  return (
    <>
      {/* Floating glass dock — desktop only, left side */}
      <aside
        className="fixed left-4 top-1/2 z-40 -translate-y-1/2 flex flex-col items-center gap-1 rounded-2xl border border-white/10 bg-neutral-900/80 px-3 py-4 shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop-blur-xl lg:flex hidden"
        aria-label="Primary navigation"
      >
        {/* Nav items */}
        <div className="flex flex-col items-center gap-0.5">
          {navItems.map(item => (
            <RailButton
              key={item.id}
              item={item}
              active={view === item.id}
              onClick={() => navigate(item.id)}
            />
          ))}
        </div>
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
            onClick={() => onGenreChange("All")}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition text-[#8a8a8e] hover:bg-white/[0.05] hover:text-white"
            aria-current={activeGenre === "All" ? "page" : undefined}
          >
            <FilmIcon className="h-3.5 w-3.5" style={{ color: "#d7d7d3" }} />
            <span className="flex-1 text-left">All Genres</span>
            {activeGenre === "All" && <FilmIcon className="h-3.5 w-3.5" style={{ color: "#d7d7d3" }} />}
          </button>
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