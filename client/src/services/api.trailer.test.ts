import { describe, expect, it } from "vitest";

import {
  fetchTrailer,
  fetchTrailerByTmdbId,
  qualityFromHeight,
} from "./api";

describe("trailer lookups", () => {
  it("returns null for the title-based lookup", async () => {
    // The catalogue's trailers are direct MP4 addresses, and the current
    // trailer component only frames YouTube/Dailymotion/Vimeo embeds. A null
    // here is the honest answer: the hero falls back to backdrop art.
    await expect(fetchTrailer("Inception", 2010)).resolves.toBeNull();
  });

  it("returns null for the id-based lookup", async () => {
    await expect(fetchTrailerByTmdbId(27205, "movie")).resolves.toBeNull();
  });
});

describe("qualityFromHeight", () => {
  it("maps a real resolution to its rung instead of parsing the label", () => {
    expect(qualityFromHeight(2160)).toBe("4K");
    expect(qualityFromHeight(1080)).toBe("1080p");
    expect(qualityFromHeight(720)).toBe("720p");
    expect(qualityFromHeight(480)).toBe("480p");
    expect(qualityFromHeight(360)).toBe("320p");
  });

  it("does not let parseInt('4K') capture ordinary heights", () => {
    expect(qualityFromHeight(1080)).not.toBe("4K");
    expect(qualityFromHeight(480)).not.toBe("4K");
  });

  it("holds the neutral rung when the height is missing", () => {
    expect(qualityFromHeight(0)).toBe("480p");
    expect(qualityFromHeight(Number.NaN)).toBe("480p");
  });
});
