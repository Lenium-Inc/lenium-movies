import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Link2,
  Play,
  Plus,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation } from "wouter";
import { toast } from "sonner";
import type { Movie } from "./types";
import { formatRuntime } from "@/lib/format";
import { tmdbImage } from "@/lib/tmdbImages";
import { absoluteUrl } from "@/lib/siteUrl";

interface SpotlightProps {
  items: readonly Movie[];
  savedIds?: ReadonlyArray<Movie["id"]>;
  onSave?: (movie: Movie) => void;
  rotateSeconds?: number;
  /** Called whenever the active featured title changes (for page-level ambient). */
  onActiveChange?: (movie: Movie) => void;
}

const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * The hero's artwork, and nothing else.
 *
 * This used to be a YouTube `<iframe>` playing the title's trailer, muted, with
 * the player's own chrome hidden behind `controls=0`. It leaked anyway: the
 * channel watermark, the title card and the "watch on YouTube" link all render
 * inside the frame and no query parameter removes them, and when a video
 * refused to embed, YouTube's own error card sat behind the title and ratings
 * reading "Video unavailable". A third-party frame as the *background* of the
 * landing page also put a foreign player, its ad scripts and its error states
 * in the path of every first impression.
 *
 * A TMDB backdrop is the right material for a hero: one high-resolution image,
 * no scripts, no third-party origin, and the gradient overlays below do the
 * work the frame was standing in for. The trailer is still one click away, on
 * the title's own page.
 */
function backdropUrl(backdrop: string | null | undefined): string | null {
  if (!backdrop) return null;
  // `tmdbImage` re-points the size segment rather than trusting the url it was
  // handed. The backend bakes w1280 into the stored string, so a
  // `startsWith("http")` bail-out would return the 1280px rendition and the
  // hero would upscale a small image across the full viewport width.
  return tmdbImage(backdrop, "original") || null;
}

function formatRating(score: number | null | undefined): string {
  if (score === null || score === undefined) return "";
  return score.toFixed(1);
}

/** Shareable watch link for a title, built the same way the watch page builds it. */
function watchLink(movie: Movie): string {
  const id = movie.providerId || movie.id;
  const isTv = movie.mediaType === "tv";
  const suffix = isTv ? "?type=tv&season=1&episode=1" : "";
  return absoluteUrl(`/watch/${id}${suffix}`);
}

/**
 * Featured "Movie-of-the-Day" hero: full-bleed TMDB backdrop for the active
 * title, the title's own metadata over it, and the three things a viewer can do
 * with it (play, keep, share). Rotates through the shelf, and pauses on hover
 * so a title is not swapped out from under someone who is reading it.
 */
export function Spotlight({
  items,
  savedIds = [],
  onSave,
  rotateSeconds = 8,
  onActiveChange,
}: SpotlightProps) {
  const [, navigate] = useLocation();
  const count = items.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (count === 0) return;
    if (index >= count) setIndex(0);
  }, [count, index]);

  useEffect(() => {
    if (count < 2 || paused || rotateSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setIndex(i => (i + 1) % count);
    }, rotateSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [count, paused, rotateSeconds]);

  const current: Movie | undefined = count > 0 ? items[index] : undefined;
  const saved = current ? savedIds.includes(current.id) : false;
  const art = backdropUrl(current?.backdrop ?? current?.backdrop_url);

  const genres = useMemo(() => {
    if (!current) return "";
    return (current.genres?.length ? current.genres : current.genre)
      ?.slice(0, 3)
      .join(" · ");
  }, [current]);

  // Report the active title so the page can drive its ambient glow.
  useEffect(() => {
    if (current) onActiveChange?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const handlePlay = (movie: Movie) => {
    const tmdbId = parseInt(movie.providerId, 10);
    if (isNaN(tmdbId)) {
      console.warn("[Spotlight] No TMDB id for title:", movie.title);
      return;
    }
    navigate(`/watch/${tmdbId}`);
  };

  const handleShare = async (movie: Movie) => {
    const url = watchLink(movie);
    try {
      if (navigator.share) {
        await navigator.share({ title: movie.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      // A cancelled share sheet throws, and so does a clipboard write on an
      // insecure origin. Neither is worth a second error toast.
    }
  };

  return (
    <section
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="Featured spotlight"
      // Full-bleed: edge to edge, no rounded frame. The bottom edge stops short
      // of the viewport bottom rather than butting against it, so the first shelf
      // has somewhere to sit.
      className="relative isolate h-[70vh] min-h-[520px] w-full overflow-hidden lg:h-[85vh] lg:min-h-[680px]"
    >
      {/* Artwork. `original` is a real 1920px-wide file, so it covers a 70vh
          hero at 2x without the browser upscaling a 780px rendition. */}
      <div className="absolute inset-0">
        <AnimatePresence initial={false}>
          {current ? (
            <motion.div
              key={current.id}
              className="absolute inset-0"
              initial={{ opacity: 0, scale: 1.04 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.01 }}
              transition={{ duration: 0.7, ease: EASE }}
            >
              {art ? (
                <img
                  src={art}
                  alt=""
                  aria-hidden
                  loading="eager"
                  fetchPriority="high"
                  className="h-full w-full object-cover object-[center_25%] opacity-60"
                />
              ) : (
                <div
                  aria-hidden
                  className="h-full w-full bg-[linear-gradient(140deg,#151824_0%,#0B0C10_60%,#09090B_100%)]"
                />
              )}
            </motion.div>
          ) : (
            <div
              aria-hidden
              className="h-full w-full bg-[linear-gradient(140deg,#151824_0%,#0B0C10_60%,#09090B_100%)]"
            />
          )}
        </AnimatePresence>
      </div>

      {/* Two scrims, doing two different jobs: the vertical one dissolves the
          bottom of the image into the page, the horizontal one darkens only
          where the copy is docked so the left half stays readable without
          dimming the artwork the viewer came for. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-r from-slate-950/90 via-slate-950/60 to-transparent"
      />
      {/* Cyan counter-light on the right edge, so the frame is not lit by one
          colour alone. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_85%_20%,rgba(6,182,212,0.14),transparent_65%)]"
      />

      {/* Content overlay. Pinned to the same 1480px column and horizontal
          gutter that <main> uses on Home, so the title sits in line with the
          shelves below it. Before the hero became full-bleed this was
          `left-4 sm:left-8`, which lined the title up with nothing. */}
      <div className="absolute inset-x-0 bottom-12 z-10 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1480px]">
          <div className="max-w-2xl space-y-4">
            <AnimatePresence initial={false} mode="popLayout">
              {current ? (
                <motion.div
                  key={current.id}
                  className="space-y-4"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.5, ease: EASE }}
                >
                  <h1 className="text-4xl font-black leading-[0.95] tracking-tight text-white drop-shadow-md sm:text-5xl lg:text-6xl">
                    {current.title}
                  </h1>

                  <div className="flex flex-wrap items-center gap-3">
                    {current.year ? (
                      <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/30">
                        {current.year}
                      </span>
                    ) : null}
                    {formatRating(current.vote_average ?? current.score) ? (
                      <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        ★ {formatRating(current.vote_average ?? current.score)}
                      </span>
                    ) : null}
                    {current.runtime ? (
                      <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-white/10 text-gray-200 border border-white/10">
                        {formatRuntime(current.runtime)}
                      </span>
                    ) : null}
                    {genres ? (
                      <span className="text-sm text-gray-300">{genres}</span>
                    ) : null}
                  </div>

                  {current.synopsis ? (
                    <p className="text-sm text-gray-300 line-clamp-3 leading-relaxed max-w-xl">
                      {current.synopsis}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-3 pt-2 sm:gap-4">
                    <button
                      type="button"
                      onClick={() => handlePlay(current)}
                      className="sv-btn-primary text-sm"
                    >
                      <Play className="h-4 w-4 fill-current" />
                      Play
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        toast.success(
                          saved
                            ? "Removed from your list"
                            : "Added to your list!"
                        );
                        onSave?.(current);
                      }}
                      aria-pressed={saved}
                      className="sv-btn-glass text-sm"
                    >
                      {saved ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                      {saved ? "In My List" : "My List"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleShare(current)}
                      className="sv-btn-glass px-4 text-sm"
                    >
                      <Link2 className="h-4 w-4" />
                      <span className="hidden sm:inline">Share</span>
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Rotation controls */}
      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous featured title"
            onClick={() => setIndex(i => (i - 1 + count) % count)}
            className="sv-btn-icon absolute bottom-6 right-20 z-10 hidden sm:grid"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next featured title"
            onClick={() => setIndex(i => (i + 1) % count)}
            className="sv-btn-icon absolute bottom-6 right-12 z-10 hidden sm:grid"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      )}

      {/* Rotation indicators */}
      {count > 1 && (
        <div className="absolute bottom-7 right-5 z-10 hidden items-center gap-1.5 sm:flex">
          {Array.from({ length: Math.min(count, 8) }, (_, dot) => {
            const active = count > 8 ? index % 8 === dot : index === dot;
            return (
              <button
                key={dot}
                type="button"
                aria-label={`Show slide ${dot + 1}`}
                onClick={() =>
                  setIndex(current =>
                    count > 8 ? current - (current % 8) + dot : dot
                  )
                }
                className={`h-1 rounded-full transition-all duration-300 ${
                  active
                    ? "w-6 bg-violet-400"
                    : "w-1.5 bg-white/30 hover:bg-white/60"
                }`}
              />
            );
          })}
        </div>
      )}

      {/* Per-slide rotation progress */}
      {count > 1 && rotateSeconds > 0 && (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-10 h-[3px] bg-white/10"
        >
          <div
            key={index}
            className="fs-progress h-full bg-gradient-to-r from-violet-500 to-cyan-400"
            style={{
              animationDuration: `${rotateSeconds}s`,
              animationPlayState: paused ? "paused" : "running",
            }}
          />
        </div>
      )}
    </section>
  );
}
