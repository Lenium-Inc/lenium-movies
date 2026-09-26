import { Star, Film, Tv, Bookmark, Check } from "lucide-react";
import { useLocation } from "wouter";
import type { Movie } from "./types";

interface MovieCardProps {
  movie: Movie;
  saved?: boolean;
  onPlay?: (movie: Movie) => void;
  onSave?: (movie: Movie) => void;
}

function formatRating(score: number | null | undefined): string {
  if (score === null || score === undefined) return "";
  return score.toFixed(1);
}

export const MovieCard: React.FC<MovieCardProps> = ({
  movie,
  saved,
  onPlay,
  onSave,
}) => {
  const [, navigate] = useLocation();
  const posterUrl =
    movie.poster ||
    `https://via.placeholder.com/500x750?text=${encodeURIComponent(movie.title)}`;
  const releaseYear = movie.year?.toString() || "Unknown";
  const voteAverage = formatRating(movie.vote_average ?? movie.score);
  const mediaType = movie.mediaType || "movie";
  const tmdbId = movie.providerId ? parseInt(movie.providerId, 10) : null;

  const handlePlayClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (onPlay) {
      onPlay(movie);
      return;
    }
    if (!tmdbId || isNaN(tmdbId)) {
      console.warn("[MovieCard] Invalid TMDB ID:", movie.providerId);
      return;
    }
    navigate(`/watch/${tmdbId}`);
  };

  const handleSaveClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSave?.(movie);
  };

  return (
    <article className="group relative bg-zinc-900/50 rounded-xl overflow-hidden border border-white/5 transition-all duration-300 hover:border-white/15 hover:shadow-[0_16px_48px_rgba(0,0,0,0.55)]">
      <button
        onClick={handlePlayClick}
        className="block"
        aria-label={`Play ${movie.title}`}
      >
        <div className="aspect-[2/3] w-full overflow-hidden bg-zinc-800 relative">
          <img
            src={posterUrl}
            alt={movie.title}
            className="w-full h-full object-cover transition-opacity duration-300 group-hover:opacity-90 group-hover:scale-[1.02]"
            loading="lazy"
          />

          {/* Media type badge - top left */}
          <span className="absolute top-2 left-2 flex items-center gap-1 px-2 py-1 bg-black/70 backdrop-blur-sm text-[10px] font-semibold uppercase text-white rounded border border-white/10">
            {mediaType === "tv" ? (
              <>
                <Tv className="h-3 w-3" />
                Series
              </>
            ) : (
              <>
                <Film className="h-3 w-3" />
                Movie
              </>
            )}
          </span>

          {/* Rating badge on poster - top right */}
          {voteAverage && (
            <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-amber-400/90 px-2 py-1 text-[11px] font-black text-black shadow-lg">
              <Star className="w-3 h-3 fill-current" />
              {voteAverage}
            </span>
          )}

          {/* Save button - top right, below rating */}
          {onSave && (
            <button
              onClick={handleSaveClick}
              className="absolute top-10 right-2 z-10 flex items-center justify-center w-8 h-8 rounded-full bg-black/60 hover:bg-white/10 backdrop-blur-sm text-white/80 hover:text-white transition-colors"
              aria-label={saved ? "Remove from My List" : "Add to My List"}
            >
              {saved ? (
                <Check className="h-4 w-4 text-green-400" />
              ) : (
                <Bookmark className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </button>

      {/* Title below poster */}
      <div className="p-3">
        <h3 className="text-white font-semibold text-sm line-clamp-1 group-hover:text-white/90 transition-colors">
          {movie.title}
        </h3>
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
          <span className="font-medium text-white/70">{releaseYear}</span>
          {voteAverage && (
            <span className="flex items-center gap-1 text-amber-400 font-medium">
              <Star className="w-3 h-3 fill-current" />
              {voteAverage}
            </span>
          )}
        </div>
      </div>
    </article>
  );
};
