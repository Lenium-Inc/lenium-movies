import { describe, expect, it } from "vitest";
import { selectOfficialVideo, type VideoAssetCandidate } from "./providers/tmdb";

const candidate = (overrides: Partial<VideoAssetCandidate>): VideoAssetCandidate => ({
  movieId: "27205",
  provider: "youtube",
  providerVideoId: "video",
  type: "Clip",
  name: "Approved video",
  official: true,
  language: "en",
  country: "US",
  thumbnailUrl: "https://i.ytimg.com/vi/video/hqdefault.jpg",
  publishedAt: new Date("2026-01-01T00:00:00Z"),
  duration: null,
  embedUrl: "https://www.youtube-nocookie.com/embed/video",
  sourceUrl: "https://www.youtube.com/watch?v=video",
  ...overrides,
});

describe("TMDB video asset selection", () => {
  it("prioritizes an official trailer over teasers, featurettes, and clips", () => {
    const selected = selectOfficialVideo([
      candidate({ type: "Clip", providerVideoId: "clip" }),
      candidate({ type: "Featurette", providerVideoId: "featurette" }),
      candidate({ type: "Teaser", providerVideoId: "teaser" }),
      candidate({ type: "Trailer", providerVideoId: "trailer" }),
    ]);
    expect(selected?.type).toBe("Trailer");
    expect(selected?.providerVideoId).toBe("trailer");
  });

  it("never selects an unofficial video", () => {
    const selected = selectOfficialVideo([candidate({ official: false, type: "Trailer" })]);
    expect(selected).toBeNull();
  });
});
