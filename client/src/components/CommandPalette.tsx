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

  // Global hotkeys + navbar trigger.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(current => !current);
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
    setOpen(false);
    setQuery("");
    navigate(`/watch/${item.id}`);
  };

  const applyToCatalog = () => {
    const value = query.trim();
    if (!value) return;
    window.dispatchEvent(
      new CustomEvent(APPLY_SEARCH_EVENT, { detail: { query: value } })
    );
    setOpen(false);
  };

  const showSuggestions = query.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="!max-w-(--breakpoint-md) gap-0 overflow-hidden border-white/10 bg-[#0a0a0c] p-0 text-white shadow-2xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search titles</DialogTitle>
        <CommandPrimitive
          label="Search titles"
          shouldFilter={false}
          className="flex h-full w-full flex-col overflow-hidden"
        >
          <div className="flex items-center gap-2 border-b border-white/10 px-4">
            <Search className="h-4 w-4 shrink-0 text-white/40" />
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search movies & shows…"
              className="h-12 w-full bg-transparent text-sm text-white outline-none placeholder:text-white/30"
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[10px] font-semibold text-white/50 transition hover:bg-white/10 hover:text-white"
            >
              ESC
            </button>
          </div>

          <CommandPrimitive.List className="max-h-[340px] overflow-y-auto py-2">
            {loading && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-white/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Searching…
              </div>
            )}

            {!loading && showSuggestions && suggestions.length === 0 && (
              <CommandPrimitive.Empty className="px-4 py-8 text-center text-sm text-white/35">
                No matches for “{query}” yet.
              </CommandPrimitive.Empty>
            )}

            {showSuggestions && suggestions.length > 0 && (
              <CommandPrimitive.Group heading="Results">
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
              <CommandPrimitive.Group heading="Top picks">
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
              <CommandPrimitive.Separator className="my-1 bg-white/10" />
            )}

            {showSuggestions && (
              <CommandPrimitive.Item
                onSelect={applyToCatalog}
                className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm text-[#c4c4c0] outline-none data-[selected=true]:bg-white/5 data-[selected=true]:text-white"
              >
                <Search className="h-4 w-4 text-white/40" />
                Show all results for “{query.trim()}”
              </CommandPrimitive.Item>
            )}

            {!showSuggestions && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-white/35">
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
      className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm text-white outline-none data-[selected=true]:bg-white/5"
    >
      {item.posterUrl ? (
        <img
          src={item.posterUrl}
          alt=""
          className="h-12 w-8 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="grid h-12 w-8 shrink-0 place-items-center rounded bg-white/5 text-white/30">
          {item.mediaType === "tv" ? (
            <Film className="h-4 w-4" />
          ) : (
            <Clapperboard className="h-4 w-4" />
          )}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.title}</span>
        <span className="block text-xs text-white/40">
          {item.year ? `${item.year} · ` : ""}
          {item.mediaType === "tv" ? "Series" : "Movie"}
        </span>
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-white/25">
        Enter
      </span>
    </CommandPrimitive.Item>
  );
}