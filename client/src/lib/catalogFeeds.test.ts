import { describe, expect, it, vi } from "vitest";
import type { StreamMovie } from "@/services/api";
import { loadCatalogFeeds } from "./catalogFeeds";

function movie(id: string): StreamMovie {
  return {
    id,
    title: `Movie ${id}`,
    poster_url: "",
    stream_url: "",
  };
}

describe("loadCatalogFeeds", () => {
  it("keeps the successful feed when another feed fails", async () => {
    const failure = new Error("popular feed unavailable");
    const result = await loadCatalogFeeds([
      async () => [movie("trending-1")],
      async () => {
        throw failure;
      },
    ]);

    expect(result.items.map(item => item.id)).toEqual(["trending-1"]);
    expect(result.errors).toEqual([failure]);
  });

  it("deduplicates while preserving feed priority and caps the result", async () => {
    const result = await loadCatalogFeeds(
      [async () => [movie("1"), movie("2")], async () => [movie("2"), movie("3")]],
      2
    );

    expect(result.items.map(item => item.id)).toEqual(["1", "2"]);
    expect(result.errors).toEqual([]);
  });

  it("distinguishes valid empty results from failed requests", async () => {
    const empty = await loadCatalogFeeds([async () => []]);
    const failed = await loadCatalogFeeds([
      vi.fn(async () => {
        throw new Error("backend unavailable");
      }),
    ]);

    expect(empty).toEqual({ items: [], errors: [] });
    expect(failed.items).toEqual([]);
    expect(failed.errors).toHaveLength(1);
  });
});
