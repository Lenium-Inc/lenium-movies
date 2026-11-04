import type { StreamMovie } from "@/services/api";

export type CatalogFeedFetcher = () => Promise<StreamMovie[]>;

export interface CatalogFeedLoad {
  items: StreamMovie[];
  errors: unknown[];
}

/**
 * Load independent homepage feeds without making one transient failure blank the
 * whole catalog. Results keep feed order (trending first) and are deduplicated by
 * movie id so the same title is never repeated on the shelf.
 */
export async function loadCatalogFeeds(
  fetchers: readonly CatalogFeedFetcher[],
  limit = 40
): Promise<CatalogFeedLoad> {
  const results = await Promise.allSettled(
    fetchers.map(fetchFeed => Promise.resolve().then(fetchFeed))
  );
  const items = new Map<string, StreamMovie>();
  const errors: unknown[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason);
      continue;
    }
    for (const item of result.value) {
      if (!items.has(item.id)) items.set(item.id, item);
      if (items.size >= limit) break;
    }
  }

  return { items: [...items.values()].slice(0, limit), errors };
}
