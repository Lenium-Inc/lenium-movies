import { afterEach, describe, expect, it } from "vitest";
import { absoluteUrl, siteUrl } from "./siteUrl";

/**
 * These run in vitest's `node` environment, so there is no `window` and every
 * assertion here is about the build-time fallback. The browser branch is the one
 * that matters in production and the one a `node`-environment test cannot reach,
 * which is exactly why the fallback is allowed to return `""` rather than
 * inventing a host.
 */

const originalEnv = { ...import.meta.env };

afterEach(() => {
  import.meta.env.VITE_SITE_URL = originalEnv.VITE_SITE_URL;
});

describe("siteUrl", () => {
  it("returns the configured origin when there is no window", () => {
    import.meta.env.VITE_SITE_URL = "https://streamvy.example";
    expect(siteUrl()).toBe("https://streamvy.example");
  });

  it("strips a trailing slash so paths do not double up", () => {
    import.meta.env.VITE_SITE_URL = "https://streamvy.example/";
    expect(siteUrl()).toBe("https://streamvy.example");
  });

  it("prefers the browser origin over the configured one", () => {
    // The reason the helper exists: a configured host that disagrees with the
    // one being viewed is the bug, not the case.
    import.meta.env.VITE_SITE_URL = "https://stale.example";
    (globalThis as { window?: unknown }).window = {
      location: { origin: "https://preview.streamvy.example" },
    };
    try {
      expect(siteUrl()).toBe("https://preview.streamvy.example");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("returns empty rather than guessing a host", () => {
    import.meta.env.VITE_SITE_URL = "";
    expect(siteUrl()).toBe("");
  });
});

describe("absoluteUrl", () => {
  it("prefixes a root-relative path with the origin", () => {
    import.meta.env.VITE_SITE_URL = "https://streamvy.example";
    expect(absoluteUrl("/watch/1396?type=tv")).toBe(
      "https://streamvy.example/watch/1396?type=tv"
    );
  });

  it("tolerates a path with no leading slash", () => {
    import.meta.env.VITE_SITE_URL = "https://streamvy.example";
    expect(absoluteUrl("watch/1396")).toBe(
      "https://streamvy.example/watch/1396"
    );
  });

  it("returns the path untouched when no origin is known", () => {
    import.meta.env.VITE_SITE_URL = "";
    expect(absoluteUrl("/watch/1396")).toBe("/watch/1396");
  });

  it("passes an already-absolute URL through instead of concatenating", () => {
    import.meta.env.VITE_SITE_URL = "https://streamvy.example";
    expect(absoluteUrl("https://image.tmdb.org/t5/p/original/x.jpg")).toBe(
      "https://image.tmdb.org/t5/p/original/x.jpg"
    );
  });
});
