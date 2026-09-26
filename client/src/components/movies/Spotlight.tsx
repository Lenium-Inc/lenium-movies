import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Play,
  Star,
  Clock,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { fetchTrailerByTmdbId, type TrailerInfo } from "@/services/api";
import type { Movie } from "./types";
import { formatRuntime } from "@/lib/format";
import { glowBackground, glowPalette } from "@/lib/glow";

const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

interface SpotlightProps {
  items: readonly Movie[];
  savedIds?: ReadonlyArray<Movie["id"]>;
  onSave?: (movie: Movie) => void;
  rotateSeconds?: number;
  /** Called whenever the active featured title changes (for page-level ambient). */
  onActiveChange?: (movie: Movie) => void;
}

const EASE = [0.32, 0.72, 0, 1] as const;

function getBackdropUrl(backdrop: string | null | undefined): string | null {
  if (!backdrop) return null;
  if (backdrop.startsWith("http")) return backdrop;
  return `${TMDB_IMAGE_BASE_URL}/original${backdrop}`;
}

function embedUrl(trailer: TrailerInfo, muted: boolean): string {
  const base =
    trailer.provider === "dailymotion"
      ? `https://www.dailymotion.com/embed/video/${trailer.id}?autoplay=1&loop=1&controls=0&muted=${muted ? 1 : 0}`
      : `https://www.youtube-nocookie.com/embed/${trailer.id}?autoplay=1&controls=0&loop=1&playlist=${trailer.id}&playsinline=1&iv_load_policy=3&modestbranding=1&rel=0${muted ? "&mute=1" : ""}`;
  return base;
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
    className={`inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-sm font-semibold transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
  >
    <Icon className="h-5 w-5 fill-current" />
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
    className={`inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-sm font-semibold transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
  >
    <Icon className="h-5 w-5" />
    {label}
  </button>
);

/**
 * Dynamic featured "Movie-of-the-Day" / Spotlight. Full-bleed hero with the
 * active title's official trailer auto-playing (muted by default, toggled via
 * the volume control), dissolvable into the void-black `#050505` gradient
 * architecture when no trailer exists.
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
  const [muted, setMuted] = useState(true);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const trailerCache = useRef(new Map<string, TrailerInfo | null>());
  const loaderSeq = useRef(0);

  useEffect(() => {
    if (count === 0) return;
    if (index >= count) setIndex(0);
  }, [count, index]);

  useEffect(() => {
    if (count < 2 || paused || rotateSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setIndex((i) => (i + 1) % count);
    }, rotateSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [count, paused, rotateSeconds]);

  const current: Movie | undefined = count > 0 ? items[index] : undefined;
  const saved = current ? savedIds.includes(current.id) : false;

  const backdropUrl = getBackdropUrl(current?.backdrop);

  // Fetch the active title's trailer once (cached per title).
  useEffect(() => {
    if (!current?.providerId) {
      setTrailer(null);
      return;
    }
    const key = String(current.providerId);
    const cached = trailerCache.current.get(key);
    if (cached !== undefined) {
      setTrailer(cached);
      return;
    }
    const seq = ++loaderSeq.current;
    setTrailer(null);
    fetchTrailerByTmdbId(key)
      .then((info) => {
        if (seq !== loaderSeq.current) return;
        trailerCache.current.set(key, info ?? null);
        setTrailer(info);
      })
      .catch(() => {
        if (seq !== loaderSeq.current) return;
        trailerCache.current.set(key, null);
        setTrailer(null);
      });
  }, [current?.providerId]);

  // Report the active title so the page can drive its ambient glow.
  useEffect(() => {
    if (current) onActiveChange?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const handlePlay = (movie: Movie) => {
    if (!movie.providerId) {
      console.warn("[Spotlight] No providerId for movie:", movie.title);
      return;
    }
    const tmdbId = parseInt(movie.providerId, 10);
    if (isNaN(tmdbId)) {
      console.warn("[Spotlight] Invalid TMDB ID:", movie.providerId);
      return;
    }
    navigate(`/watch/${tmdbId}`);
  };

  return (
    <section
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="Featured spotlight"
      // Sits inside the framed featured card on Home, so it fills its parent
      // rather than breaking out with negative margins. The page owns the
      // rounded corners and the border.
      className="relative isolate h-[560px] w-full overflow-hidden bg-[#050505] sm:h-[600px] lg:h-[660px]"
    >
      {/* Cross-fading media layer — trailer when available, backdrop otherwise */}
      <div className="absolute inset-0">
        <AnimatePresence initial={false}>
          {current ? (
            <motion.div
              key={current.id}
              className="absolute inset-0"
              style={{ filter: "brightness(1.08) saturate(1.06)" }}
              initial={{ opacity: 0, scale: 1.06 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.02 }}
              transition={{ duration: 0.7, ease: EASE }}
            >
              {trailer ? (
                <div className="absolute inset-0 overflow-hidden">
                  <iframe
                    key={`${trailer.id}-${muted ? "m" : "u"}`}
                    src={embedUrl(trailer, muted)}
                    title={`${current.title} trailer`}
                    allow="autoplay"
                    sandbox="allow-scripts allow-same-origin allow-forms"
                    referrerPolicy="no-referrer"
                    tabIndex={-1}
                    aria-hidden
                    className="absolute left-1/2 top-1/2 min-h-full min-w-full -translate-x-1/2 -translate-y-1/2"
                    style={{ aspectRatio: "16 / 9", width: "max(100%, 177.78vh)" }}
                  />
                </div>
              ) : backdropUrl ? (
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

      {/* Genre-driven aura. This lives inside the hero rather than behind it:
          the hero paints its own opaque #050505, so an aura rendered outside
          this subtree is covered and never seen. */}
      <AnimatePresence initial={false}>
        {current ? (
          <motion.div
            key={`aura-${current.id}`}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-24 h-[130%] opacity-90 blur-3xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.9 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9, ease: EASE }}
            style={{
              background: glowBackground(glowPalette(current.genres, current.id)),
            }}
          />
        ) : null}
      </AnimatePresence>

      {/* Warm ambient wash behind the sticky header. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/[0.07] to-transparent"
      />
      {/* Localised left vignette — darkens only where the copy is docked
          instead of dimming the whole frame. */}
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-[62%] bg-gradient-to-r from-zinc-950/95 via-zinc-950/55 to-transparent"
      />
      {/* Short bottom fade blending into the catalogue below. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent"
      />

      {/* Cross-fading content block - left-aligned and docked toward the bottom */}
      <div className="absolute inset-0 z-10 flex items-end justify-start px-5 pb-20 sm:px-8 lg:px-16">
        <div className="w-full max-w-3xl text-left">
          {current ? (
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={current.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.5, ease: EASE }}
              >
                {/* Title */}
                <h1 className="text-5xl font-black leading-[0.95] tracking-[-0.03em] text-[#FFFFFF] drop-shadow-[0_4px_24px_rgba(0,0,0,0.8)] md:text-7xl">
                  {current.title}
                </h1>

                {/* Consolidated Inline Metadata Row */}
                <div className="mt-4 flex flex-wrap items-center justify-start gap-2.5">
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
                      </span>
                    </>
                  )}
                  {current.genres?.length && (
                    <>
                      <span className="text-[10px] text-white/40">·</span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-300 backdrop-blur-sm">
                        {current.genres.slice(0, 3).join(", ")}
                      </span>
                    </>
                  )}
                </div>

                {/* Plot Overview / Synopsis */}
                {current.synopsis ? (
                  <p className="mt-4 line-clamp-3 max-w-2xl text-base leading-7 text-zinc-300 text-left">
                    {current.synopsis}
                  </p>
                ) : null}

                {/* Action Buttons - Only Play and My List */}
                <div className="mt-8 flex flex-wrap items-center justify-start gap-4">
                  <PrimaryActionButton
                    icon={Play}
                    label="Play"
                    onClick={() => handlePlay(current)}
                    className="bg-violet-600 font-black text-white ring-1 ring-inset ring-violet-400/40 shadow-[0_16px_40px_rgba(124,58,237,0.35)] hover:bg-violet-500 hover:shadow-[0_20px_48px_rgba(124,58,237,0.45)] active:scale-[0.97] active:bg-violet-700"
                  />
                  <SecondaryActionButton
                    icon={saved ? Check : Bookmark}
                    label={saved ? "In My List" : "My List"}
                    onClick={() => {
                    toast.success(
                      saved ? "Removed from your list" : "Added to your list!"
                    );
                    onSave?.(current);
                  }}
                    className="border-2 border-white/20 bg-black/30 text-white backdrop-blur-md hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-[0.97] active:border-white/50"
                  />
                </div>
              </motion.div>
            </AnimatePresence>
          ) : null}
        </div>
      </div>

      {/* Trailer mute toggle (bottom-right control cluster) */}
      {current && trailer && (
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute trailer" : "Mute trailer"}
          className="absolute bottom-5 right-36 z-10 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/40 text-white/80 backdrop-blur-md transition hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-95"
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      )}

      {/* Rotation controls */}
      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous featured title"
            onClick={() => setIndex((i) => (i - 1 + count) % count)}
            className="absolute bottom-5 right-20 z-10 grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-black/40 text-white/70 backdrop-blur-md transition hover:border-white/40 hover:bg-white/10 hover:text-white active:scale-95"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next featured title"
            onClick={() => setIndex((i) => (i + 1) % count)}
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
            const active = count > 8 ? index % 8 === dot : index === dot;
            return (
              <button
                key={dot}
                type="button"
                aria-label={`Show slide ${dot + 1}`}
                onClick={() =>
                  setIndex((current) =>
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

      {/* Per-slide rotation progress */}
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