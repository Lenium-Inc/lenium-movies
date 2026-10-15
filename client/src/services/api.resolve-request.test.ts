import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveStream } from "./api";

const resolvePayload = {
  available: true,
  exact: true,
  language: "en",
  movie: {
    id: "1399",
    title: "Game of Thrones",
    media_type: "tv",
    stream_url: "https://vidsrc.test/embed",
  },
};

/**
 * `/api/movies/resolve` used to be POSTed with a JSON body, and every request
 * therefore paid a CORS preflight -- an extra round trip to the backend before
 * the resolve itself could start, on the page where seconds are most visible.
 * The route reads the same fields off the query string (`_init_inputs`), so
 * these pin the wire contract the switch depends on: a GET, the fields on the
 * query string, and no `Content-Type` header that would provoke the
 * preflight back.
 */
describe("resolveStream request shape", () => {
  // The backend origin is read when the module first loads, so the env stub
  // has to land before a fresh import -- the same dance `meta.test.ts` does.
  async function loadApi() {
    vi.resetModules();
    return import("./api");
  }

  beforeEach(() => {
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function mockResolve(body: unknown, status = 200) {
    const spy = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("asks with a GET query string and no JSON body", async () => {
    const { resolveStream } = await loadApi();
    const spy = mockResolve(resolvePayload);

    await resolveStream("Game of Thrones", 2011, {
      mediaType: "tv",
      tmdbId: "1399",
      season: 2,
      episode: 5,
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://backend.test/api/movies/resolve?title=Game+of+Thrones&year=2011&media_type=tv&id=1399&season=2&episode=5"
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("still names media_type when the caller gave nothing else", async () => {
    const { resolveStream } = await loadApi();
    const spy = mockResolve(resolvePayload);

    await resolveStream("The Matrix", 1999);

    const [url] = spy.mock.calls[0] as [string];
    const query = new URL(url).searchParams;
    expect(query.get("media_type")).toBe("movie");
    expect(query.get("title")).toBe("The Matrix");
    expect(query.get("year")).toBe("1999");
    expect(query.get("id")).toBeNull();
  });
});
