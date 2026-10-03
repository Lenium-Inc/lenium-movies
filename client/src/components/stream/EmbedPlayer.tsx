import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMBED_ALLOW,
  resolveEmbedSources,
  type ResolvedEmbedSource,
} from "@/lib/embedSources";
import { cn } from "@/lib/utils";
import { titleUnavailable } from "@/lib/playbackCopy";

/**
 * How long a candidate gets before the next one in the chain is tried.
 *
 * Cross-origin iframes never fire `onError` for a dead or blocked provider, so
 * "did it load?" is inferred from time: a frame that has not reported load
 * inside this window is treated as failed.
 *
 * Four seconds is short enough that the sum of the whole chain stays inside the
 * viewer's patience even when every candidate is dead -- the worst case is now
 * `chain length x 4s` of one continuous wait rather than a wait interrupted by an
 * error card. It is also long enough to clear the handshake on a cold embed,
 * which is where most of the real latency is.
 */
const CANDIDATE_HEALTH_TIMEOUT_MS = 4_000;

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
  /**
   * Pre-resolved provider chain, in failover order.
   *
   * The backend now walks the provider chain itself and returns the order it
   * settled on, so this is the normal input. It is authoritative for *which*
   * provider serves the title, which the local registry cannot know: the
   * backend skips benched and unreachable providers, and mirroring that here
   * would immediately re-probe the ones it just ruled out.
   */
  sources?: ResolvedEmbedSource[];
  /** Used only when the backend supplied no chain, to build one locally. */
  tmdbId?: number | string | null;
  mediaType?: "movie" | "tv";
  season?: number;
  episode?: number;
  title: string;
  poster?: string;
  className?: string;
  /**
   * Controlled selection. When set, the frame shows this provider and the
   * page's `ServerSelector` is the single source of truth for which one is
   * playing — a player that also kept its own cursor would show one server
   * while the picker highlighted another. Omit it and the player picks for
   * itself, which is what a standalone embed player does.
   */
  activeSourceId?: string;
  /**
   * Called when the player decides the active source is unusable and moves to
   * the next candidate in the chain. In controlled mode the page applies the
   * move; the picker then highlights whatever is actually playing.
   */
  onActiveSourceIdChange?: (sourceId: string) => void;
  /**
   * Called once a candidate has settled -- the frame reported load and was not
   * then ruled out as an anti-framing refusal. This is the signal the page holds
   * its loading overlay up for.
   */
  onPlaying?: () => void;
  /**
   * Called when every candidate in the chain has been ruled out. The page turns
   * this into its own terminal state, so the player never renders an error of
   * its own.
   */
  onExhausted?: () => void;
}

export function EmbedPlayer({
  sources: providedSources,
  tmdbId,
  mediaType = "movie",
  season,
  episode,
  title,
  poster,
  className,
  activeSourceId,
  onActiveSourceIdChange,
  onPlaying,
  onExhausted,
}: EmbedPlayerProps) {
  const sources = useMemo<ResolvedEmbedSource[]>(
    () =>
      providedSources?.length
        ? providedSources
        : resolveEmbedSources({ tmdbId, mediaType, season, episode }),
    [providedSources, tmdbId, mediaType, season, episode]
  );

  const controlled = activeSourceId !== undefined;
  const [index, setIndex] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">(
    "loading"
  );
  // Bumping this remounts the iframe, which is how a stalled frame is retried.
  const [attempt, setAttempt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  /**
   * Sources already proven unusable for this title, so a failover never lands
   * back on one we know is dead or refusing to be framed.
   */
  const blockedIds = useRef<Set<string>>(new Set());

  const total = sources.length;
  const controlledIndex = controlled
    ? Math.max(
        0,
        sources.findIndex(src => src.id === activeSourceId)
      )
    : index;
  const active = sources[controlledIndex];

  const goTo = useCallback(
    (next: number) => {
      if (total === 0) return;
      const wrapped = ((next % total) + total) % total;
      const target = sources[wrapped];
      if (!target) return;
      // Every path here is a deliberate settle: either the viewer chose it, or
      // the current one was ruled out. Both are worth remembering.
      preferredSourceId = target.id;
      if (onActiveSourceIdChange) onActiveSourceIdChange(target.id);
      else setIndex(wrapped);
      setLoadState("loading");
      setAttempt(n => n + 1);
    },
    [total, sources, onActiveSourceIdChange]
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
    [sources, total]
  );

  const advance = useCallback(() => {
    const next = nextViableIndex(controlledIndex);
    if (next === -1) {
      setLoadState("failed");
      return;
    }
    goTo(next);
  }, [controlledIndex, nextViableIndex, goTo]);
  // Reset whenever the underlying target changes (new season/episode, new title).
  useEffect(() => {
    const start = controlled
      ? Math.max(
          0,
          sources.findIndex(src => src.id === activeSourceId)
        )
      : preferredSourceId
        ? Math.max(
            0,
            sources.findIndex(src => src.id === preferredSourceId)
          )
        : 0;
    if (!controlled) setIndex(start);
    setLoadState("loading");
    setAttempt(n => n + 1);
    blockedIds.current = new Set();
    // `activeSourceId` is deliberately not a dep: the page changing the
    // selection is a source swap, not a new target, and re-running this would
    // wipe the dead-source memory the watchdog just built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  // Watchdog: an embed that never reports load inside its budget is treated as
  // failed and we fall through to the next source. Nothing is shown to the
  // viewer when this fires -- the page's overlay never came down.
  useEffect(() => {
    if (loadState !== "loading" || !active) return;
    const timer = window.setTimeout(() => {
      blockedIds.current.add(active.id);
      advance();
    }, CANDIDATE_HEALTH_TIMEOUT_MS);
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
    if (loadState !== "ready" || !active) return;
    const timer = window.setTimeout(() => {
      const frame = frameRef.current;
      const frameWindow = frame?.contentWindow;
      if (!frame || !frameWindow) return;
      if (frameWindow.length > 0) {
        // A live player nests at least one frame, so this candidate is good.
        onPlaying?.();
        return;
      }

      blockedIds.current.add(active.id);
      advance();
    }, REFUSAL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [loadState, active, advance, onPlaying]);

  useEffect(() => {
    if (loadState === "failed") onExhausted?.();
  }, [loadState, onExhausted]);

  if (total === 0 || !active) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-black/90 text-center text-sm text-white/70",
          className
        )}
      >
        <p className="px-6">{titleUnavailable}</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden bg-black",
        className
      )}
    >
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
        className="absolute inset-0 h-full w-full border-0 rounded-2xl border-white/10 shadow-2xl bg-black"
        sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
        allow={EMBED_ALLOW}
        allowFullScreen
        // No referrer is sent to the provider at all. Several third-party
        // hosts reject a framed handshake with 403 Forbidden based on the
        // referring origin, and withholding this page's URL from ad networks
        // costs the provider nothing it is entitled to.
        referrerPolicy="no-referrer"
        onLoad={handleLoad}
      />

      {/*
        No spinner and no error card here, on purpose.

        The page renders one overlay above this frame and keeps it up until
        `onPlaying` fires, so anything drawn in this component during the load is
        a second spinner stacked on the first. And the terminal state is the
        page's: `onExhausted` lets it decide what an unplayable title looks like
        once every candidate has been tried, instead of this component asserting
        it mid-failover with a button that would restart a chain already known to
        be dead.
      */}
    </div>
  );
}

export default EmbedPlayer;
