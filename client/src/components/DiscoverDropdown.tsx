import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Filter, X, SlidersHorizontal, Check } from "lucide-react";
import {
  genreFilterOptions,
  CATALOG_SORT_OPTIONS,
  MEDIA_TYPE_OPTIONS,
  type CatalogSort,
  type MediaTypeFilter,
} from "@/hooks/useCatalog";
import type { View } from "@/components/layout/navigation";

interface DiscoverDropdownProps {
  genre: string;
  setGenre: (genre: string) => void;
  sort: CatalogSort;
  setSort: (sort: CatalogSort) => void;
  mediaType: MediaTypeFilter;
  setMediaType: (mediaType: MediaTypeFilter) => void;
  setView: (view: View) => void;
  filteredCount: number;
  isLoading: boolean;
}

/**
 * Catalogue filter panel: genre, media type and sort order.
 *
 * This panel previously owned `selectedSort` and `selectedType` as local state
 * and its Apply handler only ever forwarded `genre`, so choosing "Top Rated" or
 * "TV Show" repainted the selected chips and changed nothing else — a control
 * that lied about what it did. All three filters now live in `useCatalog` and
 * are applied to both the shelf views and the paged browse grid, so each option
 * here is doing exactly what its label says.
 */
export const DiscoverDropdown: React.FC<DiscoverDropdownProps> = ({
  genre,
  setGenre,
  sort,
  setSort,
  mediaType,
  setMediaType,
  setView,
  filteredCount,
  isLoading,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Draft state so a panel can be dismissed without applying half a choice.
  // Reset whenever it opens so it always reflects what is actually in effect.
  const [draftGenre, setDraftGenre] = useState(genre || "All");
  const [draftSort, setDraftSort] = useState<CatalogSort>(sort);
  const [draftType, setDraftType] = useState<MediaTypeFilter>(mediaType);

  const openPanel = () => {
    setDraftGenre(genre || "All");
    setDraftSort(sort);
    setDraftType(mediaType);
    setIsOpen(true);
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        if (
          triggerRef.current &&
          triggerRef.current.contains(event.target as Node)
        ) {
          return;
        }
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleApply = () => {
    setGenre(draftGenre);
    setSort(draftSort);
    setMediaType(draftType);
    setView("movies");
    setIsOpen(false);
  };

  // Counted against what is in effect, not the draft, so the summary does not
  // claim a filter is active before Apply.
  const activeFilterCount =
    (genre !== "All" ? 1 : 0) +
    (sort !== "trending" ? 1 : 0) +
    (mediaType !== "all" ? 1 : 0);

  const draftIsDirty =
    draftGenre !== (genre || "All") ||
    draftSort !== sort ||
    draftType !== mediaType;

  return (
    <div className="relative inline-block text-left z-40" ref={dropdownRef}>
      <button
        ref={triggerRef}
        onClick={() => (isOpen ? setIsOpen(false) : openPanel())}
        className="flex shrink-0 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-4 py-2.5 text-xs font-semibold text-[#c4c4c0] transition hover:border-white/25 hover:bg-white/5 hover:text-white"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <Filter className="h-4 w-4" />
        <span>Filter</span>
        {activeFilterCount > 0 && (
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-violet-600 px-1 text-[10px] font-bold text-white">
            {activeFilterCount}
          </span>
        )}
        <ChevronDown
          className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Filter catalogue"
          className="absolute left-0 mt-2 w-80 bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl overflow-hidden p-5 flex flex-col gap-4 animate-in fade-in slide-in-from-top-2 duration-150"
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-violet-500" />
              <span className="text-white font-semibold text-sm">
                Filter Catalogue
              </span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              aria-label="Close filters"
              className="text-zinc-400 hover:text-white transition-colors p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Media type. Maps onto `mediaType`, which the catalog already
              carries on every title, so this narrows to a real subset. */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Type
            </legend>
            <div className="grid grid-cols-3 gap-1.5">
              {MEDIA_TYPE_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={draftType === option.value}
                  onClick={() => setDraftType(option.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${draftType === option.value ? "bg-violet-600 text-white font-semibold" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Genre
            </legend>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pr-1">
              {genreFilterOptions.map(g => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={draftGenre === g}
                  onClick={() => setDraftGenre(g)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${draftGenre === g ? "bg-white text-black font-semibold" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`}
                >
                  {g}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Sort By
            </legend>
            <div className="grid grid-cols-2 gap-1.5">
              {CATALOG_SORT_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={draftSort === option.value}
                  onClick={() => setDraftSort(option.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium text-left transition-all flex items-center justify-between ${draftSort === option.value ? "bg-zinc-800 text-white border border-white/20" : "bg-zinc-900 text-zinc-400 hover:bg-zinc-800"}`}
                >
                  <span>{option.label}</span>
                  {draftSort === option.value && (
                    <Check className="w-3 h-3 text-violet-500" />
                  )}
                </button>
              ))}
            </div>
          </fieldset>

          <button
            onClick={handleApply}
            disabled={!draftIsDirty}
            className="mt-2 w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:hover:bg-zinc-800 text-white font-semibold rounded-xl text-xs tracking-wide transition-all shadow-lg"
          >
            Apply Filters
          </button>

          <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-zinc-500">
            <span>
              {isLoading
                ? "Loading..."
                : filteredCount === 0
                  ? "No matches found"
                  : `${filteredCount} title${filteredCount !== 1 ? "s" : ""} found`}
            </span>
            {activeFilterCount > 0 && (
              <button
                onClick={() => {
                  setGenre("All");
                  setSort("trending");
                  setMediaType("all");
                  setDraftGenre("All");
                  setDraftSort("trending");
                  setDraftType("all");
                }}
                className="text-violet-400 hover:text-violet-300 underline"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};