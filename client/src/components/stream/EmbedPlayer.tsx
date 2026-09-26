import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Loader2, RotateCw } from "lucide-react";
import { resolveEmbedSources, type ResolvedEmbedSource } from "@/lib/embedSources";
import { cn } from "@/lib/utils";
import {
  optimizingStream,
  titleUnavailable,
  tryAgain,
} from "@/lib/playbackCopy";

/**
 * Cross-origin iframes never fire `onError` for a dead or blocked provider, so
 * "did it load?" is inferred: if `onLoad` has not landed within this window we
 * treat the server as failed and move on.
 */
const LOAD_TIMEOUT_MS = 12_000;

/**
 * Grace period after `onLoad` before inspecting the frame, so a player that
 * mounts its nested frame slightly after the initial document load is not
 * misread as a refusal.
 */
const REFUSAL_SETTLE_MS = 1_200;

/**
 * Last source the viewer settled on, kept for the life of the tab so a choice
 * made on one episode carries to the next. Survives remounts of this component
 * (the player is remounted on every source swap), which component state would
 * not.
 */
let preferredSourceId: string | null = null;

export interface EmbedPlayerProps {
  tmdbId?: number | string | null;
  imdbId?: string | null;
  mediaType?: "movie" | "tv";
  season?: number;
  episode?: number;
  title: string;
  poster?: string;
  className?: string;
  onClose?: () => void;
}

export function EmbedPlayer({
  tmdbId,
  imdbId,
  mediaType = "movie",
  season,
  episode,
  title,
  poster,
  className,
  onClose,
}: EmbedPlayerProps) {
  const sources = useMemo<ResolvedEmbedSource[]>(
    () => resolveEmbedSources({ tmdbId, imdbId, mediaType, season, episode }),
    [tmdbId, imdbId, mediaType, season, episode],
  );

  const [index, setIndex] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  // Bumping this remounts the iframe, which is how a stalled frame is retried.
  const [attempt, setAttempt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  /**
   * Sources already proven unusable for this title, so a failover never lands
   * back on one we know is dead or refusing to be framed.
   */
  const blockedIds = useRef<Set<string>>(new Set());

  const active = sources[index];
  const total = sources.length;

  const goTo = useCallback(
    (next: number) => {
      if (total === 0) return;
      const wrapped = ((next % total) + total) % total;
      // Every path here is a deliberate settle: either the viewer chose it, or
      // the current one was ruled out. Both are worth remembering.
      preferredSourceId = sources[wrapped]?.id ?? null;
      setIndex(wrapped);
      setLoadState("loading");
      setAttempt((n) => n + 1);
    },
    [total, sources],
  );

  /**
   * Explicit viewer choice. Clears the dead-source memory for the target so a
   * server that was ruled out for *this* title gets a genuine second chance --
   * some providers rate-limit per title rather than being actually broken.
   */
  const selectSource = useCallback(
    (next: number) => {
      if (next < 0 || next >= total || next === index) return;
      blockedIds.current.delete(sources[next]?.id);
      goTo(next);
    },
    [index, total, sources, goTo],
  );

  /** Next source after `from` that has not already been ruled out, or -1. */
  const nextViableIndex = useCallback(
    (from: number) => {
      for (let step = 1; step <= total; step += 1) {
        const candidate = (from + step) % total;
        if (!blockedIds.current.has(sources[candidate].id)) return candidate;
      }
      return -1;
    },
    [sources, total],
  );

  const goToNextSource = useCallback(() => {
    const next = nextViableIndex(index);
    if (next === -1) {
      // Everything is ruled out; fall back to a plain rotation so the viewer is
      // not stuck on a dead frame.
      goTo(index + 1);
      return;
    }
    goTo(next);
  }, [index, nextViableIndex, goTo]);

  const advance = useCallback(() => {
    const next = nextViableIndex(index);
    if (next === -1) {
      setLoadState("failed");
      return;
    }
    goTo(next);
  }, [index, nextViableIndex, goTo]);

  const retry = useCallback(() => {
    setLoadState("loading");
    setAttempt((n) => n + 1);
  }, []);

  // Reset whenever the underlying target changes (new season/episode, new title).
  useEffect(() => {
    const remembered = preferredSourceId
      ? sources.findIndex((src) => src.id === preferredSourceId)
      : -1;
    setIndex(remembered >= 0 ? remembered : 0);
    setLoadState("loading");
    setAttempt((n) => n + 1);
    blockedIds.current = new Set();
  }, [sources]);

  // Watchdog: an embed that never reports load is treated as failed and we
  // fall through to the next source.
  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = window.setTimeout(() => {
      blockedIds.current.add(active.id);
      advance();
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loadState, active, advance]);

  const handleLoad = useCallback(() => {
    setLoadState("ready");
  }, []);

  /**
   * A frame refused for anti-framing reasons (`X-Frame-Options` or a CSP
   * `frame-ancestors` directive) still fires `onLoad`, so the watchdog above
   * never sees it and the viewer is left staring at the browser's own refusal
   * page. The document is unreadable cross-origin, but `window.length` is on
   * the cross-origin allow list: a working provider player nests at least one
   * frame, while the refusal page nests none. Reading it lets a blocked source
   * be ruled out and the failover continue.
   *
   * Runs as an effect rather than inside the load handler so the settle timer
   * is cleared if the frame is torn down first, and conservative by design: a
   * source is only ruled out on a confirmed empty frame, and a false positive
   * costs one skipped source rather than playback, because the remaining
   * candidates are still tried in order.
   */
  useEffect(() => {
    if (loadState !== "ready") return;
    const timer = window.setTimeout(() => {
      const frame = frameRef.current;
      const frameWindow = frame?.contentWindow;
      if (!frame || !frameWindow) return;
      if (frameWindow.length > 0) return;

      blockedIds.current.add(active.id);
      advance();
    }, REFUSAL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [loadState, active, advance]);

  if (total === 0 || !active) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-black/90 text-center text-sm text-white/70",
          className,
        )}
      >
        <p className="px-6">
          No playback sources are available for this title.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-black", className)}>
      {poster && loadState === "loading" ? (
        <img
          src={poster}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-25 blur-2xl scale-110"
        />
      ) : null}

      {/* Keyed on source+attempt so switching sources swaps the frame in
          place instead of reloading the page. */}
      <iframe
        key={`${active.id}-${attempt}`}
        ref={frameRef}
        src={active.url}
        title={title}
        className="absolute inset-0 h-full w-full border-0"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        // allow-scripts + allow-same-origin is safe here only because every
        // provider is a distinct origin from this app. Omitting allow-popups
        // and allow-top-navigation is what blocks forced popups/redirects.
        // Do not widen this to satisfy a provider that refuses to be framed:
        // allow-scripts + allow-same-origin already lets the framed document
        // lift its own sandbox, and adding top-navigation hands it the top
        // window. Providers that refuse are skipped instead.
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        onLoad={handleLoad}
      />

      {loadState === "loading" ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex items-center gap-3 rounded-full bg-black/70 px-5 py-2.5 text-sm text-white/90 backdrop-blur">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{optimizingStream}</span>
          </div>
        </div>
      ) : null}

      {loadState === "failed" ? (
        <div className="absolute inset-x-0 top-1/2 z-20 mx-auto w-fit max-w-sm -translate-y-1/2 rounded-xl border border-white/10 bg-black/85 px-6 py-5 text-center backdrop-blur">
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-400" />
          <p className="mt-2 text-sm font-semibold text-white">
            {titleUnavailable}
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/20"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {tryAgain}
          </button>
        </div>
      ) : null}

      {/* Manual source switcher. Top-left so it clears the provider's own
          transport controls along the bottom edge. */}
      {total > 1 ? (
        <div className="absolute left-3 top-3 z-30 flex items-center gap-1 rounded-lg bg-black/70 p-1 backdrop-blur">
          {sources.map((src, i) => {
            const isActive = i === index;
            const isBlocked = blockedIds.current.has(src.id);
            return (
              <button
                key={src.id}
                type="button"
                onClick={() => selectSource(i)}
                title={isBlocked ? `${src.title} (failed, try again)` : src.title}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] font-semibold transition",
                  isActive
                    ? "bg-violet-500 text-white"
                    : isBlocked
                      ? "text-white/35 line-through hover:bg-white/10 hover:text-white/70"
                      : "text-white/70 hover:bg-white/10 hover:text-white",
                )}
              >
                {src.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={goToNextSource}
            title="Next server"
            aria-label="Next server"
            className="ml-0.5 rounded-md p-1 text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Close control */}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close player"
          className="absolute right-3 top-3 z-30 rounded-md bg-black/60 px-2.5 py-1.5 text-xs font-semibold text-white/80 backdrop-blur transition hover:bg-black/80 hover:text-white"
        >
          Close
        </button>
      ) : null}
    </div>
  );
}

export default EmbedPlayer;
