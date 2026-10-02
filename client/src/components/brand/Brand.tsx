import { cn } from "@/lib/utils";

/**
 * The brand mark and wordmark.
 *
 * THE MARK — "the gate"
 *
 * Three sides of a rounded frame, open on the right, with a solid play
 * triangle seated in the opening. The frame is the product: it is the shape of
 * the poster tiles the catalogue is built from and the shape of the gate the
 * auth screens are drawn in. The gap on the right is the part that plays, so
 * the mark reads as a frame running rather than as another play button.
 *
 * Why open rather than closed: a closed rounded square around a triangle is the
 * single most-reproduced shape in this category and dies at 20px, where the
 * frame's own stroke competes with the triangle. Dropping the right side
 * removes that competition, and the two round caps read as a deliberate
 * aperture rather than as a broken outline.
 *
 * TWO FORMS, ONE IDEA
 *
 *   full    20px and up. Stroked open frame + solid triangle. Two elements.
 *   compact 20px and under. The frame closes and the triangle is knocked out of
 *           it as negative space. One path, `fill-rule: evenodd`.
 *
 * The compact form is the honest reduction, not a second logo: it is what is
 * left when the stroked frame is no longer thick enough to survive a 16px
 * raster, and it is the form shipped in `public/favicon.svg`. Below 20px a
 * single inked silhouette with a triangular hole carries further than two
 * competing outlines.
 *
 * COLOUR
 *
 * Every path is `currentColor` with no gradients, so the mark inherits whatever
 * surface it lands on: white in the near-black auditorium of the app, the warm
 * `--lamp` cream on the projection-booth auth screens, `text-white/70` in a
 * dimmed header. One component, zero per-surface configuration, and the mark
 * never needs a second colour token to stay legible.
 *
 * WORDMARK
 *
 * "Lenium" stays live text in DM Sans — the sans the whole app is set in —
 * rather than being outlined into the SVG. A path-traced wordmark would freeze
 * the letterforms at whatever weight the type was captured in and would then
 * disagree with the running UI, and it would need a new file per size. Live
 * text inherits the already-loaded webfont, the active theme colour, and the
 * `prefers-reduced-motion` / font-synthesis settings with no extra work.
 *
 * The one real change is the weight. DM Sans is loaded at 400/500/600/700
 * (`index.css`) and the document sets `font-synthesis: none`, so the old
 * `font-black` wordmark was not rendering at 900 — it was silently clamped to
 * 700. It now says `font-bold` and means it.
 */

const FRAME_PATH =
  "M25.4 4H11.4A7.4 7.4 0 0 0 4 11.4v9.2A7.4 7.4 0 0 0 11.4 28h14";
const TRIANGLE_PATH = "M18.2 10.6 27.6 16l-9.4 5.4Z";
/** Rounded tile with the triangle wound in the same path as a hole. */
const COMPACT_PATH =
  "M8 0h16a8 8 0 0 1 8 8v16a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8V8a8 8 0 0 1 8-8Z" +
  "M13.5 9.8 24 16l-10.5 6.2Z";

/** Below this the stroked frame stops holding together and we cut to compact. */
const COMPACT_BELOW = 20;

export interface BrandMarkProps {
  /** Rendered edge length in px. Drives the full/compact switch. */
  size?: number;
  className?: string;
  /** Force a form. Defaults to the compact reduction below 20px. */
  compact?: boolean;
  /**
   * Announce the mark to assistive tech. Leave unset when the mark sits inside
   * something already named (a link with `aria-label`, a labelled figure) — the
   * default is decorative so a wordmark never gets announced twice.
   */
  label?: string;
}

export function BrandMark({
  size = 24,
  className,
  compact,
  label,
}: BrandMarkProps) {
  const reduced = compact ?? size < COMPACT_BELOW;
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {reduced ? (
        <path d={COMPACT_PATH} fill="currentColor" fillRule="evenodd" />
      ) : (
        <>
          <path
            d={FRAME_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d={TRIANGLE_PATH} fill="currentColor" />
        </>
      )}
    </svg>
  );
}

const LOCKUP_SIZE = {
  sm: { mark: 18, wordmark: "text-[15px]", gap: "gap-2" },
  md: { mark: 22, wordmark: "text-[17px]", gap: "gap-2.5" },
  lg: { mark: 34, wordmark: "text-[26px]", gap: "gap-3.5" },
} as const;

export interface BrandLockupProps {
  size?: keyof typeof LOCKUP_SIZE;
  className?: string;
  /** Drop the wordmark and keep the mark alone. */
  markOnly?: boolean;
  label?: string;
}

/** Mark + wordmark, set as one object. Inherits colour from its container. */
export function BrandLockup({
  size = "md",
  className,
  markOnly = false,
  label,
}: BrandLockupProps) {
  const s = LOCKUP_SIZE[size];
  return (
    <span
      className={cn("inline-flex select-none items-center", s.gap, className)}
      // Decorative by default: every in-app use is either inside a link that
      // already carries an `aria-label`, or directly above the page heading.
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <BrandMark size={s.mark} />
      {markOnly ? null : (
        <span
          className={cn(
            "font-bold leading-none tracking-[-0.02em] whitespace-nowrap",
            s.wordmark
          )}
        >
          Lenium
        </span>
      )}
    </span>
  );
}
