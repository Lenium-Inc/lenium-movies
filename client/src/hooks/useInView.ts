import { useEffect, useRef, useState, useCallback } from "react";

interface UseInViewOptions {
  threshold?: number;
  rootMargin?: string;
  triggerOnce?: boolean;
}

/**
 * Hook that tracks when an element enters the viewport using Intersection Observer.
 * Returns a ref to attach to the element and a boolean indicating visibility.
 */
export function useInView(options: UseInViewOptions = {}) {
  const {
    threshold = 0.1,
    rootMargin = "100px",
    triggerOnce = true,
  } = options;

  const [isInView, setIsInView] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }

      elementRef.current = node;

      if (node) {
        observerRef.current = new IntersectionObserver(
          ([entry]) => {
            if (entry.isIntersecting) {
              setIsInView(true);
              if (triggerOnce) {
                observerRef.current?.disconnect();
              }
            } else if (!triggerOnce) {
              setIsInView(false);
            }
          },
          { threshold, rootMargin }
        );
        observerRef.current.observe(node);
      }
    },
    [threshold, rootMargin, triggerOnce]
  );

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
    };
  }, []);

  return { ref: setRef, isInView };
}

/**
 * Hook for staggered loading of multiple items with viewport intersection.
 * Items are queued and loaded with a small delay between each for smooth rendering.
 */
export function useStaggeredInView<T>(items: T[], options: UseInViewOptions = {}) {
  const { threshold = 0.1, rootMargin = "200px", triggerOnce = true } = options;
  const [visibleIndices, setVisibleIndices] = useState<Set<number>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || items.length === 0) return;

    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Load all items at once when sentinel is visible
          setVisibleIndices(new Set(items.map((_, i) => i)));
          if (triggerOnce) {
            observerRef.current?.disconnect();
          }
        }
      },
      { threshold, rootMargin }
    );

    observerRef.current.observe(sentinel);

    return () => observerRef.current?.disconnect();
  }, [items.length, threshold, rootMargin, triggerOnce]);

  const getSentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      sentinelRef.current = node;
    },
    []
  );

  const isItemVisible = useCallback(
    (index: number) => visibleIndices.has(index),
    [visibleIndices]
  );

  return { sentinelRef: getSentinelRef, isItemVisible, visibleCount: visibleIndices.size };
}