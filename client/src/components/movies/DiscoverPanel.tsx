import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Calendar,
  Filter,
  Star,
  X,
} from "lucide-react";

interface DiscoverPanelProps {
  open: boolean;
  onClose: () => void;
  genre: string;
  setGenre: (genre: string) => void;
  setView: (view: string) => void;
}

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

export function DiscoverPanel({
  open,
  onClose,
  genre,
  setGenre,
  setView,
}: DiscoverPanelProps) {
  if (!open) return null;

  const [selectedMoods, setSelectedMoods] = useState<string[]>([]);
  const [yearRange, setYearRange] = useState("");
  const [sortBy, setSortBy] = useState("trending");
  const [contentType, setContentType] = useState("all");

  const toggleMood = (value: string) => {
    setSelectedMoods(prev =>
      prev.includes(value) ? prev.filter(m => m !== value) : [...prev, value]
    );
  };

  const hasActiveFilters =
    selectedMoods.length > 0 || yearRange !== "" || contentType !== "all";

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-[#121212] p-4 animate-in slide-in-from-top-2 duration-200">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-[#d7d7d3]" />
          <h3 className="text-sm font-bold text-white">Discover Filters</h3>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-[#aaa9a5] hover:bg-white/10"
          aria-label="Close filters"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-5">
        {/* Mood/Vibe Selector */}
        <div>
          <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[#8b8b90]">
            <span className="text-white">Mood / Vibe</span>
          </label>
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
        </div>

        {/* Release Year Range */}
        <div>
          <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[#8b8b90]">
            <Calendar className="h-3.5 w-3.5" />
            <span className="text-white">Release Year</span>
          </label>
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
        </div>

        {/* Content Type */}
        <div>
          <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[#8b8b90]">
            <span className="text-white">Content Type</span>
          </label>
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
        </div>

        {/* Sort Order */}
        <div>
          <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[#8b8b90]">
            <Star className="h-3.5 w-3.5" />
            <span className="text-white">Sort By</span>
          </label>
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
        </div>

        {/* Active Filters Summary & Apply */}
        {hasActiveFilters && (
          <div className="pt-3 border-t border-white/10">
            <div className="flex items-center justify-between">
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
                    {CONTENT_TYPES.find(t => t.value === contentType)?.label}
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
                className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-indigo-500"
              >
                <Filter className="h-3 w-3" />
                Apply Filters
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
