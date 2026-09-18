import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronUp,
  Calendar,
  Filter,
  Star,
  X,
  Loader2,
} from "lucide-react";
import { genreFilterOptions } from "@/hooks/useCatalog";
import type { View } from "@/components/layout/navigation";
import { createPortal } from "react-dom";

const MOOD_TAGS = [
  { label: "Feel Good", value: "feel-good" },
  { label: "Dark & Gritty", value: "dark-gritty" },
  { label: "Mind Bending", value: "mind-bending" },
  { label: "Heartwarming", value: "heartwarming" },
  { label: "Action Packed", value: "action-packed" },
  { label: "Slow Burn", value: "slow-burn" },
  { label: "Cult Classic", value: "cult-classic" },
  { label: "Award Winners", value: "award-winners" },
];

const YEAR_RANGES = [
  { label: "All Years", value: "" },
  { label: "2020s", value: "2020-2029" },
  { label: "2010s", value: "2010-2019" },
  { label: "2000s", value: "2000-2009" },
  { label: "1990s", value: "1990-1999" },
  { label: "1980s", value: "1980-1989" },
  { label: "Classic (pre-1980)", value: "1900-1979" },
];

const SORT_OPTIONS = [
  { label: "Trending", value: "trending" },
  { label: "Popular", value: "popular" },
  { label: "Top Rated", value: "top-rated" },
  { label: "Newest", value: "newest" },
  { label: "Oldest", value: "oldest" },
];

const CONTENT_TYPES = [
  { label: "All", value: "all" },
  { label: "Movies", value: "movie" },
  { label: "TV Shows", value: "tv" },
];

interface DiscoverModalProps {
  isOpen: boolean;
  onClose: () => void;
  genre: string;
  setGenre: (genre: string) => void;
  setView: (view: View) => void;
  filteredCount: number;
  isLoading: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

export function DiscoverModal({
  isOpen,
  onClose,
  genre,
  setGenre,
  setView,
  filteredCount,
  isLoading,
  triggerRef,
}: DiscoverModalProps) {
  const [selectedMoods, setSelectedMoods] = useState<string[]>([]);
  const [yearRange, setYearRange] = useState("");
  const [sortBy, setSortBy] = useState("trending");
  const [contentType, setContentType] = useState("all");
  const [expandedSections, setExpandedSections] = useState({
    moods: true,
    years: true,
    contentType: true,
    sort: true,
  });
  const modalRef = useRef<HTMLDivElement>(null);

  const toggleMood = (value: string) => {
    setSelectedMoods(prev =>
      prev.includes(value) ? prev.filter(m => m !== value) : [...prev, value]
    );
  };

  const hasActiveFilters =
    selectedMoods.length > 0 || yearRange !== "" || contentType !== "all";

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  useEffect(() => {
    if (!isOpen) {
      setSelectedMoods([]);
      setYearRange("");
      setContentType("all");
      setSortBy("trending");
    }
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        // Check if click was on trigger button
        if (
          triggerRef.current &&
          triggerRef.current.contains(e.target as Node)
        ) {
          return;
        }
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-start justify-center pt-20 px-4 pointer-events-none">
      <div
        className="pointer-events-auto w-full max-w-sm animate-in slide-in-from-top-2 duration-200"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="discover-modal-title"
      >
        <div className="rounded-xl border border-white/10 bg-[#121212] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.55)]">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-[#d7d7d3]" />
              <h3
                id="discover-modal-title"
                className="text-sm font-bold text-white"
              >
                Discover Filters
              </h3>
              {hasActiveFilters && (
                <span className="rounded-full bg-indigo-600/20 px-2 py-0.5 text-[10px] font-medium text-indigo-300">
                  {selectedMoods.length +
                    (yearRange ? 1 : 0) +
                    (contentType !== "all" ? 1 : 0)}{" "}
                  active
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-[#aaa9a5] hover:bg-white/10"
              aria-label="Close filters"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            {/* Mood/Vibe Selector */}
            <FilterSection
              title="Mood / Vibe"
              icon={<Filter className="h-3.5 w-3.5" />}
              isOpen={expandedSections.moods}
              onToggle={() => toggleSection("moods")}
            >
              <div className="mt-2 flex flex-wrap gap-2">
                {MOOD_TAGS.map(mood => (
                  <button
                    key={mood.value}
                    onClick={() => toggleMood(mood.value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                      selectedMoods.includes(mood.value)
                        ? "bg-indigo-600 text-white shadow-[0_0_0_1px_rgba(99,102,241,0.4)]"
                        : "border border-white/10 text-[#aaa9a5] hover:border-white/25 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {mood.label}
                  </button>
                ))}
              </div>
            </FilterSection>

            {/* Release Year Range */}
            <FilterSection
              title="Release Year"
              icon={<Calendar className="h-3.5 w-3.5" />}
              isOpen={expandedSections.years}
              onToggle={() => toggleSection("years")}
            >
              <div className="mt-2 flex flex-wrap gap-2">
                {YEAR_RANGES.map(range => (
                  <button
                    key={range.value}
                    onClick={() => setYearRange(range.value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                      yearRange === range.value
                        ? "bg-indigo-600 text-white shadow-[0_0_0_1px_rgba(99,102,241,0.4)]"
                        : "border border-white/10 text-[#aaa9a5] hover:border-white/25 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            </FilterSection>

            {/* Content Type */}
            <FilterSection
              title="Content Type"
              icon={<Star className="h-3.5 w-3.5" />}
              isOpen={expandedSections.contentType}
              onToggle={() => toggleSection("contentType")}
            >
              <div className="mt-2 flex flex-wrap gap-2">
                {CONTENT_TYPES.map(type => (
                  <button
                    key={type.value}
                    onClick={() => setContentType(type.value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                      contentType === type.value
                        ? "bg-indigo-600 text-white shadow-[0_0_0_1px_rgba(99,102,241,0.4)]"
                        : "border border-white/10 text-[#aaa9a5] hover:border-white/25 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </FilterSection>

            {/* Sort Order */}
            <FilterSection
              title="Sort By"
              icon={<Star className="h-3.5 w-3.5" />}
              isOpen={expandedSections.sort}
              onToggle={() => toggleSection("sort")}
            >
              <div className="mt-2 flex flex-wrap gap-2">
                {SORT_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    onClick={() => setSortBy(option.value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                      sortBy === option.value
                        ? "bg-indigo-600 text-white shadow-[0_0_0_1px_rgba(99,102,241,0.4)]"
                        : "border border-white/10 text-[#aaa9a5] hover:border-white/25 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </FilterSection>

            {/* Active Filters Summary & Apply */}
            {hasActiveFilters && (
              <div className="pt-3 border-t border-white/10">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex flex-wrap gap-1.5">
                    {selectedMoods.map(m => (
                      <span
                        key={m}
                        className="flex items-center gap-1 rounded-full bg-indigo-600/20 px-2 py-0.5 text-[10px] font-medium text-indigo-300"
                      >
                        {MOOD_TAGS.find(t => t.value === m)?.label}
                        <button
                          onClick={() => toggleMood(m)}
                          className="ml-1 hover:text-white"
                          aria-label={`Remove ${m} filter`}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                    {yearRange && (
                      <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70">
                        {YEAR_RANGES.find(r => r.value === yearRange)?.label}
                        <button
                          onClick={() => setYearRange("")}
                          className="ml-1 hover:text-white"
                          aria-label="Remove year filter"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    )}
                    {contentType !== "all" && (
                      <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70">
                        {
                          CONTENT_TYPES.find(t => t.value === contentType)
                            ?.label
                        }
                        <button
                          onClick={() => setContentType("all")}
                          className="ml-1 hover:text-white"
                          aria-label="Remove content type filter"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setGenre("All");
                      setView("movies");
                      onClose();
                    }}
                    className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-indigo-500 self-end sm:self-auto"
                  >
                    <Filter className="h-3 w-3" />
                    Apply Filters
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
          aria-hidden="true"
        />
      </div>
    </div>,
    document.body
  );
}

function FilterSection({
  title,
  icon,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-white/5 last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between py-2"
        aria-expanded={isOpen}
      >
        <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[#8b8b90] cursor-pointer">
          {icon}
          <span className="text-white">{title}</span>
        </label>
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-white/60 transition-transform" />
        ) : (
          <ChevronDown className="h-4 w-4 text-white/60 transition-transform" />
        )}
      </button>
      {isOpen && <div className="pb-2">{children}</div>}
    </div>
  );
}
