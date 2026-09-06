import { SlidersHorizontal, X } from "lucide-react";

interface GenreChipsProps {
  genres: string[];
  active: string;
  onSelect: (genre: string) => void;
}

/** Horizontal scrollable row of genre filter chips above the catalogue. */
export function GenreChips({ genres, active, onSelect }: GenreChipsProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
      {genres.map(item => (
        <button
          key={item}
          onClick={() => onSelect(item)}
          className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold ${
            active === item
              ? "bg-[#d7d7d3] text-[#0b0b0e]"
              : "border border-white/10 text-[#aaa9a5] hover:border-white/25 hover:text-white"
          }`}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

interface DiscoverAction {
  mood: string;
  genre: string;
}

interface DiscoverDialogProps {
  open: boolean;
  actions: DiscoverAction[];
  onClose: () => void;
  onApply: (action: DiscoverAction) => void;
}

/**
 * Modal that asks "what are you in the mood for?" and maps each mood to a
 * genre filter, then returns to the movies view.
 */
export function DiscoverDialog({
  open,
  actions,
  onClose,
  onApply,
}: DiscoverDialogProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[55] bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        onClick={event => event.stopPropagation()}
        className="mx-auto mt-20 max-w-xl rounded-xl border border-white/10 bg-[#151519] p-5"
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#d7d7d3]">
              Discovery
            </p>
            <h2 className="mt-1 text-xl font-bold">
              What are you in the mood for?
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close discovery"
            className="rounded-md p-2 text-[#aaa9a5] hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {actions.map(action => (
            <button
              key={action.mood}
              onClick={() => onApply(action)}
              className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-left text-xs font-semibold text-[#ddd] hover:border-white/25 hover:bg-white/10"
            >
              <SlidersHorizontal className="mb-3 h-4 w-4 text-[#d7d7d3]" />
              {action.mood}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
