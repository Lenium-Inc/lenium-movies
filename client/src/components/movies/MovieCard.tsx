import { useState } from "react";
import { Star, Film, Tv, Bookmark, Check } from "lucide-react";
import { useLocation } from "wouter";
import {
  POSTER_SIZES_ATTRIBUTE,
  POSTER_SRCSET_SIZES,
  tmdbSrcSet,
} from "@/lib/tmdbImages";
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

/**
 * A catalogue tile is artwork, not a text row.
 *
 * The title used to sit in its own block under the poster, so every tile spent
 * a third of its height restating a name already printed on the image. It is
 * now overlaid on the poster and revealed on hover or keyboard focus, which
 * leaves the grid reading as a wall of posters at rest.
 *
 * `.movie-card-reveal` owns the show/hide, because the rule has to be gated on
 * a real hover pointer: a touch device has no hover and its first tap
 * navigates, so hiding the caption there would leave unlabelled artwork with
 * no way to read it. See index.css.
 *
 * The save control is a sibling of the play button, not a child. It used to be
 * nested inside it, which is invalid HTML -- the parser closes the outer
 * button and the layout contract quietly breaks.
 */
export const MovieCard: React.FC<MovieCardProps> = ({
  movie,
  saved,
  onPlay,
  onSave,
}) => {
  const [, navigate] = useLocation();
  const [posterFailed, setPosterFailed] = useState(false);

  const releaseYear = movie.year ? movie.year.toString() : "";
  const voteAverage = formatRating(movie.vote_average ?? movie.score);
  const mediaType = movie.mediaType || "movie";
  const tmdbId = movie.providerId ? parseInt(movie.providerId, 10) : null;
  const hasPoster = Boolean(movie.poster) && !posterFailed;

  // The browser picks the smallest rendition that still covers the painted
  // size at the device's pixel ratio, so a 3x phone gets w780 without every
  // desktop tile downloading a full-resolution poster it cannot show.
  const posterSrcSet = tmdbSrcSet(movie.poster, POSTER_SRCSET_SIZES);

  const handlePlayClick = () => {
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

  return (
    <article className="movie-card group relative overflow-hidden rounded-xl border border-white/5 bg-zinc-900/50 transition-[border-color,box-shadow] duration-300 hover:border-white/20 hover:shadow-[0_16px_48px_rgba(0,0,0,0.55)]">
      <button
        type="button"
        onClick={handlePlayClick}
        className="block w-full cursor-pointer text-left"
        aria-label={`Play ${movie.title}`}
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden bg-zinc-800">
          {hasPoster ? (
            <img
              src={movie.poster ?? ""}
              srcSet={posterSrcSet}
              sizes={posterSrcSet ? POSTER_SIZES_ATTRIBUTE : undefined}
              alt={movie.title}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
              onError={() => setPosterFailed(true)}
            />
          ) : (
            // Typographic initial rather than a third-party placeholder
            // service: no extra request, no external dependency on the hot
            // path, and it cannot go soft.
            <span
              aria-hidden
              className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-950 font-display text-5xl font-black text-white/80"
            >
              {movie.title.slice(0, 1).toUpperCase()}
            </span>
          )}

          {/* Scrim and caption share one class so they can never drift apart:
              the text is only ever legible because the gradient is there. */}
          <div className="movie-card-reveal pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-transparent" />

          <div className="movie-card-caption pointer-events-none absolute inset-x-0 bottom-0 p-3">
            <h3 className="line-clamp-2 text-sm font-semibold leading-tight text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
              {movie.title}
            </h3>
            {releaseYear || voteAverage ? (
              <div className="mt-1.5 flex items-center gap-2 text-[11px] font-medium text-zinc-300">
                {releaseYear ? <span>{releaseYear}</span> : null}
                {voteAverage ? (
                  <span className="flex items-center gap-1 text-amber-400">
                    <Star className="h-3 w-3 fill-current" />
                    {voteAverage}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </button>

      {/* Media type badge - top left */}
      <span className="movie-card-reveal absolute left-2 top-2 flex items-center gap-1 rounded border border-white/10 bg-black/70 px-2 py-1 text-[10px] font-semibold uppercase text-white backdrop-blur-sm">
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

      {/* Rating badge - top right */}
      {voteAverage ? (
        <span className="movie-card-reveal absolute right-2 top-2 flex items-center gap-1 rounded-full bg-amber-400/90 px-2 py-1 text-[11px] font-black text-black shadow-lg">
          <Star className="h-3 w-3 fill-current" />
          {voteAverage}
        </span>
      ) : null}

      {/* Save button - top right, below the rating. Sibling of the play button
          so the markup is valid and a save never registers as a play. */}
      {onSave ? (
        <button
          type="button"
          onClick={() => onSave(movie)}
          className="movie-card-reveal absolute right-2 top-10 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white/80 backdrop-blur-sm transition-colors hover:bg-white/10 hover:text-white"
          aria-label={saved ? "Remove from My List" : "Add to My List"}
        >
          {saved ? (
            <Check className="h-4 w-4 text-green-400" />
          ) : (
            <Bookmark className="h-4 w-4" />
          )}
        </button>
      ) : null}
    </article>
  );
};
