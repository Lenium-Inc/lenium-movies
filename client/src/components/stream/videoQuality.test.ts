import { describe, expect, it } from "vitest";
import { deriveDashLevels, deriveHlsLevels } from "./VideoPlayer";

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

describe("deriveDashLevels", () => {
  it("returns nothing for a missing or empty representation list", () => {
    expect(deriveDashLevels(null)).toEqual([]);
    expect(deriveDashLevels(undefined)).toEqual([]);
    expect(deriveDashLevels([])).toEqual([]);
  });

  it("labels each representation by height, tallest first, keeping its index", () => {
    // The index is the relative position dash.js's
    // setRepresentationForTypeByIndex expects, so it must survive the sort.
    const levels = deriveDashLevels([
      { height: 360 },
      { height: 1080 },
      { height: 720 },
    ]);

    expect(levels).toEqual([
      { quality: "1080p", height: 1080, index: 1 },
      { quality: "720p", height: 720, index: 2 },
      { quality: "360p", height: 360, index: 0 },
    ]);
  });

  it("collapses duplicate heights so one entry appears per rung", () => {
    const levels = deriveDashLevels([
      { height: 720 },
      { height: 720 },
      { height: 480 },
    ]);

    expect(levels.map((l) => l.quality)).toEqual(["720p", "480p"]);
    // The surviving rung keeps the first index that carried the height.
    expect(levels[0]?.index).toBe(0);
  });

  it("skips representations with no height", () => {
    const levels = deriveDashLevels([
      { height: 0 },
      { height: undefined },
      {},
      { height: 720 },
    ]);

    expect(levels).toEqual([{ quality: "720p", height: 720, index: 3 }]);
  });
});
