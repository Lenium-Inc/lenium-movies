import { describe, expect, it } from "vitest";

import { glowBackground, glowPalette } from "./glow";

describe("glowPalette", () => {
  it("maps a known genre to a stable hue", () => {
    const horror = glowPalette(["Horror"], 1);
    const western = glowPalette(["Western"], 1);
    expect(horror.primary).not.toBe(western.primary);
  });

  it("is case and whitespace insensitive on genre names", () => {
    expect(glowPalette(["  sCiFi "], 7).primary).toBe(
      glowPalette(["science fiction"], 7).primary
    );
  });

  it("is deterministic for the same title", () => {
    expect(glowPalette(["Drama"], "abc")).toEqual(glowPalette(["Drama"], "abc"));
  });

  it("varies by title when the genre is unknown", () => {
    const a = glowPalette(["Wholesome Unreleased Documentary Short"], "tt1");
    const b = glowPalette(["Wholesome Unreleased Documentary Short"], "tt2");
    expect(a.primary).not.toBe(b.primary);
  });

  it("is stable for the same unknown-genre title", () => {
    expect(glowPalette(["Something Unmapped"], "tt9")).toEqual(
      glowPalette(["Something Unmapped"], "tt9")
    );
  });

  it("survives missing, empty, and non-string genre input", () => {
    for (const input of [undefined, [], [""], ["  "]]) {
      expect(() => glowPalette(input, 5)).not.toThrow();
    }
  });

  it("offsets the second blob so the pair is not one flat wash", () => {
    const { primary, secondary } = glowPalette(["Action"], 3);
    expect(primary).not.toBe(secondary);
  });

  it("emits parseable hsl colours with alpha", () => {
    const { primary, secondary } = glowPalette(["Comedy"], 2);
    expect(primary).toMatch(/^hsl\(\d+ 82% 56% \/ 0\.55\)$/);
    expect(secondary).toMatch(/^hsl\(\d+ 82% 56% \/ 0\.45\)$/);
  });
});

describe("glowBackground", () => {
  it("builds the two-stop radial aura behind the card", () => {
    const background = glowBackground(glowPalette(["Thriller"], 4));
    expect(background).toContain("radial-gradient(circle at 30% 30%");
    expect(background).toContain("radial-gradient(circle at 70% 60%");
    expect(background).toContain("transparent 70%");
  });
});
