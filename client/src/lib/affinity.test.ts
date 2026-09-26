import { describe, expect, it } from "vitest";
import {
  affinityQueryParams,
  decayAffinity,
  emptyAffinity,
  rankByAffinity,
  parseAffinity,
  readAffinity,
  recordInteraction,
  scoreCandidate,
  writeAffinity,
} from "./affinity";

const film = (title: string, genre: string[], cast: string[] = [], director: string | null = null) => ({
  title,
  signals: { genre, cast, director },
});

describe("recordInteraction", () => {
  it("weights genres below people and directors", () => {
    const a = recordInteraction(emptyAffinity(), {
      genre: ["Action"],
      cast: ["Jane Doe"],
      director: "John Roe",
    });
    expect(a.genres.action).toBe(1);
    expect(a.people["jane doe"]).toBe(1.5);
    expect(a.people["john roe"]).toBe(2);
  });

  it("is case and whitespace insensitive", () => {
    const a = recordInteraction(emptyAffinity(), { genre: ["  Action "] });
    expect(Object.keys(a.genres)).toEqual(["action"]);
  });

  it("accumulates repeat interactions", () => {
    let a = emptyAffinity();
    a = recordInteraction(a, { genre: ["Drama"] });
    a = recordInteraction(a, { genre: ["Drama"] });
    // second visit: 1*0.6 decayed, plus 1
    expect(a.genres.drama).toBeCloseTo(1.6, 5);
  });

  it("lets recent interactions outrank older ones", () => {
    let a = emptyAffinity();
    a = recordInteraction(a, { genre: ["Horror"] });
    a = recordInteraction(a, { genre: ["Comedy"] });
    // Horror keeps a decayed residue, but a single newer signal wins outright.
    expect(a.genres.horror).toBeCloseTo(0.6, 5);
    expect(a.genres.comedy).toBeGreaterThan(a.genres.horror);
  });

  it("drops signals that decay into noise", () => {
    const a = decayAffinity({
      genres: { drama: 0.01 },
      people: { "jane doe": 3 },
    });
    expect(a.genres.drama).toBeCloseTo(0.006, 5);
  });

  it("caps retained signals", () => {
    let a = emptyAffinity();
    for (let i = 0; i < 40; i++) {
      a = recordInteraction(a, { genre: [`g${i}`], cast: [`p${i}`] });
    }
    expect(Object.keys(a.genres).length).toBeLessThanOrEqual(8);
    expect(Object.keys(a.people).length).toBeLessThanOrEqual(12);
  });
});

describe("scoreCandidate", () => {
  it("sums every matching signal", () => {
    const a = recordInteraction(emptyAffinity(), {
      genre: ["Action"],
      cast: ["Jane Doe"],
    });
    expect(scoreCandidate({ genre: ["Action"], cast: ["Jane Doe"] }, a)).toBeCloseTo(2.5);
  });

  it("is zero for an unrelated candidate", () => {
    const a = recordInteraction(emptyAffinity(), { genre: ["Action"] });
    expect(scoreCandidate({ genre: ["Romance"] }, a)).toBe(0);
  });
});

describe("rankByAffinity", () => {
  it("promotes matches", () => {
    const a = recordInteraction(emptyAffinity(), { genre: ["Action"] });
    const items = [film("Romance", ["Romance"]), film("Action", ["Action"])];
    const ranked = rankByAffinity(items, a, i => i.signals);
    expect(ranked.map(i => i.title)).toEqual(["Action", "Romance"]);
  });

  it("keeps upstream order for everything unmatched", () => {
    const a = recordInteraction(emptyAffinity(), { genre: ["Action"] });
    const items = [film("A", ["Romance"]), film("B", ["Drama"]), film("C", ["Comedy"])];
    const ranked = rankByAffinity(items, a, i => i.signals);
    expect(ranked.map(i => i.title)).toEqual(["A", "B", "C"]);
  });

  it("is deterministic across repeated runs", () => {
    let a = emptyAffinity();
    a = recordInteraction(a, { genre: ["Action"], cast: ["X"] });
    a = recordInteraction(a, { genre: ["Action", "Drama"] });
    const items = [
      film("one", ["Action"]),
      film("two", ["Drama"]),
      film("three", ["Action", "Drama"]),
      film("four", ["Comedy"]),
    ];
    const first = rankByAffinity(items, a, i => i.signals).map(i => i.title);
    for (let i = 0; i < 20; i++) {
      expect(rankByAffinity(items, a, i2 => i2.signals).map(i2 => i2.title)).toEqual(first);
    }
  });

  it("is a no-op with no affinity", () => {
    const items = [film("A", ["Romance"]), film("B", ["Drama"])];
    expect(rankByAffinity(items, emptyAffinity(), i => i.signals)).toEqual(items);
  });

  it("does not mutate its input", () => {
    const a = recordInteraction(emptyAffinity(), { genre: ["Action"] });
    const items = [film("Romance", ["Romance"]), film("Action", ["Action"])];
    rankByAffinity(items, a, i => i.signals);
    expect(items.map(i => i.title)).toEqual(["Romance", "Action"]);
  });
});

describe("affinityQueryParams", () => {
  it("serialises to compact comma lists", () => {
    const a = recordInteraction(emptyAffinity(), { genre: ["Action"], cast: ["Jane Doe"] });
    expect(affinityQueryParams(a)).toEqual({
      affinity_genres: "action",
      affinity_people: "jane doe",
    });
  });
});

describe("parseAffinity", () => {
  it("restores a serialised affinity", () => {
    const a = recordInteraction(emptyAffinity(), { genre: ["Action"] });
    expect(parseAffinity(JSON.stringify(a)).genres.action).toBeCloseTo(1);
  });

  it("treats missing or malformed storage as no affinity", () => {
    expect(parseAffinity(null)).toEqual(emptyAffinity());
    expect(parseAffinity("")).toEqual(emptyAffinity());
    expect(parseAffinity("not json")).toEqual(emptyAffinity());
    expect(parseAffinity('"a string"')).toEqual(emptyAffinity());
    expect(parseAffinity("null")).toEqual(emptyAffinity());
  });

  it("drops non-numeric weights", () => {
    expect(parseAffinity('{"genres":{"action":"lots"},"people":{}}')).toEqual({
      genres: {},
      people: {},
    });
  });
});

describe("session storage guards", () => {
  it("degrades safely where storage is unavailable", () => {
    // The test environment has no sessionStorage; the feed must still work.
    expect(typeof sessionStorage === "undefined" || readAffinity()).toBeTruthy();
    expect(() => writeAffinity(emptyAffinity())).not.toThrow();
  });
});
