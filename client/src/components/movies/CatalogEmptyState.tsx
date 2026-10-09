import { Search } from "lucide-react";

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
  /** How many titles matched; omitted from the line when unknown. */
  count?: number;
  onClear: () => void;
}

/**
 * The results heading: the query as a plain section title with its match
 * count beside it, not a boxed banner.
 *
 * The old version wrapped the line in a bordered strip with a Clear "X" that
 * echoed the one already sitting in the search field, so the same page
 * offered two identical escapes under two different appearances. The heading
 * reads as a title for the grid below it, and Clear is one quiet text link.
 */
export function SearchStatusBar({
  query,
  count,
  onClear,
}: SearchStatusBarProps) {
  return (
    <section className="mt-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-xl font-bold text-white">
        Results for <span className="text-[#aab3c7]">“{query.trim()}”</span>
      </h2>
      <div className="flex items-baseline gap-4">
        {typeof count === "number" ? (
          <span className="text-xs text-[#8f99b0]">
            {count} {count === 1 ? "title" : "titles"}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-[#8f99b0] underline-offset-4 transition hover:text-white hover:underline"
        >
          Clear search
        </button>
      </div>
    </section>
  );
}
