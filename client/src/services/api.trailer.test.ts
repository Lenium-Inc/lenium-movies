import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchTrailerByTmdbId,
  qualityFromHeight,
  resolveStream,
} from "./api";

/**
 * Two independent bugs hid behind "the trailer doesn't play".
 *
 * The backend answers `{"trailer": {"provider", "id"}}`, but the client only
 * ever parsed a bare JSON string, so every successful response was discarded
 * and the hero stayed on backdrop art. Separately the request carried no media
 * type, and a TMDB id is only meaningful against its own type -- id 1396 is a
 * film and a series at once, so a mislabelled request returns a real, wrong
 * trailer rather than an obvious error.
 */
describe("fetchTrailerByTmdbId", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function mockJsonOnce(body: unknown, status = 200) {
    const spy = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("parses the documented object payload", async () => {
    mockJsonOnce({ trailer: { provider: "youtube", id: "L2NAh3CIdig" } });

    await expect(fetchTrailerByTmdbId(299534, "movie")).resolves.toEqual({
      provider: "youtube",
      id: "L2NAh3CIdig",
    });
  });

  it("returns null when the backend reports no trailer", async () => {
    mockJsonOnce({ trailer: null });
    await expect(fetchTrailerByTmdbId(999999999, "movie")).resolves.toBeNull();
  });

  it("sends the media type alongside the id", async () => {
    const spy = mockJsonOnce({ trailer: null });
    await fetchTrailerByTmdbId(66732, "tv");

    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("id=66732");
    expect(url).toContain("media_type=tv");
  });

  it("treats a 404 as no trailer rather than an error", async () => {
    mockJsonOnce({}, 404);
    await expect(fetchTrailerByTmdbId(1, "movie")).resolves.toBeNull();
  });

  it("rejects a malformed payload instead of silently dropping it", async () => {
    // Silently returning null here is what made the failure look like
    // "no trailer exists" for months.
    mockJsonOnce({ trailer: { id: 12345 } });
    await expect(fetchTrailerByTmdbId(1, "movie")).rejects.toThrow(
      /unexpected trailer shape/
    );
  });
});

describe("resolveStream stream preservation", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function mockResolveBody(movie: Record<string, unknown>) {
    // `resolveStream` reads the body with `text()` so it can hand the raw
    // string to its error classifier, so the mock has to provide that.
    const body = { available: true, exact: true, movie };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
    );
  }

  it("keeps the stream list the backend sent", async () => {
    // `pickDownloadCandidate` prefers `streams` over `stream_url` because the
    // primary URL is often an HLS playlist or an embed while the list holds a
    // saveable file. The normalizer rebuilt the movie field by field and never
    // copied the list, so every candidate search fell back to the wrong field.
    mockResolveBody({
      id: "603",
      title: "The Matrix",
      media_type: "movie",
      stream_url: "https://vidsrc.me/embed/movie?tmdb=603",
      streams: [
        {
          url: "https://archive.org/download/matrix/matrix.mp4",
          quality: "1080p",
          width: 1920,
          height: 1080,
          size: 123456,
        },
      ],
    });

    const result = await resolveStream("The Matrix", 1999);

    expect(result.stream.streams).toHaveLength(1);
    expect(result.stream.streams?.[0]).toEqual({
      url: "https://archive.org/download/matrix/matrix.mp4",
      quality: "1080p",
      width: 1920,
      height: 1080,
      size: 123456,
    });
  });

  it("drops stream entries without a usable url", async () => {
    mockResolveBody({
      id: "1",
      title: "Broken",
      media_type: "movie",
      stream_url: "https://example.test/embed",
      streams: [{ url: "", quality: "720p" }, { quality: "480p" }],
    });

    const result = await resolveStream("Broken", null);
    expect(result.stream.streams ?? []).toHaveLength(0);
  });
});

describe("qualityFromHeight", () => {
  it("maps a real resolution to its rung instead of parsing the label", () => {
    expect(qualityFromHeight(2160)).toBe("4K");
    expect(qualityFromHeight(1080)).toBe("1080p");
    expect(qualityFromHeight(720)).toBe("720p");
    expect(qualityFromHeight(480)).toBe("480p");
    expect(qualityFromHeight(360)).toBe("320p");
  });

  it("does not let parseInt('4K') capture ordinary heights", () => {
    // "4K" parses to 4, so a naive >= scan returned 4K for everything.
    expect(qualityFromHeight(1080)).not.toBe("4K");
    expect(qualityFromHeight(480)).not.toBe("4K");
  });

  it("holds the neutral rung when the height is missing", () => {
    expect(qualityFromHeight(0)).toBe("480p");
    expect(qualityFromHeight(Number.NaN)).toBe("480p");
  });
});
