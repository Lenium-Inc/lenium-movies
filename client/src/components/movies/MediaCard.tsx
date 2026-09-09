import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Star } from "lucide-react";
import type { TrailerInfo } from "@/services/api";

interface MediaCardProps {
  id: string;
  title: string;
  posterUrl?: string | null;
  /** Muted looping native clip cross-faded over the poster after 300ms. */
  previewUrl?: string | null;
  /** High-res backdrop used when neither a trailer nor a clip is available. */
  backdropUrl?: string | null;
  /**
   * Lazy trailer lookup for the hover preview. Only invoked once per card —
   * when it resolves, the official trailer embeds in the poster frame (a
   * preview, never the film itself). Resolve to null to keep the backdrop.
   */
  trailerResolver?: () => Promise<TrailerInfo | null>;
  year?: number | null;
  runtime?: string | null;
  genres?: readonly string[] | string | null;
  rating?: string | number | null;
  onPlay?: (id: string) => void;
}

function chip(title: string): string {
  return title.trim().length > 3
    ? title
        .split(/\s+/)
        .slice(0, 2)
        .map(word => word[0])
        .join("")
    : title.slice(0, 1);
}

function genresText(genres: readonly string[] | string | null | undefined) {
  if (!genres) return null;
  return Array.isArray(genres) ? genres.join(" · ") : genres;
}

/** Cover-cropped 16:9 trailer embed pinned inside the 2:3 poster frame. */
export function TrailerEmbed({ provider, id, onLoad }: TrailerInfo & { onLoad?: () => void }) {
  const src =
    provider === "dailymotion"
      ? `https://www.dailymotion.com/embed/video/${id}?autoplay=1&muted=1&loop=1&controls=0`
      : `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${id}&playsinline=1&iv_load_policy=3&modestbranding=1&rel=0`;
  return (
    <div className="pointer-events-auto absolute left-1/2 top-1/2 aspect-video w-[266%] -translate-x-1/2 -translate-y-1/2">
      <iframe
        src={src}
        title="Preview trailer"
        allow="autoplay; encrypted-media"
        tabIndex={-1}
        aria-hidden
        className="h-full w-full"
        onLoad={onLoad}
      />
    </div>
  );
}

/**
 * High-end media card for a streaming grid. Fixed 2:3 ratio, `rounded-xl`,
 * 1px `border-white/10` on a `#121212` charcoal surface.
 *
 * Hover interactions are INSTANT (no 300ms delay): the static poster cross-
 * fades into the title's official looping trailer — a preview, never the film itself.
 * Trailers are PRE-LOADED in background when card enters viewport for instant playback.
 * When no trailer exists the card falls back to a muted native clip, then a high-res backdrop
 * at a subtle `scale(1.05)`, then a quiet zoom on the poster.
 *
 * Image Persistence: The poster remains visible until the trailer/hover video
 * has buffered enough data to begin playback, preventing black/blank flashes.
 * Video Centering: The embedded hover trailer player is absolutely positioned
 * and perfectly centered within the card container.
 */
export function MediaCard({
  id,
  title,
  posterUrl,
  previewUrl,
  backdropUrl,
  trailerResolver,
  year,
  runtime,
  genres,
  rating,
  onPlay,
}: MediaCardProps) {
  const [peeked, setPeeked] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [trailer, setTrailer] = useState<TrailerInfo | null>(null);
  const [trailerReady, setTrailerReady] = useState(false);
  const [trailerPreloaded, setTrailerPreloaded] = useState(false);
  const [isInViewport, setIsInViewport] = useState(false);
  
  const timer = useRef<number | null>(null);
  const trailerRequested = useRef(false);
  const trailerPreloadTriggered = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Reset state when key props change
  useEffect(() => {
    setPeeked(false);
    setVideoFailed(false);
    setPosterFailed(false);
    setTrailer(null);
    setTrailerReady(false);
    setTrailerPreloaded(false);
    trailerRequested.current = false;
    trailerPreloadTriggered.current = false;
  }, [posterUrl, previewUrl, backdropUrl, trailerResolver, id]);

  // Intersection Observer for viewport detection - trigger preload when card is near viewport
  useEffect(() => {
    const cardElement = document.getElementById(`media-card-${id}`);
    if (!cardElement) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting || entry.intersectionRatio > 0.1) {
            setIsInViewport(true);
          } else {
            setIsInViewport(false);
          }
        });
      },
      { rootMargin: '200px', threshold: 0.1 }
    );

    observer.observe(cardElement);
    return () => observer.disconnect();
  }, [id]);

  // Preload trailer when card enters viewport (background, non-blocking)
  useEffect(() => {
    if (!isInViewport || trailerPreloadTriggered.current || !trailerResolver || trailer) return;
    
    trailerPreloadTriggered.current = true;
    let alive = true;
    
    // Preload in background - don't await, just fire and forget
    trailerResolver()
      .then(info => {
        if (alive && info) {
          setTrailer(info);
          setTrailerPreloaded(true);
        }
      })
      .catch(() => {
        // Silently fail - keep poster/backdrop fallback
      });
    
    return () => {
      alive = false;
    };
  }, [isInViewport, trailerResolver, trailer, id]);

  // When user hovers, ensure trailer is loaded and ready
  useEffect(() => {
    if (!peeked || trailerRequested.current) return;
    trailerRequested.current = true;
    
    // If already preloaded, just mark as ready
    if (trailerPreloaded && trailer) {
      setTrailerReady(true);
      return;
    }
    
    // Otherwise fetch now (should be fast if preloaded)
    let alive = true;
    trailerResolver?.()
      .then(info => {
        if (alive) {
          setTrailer(info);
          setTrailerPreloaded(true);
        }
      })
      .catch(() => {
        // Keep poster/backdrop fallback
      });
    
    return () => {
      alive = false;
    };
  }, [peeked, trailerResolver, trailer, trailerPreloaded]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  // INSTANT hover - no 300ms delay for modern feel
  const handleEnter = useCallback(() => {
    if (timer.current !== null) return;
    // Near-instant response (50ms for perceived instant feel)
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setPeeked(true);
      setTrailerReady(trailerPreloaded); // Instant if preloaded
    }, 50);
  }, [trailerPreloaded]);

  const handleLeave = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setPeeked(false);
    setVideoFailed(false);
    setTrailerReady(false);
  }, []);

  const handleTrailerLoad = useCallback(() => {
    setTrailerReady(true);
  }, []);

  const showSkeleton = !posterUrl || posterFailed;
  const showTrailer = peeked && trailer && trailerReady;
  const showVideo = peeked && !showTrailer && previewUrl && !videoFailed;
  const showBackdrop = peeked && !showTrailer && !showVideo && backdropUrl;
  const genreLine = genresText(genres);

  return (
    <article
      id={`media-card-${id}`}
      className="group relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        type="button"
        onClick={() => onPlay?.(id)}
        aria-label={`Play ${title}`}
        className="relative block w-full overflow-hidden rounded-xl border border-white/10 bg-[#121212] text-left shadow-[0_6px_18px_rgba(0,0,0,0.5)] transition-[transform,box-shadow,border-color] duration-300 ease-out hover:-translate-y-1.5 hover:scale-[1.02] hover:border-white/25 hover:shadow-[0_22px_48px_rgba(0,0,0,0.7),0_0_0_1px_rgba(255,255,255,0.12)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <div className="relative aspect-[2/3] w-full overflow-hidden">
          {/* Base layer: poster (or typographic skeleton fallback) */}
          {showSkeleton ? (
            <div className="skeleton-sheen relative flex h-full w-full place-items-center bg-[linear-gradient(150deg,#1B1B20_0%,#121212_55%,#0B0B0E_100%)]">
              <span
                aria-hidden
                className="font-display text-4xl font-black text-[#FFFFFF]/85 drop-shadow-[0_2px_14px_rgba(0,0,0,0.8)]"
              >
                {chip(title)}
              </span>
            </div>
          ) : (
            <img
              loading="lazy"
              decoding="async"
              src={posterUrl}
              alt={title}
              onError={() => setPosterFailed(true)}
              className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-200 group-hover:scale-[1.05] ${
                showTrailer ? "opacity-0" : "opacity-100"
              }`}
            />
          )}

          {/* Preview layer: official trailer → muted native clip → backdrop */}
          {showTrailer && trailer ? (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <TrailerEmbed provider={trailer.provider} id={trailer.id} onLoad={handleTrailerLoad} ref={iframeRef} />
            </div>
          ) : null}
          {showVideo && (
            <video
              key={previewUrl}
              src={previewUrl}
              autoPlay
              muted
              loop
              playsInline
              disablePictureInPicture
              preload="auto"
              onError={() => setVideoFailed(true)}
              className="absolute inset-0 h-full w-full scale-[1.02] object-cover object-center transition-opacity duration-200"
            />
          )}
          {showBackdrop && (
            <img
              src={backdropUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full scale-[1.05] object-cover object-center opacity-100 transition-opacity duration-200"
            />
          )}

          {/* Bottom scrim */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-80 transition-opacity duration-200 group-hover:opacity-100" />

          {/* Hover inner glow (monochrome) */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,rgba(255,255,255,0.12),transparent_55%)] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />

          {/* TMDB rating tag */}
          {!showSkeleton && rating !== null && rating !== undefined && (
            <span className="absolute left-2.5 top-2.5 flex translate-y-1 items-center gap-1 rounded-md border border-white/10 bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white opacity-0 backdrop-blur-sm transition duration-150 group-hover:translate-y-0 group-hover:opacity-100">
              <Star className="h-3 w-3 fill-white" />
              {typeof rating === "number" ? rating.toFixed(1) : rating}
            </span>
          )}

          {/* Quick-action play button */}
          <div className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <span className="grid h-12 w-12 scale-75 place-items-center rounded-full bg-white text-black shadow-[0_10px_28px_rgba(255,255,255,0.18)] ring-1 ring-white/40 transition-transform duration-200 group-hover:scale-100">
              <Play className="h-5 w-5 fill-current" />
            </span>
          </div>
        </div>
      </button>

      {/* Metadata: title + consistent badge rail */}
      <div className="mt-2.5 px-0.5">
        <h3 className="line-clamp-1 text-xs font-semibold text-[#FFFFFF]">
          {title}
        </h3>
        <div className="mt-1.5 flex min-h-[22px] flex-wrap items-center gap-1">
          {year ? (
            <span className="rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-semibold text-[#E5E5EA]">
              {year}
            </span>
          ) : null}
          {runtime ? (
            <span className="rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-semibold text-[#E5E5EA]">
              {runtime}
            </span>
          ) : null}
          {genreLine ? (
            <span className="line-clamp-1 rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-semibold text-[#8E8E93]">
              {genreLine}
            </span>
          ) : null}
          {!year && !runtime && !genreLine ? (
            <span className="text-[10px] text-[#8E8E93]/70">
              Metadata pending
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}