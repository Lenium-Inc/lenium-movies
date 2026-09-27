import { describe, expect, it } from "vitest";
import {
  isTmdbImageUrl,
  POSTER_SIZES_ATTRIBUTE,
  POSTER_SRCSET_SIZES,
  tmdbImage,
  tmdbImageAtSize,
  tmdbSrcSet,
} from "./tmdbImages";

const W500 =
  "https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg";

describe("tmdbImageAtSize", () => {
  it("re-points a TMDB url at another rendition", () => {
    expect(tmdbImageAtSize(W500, "original")).toBe(
      "https://image.tmdb.org/t/p/original/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg"
    );
    expect(tmdbImageAtSize(W500, "w780")).toBe(
      "https://image.tmdb.org/t/p/w780/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg"
    );
  });

  // This is the bug the helper exists for: the stored url is already absolute,
  // so a `startsWith("http")` bail-out pinned the hero to the stored w1280.
  it("upgrades a stored backdrop even though it is already absolute", () => {
    const stored = "https://image.tmdb.org/t/p/w1280/abc123.jpg";
    expect(tmdbImageAtSize(stored, "original")).toBe(
      "https://image.tmdb.org/t/p/original/abc123.jpg"
    );
  });

  it("keeps the path, query and extension intact", () => {
    expect(
      tmdbImageAtSize(
        "https://image.tmdb.org/t/p/w500/hash.jpg?v=2",
        "original"
      )
    ).toBe("https://image.tmdb.org/t/p/original/hash.jpg?v=2");
  });

  it("leaves non-TMDB hosts alone", () => {
    const archive =
      "https://archive.org/download/SomeMovie/__ia_thumb.jpg";
    expect(tmdbImageAtSize(archive, "original")).toBe(archive);
    expect(
      tmdbImageAtSize("https://via.placeholder.com/500x750?text=x", "w780")
    ).toBe("https://via.placeholder.com/500x750?text=x");
  });

  it("does not mistake a lookalike host for TMDB", () => {
    // A regex that only checked the prefix would rewrite this and send the
    // request somewhere the caller never named.
    const evil = "https://image.tmdb.org.evil.test/t/p/w500/x.jpg";
    expect(tmdbImageAtSize(evil, "original")).toBe(evil);
  });

  it("returns an empty string for nothing", () => {
    expect(tmdbImageAtSize(null, "original")).toBe("");
    expect(tmdbImageAtSize(undefined, "original")).toBe("");
    expect(tmdbImageAtSize("", "original")).toBe("");
  });
});

describe("tmdbImage", () => {
  it("builds a url from a bare TMDB path", () => {
    expect(tmdbImage("/abc123.jpg", "original")).toBe(
      "https://image.tmdb.org/t/p/original/abc123.jpg"
    );
  });

  it("normalises a full url through the same rendition", () => {
    expect(tmdbImage(W500, "w342")).toBe(
      "https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg"
    );
  });

  it("passes anything else through untouched", () => {
    const archive = "https://archive.org/download/M/__ia_thumb.jpg";
    expect(tmdbImage(archive, "original")).toBe(archive);
    expect(tmdbImage("data:image/gif;base64,R0lGOD", "original")).toBe(
      "data:image/gif;base64,R0lGOD"
    );
  });
});

describe("isTmdbImageUrl", () => {
  it("recognises only genuine TMDB image urls", () => {
    expect(isTmdbImageUrl(W500)).toBe(true);
    expect(isTmdbImageUrl("https://image.tmdb.org/t/p/original/a.jpg")).toBe(
      true
    );
    expect(isTmdbImageUrl("https://archive.org/download/M/__ia_thumb.jpg")).toBe(
      false
    );
    expect(isTmdbImageUrl("/abc.jpg")).toBe(false);
    expect(isTmdbImageUrl(null)).toBe(false);
  });
});

describe("tmdbSrcSet", () => {
  it("emits one candidate per size with width descriptors", () => {
    expect(tmdbSrcSet(W500, ["w342", "w500", "w780"])).toBe(
      "https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg 342w, " +
        "https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg 500w, " +
        "https://image.tmdb.org/t/p/w780/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg 780w"
    );
  });

  it("omits the attribute for non-TMDB images", () => {
    // A one-candidate srcset is worse than none: it adds a second URL to
    // resolve without letting the browser choose anything.
    expect(
      tmdbSrcSet("https://archive.org/download/M/__ia_thumb.jpg", ["w500"])
    ).toBeUndefined();
    expect(tmdbSrcSet(null, ["w500"])).toBeUndefined();
    expect(tmdbSrcSet(W500, [])).toBeUndefined();
  });

  it("never advertises `original`, which has no width descriptor", () => {
    const set = tmdbSrcSet(W500, POSTER_SRCSET_SIZES) ?? "";
    expect(set).not.toContain("original");
    expect(set.split(", ")).toHaveLength(POSTER_SRCSET_SIZES.length);
  });
});

describe("POSTER_SIZES_ATTRIBUTE", () => {
  it("stays consistent with the poster srcset", () => {
    // The `sizes` claim and the offered renditions have to agree: if `sizes`
    // promises more pixels than the largest candidate provides, the browser
    // silently picks the smallest and the poster goes soft again.
    const widest = Math.max(
      ...POSTER_SRCSET_SIZES.map(size => parseInt(size.slice(1), 10))
    );
    const promised = Math.max(
      ...POSTER_SIZES_ATTRIBUTE.split(", ")
        .map(part => part.trim().split(/\s+/).pop() ?? "")
        .filter(part => part.endsWith("px"))
        .map(part => parseInt(part, 10))
    );
    expect(widest).toBeGreaterThanOrEqual(promised * 2);
  });
});
