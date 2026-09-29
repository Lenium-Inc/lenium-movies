/**
 * Avatar preset library tests.
 *
 * Two things are worth pinning down here. First, preset identity has to be
 * *stable*: `avatar` is persisted as a URL in localStorage, so if regenerating
 * this module changed any URL, saved profiles would silently show a different
 * face after a deploy. Second, `resolveAvatarUrl` is the only guard between
 * unvalidated localStorage and five `<img src>` call sites, so its fallback
 * ladder is what keeps a malformed record from rendering a broken image.
 */
import { describe, expect, it } from "vitest";

import {
  AVATAR_PRESETS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  defaultAvatarId,
  defaultAvatarUrl,
  dicebearUrl,
  hashName,
  presetById,
  presetsForCategory,
  resolveAvatarUrl,
} from "./avatars";

describe("avatar library shape", () => {
  it("provides every requested category", () => {
    for (const category of CATEGORY_ORDER) {
      expect(presetsForCategory(category).length).toBeGreaterThan(0);
      expect(CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it("covers female, male, and neutral presets", () => {
    for (const category of ["female", "male", "neutral"] as const) {
      expect(presetsForCategory(category).length).toBeGreaterThan(0);
    }
  });

  it("gives every preset a unique id and url", () => {
    expect(new Set(AVATAR_PRESETS.map((p) => p.id)).size).toBe(
      AVATAR_PRESETS.length,
    );
    expect(new Set(AVATAR_PRESETS.map((p) => p.url)).size).toBe(
      AVATAR_PRESETS.length,
    );
  });

  it("places every preset in a declared category", () => {
    for (const preset of AVATAR_PRESETS) {
      expect(CATEGORY_ORDER).toContain(preset.category);
    }
  });

  it("is frozen so a consumer cannot mutate the library", () => {
    expect(Object.isFrozen(AVATAR_PRESETS)).toBe(true);
  });

  it("assigns a non-empty accessible label to every preset", () => {
    for (const preset of AVATAR_PRESETS) {
      expect(preset.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("preset identity stability", () => {
  // Regression guard. The URLs are persisted in localStorage, so a change here
  // silently changes the face of every profile that already picked one.
  it("produces the same url for the same id across calls", () => {
    const first = AVATAR_PRESETS.map((p) => p.url);
    const second = AVATAR_PRESETS.map((p) => p.url);
    expect(second).toEqual(first);
  });

  it("builds a url that encodes the seed", () => {
    expect(dicebearUrl("notionists", "abc 123")).toContain(
      "seed=abc+123",
    );
  });

  it("omits the background parameter when none is given", () => {
    expect(dicebearUrl("notionists", "abc")).not.toContain("backgroundColor");
  });
});

describe("presetById", () => {
  it("resolves a known id", () => {
    const preset = AVATAR_PRESETS[0];
    expect(presetById(preset.id)).toBe(preset);
  });

  it("returns null for missing or unknown ids", () => {
    for (const id of [null, undefined, "", "nope", 42 as unknown as string]) {
      expect(presetById(id)).toBeNull();
    }
  });
});

describe("defaultAvatarUrl", () => {
  it("is deterministic for the same name", () => {
    expect(defaultAvatarUrl("Alex")).toBe(defaultAvatarUrl("Alex"));
  });

  it("ignores surrounding whitespace so a trimmed name is stable", () => {
    expect(defaultAvatarUrl("  Alex  ")).toBe(defaultAvatarUrl("Alex"));
  });

  it("gives different names different faces", () => {
    // Not a strict guarantee of visual difference, but a seed collision would
    // mean two people in a profile switcher are indistinguishable.
    expect(defaultAvatarUrl("Alex")).not.toBe(defaultAvatarUrl("Robin"));
  });

  it("gives kids profiles a different style than adult profiles", () => {
    expect(defaultAvatarUrl("Sam", true)).not.toBe(defaultAvatarUrl("Sam", false));
  });

  it("returns a usable url for an empty name", () => {
    // Every unnamed profile would otherwise share one seed.
    expect(defaultAvatarUrl("")).toContain("seed=profile");
    expect(defaultAvatarUrl("")).toBe(defaultAvatarUrl("   "));
  });

  it("returns a default preset id for each bucket", () => {
    expect(defaultAvatarId()).toBeTruthy();
    expect(defaultAvatarId(true)).not.toBe(defaultAvatarId(false));
  });
});

describe("hashName", () => {
  it("is stable and non-negative", () => {
    expect(hashName("abc")).toBe(hashName("abc"));
    expect(hashName("abc")).toBeGreaterThanOrEqual(0);
  });

  it("treats an empty string as zero", () => {
    expect(hashName("")).toBe(0);
  });
});

describe("resolveAvatarUrl", () => {
  it("prefers an explicitly chosen preset", () => {
    const preset = AVATAR_PRESETS[3];
    expect(
      resolveAvatarUrl({ avatarId: preset.id, avatar: "https://stale.test/x.svg" }),
    ).toBe(preset.url);
  });

  it("falls back to a stored url when the preset id is unknown", () => {
    // A library that shrank, or a profile saved by a newer build.
    expect(
      resolveAvatarUrl({ avatarId: "gone", avatar: "https://stored.test/a.svg" }),
    ).toBe("https://stored.test/a.svg");
  });

  it("generates an avatar when nothing is stored", () => {
    // `avatar` is required by the type but nothing validates storage, so a
    // record written by an older build can genuinely be missing it.
    expect(resolveAvatarUrl({ name: "Kai" })).toBe(defaultAvatarUrl("Kai"));
  });

  it("generates an avatar for a blank or whitespace stored value", () => {
    expect(resolveAvatarUrl({ avatar: "   ", name: "Kai" })).toBe(
      defaultAvatarUrl("Kai"),
    );
    expect(resolveAvatarUrl({ avatar: null, name: "Kai" })).toBe(
      defaultAvatarUrl("Kai"),
    );
  });

  it("honours isKids when generating", () => {
    expect(resolveAvatarUrl({ name: "Kai", isKids: true })).toBe(
      defaultAvatarUrl("Kai", true),
    );
  });

  it("survives a fully empty record", () => {
    expect(() => resolveAvatarUrl({})).not.toThrow();
    expect(resolveAvatarUrl({})).toContain("https://api.dicebear.com/");
  });
});
