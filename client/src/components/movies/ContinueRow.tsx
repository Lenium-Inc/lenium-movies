import { useLocation } from "wouter";
import { Play } from "lucide-react";
import { optimizedImage } from "@/lib/imageOptimize";
import { buildTitlePath } from "@/lib/watchRoute";
import { RowScroller } from "./RowScroller";
import type { Movie } from "./types";

/**
 * The Continue Watching shelf.
 *
 * It uses wide 16:9 cards rather than the 2:3 posters every curator shelf
 * uses, because a resume point is a frame of the film you were watching, not
 * its poster — but that is the only concession. The heading, the card chrome
 * and the progress rail all speak the same language as the rest of the page.
 *
 * A card opens the title page, like every other click path on the site. The
 * resume point is not lost in the detour: `buildTitlePath` carries the
 * season/episode as query params, and the title page's Play button hands them
 * straight to the watch route, so "pick this back up" resumes rather than
 * restarting at S1E1.
 */

interface ContinueRowProps {
  title: string;
  items: Movie[];
}

function resumeMeta(movie: Movie): string {
  const pct = movie.resume ? Math.round(movie.resume * 100) : 0;
  if (
    movie.mediaType === "tv" &&
    movie.resumeSeason != null &&
    movie.resumeEpisode != null
  ) {
    return `S${movie.resumeSeason} · E${movie.resumeEpisode} · ${pct}%`;
  }
  return `${pct}% watched`;
}

export function ContinueRow({ title, items }: ContinueRowProps) {
  const [, navigate] = useLocation();
  if (!items.length) return null;

  const play = (movie: Movie) => {
    const handle = movie.providerId || String(movie.id);
    if (!handle) return;
    // Route through the details page like every other click path; the resume
    // season/episode ride along so Play can pick up where the viewer stopped.
    navigate(
      buildTitlePath(handle, movie.mediaType || "movie", {
        season: movie.resumeSeason,
        episode: movie.resumeEpisode,
      })
    );
  };

  return (
    <section className="mb-10 lg:mb-12">
      {/* Same heading treatment as every other shelf, so this row reads as
          part of the page rather than as a separate module. */}
      <div className="mb-4 flex items-end justify-between px-2 sm:px-0">
        <h2 className="text-lg font-bold tracking-tight text-[#f1f1ee] sm:text-xl">
          {title}
        </h2>
      </div>

      <RowScroller label={title} className="catalog-row-cw">
        {items.map((movie, index) => {
          const pct = Math.min(100, Math.round((movie.resume ?? 0) * 100));
          const art = movie.backdrop ?? movie.poster;
          return (
            <button
              key={`${movie.providerId ?? movie.id}-${index}`}
              type="button"
              onClick={() => play(movie)}
              aria-label={`Resume ${movie.title}`}
              className="group relative block w-full cursor-pointer overflow-hidden rounded-lg border border-white/10 bg-black/40 text-left"
            >
              <div className="relative aspect-video w-full overflow-hidden bg-zinc-900">
                {/* The fallback sits under every image: a dead CDN URL
                    degrades to a flat initial, never to a broken-image glyph. */}
                <span
                  aria-hidden
                  className="absolute inset-0 flex items-center justify-center bg-zinc-900 text-3xl font-bold text-white/30"
                >
                  {movie.title.slice(0, 1).toUpperCase()}
                </span>
                {art ? (
                  <img
                    src={optimizedImage(art, 640)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={event => {
                      event.currentTarget.style.display = "none";
                    }}
                    className="absolute inset-0 h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                ) : null}

                {/* Just enough scrim to keep the caption legible over a bright
                    frame — not a full wash that dims the artwork itself. */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="grid h-10 w-10 place-items-center rounded-full border border-white/25 bg-black/50 backdrop-blur-sm">
                    <Play className="ml-0.5 h-4 w-4 fill-white text-white" />
                  </span>
                </span>

                <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2.5">
                  <h3 className="line-clamp-1 text-[13px] font-semibold leading-tight text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
                    {movie.title}
                  </h3>
                  <p className="mt-1 text-[11px] text-white/60">
                    {resumeMeta(movie)}
                  </p>
                </div>
              </div>

              {/* A single thin rail, in the accent the rest of the page already
                  uses for active states — not a separate colour system. */}
              <div
                className="relative h-0.5 bg-white/10"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${pct}% watched`}
              >
                <div
                  className="h-full bg-[var(--accent)]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </button>
          );
        })}
      </RowScroller>
    </section>
  );
}

export default ContinueRow;
