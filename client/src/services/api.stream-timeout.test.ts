import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API_ORIGIN = "https://media.test";

async function loadApi() {
  vi.resetModules();
  return import("./api");
}
const SUBJECT_ID = "6391474290696802080";
const DETAIL_PATH = "inception-e1BOR6f19C7";

const streamPayload = {
  subject_id: SUBJECT_ID,
  se: 0,
  ep: 0,
  has_resource: true,
  sources: [
    {
      resolution: "720p",
      format: "mp4",
      url: "https://cdn.test/inception-720.mp4",
      size: 1_000,
    },
    {
      resolution: "1080p",
      format: "mp4",
      url: "https://cdn.test/inception-1080.mp4",
      size: 2_000,
    },
  ],
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function mockFetch(handler: (url: string) => unknown) {
  const spy = vi.fn(async (input: RequestInfo | URL) =>
    handler(String(input))
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/**
 * Playback now needs both keys: the subject id (`tmdbId`) selects the media,
 * and the detail slug (`detailPath`) keys the lookup. Movies must be addressed
 * as season 0 / episode 0 -- the endpoint's `1/1` default is a season a film
 * does not have -- and every returned CDN URL has to be routed through the
 * proxy, because the CDN refuses a request without the MovieBox referer.
 */
describe("getStreamSource", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_STREAMVY_API_BASE_URL", API_ORIGIN);
    vi.stubEnv("VITE_STREAMVY_PROXY_BASE_URL", API_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("addresses a film as season 0, episode 0 and proxies every source", async () => {
    const { getStreamSource } = await loadApi();
    const spy = mockFetch(url =>
      url.includes("/captions")
        ? response({ captions: [] })
        : response(streamPayload)
    );

    const result = await getStreamSource({
      tmdbId: SUBJECT_ID,
      detailPath: DETAIL_PATH,
      mediaType: "movie",
    });

    const streamCall = spy.mock.calls
      .map(call => String(call[0]))
      .find(url => url.includes("/api/stream/") && !url.includes("/captions"));
    expect(streamCall).toBeDefined();
    const query = new URL(streamCall as string).searchParams;
    expect(query.get("detail_path")).toBe(DETAIL_PATH);
    expect(query.get("se")).toBe("0");
    expect(query.get("ep")).toBe("0");

    // Best rendition first, and every leg wrapped in the proxy idempotently.
    expect(result.streams?.[0]).toMatchObject({
      quality: "1080p",
      height: 1080,
      size: 2_000,
    });
    expect(result.url).toContain(`${API_ORIGIN}/proxy/stream?url=`);
    expect(result.url).toContain(
      encodeURIComponent("https://cdn.test/inception-1080.mp4")
    );
    expect(result.sources).toHaveLength(2);
  });

  it("scopes a series to the selected season and episode", async () => {
    const { getStreamSource } = await loadApi();
    const spy = mockFetch(url =>
      url.includes("/captions")
        ? response({ captions: [] })
        : response({ ...streamPayload, se: 2, ep: 5 })
    );

    await getStreamSource({
      tmdbId: SUBJECT_ID,
      detailPath: DETAIL_PATH,
      mediaType: "tv",
      season: 2,
      episode: 5,
    });

    const streamCall = spy.mock.calls
      .map(call => String(call[0]))
      .find(url => url.includes("/api/stream/") && !url.includes("/captions"));
    const query = new URL(streamCall as string).searchParams;
    expect(query.get("se")).toBe("2");
    expect(query.get("ep")).toBe("5");
  });

  it("reports a title with no sources as exhausted", async () => {
    const { getStreamSource, StreamExhaustedError } = await loadApi();
    mockFetch(url =>
      url.includes("/captions")
        ? response({ captions: [] })
        : response({ ...streamPayload, sources: [] })
    );

    await expect(
      getStreamSource({
        tmdbId: SUBJECT_ID,
        detailPath: DETAIL_PATH,
        mediaType: "movie",
      })
    ).rejects.toBeInstanceOf(StreamExhaustedError);
  });

  it("surfaces an upstream failure as a classifiable ApiError", async () => {
    const { getStreamSource, ApiError } = await loadApi();
    mockFetch(() => response({ detail: "bad gateway" }, 502));

    await expect(
      getStreamSource({
        tmdbId: SUBJECT_ID,
        detailPath: DETAIL_PATH,
        mediaType: "movie",
      })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("aborts a request that never answers", async () => {
    const { getStreamSource, STREAM_RESOLVE_TIMEOUT_MS } = await loadApi();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      )
    );

    const pending = getStreamSource({
      tmdbId: SUBJECT_ID,
      detailPath: DETAIL_PATH,
      mediaType: "movie",
    });
    const assertion = expect(pending).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(STREAM_RESOLVE_TIMEOUT_MS);
    await assertion;
  });
});
