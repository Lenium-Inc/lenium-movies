/**
 * Lets a title page publish its own metadata for the head.
 *
 * The problem is ordering. `RouteSeo` is mounted above the router precisely so no
 * page can forget to set its title, which means it runs before -- and independently
 * of -- whatever the page itself loads. A watch page cannot know a film is "The
 * Matrix" until it has fetched it, so by the time it has a title, the component
 * responsible for writing the head has already run for this URL.
 *
 * The two obvious fixes are both worse:
 *
 * - Move the head writing into each page. Then "did this page remember to set its
 *   title" is an open question again, which is the failure mode this component
 *   exists to remove.
 * - Use context. Context flows down, and the consumer here is above the provider,
 *   so it cannot work without lifting the head writing back into the page.
 *
 * So this is a module-level store read through `useSyncExternalStore`, which is
 * what it is for: one value, several unrelated components, no shared ancestry. The
 * page publishes when its details land; `RouteSeo` re-renders and rewrites the
 * head; the entry is cleared when the viewer leaves so a title cannot leak onto the
 * next page.
 */

import { useSyncExternalStore } from "react";
import type { WatchSeoContext } from "@/lib/seo";

let current: WatchSeoContext | null = null;
const listeners = new Set<() => void>();

function emit() {
  // forEach rather than `for...of`: this file is compiled without a target that
  // allows iterating a Set, and changing the shared compiler target to suit one
  // listener loop is not a trade worth making.
  listeners.forEach(listener => listener());
}

/** Called by a watch page once its details have loaded, and on unmount. */
export function publishWatchSeo(movie: WatchSeoContext | null): void {
  if (current === movie) return;
  current = movie;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current title page's metadata, or null on any other route.
 *
 * Identity is stable across renders -- the same object is returned until something
 * is published -- which `useSyncExternalStore` requires, or it would loop.
 */
export function useWatchSeo(): WatchSeoContext | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
}

/** Test seam: returns the store to its initial state between cases. */
export function resetWatchSeo(): void {
  publishWatchSeo(null);
}
