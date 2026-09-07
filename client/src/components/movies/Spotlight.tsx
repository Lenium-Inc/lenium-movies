import { useEffect, useState } from "react";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Star,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { Movie } from "./types";

interface SpotlightProps {
  /** Rotation pool. Filter changes that alter this list are picked up instantly. */
  items: readonly Movie[];
  savedIds?: ReadonlyArray<Movie["id"]>;
  onDetails?: (movie: Movie) => void;
  onSave?: (movie: Movie) => void;
  /** Seconds per auto-rotation; 0 disables rotation. Defaults to 8. */
  rotateSeconds?: number;
}

const EASE = [0.32, 0.72, 0, 1] as const;

function chip(primary: boolean): string {
  return [
    "rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-sm transition",
    primary
      ? "border-white/30 bg-white/10 text-white"
      : "border-white/10 text-[#D6D6DA]",
  ].join(" ");
}

const ActionButton = ({
  icon: Icon,
  label,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  className: string;
  onClick?: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${className}`}
  >
    <Icon className="h-4 w-4" />
    {label}
  </button>
);

/**
 * Dynamic featured "Movie-of-the-Day" / Spotlight. Renders the full-bleed hero
 * media (Ken Burns backdrop dissolved into void black `#050505`), the title
 * block, metadata chips, and the high-contrast monochrome Details / My List
 * CTA cluster.
 *
 * The spotlight is filter-responsive and self-rotating: when the surrounding
 * filter engine changes the item pool — or an item is clicked / the rotation
 * advances — `AnimatePresence` cross-fades the backdrop, typography, tags and
 * synopsis in real time. The frosted-glass navigation lives outside this
 * component (GlassHeader) so it never re-renders between state switches.
 */
export function Spotlight({
  items,
  savedIds = [],
  onDetails,
  onSave,
  rotateSeconds = 8,
}: SpotlightProps) {
  const count = items.length;
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  // Keep the index valid whenever the pool shrinks (e.g. a filter narrows it).
  useEffect(() => {
    if (count === 0) return;
    if (index >= count) setIndex(0);
  }, [count, index]);

  // Auto-rotate with crossfade, paused while the pointer is inside the hero.
  useEffect(() => {
    if (count < 2 || paused || rotateSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setIndex(i => (i + 1) % count);
    }, rotateSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [count, paused, rotateSeconds]);

  const current: Movie | undefined = count > 0 ? items[index] : undefined;
  const saved = current ? savedIds.includes(current.id) : false;

  const backdrop =
    current?.backdrop?.replace("/w780/", "/w1280/") ?? current?.backdrop;

  return (
    <section
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="Featured spotlight"
      className="relative isolate -mx-4 h-[560px] w-[calc(100%+2rem)] overflow-hidden bg-[#050505] sm:-mx-6 sm:w-[calc(100%+3rem)] sm:h-[600px] lg:-mx-8 lg:w-[calc(100%+4rem)] lg:h-[660px]"
    >
      {/* Cross-fading media layer */}
      <div className="absolute inset-0">
        <AnimatePresence initial={false}>
          {current ? (
            <motion.div
              key={current.id}
              className="absolute inset-0"
              initial={{ opacity: 0, scale: 1.06 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              transition={{ duration: 0.7, ease: EASE }}
            >
              {backdrop ? (
                <img
                  src={backdrop}
                  alt=""
                  loading="eager"
                  fetchPriority="high"
                  className="spotlight-kenburns h-full w-full object-cover object-[center_22%]"
                />
              ) : (
                <div className="h-full w-full bg-[linear-gradient(160deg,#1B1B20_0%,#0A0A0A_55%,#050505_100%)]" />
              )}
            </motion.div>
          ) : (
            <div className="absolute inset-0 bg-[linear-gradient(160deg,#1B1B20_0%,#0A0A0A_55%,#050505_100%)]" />
          )}
        </AnimatePresence>
      </div>

      {/* Gradient architecture into void black — constant across state switches */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_130%_110%_at_62%_-12%,transparent_0%,rgba(5,5,5,0.30)_40%,#050505_80%)]"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-[linear-gradient(90deg,#050505_0%,rgba(5,5,5,0.80)_44%,rgba(5,5,5,0.20)_72%,transparent_100%)]"
      />
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-44 bg-[linear-gradient(180deg,transparent_0%,#050505_92%)]"
      />

      {/* Cross-fading content block */}
      <div className="absolute inset-0 z-10 flex items-end px-5 pb-14 sm:px-8 lg:px-14">
        <div className="max-w-2xl">
          {current ? (
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={current.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.45, ease: EASE }}
              >
                <p className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.3em] text-white/60">
                  <span className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.9)]" />
                  FreeStream · Now streaming
                </p>

                <h1 className="mt-4 text-4xl font-black leading-[0.95] tracking-[-0.03em] text-[#FFFFFF] drop-shadow-[0_2px_20px_rgba(0,0,0,0.7)] sm:text-5xl lg:text-6xl">
                  {current.title}
                </h1>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {current.year ? (
                    <span className={chip(true)}>{current.year}</span>
                  ) : null}
                  {current.runtime ? (
                    <>
                      <span className="text-[10px] text-white/40">·</span>
                      <span className={chip(false)}>{current.runtime}</span>
                    </>
                  ) : null}
                  {current.genre.slice(0, 3).map((genre, index) => (
                    <span
                      key={genre}
                      className="flex items-center gap-2"
                    >
                      {index > 0 && (
                        <span className="text-[10px] text-white/40">·</span>
                      )}
                      <span className={chip(false)}>{genre}</span>
                    </span>
                  ))}
                  {current.score !== null && (
                    <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.08] px-2.5 py-1 text-xs font-bold text-white backdrop-blur-sm">
                      <Star className="h-3 w-3 fill-white" />
                      {current.score}
                      <span className="text-white/50">TMDB</span>
                    </span>
                  )}
                </div>

                {current.synopsis ? (
                  <p className="mt-4 line-clamp-3 max-w-xl text-sm leading-6 text-[#D6D6DA]">
                    {current.synopsis}
                  </p>
                ) : null}

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <ActionButton
                    icon={CirclePlay}
                    label="Watch"
                    onClick={() => onDetails?.(current)}
                    className="bg-white font-black text-black ring-1 ring-inset ring-white/40 shadow-[0_12px_32px_rgba(0,0,0,0.5)] hover:bg-white/90 active:scale-[0.98]"
                  />
                  <ActionButton
                    icon={saved ? Check : Bookmark}
                    label={saved ? "In My List" : "My List"}
                    onClick={() => onSave?.(current)}
                    className="border border-white/15 bg-white/[0.07] font-semibold text-white backdrop-blur-md hover:border-white/30 hover:bg-white/[0.14] active:scale-[0.98]"
                  />
                </div>
              </motion.div>
            </AnimatePresence>
          ) : null}
        </div>
      </div>

      {/* Rotation controls */}
      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous featured title"
            onClick={() => setIndex(i => (i - 1 + count) % count)}
            className="absolute bottom-5 right-20 z-10 grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-black/40 text-white/70 backdrop-blur-md transition hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-95"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next featured title"
            onClick={() => setIndex(i => (i + 1) % count)}
            className="absolute bottom-5 right-12 z-10 grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-black/40 text-white/70 backdrop-blur-md transition hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-95"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      )}
      {/* Rotation indicators */}
      {count > 1 && (
        <div className="absolute bottom-5 right-5 z-10 flex items-center gap-1.5">
          {Array.from({ length: Math.min(count, 8) }, (_, dot) => {
            const active =
              count > 8 ? index % 8 === dot : index === dot;
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
                    ? "w-6 bg-white"
                    : "w-1.5 bg-white/30 hover:bg-white/60"
                }`}
              />
            );
          })}
        </div>
      )}

      {/* Per-slide rotation progress, ticking down until the next crossfade */}
      {count > 1 && rotateSeconds > 0 && (
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 z-10 h-[3px] bg-white/10"
        >
          <div
            key={index}
            className="fs-progress h-full bg-white"
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