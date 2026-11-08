import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTrailer,
  fetchTrailerByTmdbId,
  qualityFromHeight,
} from "./api";

const TRAILER = {
  provider: "youtube",
  id: "YoHD9XEInc0",
  title: "Inception — Official Trailer",
  embed_url: "https://www.youtube.com/embed/YoHD9XEInc0",
  thumb_url: "https://i.ytimg.com/vi/YoHD9XEInc0/hqdefault.jpg",
};

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof mockFetch>): URL {
  return new URL(String(fetchMock.mock.calls[0]?.[0]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trailer lookups", () => {
  it("asks the trailer route by title, year and type", async () => {
    const fetchMock = mockFetch({ trailer: TRAILER });

    await expect(fetchTrailer("Inception", 2010)).resolves.toEqual(TRAILER);

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/api/trailer");
    expect(url.searchParams.get("title")).toBe("Inception");
    expect(url.searchParams.get("year")).toBe("2010");
    expect(url.searchParams.get("type")).toBe("movie");
  });

  it("passes the series media type through instead of assuming a film", async () => {
    const fetchMock = mockFetch({ trailer: TRAILER });

    await fetchTrailer("Severance", 2022, "tv");

    expect(requestedUrl(fetchMock).searchParams.get("type")).toBe("tv");
  });

  it("returns null when the route has no playable trailer", async () => {
    mockFetch({ trailer: null });
    await expect(fetchTrailer("Inception", 2010)).resolves.toBeNull();
  });

  it("treats an error response as no trailer rather than throwing", async () => {
    mockFetch({ error: "nope" }, { ok: false, status: 502 });
    await expect(fetchTrailer("Inception", 2010)).resolves.toBeNull();
  });

  it("returns null for the id-based lookup when the id is not numeric", async () => {
    const fetchMock = mockFetch({ trailer: TRAILER });
    // Catalogue slugs are not TMDB ids; sending one would only search for the
    // wrong thing, so the call is skipped entirely.
    await expect(fetchTrailerByTmdbId("inception-2010")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks a numeric id up directly, without a title search", async () => {
    const fetchMock = mockFetch({ trailer: TRAILER });

    await expect(fetchTrailerByTmdbId(27205, "movie")).resolves.toEqual(TRAILER);

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get("id")).toBe("27205");
    expect(url.searchParams.has("title")).toBe(false);
  });

  it("does not request a trailer for a blank title", async () => {
    const fetchMock = mockFetch({ trailer: TRAILER });
    await expect(fetchTrailer("   ")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(qualityFromHeight(1080)).not.toBe("4K");
    expect(qualityFromHeight(480)).not.toBe("4K");
  });

  it("holds the neutral rung when the height is missing", () => {
    expect(qualityFromHeight(0)).toBe("480p");
    expect(qualityFromHeight(Number.NaN)).toBe("480p");
  });
});
