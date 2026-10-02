import { useState } from "react";
import { Star, Film, Tv, Bookmark, Check } from "lucide-react";
import { useLocation } from "wouter";
import {
  POSTER_SIZES_ATTRIBUTE,
  POSTER_SRCSET_SIZES,
  tmdbSrcSet,
} from "@/lib/tmdbImages";
import { buildWatchPath } from "@/lib/watchRoute";
import type { Movie } from "./types";

interface MovieCardProps {
  movie: Movie;
  saved?: boolean;
  onPlay?: (movie: Movie) => void;
  onSave?: (movie: Movie) => void;
  /**
   * Card presentation.
   *
   * `poster` is the wall-of-artwork shelf tile. `score` moves the rating out of
   * the hover caption and into a permanent block beside the artwork, because a
   * trending shelf is ranked by reception and a number that only appears on
   * hover is not doing that job.
   */
  variant?: MovieCardVariant;
}

export type MovieCardVariant = "poster" | "score";

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
  variant = "poster",
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
    // `buildWatchPath` is the single place that knows a series needs `type=tv`
    // and an episode, and a film must carry neither. Hand-writing the path here
    // is what previously sent series to a route with no episode to play.
    navigate(
      buildWatchPath(tmdbId, {
        mediaType,
        season: movie.resumeSeason,
        episode: movie.resumeEpisode,
      })
    );
  };

  return (
    <article
      className={
        "movie-card group relative overflow-hidden rounded-xl border border-white/5 bg-zinc-900/50 transition-[border-color,box-shadow] duration-300 hover:border-white/20 hover:shadow-[0_16px_48px_rgba(0,0,0,0.55)]" +
        // The score variant sits beside the artwork rather than under it, so the
        // tile becomes a row. `items-stretch` keeps the score column the full
        // height of the poster instead of collapsing to the text.
        (variant === "score" ? " flex items-stretch" : "")
      }
    >
      {variant === "score" && voteAverage ? (
        /* Permanent, and beside the artwork rather than on top of it: a badge
           laid over the poster competes with the poster's own composition, and
           this number is meant to be read while scanning the shelf, not on hover. */
        <div className="flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 pr-2.5">
          <span className="font-display text-2xl font-black leading-none text-white">
            {voteAverage}
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
            IMDb
          </span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={handlePlayClick}
        className={
          "block w-full cursor-pointer text-left" +
          (variant === "score" ? " min-w-0 flex-1" : "")
        }
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

          {/* Resume bar, drawn at the foot of the poster and always visible:
              it is the one piece of information on this card that has to be
              readable without hovering, because it is the reason the card is
              on this particular shelf. */}
          {typeof movie.resume === "number" && movie.resume > 0 ? (
            <div
              className="absolute inset-x-0 bottom-0 h-1 bg-white/15"
              role="progressbar"
              aria-valuenow={Math.round(movie.resume * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${Math.round(movie.resume * 100)}% watched`}
            >
              <div
                className="h-full bg-gradient-to-r from-violet-500 to-cyan-400"
                style={{
                  width: `${Math.min(100, Math.round(movie.resume * 100))}%`,
                }}
              />
            </div>
          ) : null}
        </div>
      </button>

      {/* Media type badge - top left. Suppressed in the score variant, where the
          rating block already carries the card's metadata and the top-left corner
          is better left to the artwork. */}
      {variant === "poster" ? (
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
      ) : null}

      {/* Rating badge - top right. Only in the poster variant; the score variant
          shows the same number permanently beside the poster. */}
      {voteAverage && variant === "poster" ? (
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
