import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API_ORIGIN = "https://media.test";
const SLUG = "breaking-bad-abc123";

async function loadMeta() {
  vi.resetModules();
  return import("./meta");
}

const detailEnvelope = {
  data: {
    subject: {
      subjectId: "9028867555875774472",
      subjectType: 2,
      title: "Breaking Bad",
      description: "A chemistry teacher turns to manufacturing.",
      releaseDate: "2008-01-20",
      duration: 2700,
      genre: "Drama,Crime",
      detailPath: SLUG,
      cover: { url: "https://cdn.test/breaking-bad.jpg" },
      stills: { url: "https://cdn.test/breaking-bad-wide.jpg" },
      imdbRatingValue: "9.5",
      countryName: "United States",
    },
    stars: [
      { staffType: 1, name: "Bryan Cranston", character: "Walter White" },
      { staffType: 1, name: "Aaron Paul", character: "Jesse Pinkman" },
      { staffType: 2, name: "Vince Gilligan", character: "Director" },
    ],
    resource: {
      seasons: [
        { se: 1, maxEp: 7 },
        { se: 2, maxEp: 13 },
      ],
    },
    metadata: {},
  },
};

const homePayload = {
  sections: [
    {
      section: "Popular Series",
      items: [
        {
          name: "Breaking Bad",
          slug: SLUG,
          subject_id: "9028867555875774472",
          poster_url: "https://cdn.test/breaking-bad.jpg",
        },
        {
          name: "Better Call Saul",
          slug: "better-call-saul-xyz",
          subject_id: "1234567890123456789",
          poster_url: "https://cdn.test/saul.jpg",
          year: 2015,
        },
      ],
    },
    {
      section: "Popular Movie",
      items: [
        {
          name: "El Camino",
          slug: "el-camino-xyz",
          subject_id: "2234567890123456789",
          poster_url: "https://cdn.test/el-camino.jpg",
        },
      ],
    },
  ],
};

function mockFetch() {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/detail/") ? detailEnvelope : homePayload;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/**
 * Metadata is read from the same `/detail/{slug}` record playback uses. The
 * neighbours wall is derived from the curated home feed -- the API has no
 * second metadata route -- and a title that cannot be loaded answers null
 * rather than throwing into the details page.
 */
describe("fetchMovieMeta", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_STREAMVY_API_BASE_URL", API_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fetches the detail slug and maps the record", async () => {
    const { fetchMovieMeta } = await loadMeta();
    const spy = mockFetch();

    const meta = await fetchMovieMeta(SLUG, "tv");

    expect(spy.mock.calls[0]?.[0]).toBe(`${API_ORIGIN}/detail/${SLUG}`);
    expect(meta).not.toBeNull();
    const { movie } = meta!;
    expect(movie.providerId).toBe(SLUG);
    expect(movie.mediaType).toBe("tv");
    expect(movie.title).toBe("Breaking Bad");
    expect(movie.year).toBe(2008);
    expect(movie.runtime).toBe(45);
    expect(movie.score).toBe(9.5);
    expect(movie.genre).toEqual(["Drama", "Crime"]);
    expect(movie.director).toBe("Vince Gilligan");
    expect(movie.cast).toEqual(["Bryan Cranston", "Aaron Paul"]);
    expect(movie.seasons).toBe(2);
    expect(movie.episodes_per_season).toBe(13);
    expect(movie.synopsis).toContain("chemistry teacher");
  });

  it("builds a same-kind neighbours wall from the home feed", async () => {
    const { fetchMovieMeta } = await loadMeta();
    mockFetch();

    const meta = await fetchMovieMeta(SLUG, "tv");

    expect(meta?.similar.map(item => item.providerId)).toEqual([
      "better-call-saul-xyz",
    ]);
  });

  it("answers null when the title does not exist", async () => {
    const { fetchMovieMeta } = await loadMeta();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => "{}",
        json: async () => ({}),
      }))
    );

    expect(await fetchMovieMeta("missing", "movie")).toBeNull();
  });
});

describe("fetchMovieDetails", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_STREAMVY_API_BASE_URL", API_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is the meta fetch without its wall", async () => {
    const { fetchMovieDetails } = await loadMeta();
    mockFetch();

    const movie = await fetchMovieDetails(SLUG, "tv");

    expect(movie?.title).toBe("Breaking Bad");
    expect(movie?.providerId).toBe(SLUG);
  });
});
