import { useEffect, useState } from "react";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Play,
  Star,
  Users,
  Clock,
  Award,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { Movie } from "./types";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

interface SpotlightProps {
  /** Rotation pool. Filter changes that alter this list are picked up instantly. */
  items: readonly Movie[];
  savedIds?: ReadonlyArray<Movie["id"]>;
  onDetails?: (movie: Movie) => void;
  onPlay?: (movie: Movie) => void;
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

function getBackdropUrl(backdrop: string | null | undefined): string | null {
  if (!backdrop) return null;
  if (backdrop.startsWith("http")) return backdrop;
  return `${TMDB_IMAGE_BASE_URL}/original${backdrop}`;
}

function formatRuntime(minutes: string | number | undefined): string {
  if (!minutes) return "";
  const mins = typeof minutes === "string" ? parseInt(minutes.replace("m", "")) : minutes;
  if (isNaN(mins)) return "";
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return hours > 0 ? `${hours}h ${remainingMins}m` : `${remainingMins}m`;
}

function formatRating(score: number | null): string {
  if (score === null || score === undefined) return "";
  return score.toFixed(1);
}

const PrimaryActionButton = ({
  icon: Icon,
  label,
  className,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  className: string;
  onClick?: () => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-sm font-semibold transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
  >
    <Icon className="h-5 w-5" />
    {label}
  </button>
);

const SecondaryActionButton = ({
  icon: Icon,
  label,
  className,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  className: string;
  onClick?: () => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-sm font-semibold transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
  >
    <Icon className="h-5 w-5" />
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
  onPlay,
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

  const backdropUrl = getBackdropUrl(current?.backdrop);

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
              {backdropUrl ? (
                <img
                  src={backdropUrl}
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
        className="absolute inset-x-0 bottom-0 h-48 bg-[linear-gradient(180deg,transparent_0%,#050505_92%)]"
      />

      {/* Cross-fading content block - positioned higher for better visibility */}
      <div className="absolute inset-0 z-10 flex items-center px-5 pb-16 sm:px-8 lg:px-14">
        <div className="max-w-2xl w-full">
          {current ? (
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={current.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.5, ease: EASE }}
              >
                <p className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.3em] text-white/70 mb-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.9)]" />
                  FreeStream · Now streaming
                </p>

                <h1 className="mt-2 text-4xl font-black leading-[0.95] tracking-[-0.03em] text-[#FFFFFF] drop-shadow-[0_4px_24px_rgba(0,0,0,0.8)] sm:text-5xl lg:text-6xl xl:text-7xl">
                  {current.title}
                </h1>

                {/* Inline Metadata Row - Netflix Grade */}
                <div className="mt-4 flex flex-wrap items-center gap-2.5">
                  {current.year ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                      {current.year}
                    </span>
                  ) : null}
                  {current.runtime && (
                    <>
                      <span className="text-[10px] text-white/40">·</span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300 backdrop-blur-sm">
                        <Clock className="h-3 w-3" />
                        {formatRuntime(current.runtime)}
                      </span>
                    </>
                  )}
                  {current.vote_average && current.vote_average > 0 && (
                    <>
                      <span className="text-[10px] text-white/40">·</span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-bold text-amber-400 backdrop-blur-sm">
                        <Star className="h-3 w-3 fill-current" />
                        {formatRating(current.vote_average)}
                        <span className="text-white/50">TMDB</span>
                      </span>
                    </>
                  )}
                  {current.genres?.length && (
                    <>
                      <span className="text-[10px] text-white/40">·</span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300 backdrop-blur-sm">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase">Genres:</span>
                        <span className="font-medium text-zinc-300">{current.genres.slice(0, 4).join(", ")}</span>
                      </span>
                    </>
                  )}
                </div>

                {/* Plot Overview / Synopsis */}
                {current.synopsis ? (
                  <p className="mt-4 line-clamp-3 max-w-2xl text-base leading-7 text-zinc-300">
                    {current.synopsis}
                  </p>
                ) : null}

                {/* Expanded metadata row - rating, runtime, genres */}
                <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-zinc-400">
                  {current.vote_average && current.vote_average > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 backdrop-blur-sm border border-white/10">
                      <Award className="h-4 w-4 text-amber-400" />
                      <span className="font-semibold text-white">{current.vote_average.toFixed(1)}</span>
                      <span className="text-zinc-500">/10</span>
                    </span>
                  )}
                  {current.runtime && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 backdrop-blur-sm border border-white/10">
                      <Clock className="h-4 w-4" />
                      <span className="font-medium text-zinc-300">{formatRuntime(current.runtime)}</span>
                    </span>
                  )}
                  {current.genres?.length && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 backdrop-blur-sm border border-white/10">
                      <span className="text-[10px] font-medium text-zinc-500 uppercase">Genres:</span>
                      <span className="font-medium text-zinc-300">{current.genres.slice(0, 5).join(", ")}</span>
                    </span>
                  )}
                </div>

                {/* Cast/Director info if available */}
                {(current as any).director && (
                  <div className="mt-4 flex items-center gap-2 text-sm text-zinc-400">
                    <Users className="h-4 w-4" />
                    <span className="text-zinc-500">Director:</span>
                    <span className="font-medium text-zinc-300">{(current as any).director}</span>
                  </div>
                )}

                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <PrimaryActionButton
                    icon={Play}
                    label="Play"
                    onClick={() => onPlay?.(current)}
                    className="bg-white font-black text-black ring-1 ring-inset ring-white/40 shadow-[0_16px_40px_rgba(0,0,0,0.6)] hover:bg-white/95 hover:shadow-[0_20px_48px_rgba(0,0,0,0.7)] active:scale-[0.97] active:shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                  />
                  <SecondaryActionButton
                    icon={saved ? Check : Bookmark}
                    label={saved ? "In My List" : "My List"}
                    onClick={() => onSave?.(current)}
                    className="border-2 border-white/20 bg-black/30 text-white backdrop-blur-md hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-[0.97] active:border-white/50"
                  />
                  {onDetails && (
                    <SecondaryActionButton
                      icon={CirclePlay}
                      label="More Info"
                      onClick={() => onDetails?.(current)}
                      className="border-2 border-white/20 bg-black/30 text-white backdrop-blur-md hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-[0.97] active:border-white/50"
                    />
                  )}
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