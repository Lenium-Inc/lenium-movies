import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStreamSource,
  STREAM_RESOLVE_TIMEOUT_MS,
  StreamTimeoutError,
} from "./api";

/**
 * The Watch page decides whether to show the error screen by error type, not
 * message: a cold-start timeout must stay retryable while a real failure must
 * not. These pin that distinction and the exact budget.
 */
describe("getStreamSource timeout handling", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.test");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("allows a cold start window of at least 30 seconds", () => {
    // The brief asked for 30s: a Render free-tier instance scaled to zero needs
    // 15-20s to boot, so anything shorter fails a healthy service.
    expect(STREAM_RESOLVE_TIMEOUT_MS).toBe(30_000);
  });

  it("throws StreamTimeoutError when the backend never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          })
      )
    );

    const pending = getStreamSource({ tmdbId: "1", mediaType: "movie" });
    const assertion = expect(pending).rejects.toBeInstanceOf(StreamTimeoutError);

    await vi.advanceTimersByTimeAsync(STREAM_RESOLVE_TIMEOUT_MS);
    await assertion;
  });

  it("does not abort a request that answers in time", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        activeSource: "https://cdn.test/a.m3u8",
        mirrors: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = getStreamSource({ tmdbId: "1", mediaType: "movie" });
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await pending;
    expect(result.url).toBe("https://cdn.test/a.m3u8");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports a non-timeout failure as a plain Error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }))
    );

    // A 502 is the backend being awake and failing, so it must not be
    // mistaken for a cold start the retry loop should forgive.
    await expect(
      getStreamSource({ tmdbId: "1", mediaType: "movie" })
    ).rejects.toThrow(/status 502/);
    await expect(
      getStreamSource({ tmdbId: "1", mediaType: "movie" })
    ).rejects.not.toBeInstanceOf(StreamTimeoutError);
  });

  it("scopes the selected episode into the request", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        activeSource: "https://cdn.test/a.m3u8",
        mirrors: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getStreamSource({
      tmdbId: "1399",
      mediaType: "tv",
      season: 2,
      episode: 5,
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("tmdb_id=1399");
    expect(url).toContain("season=2");
    expect(url).toContain("episode=5");
  });
});
