import { cn } from "@/lib/utils";

/**
 * Full-bleed loader for the watch page.
 *
 * Deliberately wordless. The backend now walks the whole provider chain before
 * answering, so a viewer waiting on it is waiting on something real -- but what
 * is happening is provider failover, which is not their business. The previous
 * copy ("Optimizing high-definition stream…", "Finding the best stream…",
 * "Resolving playback sources…") described an internal retry loop that
 * frequently had nothing to do with high definition, and naming a stage
 * invited the viewer to wait for a specific message that might never arrive.
 *
 * Poster stays visible behind it: the surface is alive and the title is
 * recognisable, so a long resolve reads as "loading" rather than "broken".
 */
export interface StreamLoaderProps {
  poster?: string;
  title?: string;
  className?: string;
}

export function StreamLoader({ poster, title, className }: StreamLoaderProps) {
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
        className="relative z-10"
      >
        <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-white/20 border-t-white" />
        {/* Announced to screen readers, invisible on screen. */}
        <span className="sr-only">Loading stream…</span>
      </div>
    </div>
  );
}

export default StreamLoader;
