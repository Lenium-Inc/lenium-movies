import { Search, X } from "lucide-react";

interface CatalogEmptyStateProps {
  loading: boolean;
  configured: boolean;
}

/**
 * Fallback shown when the catalogue has no movies: distinguishes "loading",
 * "no results", and "provider not configured" so failures read clearly.
 */
export function CatalogEmptyState({
  loading,
  configured,
}: CatalogEmptyStateProps) {
  const title = loading
    ? "Loading the catalogue…"
    : configured
      ? "No movies found"
      : "Movies aren't available right now";
  const description = loading
    ? "Fetching current movie metadata."
    : configured
      ? "Try another search or genre."
      : "Please try again in a little while.";

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

/** Read-only banner confirming that results below come from a live TMDB query. */
export function SearchStatusBar({ query, onClear }: SearchStatusBarProps) {
  return (
    <div className="mt-5 flex items-center justify-between rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-[#c4c4c0]">
      <span>
        Live TMDB results for <strong className="text-white">{query}</strong>
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
