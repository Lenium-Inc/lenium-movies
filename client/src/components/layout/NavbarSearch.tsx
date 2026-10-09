import { useCallback, useEffect, useRef, useState } from "react";
import {
  Clapperboard,
  Film,
  Loader2,
  Search,
  TrendingUp,
  X,
} from "lucide-react";
import { useComposition } from "@/hooks/useComposition";
import {
  searchSuggest,
  fetchTrending,
  type SearchSuggestion,
} from "@/services/api";

/** Fired with `{ query: string }` to drop a plain query back into the catalog
 *  grid on the home page. An empty query means "clear the applied search", so
 *  the home page's Clear control and this input stay in sync either way. */
export const APPLY_SEARCH_EVENT = "lenium:apply-search";

/**
 * Fired with the picked `PaletteItem` so the home page opens that title's
 * details panel.
 *
 * Picking a row used to `navigate('/watch/:id')`, which skipped the details
 * view entirely and dropped the viewer straight into stream resolution. A
 * suggestion carries only a title and a poster, so the sheet is what owns the
 * upgrade to the full record; this component only reports the pick.
 */
export const SELECT_TITLE_EVENT = "lenium:select-title";

const SEARCH_DEBOUNCE_MS = 300;

export interface PaletteItem {
  id: string;
  title: string;
  year?: string;
  posterUrl: string;
  mediaType: "movie" | "tv";
}

function toItem(r: SearchSuggestion): PaletteItem {
  return {
    id: r.id,
    title: r.title,
    year: r.year,
    posterUrl: r.poster_url,
    mediaType: r.media_type,
  };
}

/**
 * Navbar search: a real, always-visible text input plus a dropdown anchored
 * under it.
 *
 * This used to be a full-screen command palette behind a `bg-black/80` backdrop,
 * opened by a button that only *looked* like a search field. Two problems with
 * that: the trigger was a `<button>`, so there was nothing to type into and no
 * value to show once a query was active, and a modal with an opaque backdrop
 * took over the page for what is a lightweight, non-blocking query.
 *
 * So the field is inline and the results are an `absolute` panel inside the
 * header's own stacking context. Nothing is portalled, nothing covers the rest
 * of the page, and Escape or a click anywhere outside returns to the page
 * without a close button being hunted for.
 *
 * ⌘K / Ctrl+K focuses the input directly (it no longer toggles a dialog), and
 * "/" is kept because the hero header advertises it.
 */
export function NavbarSearch() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<PaletteItem[]>([]);
  const [topPicks, setTopPicks] = useState<PaletteItem[]>([]);
  const [loading, setLoading] = useState(false);
  // Which row the arrow keys have reached. -1 means "still on the input", so
  // Enter falls through to "show all results" rather than jumping the list.
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hasQuery = query.trim().length > 0;

  // Dismiss on outside click and on Escape. `mousedown` + `touchstart` mirrors
  // ProfileMenu, and means the panel closes before the click reaches whatever
  // is underneath, so the same tap does not also activate a result.
  const dismiss = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, dismiss]);

  // ⌘K / Ctrl+K focuses the field; "/" does too, but only outside a text field
  // so it stays typeable while composing a query.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The results grid's own Clear control dispatches this same event, so
  // listening here keeps the field in step with a search that was cleared
  // from somewhere other than this input. Dispatching from here and hearing
  // our own event back is harmless: the value we set equals the value we sent.
  useEffect(() => {
    const onApply = (event: Event) => {
      const applied = (event as CustomEvent<{ query?: string }>).detail?.query;
      if (typeof applied !== "string") return;
      setQuery(applied);
      if (!applied.trim()) {
        setSuggestions([]);
        setActiveIndex(-1);
      }
    };
    window.addEventListener(APPLY_SEARCH_EVENT, onApply);
    return () => window.removeEventListener(APPLY_SEARCH_EVENT, onApply);
  }, []);

  // Debounced live suggestions. The `cancelled` flag is what stops a slow
  // response for an earlier query from overwriting a newer one: the request
  // itself cannot be cancelled, because `searchSuggest` takes no AbortSignal.
  useEffect(() => {
    if (!open || !hasQuery) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchSuggest(query)
        .then(results => {
          if (cancelled) return;
          setSuggestions(results.map(toItem));
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open, hasQuery]);

  // Top picks for the empty state. `fetchTrending` caches for five minutes, so
  // reopening the panel is normally free.
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

  // A fresh keystroke invalidates whatever the arrow keys had highlighted.
  useEffect(() => {
    setActiveIndex(-1);
  }, [query]);

  const openItem = (item: PaletteItem) => {
    dismiss();
    window.dispatchEvent(new CustomEvent(SELECT_TITLE_EVENT, { detail: item }));
  };

  const applyToCatalog = () => {
    const value = query.trim();
    if (!value) return;
    window.dispatchEvent(
      new CustomEvent(APPLY_SEARCH_EVENT, { detail: { query: value } })
    );
    dismiss();
  };

  const visible = hasQuery ? suggestions : topPicks;

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // `preventDefault` is load-bearing here. A `type="search"` input treats
      // Escape as "clear the field", so the browser clears it *after* this
      // handler and fires an `input` event. `onChange` then runs
      // `setOpen(true)` and the panel springs straight back open, which made
      // Escape look like it did nothing at all. Suppressing the native clear
      // means the close and the clear both go through React state.
      event.preventDefault();
      clear();
      dismiss();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (visible.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(current => {
        const next = current + step;
        if (next < 0) return visible.length - 1;
        if (next >= visible.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = visible[activeIndex];
      // No row highlighted means the user typed a query and wants the grid.
      if (picked) openItem(picked);
      else applyToCatalog();
    }
  };

  const clear = () => {
    setQuery("");
    setSuggestions([]);
    setActiveIndex(-1);
    inputRef.current?.focus();
    // Also drop the search already applied to the results grid: the input and
    // the grid are two views of the same query, and clearing only the input
    // left results on screen for a query the field no longer showed.
    window.dispatchEvent(
      new CustomEvent(APPLY_SEARCH_EVENT, { detail: { query: "" } })
    );
  };

  // Escape has to mean "cancel my CJK composition" while an IME is mid-flight,
  // not "throw away the panel", so route the key through the shared hook the
  // rest of the app's inputs use.
  const {
    onCompositionStart,
    onCompositionEnd,
    onKeyDown: handleKeyDown,
  } = useComposition<HTMLInputElement>({ onKeyDown });

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div
        className={`flex items-center gap-2 rounded-full border bg-white/[0.06] px-3 py-1.5 transition focus-within:border-white/30 focus-within:bg-white/10 ${
          open ? "border-white/30 bg-white/10" : "border-white/10"
        }`}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-white/50" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onKeyDown={handleKeyDown}
          placeholder="Search titles…"
          aria-label="Search titles"
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
          aria-controls="navbar-search-results"
          autoComplete="off"
          // `min-w-0` lets this shrink instead of forcing the header wider than
          // the viewport on narrow phones, which is what pushed the nav off
          // screen before. The width steps up at each breakpoint instead.
          className="w-[6.5rem] min-w-0 bg-transparent text-xs text-white outline-none placeholder:text-white/50 focus:outline-none sm:w-[12rem] lg:w-[16rem]"
        />
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/40" />
        ) : query ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="shrink-0 rounded-full p-0.5 text-white/40 transition hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <kbd className="hidden shrink-0 rounded border border-white/10 bg-white/5 px-1.5 py-px text-[9px] font-semibold text-white/40 lg:block">
            ⌘K
          </kbd>
        )}
      </div>

      {/*
        Anchored to the input, not the page. `z-50` lifts it above the header's
        own content while staying inside the header's stacking context, so it
        scrolls with the nav instead of detaching. The width tracks the input at
        every breakpoint and is capped by the viewport, so it cannot overflow on
        a phone.
      */}
      {open && (
        <div
          id="navbar-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[min(24rem,60vh)] min-w-[16rem] overflow-y-auto overscroll-contain rounded-xl border border-zinc-800 bg-zinc-900/95 p-1.5 shadow-2xl backdrop-blur-xl"
        >
          {hasQuery && loading && suggestions.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Searching…
            </div>
          ) : null}

          {hasQuery && !loading && suggestions.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-zinc-500">
              No matches for “{query.trim()}” yet.
            </p>
          ) : null}

          {visible.length > 0 ? (
            <>
              <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {hasQuery ? "Results" : "Top picks"}
              </p>
              {visible.map((item, index) => (
                <ResultRow
                  key={`${item.mediaType}:${item.id}`}
                  item={item}
                  active={index === activeIndex}
                  onHover={() => setActiveIndex(index)}
                  onSelect={() => openItem(item)}
                />
              ))}
            </>
          ) : null}

          {hasQuery ? (
            <button
              type="button"
              onClick={applyToCatalog}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-300 transition hover:bg-zinc-800/60"
            >
              <Search className="h-4 w-4 shrink-0 text-zinc-500" />
              Show all results for “{query.trim()}”
            </button>
          ) : (
            <p className="flex items-center gap-2 px-3 py-2.5 text-xs text-zinc-500">
              <TrendingUp className="h-3.5 w-3.5 shrink-0" />
              Trending now across movies &amp; shows
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ResultRow({
  item,
  active,
  onHover,
  onSelect,
}: {
  item: PaletteItem;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onPointerEnter={onHover}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
        active
          ? "bg-zinc-800/60 text-zinc-100"
          : "text-zinc-200 hover:bg-zinc-800/40"
      }`}
    >
      {item.posterUrl ? (
        <img
          src={item.posterUrl}
          alt=""
          className="h-11 w-7 shrink-0 rounded object-cover"
        />
      ) : (
        <span className="grid h-11 w-7 shrink-0 place-items-center rounded bg-zinc-800 text-zinc-500">
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
    </button>
  );
}
