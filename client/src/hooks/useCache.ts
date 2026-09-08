import { useRef, useCallback } from "react";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  promise?: Promise<T>;
}

interface CacheOptions {
  staleTime?: number;
  maxSize?: number;
}

/**
 * Lightweight in-memory cache with stale-while-revalidate semantics.
 * Provides 5-10 second stale window to prevent redundant network requests.
 */
export function createCache<T>(options: CacheOptions = {}) {
  const { staleTime = 5000, maxSize = 50 } = options;
  const cache = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Promise<T>>();

  function get(key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    return entry.data;
  }

  function isStale(key: string): boolean {
    const entry = cache.get(key);
    if (!entry) return true;
    return Date.now() - entry.timestamp > staleTime;
  }

  async function fetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const entry = cache.get(key);
    const now = Date.now();

    if (entry && now - entry.timestamp <= staleTime) {
      return entry.data;
    }

    if (inflight.has(key)) {
      return inflight.get(key)!;
    }

    const promise = fetcher().then(
      (data) => {
        cache.set(key, { data, timestamp: Date.now() });
        if (cache.size > maxSize) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
        inflight.delete(key);
        return data;
      },
      (error) => {
        inflight.delete(key);
        throw error;
      }
    );

    inflight.set(key, promise);
    return promise;
  }

  function set(key: string, data: T): void {
    cache.set(key, { data, timestamp: Date.now() });
    if (cache.size > maxSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
  }

  function invalidate(key: string): void {
    cache.delete(key);
    inflight.delete(key);
  }

  function clear(): void {
    cache.clear();
    inflight.clear();
  }

  return { get, fetch, set, invalidate, clear, isStale };
}

/**
 * React hook wrapper for the cache.
 */
export function useCache<T>(options: CacheOptions = {}) {
  const cacheRef = useRef(createCache<T>(options));

  const get = useCallback(
    (key: string) => cacheRef.current.get(key),
    []
  );

  const fetch = useCallback(
    (key: string, fetcher: () => Promise<T>) => cacheRef.current.fetch(key, fetcher),
    []
  );

  const set = useCallback((key: string, data: T) => cacheRef.current.set(key, data), []);

  const invalidate = useCallback((key: string) => cacheRef.current.invalidate(key), []);

  const clear = useCallback(() => cacheRef.current.clear(), []);

  return { get, fetch, set, invalidate, clear };
}

// Global cache instances for different data types
export const movieCache = createCache<any>({ staleTime: 5000, maxSize: 100 });
export const trailerCache = createCache<any>({ staleTime: 10000, maxSize: 50 });
export const episodeCache = createCache<any>({ staleTime: 5000, maxSize: 100 });