import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, RotateCw } from "lucide-react";
import { resolveEmbedSources, type ResolvedEmbedSource } from "@/lib/embedSources";
import { cn } from "@/lib/utils";

/**
 * Cross-origin iframes never fire `onError` for a dead or blocked provider, so
 * "did it load?" is inferred: if `onLoad` has not landed within this window we
 * treat the server as failed and move on.
 */
const LOAD_TIMEOUT_MS = 12_000;

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
  const autoAdvanced = useRef(false);

  const active = sources[index];
  const total = sources.length;

  const goTo = useCallback(
    (next: number) => {
      if (total === 0) return;
      setIndex(((next % total) + total) % total);
      setLoadState("loading");
      setAttempt((n) => n + 1);
    },
    [total],
  );

  const retry = useCallback(() => {
    setLoadState("loading");
    setAttempt((n) => n + 1);
  }, []);

  // Reset whenever the underlying target changes (new season/episode, new title).
  useEffect(() => {
    setIndex(0);
    setLoadState("loading");
    setAttempt((n) => n + 1);
    autoAdvanced.current = false;
  }, [sources]);

  // Watchdog: an embed that never reports load is treated as failed and we
  // fall through to the next provider exactly once per source.
  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = window.setTimeout(() => {
      setLoadState("failed");
      if (!autoAdvanced.current && index + 1 < total) {
        autoAdvanced.current = true;
        goTo(index + 1);
      }
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loadState, index, total, goTo]);

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

      {/* Keyed on source+attempt so switching servers swaps the frame in
          place instead of reloading the page. */}
      <iframe
        key={`${active.id}-${attempt}`}
        ref={frameRef}
        src={active.url}
        title={`${title} - ${active.title}`}
        className="absolute inset-0 h-full w-full border-0"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        // allow-scripts + allow-same-origin is safe here only because every
        // provider is a distinct origin from this app. Omitting allow-popups
        // and allow-top-navigation is what blocks forced popups/redirects.
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        onLoad={() => setLoadState("ready")}
      />

      {loadState === "loading" ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex items-center gap-3 rounded-full bg-black/70 px-5 py-2.5 text-sm text-white/90 backdrop-blur">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Connecting to {active.title}…</span>
          </div>
        </div>
      ) : null}

      {loadState === "failed" ? (
        <div className="absolute inset-x-0 top-1/2 z-20 mx-auto w-fit max-w-sm -translate-y-1/2 rounded-xl border border-white/10 bg-black/85 px-6 py-5 text-center backdrop-blur">
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-400" />
          <p className="mt-2 text-sm font-semibold text-white">
            {active.title} did not respond
          </p>
          <p className="mt-1 text-xs text-white/60">
            Pick another server below to keep watching.
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/20"
          >
            <RotateCw className="h-3.5 w-3.5" />
            Retry this server
          </button>
        </div>
      ) : null}

      {/* Server switcher */}
      <div className="absolute inset-x-0 top-0 z-30 flex items-start gap-2 bg-gradient-to-b from-black/85 to-transparent p-3">
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {sources.map((source, i) => {
            const selected = i === index;
            return (
              <button
                key={source.id}
                type="button"
                onClick={() => goTo(i)}
                aria-pressed={selected}
                title={source.title}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition sm:text-xs",
                  selected
                    ? "bg-white text-black"
                    : "bg-black/60 text-white/80 hover:bg-black/80 hover:text-white",
                )}
              >
                {source.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => goTo(index - 1)}
            aria-label="Previous server"
            className="rounded-md bg-black/60 p-1.5 text-white/80 transition hover:bg-black/80 hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => goTo(index + 1)}
            aria-label="Next server"
            className="rounded-md bg-black/60 p-1.5 text-white/80 transition hover:bg-black/80 hover:text-white"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close player"
              className="rounded-md bg-black/60 px-2 py-1.5 text-xs font-semibold text-white/80 transition hover:bg-black/80 hover:text-white"
            >
              Close
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default EmbedPlayer;
