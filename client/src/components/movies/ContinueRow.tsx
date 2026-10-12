import { useLocation } from "wouter";
import { Play } from "lucide-react";
import { buildWatchPath } from "@/lib/watchRoute";
import { RowScroller } from "./RowScroller";
import type { Movie } from "./types";

/**
 * The Continue Watching shelf, on its own velvet panel.
 *
 * This row speaks a different card language from the rest of the home page on
 * purpose. Every other shelf is a wall of 2:3 posters chosen by a curator --
 * this one is the viewer's own paused screening: a wide 16:9 frame borrowed
 * from the hero, and a wine-red rail across the foot of it marking where they
 * stopped. The cue dot on the rail's leading edge is the position marker a
 * stage manager would tape down -- the smallest possible ornament, and the
 * thing the eye goes to first.
 *
 * A card plays on click instead of opening the details sheet: the shelf's
 * whole promise is "pick this back up", and a detour through metadata is the
 * opposite of that.
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
    const tmdbId = parseInt(movie.providerId || String(movie.id), 10);
    if (!tmdbId || Number.isNaN(tmdbId)) return;
    navigate(
      buildWatchPath(tmdbId, {
        mediaType: movie.mediaType || "movie",
        season: movie.resumeSeason,
        episode: movie.resumeEpisode,
      })
    );
  };

  return (
    <section className="mb-10 lg:mb-12">
      <div className="cw-band rounded-2xl px-3 pb-3 pt-4 sm:px-4">
        <div className="mb-3 flex items-center gap-4 px-1">
          <h2 className="font-display text-[18px] font-medium italic leading-none text-white">
            {title}
          </h2>
          <span
            aria-hidden
            className="h-px flex-1 bg-gradient-to-r from-[var(--cw-wine)]/70 via-white/10 to-transparent"
          />
          <span className="font-tech text-[11px] tracking-wider text-white/40">
            {items.length} {items.length === 1 ? "title" : "titles"}
          </span>
        </div>

        <RowScroller
          label={title}
          className="catalog-row-cw"
          fadeClass="from-[var(--cw-velvet)]"
        >
          {items.map((movie, index) => {
            const pct = Math.min(100, Math.round((movie.resume ?? 0) * 100));
            const art = movie.backdrop ?? movie.poster;
            return (
              <div
                key={`${movie.providerId ?? movie.id}-${index}`}
                className="cw-card-rise"
                style={{ animationDelay: `${Math.min(index, 8) * 70}ms` }}
              >
                <button
                  type="button"
                  onClick={() => play(movie)}
                  aria-label={`Resume ${movie.title}`}
                  className="cw-card group relative block w-full cursor-pointer overflow-hidden rounded-xl border border-white/10 bg-black/40 text-left"
                >
                  <div className="relative aspect-video w-full overflow-hidden bg-zinc-900">
                    {/* The fallback sits under every image: a dead CDN URL
                        degrades to the velvet initial, never to a broken-image
                        glyph in the middle of the shelf. */}
                    <span
                      aria-hidden
                      className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[var(--cw-velvet)] to-zinc-950 font-display text-4xl font-black text-white/70"
                    >
                      {movie.title.slice(0, 1).toUpperCase()}
                    </span>
                    {art ? (
                      <img
                        src={art}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={event => {
                          event.currentTarget.style.display = "none";
                        }}
                        className="absolute inset-0 h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-[1.04]"
                      />
                    ) : null}

                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent" />

                    {/* The play affordance belongs to hover and focus, never to
                        the caption: title and resume meta are readable at rest. */}
                    <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
                      <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--cw-wine-hot)]/70 bg-[var(--cw-velvet-deep)]/80 backdrop-blur-sm">
                        <Play className="ml-0.5 h-4 w-4 fill-[var(--cw-wine-hot)] text-[var(--cw-wine-hot)]" />
                      </span>
                    </span>

                    <div className="pointer-events-none absolute inset-x-0 bottom-0 p-2.5">
                      <h3 className="line-clamp-1 text-[13px] font-semibold leading-tight text-white drop-shadow-[0_1px_6px_rgba(0,0,0,0.9)]">
                        {movie.title}
                      </h3>
                      <p className="mt-1 font-tech text-[10px] tracking-wider text-white/60">
                        {resumeMeta(movie)}
                      </p>
                    </div>
                  </div>

                  {/* The rail: wine where progress lives, cue dot on the seam. */}
                  <div
                    className="relative h-1 bg-white/10"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${pct}% watched`}
                  >
                    <div
                      className="cw-fill absolute inset-y-0 left-0 bg-gradient-to-r from-[#6d1526] via-[var(--cw-wine)] to-[var(--cw-wine-hot)]"
                      style={{ width: `${pct}%` }}
                    >
                      <span className="cw-cue absolute right-0 top-1/2 h-2 w-2 -translate-y-1/2 translate-x-1/2 rounded-full bg-[#ff8fa3]" />
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
        </RowScroller>
      </div>
    </section>
  );
}

export default ContinueRow;
