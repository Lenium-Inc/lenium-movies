import { useEffect, useState } from "react";
import {
  Clapperboard,
  Film,
  Loader2,
  Search,
  TrendingUp,
} from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { searchSuggest, fetchTrending, type SearchSuggestion } from "@/services/api";

/** Fired (with `{ query: string }`) to drop a plain query back into the catalog
 * grid on the home page. */
export const APPLY_SEARCH_EVENT = "lenium:apply-search";
/** Fired with no payload to open the palette (used by the navbar trigger). */
export const OPEN_SEARCH_EVENT = "lenium:open-search";

const SEARCH_DEBOUNCE_MS = 300;

interface PaletteItem {
  id: string;
  title: string;
  year?: string;
  posterUrl: string;
  mediaType: "movie" | "tv";
}

/**
 * Global command-palette search (⌘K / Ctrl+K / "/"). Live, debounced results
 * from the backend's suggest endpoint and, with an empty query, live trending
 * top picks. Selecting a result jumps straight to the watch page.
 */
export function CommandPalette() {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PaletteItem[]>([]);
  const [topPicks, setTopPicks] = useState<PaletteItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Every dismissal path -- Escape, backdrop click, the ESC button, ⌘K toggle,
  // picking a result -- must clear the query, not just close the dialog.
  // Otherwise the stale query and its stale suggestions reappear the next time
  // the palette opens, and the user has to backspace before they can search.
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  // Global hotkeys + navbar trigger.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(current => {
          if (current) setQuery("");
          return !current;
        });
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
    };
  }, []);

  // Debounced live suggestions.
  useEffect(() => {
    if (!open || !query.trim()) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchSuggest(query)
        .then(results =>
          results.map(r => ({
            id: r.id,
            title: r.title,
            year: r.year,
            posterUrl: r.poster_url,
            mediaType: r.media_type,
          }))
        )
        .then(picks => setSuggestions(picks))
        .catch(() => setSuggestions([]))
        .finally(() => setLoading(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  // Live top picks for the empty state (cached by the backend client).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchTrending({ media_type: "all", time_window: "week" })
      .then(results => {
        if (cancelled) return;
        setTopPicks(
          results.slice(0, 6).map(r => ({
            id: r.id,
            title: r.title,
            year: r.year != null ? String(r.year) : undefined,
            posterUrl: r.poster_url ?? "",
            mediaType: r.media_type === "tv" ? "tv" : "movie",
          }))
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const openItem = (item: PaletteItem) => {
    close();
    navigate(`/watch/${item.id}`);
  };

  const applyToCatalog = () => {
    const value = query.trim();
    if (!value) return;
    window.dispatchEvent(
      new CustomEvent(APPLY_SEARCH_EVENT, { detail: { query: value } })
    );
    close();
  };

  const showSuggestions = query.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="!top-[15vh] !translate-y-0 !max-w-2xl gap-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/95 p-0 text-zinc-100 shadow-2xl"
        overlayClassName="bg-black/80 backdrop-blur-md"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search titles</DialogTitle>
        <CommandPrimitive
          label="Search titles"
          shouldFilter={false}
          className="flex h-full w-full flex-col overflow-hidden"
        >
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4">
            <Search className="h-4 w-4 shrink-0 text-zinc-500" />
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search movies & shows…"
              className="h-12 w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
            />
            <button
              type="button"
              onClick={close}
              className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-700 hover:text-zinc-100"
            >
              ESC
            </button>
          </div>

          <CommandPrimitive.List className="max-h-[340px] overflow-y-auto py-2">
            {loading && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Searching…
              </div>
            )}

            {!loading && showSuggestions && suggestions.length === 0 && (
              <CommandPrimitive.Empty className="px-4 py-8 text-center text-sm text-zinc-500">
                No matches for “{query}” yet.
              </CommandPrimitive.Empty>
            )}

            {showSuggestions && suggestions.length > 0 && (
              <CommandPrimitive.Group
                heading="Results"
                className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-500"
              >
                {suggestions.map(item => (
                  <PaletteRow
                    key={item.id}
                    item={item}
                    onSelect={() => openItem(item)}
                  />
                ))}
              </CommandPrimitive.Group>
            )}

            {!showSuggestions && topPicks.length > 0 && (
              <CommandPrimitive.Group
                heading="Top picks"
                className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-500"
              >
                {topPicks.map(item => (
                  <PaletteRow
                    key={item.id}
                    item={item}
                    onSelect={() => openItem(item)}
                  />
                ))}
              </CommandPrimitive.Group>
            )}

            {showSuggestions && suggestions.length > 0 && (
              <CommandPrimitive.Separator className="my-1 bg-zinc-800" />
            )}

            {showSuggestions && (
              <CommandPrimitive.Item
                onSelect={applyToCatalog}
                className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm text-zinc-300 outline-none data-[selected=true]:bg-zinc-800/60 data-[selected=true]:text-zinc-100"
              >
                <Search className="h-4 w-4 text-zinc-500" />
                Show all results for “{query.trim()}”
              </CommandPrimitive.Item>
            )}

            {!showSuggestions && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-zinc-500">
                <TrendingUp className="h-3.5 w-3.5" />
                Trending now across movies & shows
              </div>
            )}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

function PaletteRow({
  item,
  onSelect,
}: {
  item: PaletteItem;
  onSelect: () => void;
}) {
  return (
    <CommandPrimitive.Item
      value={`${item.mediaType}:${item.id}`}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm text-zinc-100 outline-none data-[selected=true]:bg-zinc-800/60"
    >
      {item.posterUrl ? (
        <img
          src={item.posterUrl}
          alt=""
          className="h-12 w-8 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="grid h-12 w-8 shrink-0 place-items-center rounded bg-zinc-800 text-zinc-500">
          {item.mediaType === "tv" ? (
            <Film className="h-4 w-4" />
          ) : (
            <Clapperboard className="h-4 w-4" />
          )}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-zinc-400">
            {item.mediaType === "tv" ? "Show" : "Movie"}
          </span>
          {item.year ? <span>{item.year}</span> : null}
        </span>
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-zinc-600">
        Enter
      </span>
    </CommandPrimitive.Item>
  );
}