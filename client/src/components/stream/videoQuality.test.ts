import { describe, expect, it } from "vitest";
import { deriveHlsLevels } from "./VideoPlayer";

describe("deriveHlsLevels", () => {
  it("returns nothing for a missing or unparsed instance", () => {
    expect(deriveHlsLevels(null)).toEqual([]);
    expect(deriveHlsLevels(undefined)).toEqual([]);
    expect(deriveHlsLevels({ levels: [] } as never)).toEqual([]);
  });

  it("labels each rendition by height, tallest first", () => {
    const levels = deriveHlsLevels({
      levels: [
        { height: 360 },
        { height: 1080 },
        { height: 720 },
      ],
    } as never);

    expect(levels).toEqual([
      { quality: "1080p", height: 1080 },
      { quality: "720p", height: 720 },
      { quality: "360p", height: 360 },
    ]);
  });

  it("collapses duplicate heights so one entry appears per rung", () => {
    const levels = deriveHlsLevels({
      levels: [{ height: 720 }, { height: 720 }, { height: 480 }],
    } as never);

    expect(levels.map((l) => l.quality)).toEqual(["720p", "480p"]);
  });

  it("skips audio-only and malformed levels with no height", () => {
    const levels = deriveHlsLevels({
      levels: [
        { height: 0 },
        { height: undefined },
        { height: null },
        {},
        { height: 1080 },
      ],
    } as never);

    expect(levels).toEqual([{ quality: "1080p", height: 1080 }]);
  });

  it("coerces string heights from raw manifest attributes", () => {
    const levels = deriveHlsLevels({
      levels: [{ height: "720" }, { height: "1080" }],
    } as never);

    expect(levels.map((l) => l.quality)).toEqual(["1080p", "720p"]);
  });
});
