import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Link2,
  Pause,
  Play,
  Plus,
  Star,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation } from "wouter";
import { toast } from "sonner";
import type { Movie } from "./types";
import { formatRuntime } from "@/lib/format";
import { tmdbImage } from "@/lib/tmdbImages";
import { absoluteUrl } from "@/lib/siteUrl";

export interface SpotlightProps {
  items: readonly Movie[];
  savedIds?: ReadonlyArray<Movie["id"]>;
  onSave?: (movie: Movie) => void;
  rotateSeconds?: number;
  /** Called whenever the active featured title changes (for page-level ambient). */
  onActiveChange?: (movie: Movie) => void;
}

const EASE = [0.32, 0.72, 0, 1] as const;

/** How many slides the dot strip is willing to show before it collapses to a count. */
const MAX_DOTS = 10;

/**
 * A TMDB backdrop at `original` is a real ~1920px file, which is what covers a
 * 70vh card at 2x without the browser upscaling the 780px rendition.
 */
function backdropUrl(backdrop: string | null | undefined): string | null {
  if (!backdrop) return null;
  return tmdbImage(backdrop, "original") || null;
}

/**
 * The title's own lettering, when TMDB has it.
 *
 * Logos are PNG or SVG and are already transparent, so they need no treatment
 * beyond a ceiling on their height -- a 3000px-wide SVG otherwise renders at
 * the width of the copy column and pushes the synopsis off the card.
 */
function logoUrl(movie: Movie | undefined): string | null {
  if (!movie?.logo_url) return null;
  return tmdbImage(movie.logo_url, "w500") || movie.logo_url;
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
 * The one class every badge in the meta row shares, so the year, the rating and
 * the genre tags cannot drift apart as they are added and removed.
 */
const BADGE =
  "px-2.5 py-1 rounded-md text-xs font-semibold bg-white/10 backdrop-blur-md " +
  "border border-white/10 text-white/90";

/**
 * The featured hero, as a bounded card rather than a full-bleed wash.
 *
 * Bounding it (`max-w-7xl`, `rounded-2xl`, a hairline and a drop shadow) is what
 * makes the artwork read as a poster rather than as wallpaper: the image has an
 * edge, and an edge is what tells the eye this is an object it can look *at*.
 *
 * The old version dimmed the backdrop to `opacity-60` and then laid two heavy
 * scrims over it, which compounded -- the artwork the visitor came to see was
 * the faintest thing on screen. Now the image plays at full strength and the
 * gradients are weighted to the left and bottom only, so the right two thirds of
 * the frame stays clean while the copy keeps its contrast.
 *
 * It also used to be a YouTube `<iframe>` playing the trailer as the background.
 * That leaked: the channel watermark, the title card and the "watch on YouTube"
 * link all render inside the frame, `controls=0` removes none of them, and a
 * video that refused to embed put YouTube's own error card behind the title.
 * A third-party player on the critical path of every first impression is not
 * worth the motion. The trailer is one click away on the title's own page.
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
  const [failedLogo, setFailedLogo] = useState<number | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (count === 0) return;
    if (index >= count) setIndex(0);
  }, [count, index]);

  // Reset the rotation timer whenever the slide changes, so the progress bar and
  // the autoplay interval can never drift apart.
  useEffect(() => {
    if (count < 2 || paused || rotateSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setIndex(i => (i + 1) % count);
    }, rotateSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [count, paused, rotateSeconds, index]);

  const current: Movie | undefined = count > 0 ? items[index] : undefined;
  const saved = current ? savedIds.includes(current.id) : false;
  const art = backdropUrl(current?.backdrop ?? current?.backdrop_url);
  const titleLogoUrl =
    current && failedLogo !== current.id ? logoUrl(current) : null;

  const genres = useMemo(() => {
    if (!current) return [] as string[];
    const list = current.genres?.length ? current.genres : current.genre;
    return (list ?? []).slice(0, 3);
  }, [current]);

  const rating = formatRating(current?.vote_average ?? current?.score);

  const step = useCallback(
    (delta: number) => setIndex(i => (i + delta + count) % count),
    [count]
  );

  // Report the active title so the page can drive its ambient glow.
  useEffect(() => {
    if (current) onActiveChange?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Arrow keys step the carousel, but only while the hero actually holds focus:
  // a document-level listener would swallow the arrows of every input on the
  // page, including the search field in the header.
  useEffect(() => {
    if (count < 2) return;
    const node = rootRef.current;
    if (!node) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      step(e.key === "ArrowLeft" ? -1 : 1);
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [count, step]);

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

  const dots = count <= MAX_DOTS;

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      aria-label="Featured spotlight"
      aria-roledescription="carousel"
      className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8"
    >
      <div
        className={
          "relative isolate h-[70vh] min-h-[520px] w-full overflow-hidden " +
          "rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl"
        }
      >
        {/* Artwork, at full strength. A slow settle gives the crossfade
            something to do that a straight fade cannot. */}
        <div className="absolute inset-0">
          <AnimatePresence initial={false}>
            {current ? (
              <motion.div
                key={current.id}
                className="absolute inset-0"
                initial={{ opacity: 0, scale: 1.06 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.8, ease: EASE }}
              >
                {art ? (
                  <img
                    src={art}
                    alt=""
                    aria-hidden
                    loading="eager"
                    fetchPriority="high"
                    className="h-full w-full object-cover object-center"
                  />
                ) : (
                  <div
                    aria-hidden
                    className="h-full w-full bg-[linear-gradient(140deg,#1c1f2b_0%,#0f1015_55%,#0a0a0c_100%)]"
                  />
                )}
              </motion.div>
            ) : (
              <div
                aria-hidden
                className="h-full w-full bg-[linear-gradient(140deg,#1c1f2b_0%,#0f1015_55%,#0a0a0c_100%)]"
              />
            )}
          </AnimatePresence>
        </div>

        {/* Staged scrims. Each does one job, and both are weighted away from
            the upper right so the artwork keeps its brightness where nothing
            is set over it. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.85)_0%,rgba(0,0,0,0.55)_32%,rgba(0,0,0,0.15)_62%,transparent_88%)]"
        />
        <div
          aria-hidden
          className="absolute inset-0 bg-[linear-gradient(0deg,rgba(15,15,15,0.95)_0%,rgba(15,15,15,0.55)_28%,transparent_62%)]"
        />
        {/* Clears the header without another full-bleed wash. */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-28 bg-[linear-gradient(180deg,rgba(0,0,0,0.55)_0%,transparent_100%)]"
        />
        {/* A single cool counter-light, so the frame is not lit by one colour. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_88%_18%,rgba(139,92,246,0.16),transparent_68%)]"
        />

        {/* Copy, docked bottom-left inside the card's own gutter. */}
        <div className="absolute inset-x-0 bottom-0 z-10 px-6 pb-24 sm:px-10 sm:pb-14 lg:px-14 lg:pb-16">
          <div className="max-w-xl">
            <AnimatePresence initial={false} mode="popLayout">
              {current ? (
                <motion.div
                  key={current.id}
                  className="space-y-5"
                  initial={{ opacity: 0, y: 22 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.5, ease: EASE }}
                >
                  {titleLogoUrl ? (
                    <img
                      src={titleLogoUrl}
                      alt={current.title}
                      onError={() => setFailedLogo(current.id)}
                      className="max-h-24 w-auto max-w-full object-contain object-left drop-shadow-[0_4px_20px_rgba(0,0,0,0.7)] sm:max-h-28"
                    />
                  ) : (
                    <h1 className="text-4xl font-black leading-[0.95] tracking-tight text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.8)] sm:text-5xl lg:text-6xl">
                      {current.title}
                    </h1>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {current.year ? (
                      <span className={BADGE}>{current.year}</span>
                    ) : null}
                    {rating ? (
                      <span className={BADGE}>
                        <span className="inline-flex items-center gap-1 align-middle">
                          <Star
                            className="h-3 w-3 fill-amber-400 text-amber-400"
                            aria-hidden
                          />
                          {rating}
                        </span>
                      </span>
                    ) : null}
                    {current.runtime ? (
                      <span className={BADGE}>
                        {formatRuntime(current.runtime)}
                      </span>
                    ) : null}
                    {genres.map(genre => (
                      <span key={genre} className={BADGE}>
                        {genre}
                      </span>
                    ))}
                  </div>

                  {/* Hidden rather than truncated on the shortest screens: three
                      clamped lines at 375px is a paragraph of fragments. */}
                  {current.synopsis ? (
                    <p className="hidden max-w-lg text-sm leading-relaxed text-white/80 sm:line-clamp-3 sm:block">
                      {current.synopsis}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2.5 pt-1 sm:gap-3">
                    <button
                      type="button"
                      onClick={() => handlePlay(current)}
                      className={
                        "inline-flex min-h-11 items-center gap-2 rounded-lg px-6 " +
                        "text-sm font-bold text-neutral-900 transition " +
                        "hover:bg-white/85 focus-visible:outline focus-visible:outline-2 " +
                        "focus-visible:outline-offset-2 focus-visible:outline-white"
                      }
                    >
                      <Play className="h-4 w-4 fill-current" aria-hidden />
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
                      className={
                        "inline-flex min-h-11 items-center gap-2 rounded-lg px-5 " +
                        "text-sm font-semibold text-white backdrop-blur-md transition " +
                        "bg-white/15 hover:bg-white/25 focus-visible:outline " +
                        "focus-visible:outline-2 focus-visible:outline-offset-2 " +
                        "focus-visible:outline-white/70"
                      }
                    >
                      {saved ? (
                        <Check className="h-4 w-4" aria-hidden />
                      ) : (
                        <Plus className="h-4 w-4" aria-hidden />
                      )}
                      <span>{saved ? "In My List" : "My List"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleShare(current)}
                      className={
                        "inline-flex min-h-11 items-center gap-2 rounded-lg px-5 " +
                        "text-sm font-semibold text-white backdrop-blur-md transition " +
                        "bg-white/15 hover:bg-white/25 focus-visible:outline " +
                        "focus-visible:outline-2 focus-visible:outline-offset-2 " +
                        "focus-visible:outline-white/70"
                      }
                    >
                      <Link2 className="h-4 w-4" aria-hidden />
                      Share
                    </button>

                    {/* There is no standalone detail route in this app; the
                        title's page carries its own details section, so "More
                        info" is a deep link into it rather than a new screen. */}
                    <button
                      type="button"
                      onClick={() => {
                        const tmdbId = parseInt(current.providerId, 10);
                        if (isNaN(tmdbId)) return;
                        const suffix =
                          current.mediaType === "tv"
                            ? "?type=tv&season=1&episode=1"
                            : "";
                        navigate(`/watch/${tmdbId}${suffix}#details`);
                      }}
                      aria-label={`More info about ${current.title}`}
                      className={
                        "grid h-11 w-11 shrink-0 place-items-center rounded-full text-white " +
                        "backdrop-blur-md transition bg-white/15 hover:bg-white/25 " +
                        "focus-visible:outline focus-visible:outline-2 " +
                        "focus-visible:outline-offset-2 focus-visible:outline-white/70"
                      }
                    >
                      <Info className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        {/* Controls. One frosted cluster, bottom-right on desktop and a
            full-width strip on phones, so the arrows are a real 44px target
            instead of the two 36px buttons the previous version hid entirely
            below `sm`. */}
        {count > 1 ? (
          <div
            className={
              "absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 " +
              "border-t border-white/10 bg-neutral-900/50 px-4 py-3 " +
              "backdrop-blur-md sm:inset-x-auto sm:right-6 sm:bottom-6 " +
              "sm:rounded-full sm:border sm:px-3"
            }
          >
            <button
              type="button"
              aria-label="Previous featured title"
              onClick={() => step(-1)}
              className={
                "grid h-9 w-9 shrink-0 place-items-center rounded-full text-white " +
                "transition hover:bg-white/20 focus-visible:outline focus-visible:outline-2 " +
                "focus-visible:outline-offset-2 focus-visible:outline-white/80"
              }
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>

            {/* Live position, so the viewer knows how long the shelf is. */}
            <p className="shrink-0 text-xs font-semibold tabular-nums text-white/70">
              <span className="text-white">{index + 1}</span>
              <span className="mx-1 text-white/40">/</span>
              {count}
            </p>

            <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none">
              {dots
                ? Array.from({ length: count }, (_, dot) => (
                    <button
                      key={dot}
                      type="button"
                      aria-label={`Show featured title ${dot + 1}`}
                      aria-current={index === dot}
                      onClick={() => setIndex(dot)}
                      className={`h-1.5 rounded-full transition-all duration-300 ${
                        index === dot
                          ? "w-6 bg-white"
                          : "w-1.5 bg-white/35 hover:bg-white/70"
                      }`}
                    />
                  ))
                : // Past MAX_DOTS a strip of ten indistinguishable pills is
                  // noise; the counter above carries the position instead.
                  null}
            </div>

            <button
              type="button"
              aria-label={paused ? "Resume rotation" : "Pause rotation"}
              aria-pressed={paused}
              onClick={() => setPaused(p => !p)}
              className={
                "grid h-9 w-9 shrink-0 place-items-center rounded-full text-white " +
                "transition hover:bg-white/20 focus-visible:outline focus-visible:outline-2 " +
                "focus-visible:outline-offset-2 focus-visible:outline-white/80"
              }
            >
              {paused ? (
                <Play className="h-3.5 w-3.5 fill-current" aria-hidden />
              ) : (
                <Pause className="h-3.5 w-3.5 fill-current" aria-hidden />
              )}
            </button>

            <button
              type="button"
              aria-label="Next featured title"
              onClick={() => step(1)}
              className={
                "grid h-9 w-9 shrink-0 place-items-center rounded-full text-white " +
                "transition hover:bg-white/20 focus-visible:outline focus-visible:outline-2 " +
                "focus-visible:outline-offset-2 focus-visible:outline-white/80"
              }
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : null}

        {/* Per-slide progress, riding the top edge of the control strip. */}
        {count > 1 && rotateSeconds > 0 ? (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 z-20 h-[3px] bg-white/10"
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
        ) : null}
      </div>
    </section>
  );
}
