import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface RowScrollerProps {
  children: ReactNode;
  /**
   * Accessible name for the scroll region. Rows are regions of links, and a
   * screen-reader user paging through them needs to know which shelf they are in.
   */
  label: string;
  /**
   * Pixels advanced per arrow press. Deliberately a fraction of the viewport
   * rather than one card: one card at a time is unusable on a shelf of 20, and a
   * full viewport jump hides whatever was under the cursor.
   */
  step?: number;
  className?: string;
}

/**
 * The horizontal shelf every row on this site is built from.
 *
 * What it adds over a plain `overflow-x: auto` container:
 *
 * * **Arrows that only exist when there is somewhere to go.** A disabled arrow
 *   pinned to both edges of every row is furniture; these appear on hover and on
 *   keyboard focus, and only on the side that has more content.
 * * **Keyboard navigation along the row.** Left/Right move between cards, which
 *   is the whole reason a shelf is a list and not a strip of divs. The cards
 *   themselves are buttons or links, so Tab order stays correct without this;
 *   the arrows are the affordance a pointer user has.
 * * **Edge fades.** They are what tells the eye there is more of the shelf to the
 *   right, which a clipped card edge alone does not convey.
 *
 * Scroll position is tracked with a resize/scroll listener pair rather than
 * `IntersectionObserver`, because the question being asked -- "can I still scroll
 * right?" -- is about total extent, not about what is currently on screen. It is
 * rAF-throttled: `scroll` fires far faster than the UI can paint, and each event
 * here would otherwise force a layout read.
 */
export function RowScroller({
  children,
  label,
  step,
  className = "",
}: RowScrollerProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const frameRef = useRef<number | null>(null);

  const syncEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // `clientWidth`/`scrollWidth` are rounded, so a sub-pixel remainder at the end
    // of the shelf would otherwise leave the right arrow enabled and clicking it
    // would do nothing. One pixel of slack is enough to absorb the rounding.
    const slack = 1;
    setCanScrollLeft(el.scrollLeft > slack);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - slack);
  }, []);

  const scheduleSync = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncEdges();
    });
  }, [syncEdges]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    syncEdges();

    el.addEventListener("scroll", scheduleSync, { passive: true });
    // A shelf's scrollability changes when the viewport resizes, when a card's
    // poster fails and changes the card's height, and when `font-size` is
    // changed by the OS accessibility setting. `ResizeObserver` on the element
    // catches all three; a window resize listener catches only the first.
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(syncEdges)
        : null;
    observer?.observe(el);

    return () => {
      el.removeEventListener("scroll", scheduleSync);
      observer?.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [scheduleSync, syncEdges]);

  const scrollBy = useCallback(
    (direction: 1 | -1) => {
      const el = scrollerRef.current;
      if (!el) return;
      const distance = step ?? Math.max(240, Math.round(el.clientWidth * 0.8));
      el.scrollBy({ left: distance * direction, behavior: "smooth" });
    },
    [step]
  );

  // Arrow keys move along the shelf, but only while the shelf holds focus. A
  // global ArrowLeft/ArrowRight handler would fight the page scroll and hijack
  // every other control on screen.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const el = scrollerRef.current;
      if (!el) return;
      // Leave the keys alone when a control inside a card owns them -- a card's own
      // arrow-key behaviour (or a slider in a card) must win.
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-row-scroller-ignore-keys]")) return;
      event.preventDefault();
      scrollBy(event.key === "ArrowRight" ? 1 : -1);
    },
    [scrollBy]
  );

  const interactive =
    "pointer-events-none absolute inset-y-0 z-20 hidden w-10 items-center justify-center text-white/90 transition-opacity duration-200 group-hover/shelf:pointer-events-auto group-hover/shelf:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 sm:flex";

  return (
    <div className="group/shelf relative">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-[var(--sv-base)] to-transparent opacity-0 transition-opacity duration-200 group-hover/shelf:opacity-100" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-[var(--sv-base)] to-transparent opacity-0 transition-opacity duration-200 group-hover/shelf:opacity-100" />

      <button
        type="button"
        onClick={() => scrollBy(-1)}
        disabled={!canScrollLeft}
        aria-label={`Scroll ${label} left`}
        className={`${interactive} left-0 rounded-r-2xl bg-black/40 hover:bg-black/60 disabled:pointer-events-none`}
        style={{ opacity: canScrollLeft ? undefined : 0 }}
      >
        <ChevronLeft className="h-7 w-7" />
      </button>
      <button
        type="button"
        onClick={() => scrollBy(1)}
        disabled={!canScrollRight}
        aria-label={`Scroll ${label} right`}
        className={`${interactive} right-0 rounded-l-2xl bg-black/40 hover:bg-black/60 disabled:pointer-events-none`}
        style={{ opacity: canScrollRight ? undefined : 0 }}
      >
        <ChevronRight className="h-7 w-7" />
      </button>

      <div
        ref={scrollerRef}
        role="region"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`catalog-row ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

export default RowScroller;
