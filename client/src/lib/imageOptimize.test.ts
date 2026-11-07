import { describe, expect, it } from "vitest";
import {
  BACKDROP_IMAGE_SIZES,
  optimizedImage,
  posterSrcSet,
} from "./imageOptimize";

const AONEROOM =
  "https://pbcdn.aoneroom.com/image/2026/11/06/8a851d81a92520e6979c7984e757e3fe.webp";
const TMDB =
  "https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg";

describe("optimizedImage", () => {
  it("routes the catalogue CDN through the downscaler at the asked width", () => {
    const url = optimizedImage(AONEROOM, 342);
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/\/image$/);
    expect(parsed.searchParams.get("url")).toBe(AONEROOM);
    expect(parsed.searchParams.get("w")).toBe("342");
    expect(parsed.searchParams.get("f")).toBe("webp");
  });

  it("clamps the requested width to the proxy's supported range", () => {
    expect(new URL(optimizedImage(AONEROOM, 5000)).searchParams.get("w")).toBe(
      "2048"
    );
    expect(new URL(optimizedImage(AONEROOM, 10)).searchParams.get("w")).toBe(
      "64"
    );
  });

  it("rewrites a TMDB url instead of proxying it", () => {
    expect(optimizedImage(TMDB, 342)).toBe(
      "https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg"
    );
  });

  it("normalises a bare TMDB path", () => {
    expect(optimizedImage("/abc123.jpg", 185)).toBe(
      "https://image.tmdb.org/t/p/w185/abc123.jpg"
    );
  });

  it("passes through hosts it cannot improve", () => {
    const other = "https://example.com/poster.jpg";
    expect(optimizedImage(other, 342)).toBe(other);
    expect(optimizedImage("", 342)).toBe("");
  });
});

describe("posterSrcSet", () => {
  it("offers three proxy renditions for the catalogue CDN", () => {
    const srcset = posterSrcSet(AONEROOM);
    expect(srcset?.split(", ").map(part => part.split(" ")[1])).toEqual([
      "180w",
      "342w",
      "500w",
    ]);
    for (const candidate of srcset!.split(", ")) {
      expect(new URL(candidate.split(" ")[0]).pathname).toMatch(/\/image$/);
    }
  });

  it("builds TMDB candidates, including for a bare path", () => {
    expect(posterSrcSet(TMDB)?.split(", ")).toContain(
      "https://image.tmdb.org/t/p/w342/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg 342w"
    );
    expect(posterSrcSet("/abc123.jpg")?.split(", ")).toContain(
      "https://image.tmdb.org/t/p/w342/abc123.jpg 342w"
    );
  });

  it("returns undefined for a host with no renditions to offer", () => {
    expect(posterSrcSet("https://example.com/poster.jpg")).toBeUndefined();
    expect(posterSrcSet(null)).toBeUndefined();
  });

  it("sizes hero art to the full viewport", () => {
    expect(BACKDROP_IMAGE_SIZES).toBe("100vw");
  });
});
