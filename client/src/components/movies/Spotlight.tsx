import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Link2,
  Play,
  Star,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation } from "wouter";
import { toast } from "sonner";
import type { Movie } from "./types";
import { RemindMeButton } from "./RemindMeButton";
import { formatRuntime } from "@/lib/format";
import { tmdbImage } from "@/lib/tmdbImages";
import { absoluteUrl } from "@/lib/siteUrl";
import { resolveTrailer } from "@/lib/tmdbTrailers";
import { useTrailerPlayback } from "@/hooks/useTrailerPlayback";
import { fetchTrailerByTmdbId, type TrailerInfo } from "@/services/api";
import { isUpcoming, releaseCountdownLabel } from "@/services/notifications";

export interface SpotlightProps {
  items: readonly Movie[];
  rotateSeconds?: number;
  /** Called whenever the active featured title changes (for page-level ambient). */
  onActiveChange?: (movie: Movie) => void;
  /**
   * Opens details for a title.
   *
   * This used to navigate to `/watch/{id}`, which was wrong twice over: it
   * started playback when the viewer asked for information, and it took the
   * viewer off the home page to get it. The hero now only reports the intent
   * and the page decides what details means, so the same button can open a
   * panel here and navigate on the watch page later.
   */
  onMoreInfo?: (movie: Movie) => void;
}

const EASE = [0.32, 0.72, 0, 1] as const;

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
 * Bounding it (`max-w-7xl`, `rounded-3xl`, a hairline and a drop shadow) is what
 * makes the artwork read as a poster rather than as wallpaper: the image has an
 * edge, and an edge is what tells the eye this is an object it can look *at*.
 * Height is capped at 660px per the home artboard, so a tall monitor does not
 * turn the first shelf below the fold into a rumour.
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
  rotateSeconds = 8,
  onActiveChange,
  onMoreInfo,
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
  const art = backdropUrl(current?.backdrop ?? current?.backdrop_url);

  /*
   * Trailer, on click only.
   *
   * Nothing is fetched until the viewer asks for it. The obvious alternative --
   * fetch every hero title's trailer up front and play the lot as the carousel
   * rotates -- costs one request per slide every eight seconds and, worse, makes
   * the first impression of the page a video that nobody asked to watch. So the
   * frame stays unmounted until a click, and `activated` gates it.
   *
   * `null` while a title has no trailer is the normal case, not an error: most
   * TMDB titles have no playable official trailer, and the artwork behind is a
   * perfectly good hero. There is no toast and no error state, because the
   * spec explicitly forbids telling the viewer anything about it.
   */
  const [trailerFor, setTrailerFor] = useState<TrailerInfo | null>(null);
  const [trailerForId, setTrailerForId] = useState<Movie["id"] | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  // Drop a trailer that belongs to a title we have since rotated away from.
  useEffect(() => {
    setTrailerForId(null);
    setTrailerFor(null);
    setLookingUp(false);
  }, [current?.id]);

  const startTrailer = useCallback(
    (movie: Movie) => {
      if (lookingUp || trailerForId) return;
      const tmdbId = movie.providerId;
      if (!tmdbId) return;
      setLookingUp(true);
      void fetchTrailerByTmdbId(
        tmdbId,
        movie.mediaType === "tv" ? "tv" : "movie"
      )
        .then(info => {
          if (info) {
            setTrailerFor(info);
            setTrailerForId(movie.id);
          }
        })
        .catch(() => {
          // Swallowed on purpose. The hero has nothing to fall back to other
          // than the artwork it is already showing, and announcing a missing
          // trailer would be noise.
        })
        .finally(() => setLookingUp(false));
    },
    [lookingUp, trailerForId]
  );

  const resolvedTrailer = useMemo(
    () => resolveTrailer(trailerFor, { loop: false, controls: false }),
    [trailerFor]
  );
  const playback = useTrailerPlayback(resolvedTrailer?.site ?? null);

  // A paused-on-hold carousel should not rotate away the trailer mid-watch, so
  // engaging one also halts the rotation.
  useEffect(() => {
    if (playback.engaged) setPaused(true);
  }, [playback.engaged]);
  const titleLogoUrl =
    current && failedLogo !== current.id ? logoUrl(current) : null;

  const genres = useMemo(() => {
    if (!current) return [] as string[];
    const list = current.genres?.length ? current.genres : current.genre;
    return (list ?? []).slice(0, 3);
  }, [current]);

  const rating = formatRating(current?.vote_average ?? current?.score);
  const upcoming = isUpcoming(current?.releaseDate);
  const countdownLabel = current?.releaseDate
    ? releaseCountdownLabel(current.releaseDate)
    : "";

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
          // `group` so the edge arrows can reveal themselves on card hover.
          "group relative isolate h-[min(660px,72vh)] min-h-[540px] w-full overflow-hidden " +
          "rounded-3xl border border-white/[0.07] bg-neutral-900 shadow-2xl"
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
                    className="hero-drift h-full w-full object-cover object-center"
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
        {/* Grain, per the artboard: kills gradient banding on wide displays
            without touching the artwork's own contrast. */}
        <div
          aria-hidden
          className="hero-grain pointer-events-none absolute inset-0 z-[1]"
        />

        {/* The trailer frame, once the viewer has asked for it.
         *
         * Rendered above the artwork and given `pointer-events-none` so the
         * provider never sees a click: the overlay below is the only thing
         * the pointer can reach, which is what makes "click anywhere to
         * toggle" possible without the embed's own chrome appearing.
         *
         * `scale-125` is not decoration. A YouTube embed letterboxes with a
         * title bar in the top-left, and at 16:9 inside this wider-than-16:9
         * frame that bar sits fully visible over the artwork. Overscaling
         * pushes the bar outside the crop box, so the title is removed by
         * the frame's `overflow-hidden` rather than by a parameter YouTube
         * deprecated and now ignores.
         */}
        {resolvedTrailer && playback.commandable ? (
          <div
            key={trailerForId}
            className="absolute inset-0 z-[5] overflow-hidden"
          >
            <iframe
              ref={playback.frameRef}
              src={resolvedTrailer.src}
              title={`${current?.title ?? "Featured title"} — ${resolvedTrailer.label}`}
              allow="autoplay; encrypted-media"
              // Same reason as `Details`: this origin has to be sent, or the host
              // answers 153 and the frame renders blank.
              referrerPolicy="strict-origin-when-cross-origin"
              className="pointer-events-none absolute left-1/2 top-1/2 h-full w-full max-w-none -translate-x-1/2 -translate-y-1/2 scale-125 border-0"
            />
          </div>
        ) : null}

        {/* The click surface.
         *
         * Sits at z-6, between the trailer (z-5) and the copy (z-10), so it
         * catches every click on the artwork while the action row and the
         * arrows still win where they sit. Deliberately not a `<button>`:
         * it covers the whole card, and nesting it around the action row
         * would put a button inside a button.
         *
         * First click resolves the trailer, later clicks toggle it. The
         * `aria-hidden` div is pointer-only by design -- it would otherwise
         * be an unlabelled region covering everything -- so keyboard users
         * get the `sr-only` button below instead. That is invisible, which
         * keeps the "no visible play/pause state" rule intact while not
         * leaving the feature mouse-only.
         */}
        <div
          aria-hidden
          onClick={() => {
            if (!playback.engaged) {
              if (current) startTrailer(current);
              return;
            }
            playback.toggle();
          }}
          className="absolute inset-0 z-[6] cursor-pointer"
        />

        {playback.engaged ? (
          <button
            type="button"
            onClick={() => playback.toggle()}
            className="sr-only"
          >
            {playback.playing ? "Pause trailer" : "Play trailer"}
          </button>
        ) : null}

        {/* Copy, docked bottom-left inside the card's own gutter.
         *
         * `pb-24` used to clear the bottom control strip. That strip is gone,
         * so the padding drops to the arrow height and the actions sit closer
         * to the edge of the frame. */}
        <div className="absolute inset-x-0 bottom-0 z-10 px-6 pb-12 sm:px-10 sm:pb-14 lg:px-14 lg:pb-16">
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
                      className="max-h-20 w-auto max-w-full object-contain object-left drop-shadow-[0_4px_20px_rgba(0,0,0,0.7)] sm:max-h-24"
                    />
                  ) : (
                    /* Six lines of 60px display type was the largest object on the
                       page by a wide margin, and it pushed the synopsis below the
                       fold on a 700px card. Capped two steps down: the title now
                       reads as a label on the artwork instead of competing with
                       it. */
                    <h1 className="text-3xl font-black leading-[1] tracking-tight text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.8)] sm:text-4xl lg:text-5xl">
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
                      clamped lines at 375px is a paragraph of fragments. Three
                      lines at sm and up, where the card has the width to hold
                      them. */}
                  {current.synopsis ? (
                    <p className="hidden max-w-lg text-sm leading-relaxed text-neutral-300 sm:line-clamp-3 sm:block">
                      {current.synopsis}
                    </p>
                  ) : null}

                  {/* Exactly three actions. My List was demoted out of the hero:
                      it is a second-tier intent, and it used to sit between Play
                      and Share at the same weight, which made the row read as
                      three peers rather than one primary action and two
                      affordances. It is still one tap away inside More Info.

                      A title that has not come out yet has no play: the white
                      pill becomes the artboard's notify button and the countdown
                      sits above it, where Play's click-to-trailer surface still
                      works because a teaser is usually already online. */}
                  <div className="space-y-3 pt-1">
                    {upcoming && countdownLabel ? (
                      <div className="text-xs font-medium uppercase tracking-[0.2em] text-[#aab3c7]">
                        {countdownLabel}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
                      {upcoming ? (
                        <RemindMeButton movie={current} />
                      ) : (
                        <button
                          type="button"
                          onClick={() => handlePlay(current)}
                          className={
                            "inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-8 " +
                            "text-sm font-bold text-black transition " +
                            "hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 " +
                            "focus-visible:outline-offset-2 focus-visible:outline-white"
                          }
                        >
                          <Play className="h-4 w-4 fill-current" aria-hidden />
                          Play
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onMoreInfo?.(current)}
                        className={
                          "inline-flex min-h-11 items-center gap-2 rounded-xl px-5 " +
                          "text-sm font-semibold text-white backdrop-blur-md transition " +
                          "border border-white/15 bg-white/10 hover:bg-white/20 " +
                          "focus-visible:outline focus-visible:outline-2 " +
                          "focus-visible:outline-offset-2 focus-visible:outline-white/70"
                        }
                      >
                        <Info className="h-4 w-4" aria-hidden />
                        More Info
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleShare(current)}
                        aria-label={`Share ${current.title}`}
                        className={
                          "grid h-11 w-11 shrink-0 place-items-center rounded-full text-white " +
                          "backdrop-blur-md transition border border-white/15 bg-white/10 hover:bg-white/20 " +
                          "focus-visible:outline focus-visible:outline-2 " +
                          "focus-visible:outline-offset-2 focus-visible:outline-white/70"
                        }
                      >
                        <Link2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        {/* Arrows, pinned to the vertical middle of each edge.
         *
         * This replaces a bottom strip that carried a `1/5` counter, a
         * progress-adjacent pause button and a row of dots. All four are gone:
         * the counter duplicates what the top progress bar already says, the
         * pause button was the only way to stop a rotation that also stops
         * whenever the pointer enters the card, and the dots were a
         * second, redundant answer to "which slide is this". A carousel
         * indicator that duplicates the artwork underneath it is noise.
         *
         * Vertically centred rather than bottom-aligned so they do not fight
         * the action row for the same corner, and `opacity-0` until hover so
         * the frame stays clean when nobody is driving it. They stay solid on
         * coarse pointers, which never hover. */}
        {count > 1 ? (
          <>
            <button
              type="button"
              aria-label="Previous featured title"
              onClick={() => step(-1)}
              className={
                "group absolute left-2 top-1/2 z-20 grid h-12 w-12 -translate-y-1/2 " +
                "place-items-center rounded-full border border-white/15 text-white " +
                "transition bg-[rgba(7,9,15,0.35)] backdrop-blur-md hover:bg-[rgba(7,9,15,0.6)] " +
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
                "focus-visible:outline-white/80 " +
                "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 " +
                "max-[1023px]:opacity-100 sm:left-4"
              }
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>

            <button
              type="button"
              aria-label="Next featured title"
              onClick={() => step(1)}
              className={
                "group absolute right-2 top-1/2 z-20 grid h-12 w-12 -translate-y-1/2 " +
                "place-items-center rounded-full border border-white/15 text-white " +
                "transition bg-[rgba(7,9,15,0.35)] backdrop-blur-md hover:bg-[rgba(7,9,15,0.6)] " +
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
                "focus-visible:outline-white/80 " +
                "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 " +
                "max-[1023px]:opacity-100 sm:right-4"
              }
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          </>
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
