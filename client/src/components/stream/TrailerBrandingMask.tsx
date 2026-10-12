import type { CSSProperties } from "react";

/**
 * Thin veil over the bottom-right corner of a framed trailer player.
 *
 * YouTube places its logo/watermark there and `modestbranding=1` only removes
 * it from the control bar, not from the corner bug. This mask covers just that
 * corner — small enough to never obscure subtitles or controls, and always
 * `pointer-events-none` so the provider's own chrome stays clickable underneath.
 *
 * Shared by every surface that autoplays a trailer iframe (Details sheet,
 * Watch trailer tab, Spotlight hero) so the treatment cannot drift between them.
 */
export function TrailerBrandingMask() {
  const style: CSSProperties = {
    background:
      "linear-gradient(to top left, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 40%, transparent 70%)",
  };
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute bottom-0 right-0 z-[2] h-16 w-32 sm:h-20 sm:w-40"
      style={style}
    />
  );
}

export default TrailerBrandingMask;
