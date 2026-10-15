import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The configured backend origin is read at module load, so the stub has to
// land first: reset the registry, then import fresh against the stubbed env.
async function loadMeta() {
  vi.resetModules();
  return import("./meta");
}

/**
 * The details window used to fetch its metadata from `/api/movies/resolve`,
 * which walks every provider chain behind a headless browser -- tens of
 * seconds to learn a director's name, and a queue every real Play click sat
 * behind. `/api/movies/meta` answers the same record plus the neighbours
 * wall from one cached TMDB call. These tests pin the contract: one POST,
 * the movie mapped onto the catalog's `Movie`, the wall kept as compact
 * picks, and an unanswered id reported as `null` rather than thrown.
 */
describe("fetchMovieMeta", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it("posts the pre-v1 alias body and maps record and wall", async () => {
    const { fetchMovieMeta } = await loadMeta();
    const spy = mockJsonOnce({
      success: true,
      movie: {
        id: "1396",
        title: "Breaking Bad",
        year: "2008",
        media_type: "tv",
        runtime: 45,
        vote_average: 8.9,
        genres: ["Drama", "Crime"],
        poster_url: "https://image.tmdb.org/t/p/w500/poster.jpg",
        backdrop_url: "https://image.tmdb.org/t/p/w1280/bg.jpg",
        overview: "A chemistry teacher turns to manufacturing.",
        director: "Vince Gilligan",
        cast: ["Bryan Cranston", "Aaron Paul"],
        country: "United States",
        language: "English",
        release_date: "2008-01-20",
        seasons: 5,
        episodes_per_season: 62,
      },
      similar: [
        {
          id: "60059",
          title: "Better Call Saul",
          year: 2015,
          media_type: "tv",
          poster_path: "/saul.jpg",
          vote_average: 8.7,
          overview: "Before Saul, Jimmy McGill.",
        },
        // No id: dropped, the way the wall drops it server-side.
        { title: "Unidentifiable" },
        null,
      ],
    });

    const meta = await fetchMovieMeta("1396", "tv");

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://backend.test/api/movies/meta");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ id: "1396", media_type: "tv" });

    expect(meta).not.toBeNull();
    const { movie, similar } = meta!;
    expect(movie.providerId).toBe("1396");
    expect(movie.mediaType).toBe("tv");
    expect(movie.year).toBe(2008);
    expect(movie.genre).toEqual(["Drama", "Crime"]);
    expect(movie.director).toBe("Vince Gilligan");
    expect(movie.cast).toEqual(["Bryan Cranston", "Aaron Paul"]);
    expect(movie.seasons).toBe(5);
    expect(movie.synopsis).toContain("chemistry teacher");

    expect(similar).toHaveLength(1);
    expect(similar[0]).toEqual({
      providerId: "60059",
      mediaType: "tv",
      title: "Better Call Saul",
      year: 2015,
      poster: "/saul.jpg",
      score: 8.7,
      synopsis: "Before Saul, Jimmy McGill.",
    });
  });

  it("answers null when the title does not exist, without retrying 4xx", async () => {
    const { fetchMovieMeta } = await loadMeta();
    const spy = mockJsonOnce({ error: "not found" }, 400);

    const meta = await fetchMovieMeta("999999", "movie");

    expect(meta).toBeNull();
    // 400 is a decision, not a hiccup: asking again only repeats it.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("answers null when the payload has no movie", async () => {
    const { fetchMovieMeta } = await loadMeta();
    mockJsonOnce({ success: true, movie: null });

    expect(await fetchMovieMeta("1396", "movie")).toBeNull();
  });

  it("retries a 500 once before giving up", async () => {
    const { fetchMovieMeta } = await loadMeta();
    vi.useFakeTimers();
    const spy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "{}",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ movie: { id: "1", title: "One" }, similar: [] }),
        text: async () => "{}",
      });
    vi.stubGlobal("fetch", spy);

    const pending = fetchMovieMeta("1", "movie");
    await vi.advanceTimersByTimeAsync(1500);
    const meta = await pending;

    expect(spy).toHaveBeenCalledTimes(2);
    expect(meta?.movie.title).toBe("One");
    expect(meta?.similar).toEqual([]);
  });
});

describe("fetchMovieDetails", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MOVIE_API_BASE_URL", "https://backend.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is the meta fetch without its wall", async () => {
    const { fetchMovieDetails } = await loadMeta();
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        movie: { id: "60059", title: "Better Call Saul", year: "2015" },
        similar: [{ id: "1396", title: "Breaking Bad" }],
      }),
      text: async () => "{}",
    });
    vi.stubGlobal("fetch", spy);

    const movie = await fetchMovieDetails("60059", "movie");

    expect(spy.mock.calls[0][0]).toBe(
      "https://backend.test/api/movies/meta"
    );
    expect(movie?.title).toBe("Better Call Saul");
  });
});
