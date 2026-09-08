import { Children, isValidElement, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface MovieGridProps {
  children: ReactNode;
  className?: string;
}

/** Grid items are keyed by their React `key`, falling back to the index. */
function itemKey(child: ReactNode, index: number): string | number {
  if (isValidElement(child)) {
    const key = child.key;
    if (key !== null && key !== undefined) return key;
  }
  return index;
}

/**
 * Responsive media grid for streaming titles (2 → 3 → 4 → 5 columns).
 *
 * Items are animated with Framer Motion's `layout` prop inside an
 * `AnimatePresence mode="popLayout"` container: when a filter toggle removes or
 * adds tiles, exiting cards are popped out of layout flow instantly and the
 * survivors glide into their new cells, so the grid transitions smoothly with
 * zero visual layout shift. Entering cards cross-fade and rise in place.
 */
export function MovieGrid({ children, className = "" }: MovieGridProps) {
  const items = Children.toArray(children);

  return (
    <div
      className={`grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 ${className}`}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {items.map((child, index) => (
          <motion.div
            key={itemKey(child, index)}
            layout
            className="min-w-0"
            initial={{ opacity: 0, scale: 0.94, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
          >
            {child}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}