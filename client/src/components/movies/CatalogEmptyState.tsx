import { Search, X, Loader2 } from "lucide-react";

interface CatalogEmptyStateProps {
  loading: boolean;
  configured: boolean;
  /** Active search query that returned no matches (query-aware messaging). */
  query?: string;
  /** Whether a search request is currently in-flight (debouncing or fetching). */
  searchLoading?: boolean;
}

/**
 * Fallback shown when the catalogue has no movies: distinguishes "loading",
 * "no results", and "provider not configured" so failures read clearly.
 *
 * Loading states are now handled by the global TopProgressBar component.
 * This component only renders for empty/error states.
 */
export function CatalogEmptyState({
  loading,
  configured,
  query,
  searchLoading = false,
}: CatalogEmptyStateProps) {
  const isSearch = Boolean(query?.trim());
  const title = searchLoading
    ? "Searching…"
    : isSearch
      ? `No results for "${query?.trim()}"`
      : configured
        ? "No movies found"
        : "Movies aren't available right now";
  const description = searchLoading
    ? "Looking for matches…"
    : isSearch
      ? "Try a different title, or clear the search to browse the catalogue."
      : configured
        ? "Try another search or genre."
        : "Please try again in a little while.";

  // Only show for empty/error states, not loading (handled by TopProgressBar)
  if (loading || searchLoading) {
    return null;
  }

  return (
    <section className="mt-5 rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-6 py-16 text-center">
      <Search className="mx-auto mb-3 h-8 w-8 text-[#77777d]" />
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[#99999d]">
        {description}
      </p>
    </section>
  );
}

interface SearchStatusBarProps {
  query: string;
  onClear: () => void;
}

/** Read-only banner confirming that results below are streamable matches. */
export function SearchStatusBar({ query, onClear }: SearchStatusBarProps) {
  return (
    <div className="mt-5 flex items-center justify-between rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-[#c4c4c0]">
      <span>
        Playable results for <strong className="text-white">{query}</strong>
      </span>
      <button
        onClick={onClear}
        className="flex items-center gap-1 text-[#d7d7d3]"
      >
        <X className="h-3 w-3" /> Clear
      </button>
    </div>
  );
}
