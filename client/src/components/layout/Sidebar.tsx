import { CirclePlay, X } from "lucide-react";
import { navItems, type View } from "./navigation";

interface SidebarProps {
  view: View;
  onNavigate: (view: View) => void;
  open: boolean;
  onClose: () => void;
}

/**
 * Fixed sidebar navigation for desktop plus a slide-in drawer on mobile.
 * Selecting an item closes the drawer and routes to the matching view.
 */
export function Sidebar({ view, onNavigate, open, onClose }: SidebarProps) {
  const navigate = (next: View) => {
    onNavigate(next);
    onClose();
  };

  return (
    <>
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[232px] flex-col border-r border-white/10 bg-[#101014] px-4 py-5 transition-transform duration-200 lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-2">
          <button
            onClick={() => navigate("home")}
            className="flex items-center gap-2 text-left"
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[#d7d7d3] text-[#0b0b0e]">
              <CirclePlay className="h-4 w-4 fill-current" />
            </span>
            <span className="text-base font-bold tracking-tight">
              LeNium<span className="text-[#d7d7d3]">.</span>
            </span>
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-[#8e8e92] hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-2 mt-9 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[#6f6f75]">
          Browse
        </p>
        <nav className="space-y-1">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-semibold transition ${
                view === id
                  ? "bg-[#d7d7d3] text-[#0b0b0e]"
                  : "text-[#a8a8aa] hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="mt-auto rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-5 text-[#85858a]">
          Live metadata from TMDB.
          <br />
          <span className="text-[#c9c9c5]">
            Playback requires separate rights and source configuration.
          </span>
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
