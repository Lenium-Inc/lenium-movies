import { afterEach, describe, expect, it, vi } from "vitest";

function mockFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof mockFetch>): URL {
  return new URL(String(fetchMock.mock.calls[0]?.[0]));
}

async function loadTmdb(key = "test-key") {
  vi.resetModules();
  vi.stubEnv("VITE_TMDB_API_KEY", key);
  return import("./tmdb");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("TMDB fallback configuration", () => {
  it("is disabled without a key", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_TMDB_API_KEY", "");
    const mod = await import("./tmdb");
    expect(mod.tmdbEnabled()).toBe(false);
    expect(mod.tmdbApiKey()).toBe("");
  });

  it("is enabled when a key is present", async () => {
    const mod = await loadTmdb("abc123");
    expect(mod.tmdbEnabled()).toBe(true);
  });

  it("sends a v4 read token as a bearer header instead of a query param", async () => {
    const fetchMock = mockFetch({
      page: 1,
      total_pages: 1,
      total_results: 0,
      results: [],
    });
    const mod = await loadTmdb("eyJtoken");

    await mod.tmdbDiscover({ mediaType: "movie" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.has("api_key")).toBe(false);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer eyJtoken"
    );
  });
});

describe("tmdbDiscover", () => {
  it("requests the genre-filtered page and maps TMDB fields", async () => {
    const fetchMock = mockFetch({
      page: 2,
      total_pages: 5,
      total_results: 100,
      results: [
        {
          id: 27205,
          title: "Inception",
          overview: "A thief who steals corporate secrets.",
          poster_path: "/poster.jpg",
          backdrop_path: "/backdrop.jpg",
          vote_average: 8.4,
          popularity: 91,
          release_date: "2010-07-16",
          genre_ids: [28, 878],
        },
      ],
    });
    const mod = await loadTmdb();

    const page = await mod.tmdbDiscover({
      mediaType: "movie",
      page: 2,
      genre: "Sci-fi",
    });

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/3/discover/movie");
    expect(url.searchParams.get("api_key")).toBe("test-key");
    expect(url.searchParams.get("with_genres")).toBe("878");
    expect(page.hasMore).toBe(true);
    expect(page.movies[0]).toMatchObject({
      id: "27205",
      title: "Inception",
      media_type: "movie",
      year: 2010,
      poster_url: "https://image.tmdb.org/t/p/w500/poster.jpg",
      backdrop_url: "https://image.tmdb.org/t/p/original/backdrop.jpg",
      vote_average: 8.4,
      genres: ["Action", "Sci-Fi"],
    });
  });

  it("merges movie and TV pages when asked for all media", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const isTv = url.pathname.endsWith("/tv");
      return new Response(
        JSON.stringify({
          page: 1,
          total_pages: 2,
          total_results: 40,
          results: [
            {
              id: isTv ? 101 : 202,
              [isTv ? "name" : "title"]: isTv ? "Series" : "Film",
              genre_ids: [],
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await loadTmdb();

    const page = await mod.tmdbDiscover({ mediaType: "all" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.movies.map(movie => movie.id)).toEqual(["202", "101"]);
    expect(page.total).toBe(80);
  });
});

describe("tmdbSearch", () => {
  it("keeps movies and series but drops people", async () => {
    mockFetch({
      page: 1,
      results: [
        { id: 1, media_type: "person", name: "An Actor" },
        {
          id: 2,
          media_type: "movie",
          title: "Film",
          poster_path: null,
        },
        {
          id: 3,
          media_type: "tv",
          name: "Show",
          poster_path: "/show.jpg",
        },
      ],
    });
    const mod = await loadTmdb();

    const results = await mod.tmdbSearch("  inception  ");

    expect(results.map(movie => movie.id)).toEqual(["2", "3"]);
    expect(results[1].media_type).toBe("tv");
  });

  it("does not call TMDB for a blank query", async () => {
    const fetchMock = mockFetch({ results: [] });
    const mod = await loadTmdb();
    await expect(mod.tmdbSearch("   ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tmdbTitleDetails", () => {
  it("maps runtime, genres, cast and director", async () => {
    const fetchMock = mockFetch({
      id: 27205,
      title: "Inception",
      overview: "A thief.",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
      vote_average: 8.4,
      runtime: 148,
      release_date: "2010-07-16",
      genres: [{ id: 28, name: "Action" }],
      credits: {
        cast: [{ name: "Leonardo DiCaprio" }, { name: "Elliot Page" }],
        crew: [
          { name: "Christopher Nolan", job: "Director" },
          { name: "Someone Else", job: "Editor" },
        ],
      },
    });
    const mod = await loadTmdb();

    const details = await mod.tmdbTitleDetails("27205", "movie");

    expect(requestedUrl(fetchMock).pathname).toBe("/3/movie/27205");
    expect(details).toMatchObject({
      id: 27205,
      title: "Inception",
      mediaType: "movie",
      runtime: 148,
      year: 2010,
      genres: ["Action"],
      cast: ["Leonardo DiCaprio", "Elliot Page"],
      director: "Christopher Nolan",
    });
  });

  it("refuses a handle that cannot be a TMDB id", async () => {
    const fetchMock = mockFetch({ id: 1, title: "Nope" });
    const mod = await loadTmdb();

    await expect(mod.tmdbTitleDetails("inception-2010")).resolves.toBeNull();
    await expect(
      mod.tmdbTitleDetails("1234567890123456789")
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
