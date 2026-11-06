import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API_ORIGIN = "https://media.test";

const detailEnvelope = {
  code: 0,
  message: "ok",
  data: {
    subject: {
      subjectId: "6391474290696802080",
      subjectType: 1,
      title: "Inception",
      description: "A thief who steals corporate secrets through dream-sharing.",
      releaseDate: "2010-07-16",
      duration: 8880,
      genre: "Action,Sci-Fi,Thriller",
      detailPath: "inception-e1BOR6f19C7",
      cover: { url: "https://cdn.test/inception.jpg" },
      stills: { url: "https://cdn.test/inception-wide.jpg" },
      imdbRatingValue: "8.8",
      countryName: "United States",
    },
    stars: [
      { staffType: 1, name: "Leonardo DiCaprio", character: "Cobb" },
      { staffType: 2, name: "Christopher Nolan", character: "Director" },
    ],
    resource: {
      seasons: [{ se: 1, maxEp: 1 }],
    },
    metadata: {},
  },
};

/**
 * `resolveStream` no longer searches a catalogue by title/year. The route handle
 * is the lookup key, and the live API answers `/detail/{slug}` only -- it 502s
 * on a subject id. These pin the new wire contract and the mapping that keeps
 * the detail slug, the 19-digit subject id, and the season manifest intact.
 */
async function loadApi() {
  vi.resetModules();
  return import("./api");
}

function mockDetail(body: unknown, status = 200) {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("resolveStream detail lookup", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_STREAMVY_API_BASE_URL", API_ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fetches the detail slug with a GET, not a title search", async () => {
    const { resolveStream } = await loadApi();
    const spy = mockDetail(detailEnvelope);

    await resolveStream("inception-e1BOR6f19C7", 2010, {
      mediaType: "movie",
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_ORIGIN}/detail/inception-e1BOR6f19C7`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("maps the detail record onto a metadata-only StreamMovie", async () => {
    const { resolveStream } = await loadApi();
    mockDetail(detailEnvelope);

    const result = await resolveStream("inception-e1BOR6f19C7", 2010, {
      mediaType: "movie",
    });

    expect(result.exact).toBe(true);
    expect(result.stream).toMatchObject({
      id: "6391474290696802080",
      detail_path: "inception-e1BOR6f19C7",
      title: "Inception",
      media_type: "movie",
      poster_url: "https://cdn.test/inception.jpg",
      backdrop_url: "https://cdn.test/inception-wide.jpg",
      year: 2010,
      vote_average: 8.8,
      stream_url: "",
    });
    expect(result.stream.genres).toEqual(["Action", "Sci-Fi", "Thriller"]);
  });

  it("keeps the full series season manifest", async () => {
    const { resolveStream } = await loadApi();
    mockDetail({
      data: {
        subject: {
          ...detailEnvelope.data.subject,
          subjectId: "9028867555875774472",
          subjectType: 2,
          title: "Wednesday",
          detailPath: "wednesday-urChTxajYKa",
        },
        stars: [],
        resource: {
          seasons: [
            { se: 1, maxEp: 8 },
            { se: 2, maxEp: 8 },
          ],
        },
      },
    });

    const result = await resolveStream("wednesday-urChTxajYKa", null, {
      mediaType: "tv",
      season: 2,
      episode: 3,
    });

    expect(result.stream.media_type).toBe("tv");
    expect(result.stream.seasons).toBe(2);
    expect(result.stream.episodes).toHaveLength(16);
    expect(result.stream.episodes?.[15]).toMatchObject({
      season: 2,
      number: 8,
    });
    expect(result.stream.season).toBe(2);
    expect(result.stream.episode).toBe(3);
  });

  it("reports an unknown handle as StreamNotFoundError", async () => {
    const { resolveStream, StreamNotFoundError } = await loadApi();
    mockDetail({ detail: "not found" }, 404);

    await expect(
      resolveStream("missing-handle", null, { mediaType: "movie" })
    ).rejects.toBeInstanceOf(StreamNotFoundError);
  });
});
