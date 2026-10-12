import { describe, expect, it } from "vitest";
import { deriveDashLevels, deriveHlsLevels, labelForHeight } from "./VideoPlayer";

describe("labelForHeight", () => {
  it("names the tall rungs the way a viewer picks them", () => {
    // A spec sheet writes 4320p; a menu row that reads "8K" is what the
    // viewer asked for, and it must match the resolver's own label or the
    // highlight and the list disagree.
    expect(labelForHeight(4320)).toBe("8K");
    expect(labelForHeight(2160)).toBe("4K");
  });

  it("keeps the raw pixel height for everything between", () => {
    expect(labelForHeight(1440)).toBe("1440p");
    expect(labelForHeight(1080)).toBe("1080p");
    expect(labelForHeight(360)).toBe("360p");
  });

  it("reports no ladder for absent heights", () => {
    expect(labelForHeight(0)).toBe("Auto");
    expect(labelForHeight(-1)).toBe("Auto");
    expect(labelForHeight(Number.NaN)).toBe("Auto");
  });
});

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

  it("shows 4K/8K as one row each, keeping the tallest height", () => {
    // 2000 and 2160 share the "4K" label; a viewer picking "4K" should land
    // on the taller of the two, never see the row twice.
    const levels = deriveHlsLevels({
      levels: [{ height: 2000 }, { height: 2160 }, { height: 4320 }],
    } as never);

    expect(levels).toEqual([
      { quality: "8K", height: 4320 },
      { quality: "4K", height: 2160 },
    ]);
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

  it("keeps the taller representation's index when two share a label", () => {
    // The row says "4K"; the switch must target the 2160 representation
    // (index 2), not the shorter one that happened to come first.
    const levels = deriveDashLevels([
      { height: 1080 },
      { height: 2000 },
      { height: 2160 },
    ]);

    expect(levels[0]).toEqual({ quality: "4K", height: 2160, index: 2 });
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
