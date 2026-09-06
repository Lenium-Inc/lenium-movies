import { X } from "lucide-react";
import { Link } from "wouter";
import { navItems, type NavItem, type View } from "./navigation";

interface SidebarProps {
  view: View;
  onNavigate: (view: View) => void;
  open: boolean;
  onClose: () => void;
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
 * On desktop this is a floating, ultra-slim glassmorphic dock — a translucent
 * pill (`backdrop-blur-[16px]`) vertically centered on the left edge of the
 * viewport, with generous spacing, micro tooltip labels on hover, and a soft
 * glow on the active destination. On mobile the same items render inside a
 * slide-in drawer that is toggled from the header.
 *
 * The brand lives in the pinned top bar (GlassHeader), so the dock carries no
 * duplicate logo.
 */
export function Sidebar({ view, onNavigate, open, onClose }: SidebarProps) {
  const navigate = (next: View) => {
    onNavigate(next);
    onClose();
  };

  return (
    <>
      {/* Floating glass dock — desktop only */}
      <aside
        className="fixed left-4 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.05] px-2.5 py-7 shadow-[0_16px_48px_rgba(0,0,0,0.55)] backdrop-blur-[16px] lg:flex"
        aria-label="Primary navigation"
      >
        {navItems.map(item => (
          <RailButton
            key={item.id}
            item={item}
            active={view === item.id}
            onClick={() => navigate(item.id)}
          />
        ))}
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