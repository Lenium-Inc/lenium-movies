import { cn } from "@/lib/utils";

/**
 * The four states playback moves through.
 *
 * `idle` and `playing` render nothing -- there is no overlay to show in either.
 * The pair in between is what the overlay is for, and they are kept distinct
 * because they mean different things to the viewer even though the picture is
 * the same: one is the backend resolving, the other is a candidate being tried.
 */
export type StreamLoadStage =
  | "idle"
  | "resolving_backend"
  | "testing_candidate"
  | "playing";

/**
 * Full-bleed loader for the watch page, and the single overlay every wait goes
 * through.
 *
 * The poster stays visible behind it, blurred: the surface is alive and the
 * title is recognisable, so a long resolve reads as "loading" rather than
 * "broken". There is no caption — the spinner alone says everything a viewer
 * can act on, and stage labels made the wait feel longer than it was.
 *
 * There is exactly one of these per title. Resolution, candidate failover and
 * mid-playback buffering all render it, so moving between them does not swap the
 * picture or restart the animation -- a viewer who arrives mid-failover never
 * learns that they did.
 */
export interface StreamLoaderProps {
  poster?: string;
  title?: string;
  /** Which wait this is. Kept for callers; no longer drives visible copy. */
  stage?: StreamLoadStage;
  className?: string;
}

/**
 * Two-tone ring: a dim track with a bright arc sweeping it. The arc's gradient
 * runs off the top-right so the sweep reads as one continuous motion rather than
 * a rotating solid segment, and the inner disc keeps the middle of the frame
 * clear for the poster.
 */
function Spinner() {
  return (
    <div
      className="relative h-14 w-14"
      role="presentation"
      aria-hidden
    >
      <div className="absolute inset-0 rounded-full border-2 border-white/10" />
      <div
        className="absolute inset-0 animate-spin rounded-full"
        style={{
          background:
            "conic-gradient(from 90deg at 50% 50%, rgba(255,255,255,0) 0deg, rgba(255,255,255,0) 220deg, rgba(255,255,255,0.95) 340deg, rgba(255,255,255,0) 360deg)",
          WebkitMask:
            "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
          mask:
            "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
        }}
      />
      {/* Soft bloom, so the ring reads as lit rather than drawn. */}
      <div className="absolute inset-2 animate-pulse rounded-full bg-white/5 blur-md" />
    </div>
  );
}

export function StreamLoader({
  poster,
  title,
  className,
}: StreamLoaderProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center overflow-hidden bg-black",
        className
      )}
    >
      {poster ? (
        <img
          src={poster}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
        />
      ) : null}

      <div
        role="status"
        aria-label={title ? `Loading ${title}` : "Loading stream"}
        className="relative z-10 flex flex-col items-center gap-6"
      >
        <Spinner />

        {/* Announced to screen readers, invisible on screen. */}
        <span className="sr-only">Loading stream…</span>
      </div>
    </div>
  );
}

export default StreamLoader;
