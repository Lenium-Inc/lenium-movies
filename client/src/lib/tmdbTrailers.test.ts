import { describe, expect, it } from "vitest";
import type { TrailerInfo } from "@/services/api";
import { resolveTrailer, trailerThumbnail } from "./tmdbTrailers";

/**
 * `resolveTrailer` is the only place in the app that builds a frame URL, so
 * these tests are about which of two available answers wins, not about the
 * parameter spellings -- those are pinned down by the player, not by us.
 */

const youtube: TrailerInfo = { provider: "youtube", id: "abc123" };
const vimeo: TrailerInfo = { provider: "vimeo", id: "99" };
const dailymotion: TrailerInfo = { provider: "dailymotion", id: "dm1" };

describe("resolveTrailer", () => {
  it("prefers the backend's embed URL when it has one", () => {
    const trailer: TrailerInfo = {
      ...youtube,
      embed_url: "https://www.youtube-nocookie.com/embed/from-server",
    };
    expect(resolveTrailer(trailer)?.src).toContain("/embed/from-server?");

    // And the one thing the server must not have to know is still ours: the
    // playback parameters, which are a property of the embed rather than of
    // the site.
    expect(resolveTrailer(trailer)?.src).toContain("autoplay=1");
    expect(resolveTrailer(trailer)?.src).toContain("enablejsapi=1");
  });

  it("keeps playback parameters when the backend URL already has a query", () => {
    const trailer: TrailerInfo = {
      ...youtube,
      embed_url: "https://www.youtube-nocookie.com/embed/from-server?rel=0",
    };
    const src = resolveTrailer(trailer)?.src;
    expect(src).toContain("rel=0");
    // `&` not `?`, or every parameter below the first would be discarded and
    // the hero would silently stop autolooping.
    expect(src).toContain("&autoplay=1");
  });

  it("builds the base itself when only a provider and id are given", () => {
    expect(resolveTrailer(youtube)?.src).toContain(
      "https://www.youtube-nocookie.com/embed/abc123"
    );
    expect(resolveTrailer(vimeo)?.src).toContain(
      "https://player.vimeo.com/video/99"
    );
    expect(resolveTrailer(dailymotion)?.src).toContain(
      "https://www.dailymotion.com/embed/video/dm1"
    );
  });

  it("returns null for a site it cannot frame", () => {
    // No iframe with a src the browser will refuse, and no guess at the URL.
    expect(resolveTrailer({ provider: "SomeHost", id: "x" })).toBeNull();
    expect(resolveTrailer({ provider: "", id: "x" })).toBeNull();
    expect(resolveTrailer(null)).toBeNull();
    expect(resolveTrailer({ provider: "youtube", id: "" })).toBeNull();
  });

  it("turns an unknown provider into null rather than a default branch", () => {
    // `toSite` normalizes case, so the backend's "YouTube" and the older
    // "youtube" both resolve -- the regression that once returned nothing at all.
    expect(resolveTrailer({ provider: "YouTube", id: "abc" })).not.toBeNull();
    expect(resolveTrailer({ provider: "Vimeo", id: "99" })).not.toBeNull();
  });
});

describe("trailerThumbnail", () => {
  it("prefers the backend's thumbnail when it has one", () => {
    const trailer: TrailerInfo = {
      ...youtube,
      thumb_url: "https://i.ytimg.com/vi/from-server/hqdefault.jpg",
    };
    expect(trailerThumbnail(trailer)).toBe(
      "https://i.ytimg.com/vi/from-server/hqdefault.jpg"
    );
  });

  it("falls back to the image host, not to a frame origin", () => {
    // `TRAILER_ORIGINS.youtube` is youtube-nocookie, which serves frames, not
    // images. Building the thumbnail from it produced a URL that never resolves
    // and left the letterbox visible while the embed loaded.
    const src = trailerThumbnail(youtube);
    expect(src).toBe("https://i.ytimg.com/vi/abc123/hqdefault.jpg");
    expect(src).not.toContain("youtube-nocookie.com/vi/");
  });

  it("returns null where no thumbnail exists", () => {
    expect(trailerThumbnail(vimeo)).toBeNull();
    expect(trailerThumbnail({ provider: "SomeHost", id: "x" })).toBeNull();
    expect(trailerThumbnail(null)).toBeNull();
  });
});
