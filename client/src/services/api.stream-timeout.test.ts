import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getStreamSource,
  STREAM_RESOLVE_TIMEOUT_MS,
  StreamExhaustedError,
  StreamTimeoutError,
} from "./api";

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Await a rejection and return it typed, so assertions can read its fields. */
async function rejection(promise: Promise<unknown>): Promise<StreamExhaustedError> {
  const settled = await promise.then(
    () => null,
    (error: unknown) => error
  );
  if (settled === null) throw new Error("expected the request to reject, but it resolved");
  return settled as StreamExhaustedError;
}

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

/**
 * `/api/get-stream` distinguishes "the chain is exhausted" from "the server is
 * busy", and the Watch page's response to the two is opposite: an exhausted
 * chain is a final answer and re-asking only re-walks providers that already
 * failed, while a shed request clears on its own and is worth waiting for.
 * The two used to share a status, so neither could be told apart.
 */
describe("getStreamSource provider exhaustion", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("throws StreamExhaustedError, not a generic error, on 404 PROVIDERS_EXHAUSTED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(404, {
          success: false,
          status: 404,
          code: "PROVIDERS_EXHAUSTED",
          available: false,
        })
      )
    );

    const pending = getStreamSource({ tmdbId: "603", mediaType: "movie" });
    await expect(pending).rejects.toBeInstanceOf(StreamExhaustedError);
    // A cold start must never be satisfied by this path.
    await expect(pending).rejects.not.toBeInstanceOf(StreamTimeoutError);
  });

  it("keeps a plain 404 retryable, because it is 'no such title' not 'no source'", async () => {
    // `/api/movies/resolve` answers 404 TITLE_NOT_FOUND for an unmatched title.
    // Reading every 404 as exhaustion would hand the viewer a terminal screen
    // for a request that was simply wrong.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { success: false, code: "TITLE_NOT_FOUND" }))
    );

    await expect(
      getStreamSource({ tmdbId: "603", mediaType: "movie" })
    ).rejects.not.toBeInstanceOf(StreamExhaustedError);
  });

  it("keeps a shed 503 retryable, because it clears on its own", async () => {
    // The memory guard's answer when the byte ceiling trips. It is transient by
    // construction, so treating it as exhaustion -- as this did before -- turned
    // a request that would have succeeded in ten seconds into a permanent
    // failure screen for the viewer.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(503, {
          error: "Server under high load. Retrying shortly.",
          code: "RESOURCE_LIMIT_EXCEEDED",
        })
      )
    );

    await expect(
      getStreamSource({ tmdbId: "603", mediaType: "movie" })
    ).rejects.not.toBeInstanceOf(StreamExhaustedError);
  });

  it("carries the per-provider diagnostics so the terminal state explains itself", async () => {
    const attempts = [
      { id: "archive_direct", kind: "direct", outcome: "empty" },
      { id: "vidsrc", kind: "embed", outcome: "unreachable" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(404, { success: false, code: "PROVIDERS_EXHAUSTED", provider_attempts: attempts })
      )
    );

    const error = await rejection(getStreamSource({ tmdbId: "603", mediaType: "movie" }));
    expect(error).toBeInstanceOf(StreamExhaustedError);
    expect(error.providerAttempts).toEqual(attempts);
  });

  it("still reports exhaustion when a legacy 503 body is unreadable", async () => {
    // A proxy in front of the backend can replace the body with its own error
    // page. With no code to read, 503 is the only evidence left, and the client
    // must still reach a terminal state rather than retry forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }))
    );

    const error = await rejection(getStreamSource({ tmdbId: "603", mediaType: "movie" }));
    expect(error).toBeInstanceOf(StreamExhaustedError);
    expect(error.providerAttempts).toEqual([]);
  });

  it("rejects a 200 that says available:false rather than parsing it as a source", async () => {
    // `isGetStreamPayload` only requires `success` and a string `activeSource`,
    // so a defensive backend could return an empty url with success:true. That
    // must not reach the player as a source that can never play.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { success: true, available: false, activeSource: "", mirrors: [] })
      )
    );

    await expect(getStreamSource({ tmdbId: "603", mediaType: "movie" })).rejects.toBeInstanceOf(
      StreamExhaustedError
    );
  });

  it("leaves other 5xx statuses retryable", async () => {
    // A 502 means something upstream broke, which is exactly the case the
    // retry budget exists for: no code names exhaustion, so no code admits it.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(502, { success: false })));

    await expect(
      getStreamSource({ tmdbId: "603", mediaType: "movie" })
    ).rejects.not.toBeInstanceOf(StreamExhaustedError);
  });
});
