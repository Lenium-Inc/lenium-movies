import { describe, expect, it } from "vitest";
import { buildWatchPath, resolveMediaType } from "./watchRoute";

describe("resolveMediaType", () => {
  it("prefers local metadata over a disagreeing resolver", () => {
    // The real failure: TMDB says film, the stream resolver said "tv".
    expect(
      resolveMediaType({ localMediaType: "movie", resolverMediaType: "tv" }),
    ).toBe("movie");
    expect(
      resolveMediaType({ localMediaType: "tv", resolverMediaType: "movie" }),
    ).toBe("tv");
  });

  it("prefers local metadata over a disagreeing URL", () => {
    expect(
      resolveMediaType({ localMediaType: "movie", urlType: "tv" }),
    ).toBe("movie");
  });

  it("falls back to the resolver while local metadata is loading", () => {
    expect(
      resolveMediaType({ localMediaType: null, resolverMediaType: "tv" }),
    ).toBe("tv");
    expect(
      resolveMediaType({ resolverMediaType: "movie", urlType: "tv" }),
    ).toBe("movie");
  });

  it("falls back to the URL when nothing else is known", () => {
    expect(resolveMediaType({ urlType: "tv" })).toBe("tv");
    expect(resolveMediaType({ urlType: "movie" })).toBe("movie");
    expect(resolveMediaType({})).toBe("movie");
  });

  it("ignores a nonsense resolver value", () => {
    expect(
      resolveMediaType({ resolverMediaType: "series", urlType: "tv" }),
    ).toBe("tv");
    expect(resolveMediaType({ resolverMediaType: "series" })).toBe("movie");
  });
});

describe("buildWatchPath", () => {
  it("never puts season/episode on a film", () => {
    expect(buildWatchPath(22980, { mediaType: "movie" })).toBe(
      "/watch/22980",
    );
    // Even if a caller passes them, a film must not receive them.
    expect(
      buildWatchPath(22980, { mediaType: "movie", season: 1, episode: 1 }),
    ).toBe("/watch/22980");
  });

  it("writes series params for a series", () => {
    expect(
      buildWatchPath(1396, { mediaType: "tv", season: 2, episode: 5 }),
    ).toBe("/watch/1396?season=2&episode=5&type=tv");
  });

  it("defaults series params to S1E1", () => {
    expect(buildWatchPath(1396, { mediaType: "tv" })).toBe(
      "/watch/1396?season=1&episode=1&type=tv",
    );
  });

  it("defaults to a film when no options are given", () => {
    expect(buildWatchPath(22980)).toBe("/watch/22980");
  });
});
