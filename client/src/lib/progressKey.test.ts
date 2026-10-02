import { describe, expect, it } from "vitest";
import { parseProgressKey, progressKey } from "./progressKey";

describe("progressKey", () => {
  it("keys a film by its TMDB id", () => {
    expect(progressKey(603, "movie")).toBe("603");
    expect(progressKey("603", "movie")).toBe("603");
  });

  it("keys an episode by show and episode", () => {
    expect(progressKey(1396, "tv", 1, 7)).toBe("1396:s1e7");
    expect(progressKey(1396, "tv", 12, 3)).toBe("1396:s12e3");
  });

  it("falls back to the show key when no episode is in hand", () => {
    // Opening the show page before picking an episode must not claim S01E01.
    expect(progressKey(1396, "tv")).toBe("1396");
    expect(progressKey(1396, "tv", 1, 0)).toBe("1396");
    expect(progressKey(1396, "tv", 0, 1)).toBe("1396");
    expect(progressKey(1396, "tv", 1.5, 2)).toBe("1396");
  });

  it("keeps films free of episode suffixes", () => {
    // The invariant behind the whole module: a film route carries no season.
    expect(progressKey(603, "movie", 1, 4)).toBe("603");
  });

  it("gives each episode of a show its own record", () => {
    const keys = new Set([
      progressKey(1396, "tv", 1, 1),
      progressKey(1396, "tv", 1, 2),
      progressKey(1396, "tv", 2, 1),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe("parseProgressKey", () => {
  it("reads a film key written before episodes existed", () => {
    expect(parseProgressKey("603")).toEqual({ id: "603" });
  });

  it("reads an episode key", () => {
    expect(parseProgressKey("1396:s1e7")).toEqual({
      id: "1396",
      season: 1,
      episode: 7,
    });
  });

  it("ignores case and stray whitespace in stored keys", () => {
    expect(parseProgressKey(" 1396:S01E07 ")).toEqual({
      id: "1396",
      season: 1,
      episode: 7,
    });
  });

  it("rejects a key that carries no addressable id", () => {
    expect(parseProgressKey("")).toBeNull();
    expect(parseProgressKey("   ")).toBeNull();
    expect(parseProgressKey("movie-603")).toBeNull();
    expect(parseProgressKey("1396:s1")).toBeNull();
    expect(parseProgressKey("1396:s0e1")).toEqual({ id: "1396" });
  });
});

describe("round trip", () => {
  it("returns to the episode it was built from", () => {
    const key = progressKey(1396, "tv", 3, 12);
    const parts = parseProgressKey(key);
    expect(parts).not.toBeNull();
    expect(progressKey(parts!.id, "tv", parts!.season, parts!.episode)).toBe(
      key,
    );
  });
});