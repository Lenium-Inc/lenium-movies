import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import handler from "./trailer";

const KEY = "test-tmdb-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function call(query = ""): Promise<Response> {
  return handler(new Request(`https://example.com/api/trailer?${query}`));
}

const VIDEOS = {
  results: [
    {
      key: "teaser",
      name: "Teaser",
      site: "YouTube",
      type: "Teaser",
      official: false,
    },
    {
      key: "official",
      name: "Official Trailer",
      site: "YouTube",
      type: "Trailer",
      official: true,
      iso_639_1: "en",
    },
    {
      key: "vimeo-clip",
      name: "Clip",
      site: "Vimeo",
      type: "Clip",
      official: false,
    },
  ],
};

beforeEach(() => {
  vi.stubEnv("TMDB_API_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("api/trailer", () => {
  it("returns the ranked official trailer for a numeric id", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(VIDEOS)
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await call("id=27205&type=movie");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      trailer: { provider: string; id: string; embed_url: string };
    };
    expect(payload.trailer.id).toBe("official");
    expect(payload.trailer.provider).toBe("youtube");
    expect(payload.trailer.embed_url).toContain("/embed/official");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/movie/27205/videos"
    );
  });

  it("searches by title and year when no id is supplied", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/movie")) {
        return jsonResponse({
          results: [
            { id: 999, title: "Inception", release_date: "2010-07-15" },
            { id: 27205, title: "Inception", release_date: "2010-07-16" },
          ],
        });
      }
      return jsonResponse(VIDEOS);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await call("title=Inception&year=2010&type=movie");
    const payload = (await response.json()) as { trailer: { id: string } };
    expect(payload.trailer.id).toBe("official");

    const searchUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(searchUrl).toContain("/search/movie");
    expect(searchUrl).toContain("query=Inception");
    expect(searchUrl).toContain("year=2010");
  });

  it("asks the TV search endpoint for a series", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/tv")) {
        return jsonResponse({
          results: [
            { id: 95396, name: "Severance", first_air_date: "2022-02-18" },
          ],
        });
      }
      return jsonResponse(VIDEOS);
    });
    vi.stubGlobal("fetch", fetchMock);

    await call("title=Severance&year=2022&type=tv");

    const searchUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(searchUrl).toContain("/search/tv");
    expect(searchUrl).toContain("first_air_date_year=2022");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/tv/95396/videos");
  });

  it("returns trailer: null when nothing playable exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ results: [] }))
    );

    const payload = (await (await call("id=1")).json()) as {
      trailer: unknown;
    };
    expect(payload.trailer).toBeNull();
  });

  it("returns trailer: null instead of failing when TMDB errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500))
    );

    const payload = (await (await call("id=1")).json()) as {
      trailer: unknown;
    };
    expect(payload.trailer).toBeNull();
  });

  it("answers the CORS preflight without touching TMDB", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handler(
      new Request("https://example.com/api/trailer", { method: "OPTIONS" })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unavailable rather than guessing when the key is absent", async () => {
    vi.stubEnv("TMDB_API_KEY", "");

    const response = await call("id=27205");

    expect(response.status).toBe(503);
  });
});
