import { describe, expect, it } from "vitest";

import { baseLanguage, sameLanguage } from "./language";

describe("baseLanguage", () => {
  it("keeps a two-letter code as it is", () => {
    expect(baseLanguage("en")).toBe("en");
    expect(baseLanguage("pt")).toBe("pt");
  });

  it("drops region and script subtags", () => {
    // `pt-BR` and `pt_br` are the same language for the only question this
    // answers -- is this track in the viewer's language.
    expect(baseLanguage("pt-BR")).toBe("pt");
    expect(baseLanguage("pt_br")).toBe("pt");
    expect(baseLanguage("zh-Hans-CN")).toBe("zh");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(baseLanguage("  EN  ")).toBe("en");
    expect(baseLanguage("ES")).toBe("es");
  });

  it("translates the three-letter codes the subtitle filenames use", () => {
    // Archive.org names caption files with ISO 639-2/B codes, so a Portuguese
    // track arrives as `por` while the viewer's detected language is `pt`.
    expect(baseLanguage("por")).toBe("pt");
    expect(baseLanguage("eng")).toBe("en");
    expect(baseLanguage("spa")).toBe("es");
    expect(baseLanguage("zho")).toBe("zh");
  });

  it("passes through a code it has no mapping for", () => {
    // An unknown language is still a language; dropping it would silently
    // unmatch a viewer who speaks one we did not anticipate.
    expect(baseLanguage("tr")).toBe("tr");
    expect(baseLanguage("xxq")).toBe("xxq");
  });

  it("returns empty when there is nothing to match on", () => {
    expect(baseLanguage(null)).toBe("");
    expect(baseLanguage(undefined)).toBe("");
    expect(baseLanguage("")).toBe("");
    expect(baseLanguage("   ")).toBe("");
  });
});

describe("sameLanguage", () => {
  it("matches the same language written two ways", () => {
    expect(sameLanguage("pt", "pt-BR")).toBe(true);
    expect(sameLanguage("en", "eng")).toBe(true);
    expect(sameLanguage("por", "pt")).toBe(true);
    expect(sameLanguage("EN", "en-GB")).toBe(true);
  });

  it("separates languages that merely share a prefix", () => {
    // `no` is Norwegian, `nb` is Norwegian Bokmål's neighbour, and `pt`/`pa`
    // have nothing to do with each other -- prefix matching would blur these.
    expect(sameLanguage("pt", "pa")).toBe(false);
    expect(sameLanguage("en", "de")).toBe(false);
    expect(sameLanguage("eng", "fra")).toBe(false);
  });

  it("never treats an unknown tag as a match", () => {
    // Empty is not evidence of agreement: every track with no declared
    // language would otherwise satisfy every preference at once.
    expect(sameLanguage("", "en")).toBe(false);
    expect(sameLanguage("en", null)).toBe(false);
    expect(sameLanguage(undefined, undefined)).toBe(false);
  });
});
