import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {}
) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  };
}

async function loadDirect() {
  vi.resetModules();
  vi.stubEnv("VITE_MOVIEBOX_BFF_URL", "https://bff.test/wefeed");
  return import("./movieboxDirect");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("directHome", () => {
  it("maps the BFF operating list into home sections", async () => {
    const mod = await loadDirect();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 0,
          data: {
            operatingList: [
              {
                type: "BANNER",
                title: "Banner",
                banner: {
                  items: [
                    {
                      title: "Featured",
                      image: { url: "https://img/hero.jpg" },
                      detailPath: "featured",
                      subject: { subjectId: "111", corner: "HD" },
                    },
                    {
                      title: "Communities",
                      image: { url: "https://img/communities.jpg" },
                      detailPath: "communities",
                    },
                  ],
                },
              },
              {
                type: "SUBJECTS_MOVIE",
                title: "Trending Movies",
                subjects: [
                  {
                    title: "Inception",
                    cover: { url: "https://img/inc.jpg" },
                    detailPath: "inception",
                    subjectId: "222",
                    imdbRatingValue: "8.8",
                  },
                ],
              },
            ],
          },
        },
        { "x-user": JSON.stringify({ token: "guest" }) }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const home = await mod.directHome();

    expect(home.sections).toEqual([
      {
        section: "Banner",
        count: 1,
        items: [
          {
            name: "Featured",
            poster_url: "https://img/hero.jpg",
            slug: "featured",
            subject_id: "111",
            badge: "HD",
          },
        ],
      },
      {
        section: "Trending Movies",
        count: 1,
        items: [
          {
            name: "Inception",
            poster_url: "https://img/inc.jpg",
            slug: "inception",
            subject_id: "222",
            badge: null,
            rating: "8.8",
          },
        ],
      },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bff.test/wefeed/home?host=moviebox.ph");
    expect(init.credentials).toBe("omit");
    expect(
      (init.headers as Record<string, string>).Authorization
    ).toBeUndefined();
  });
});

describe("directSearch", () => {
  it("obtains a guest token and sends it on the search request", async () => {
    const mod = await loadDirect();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/home")) {
        return jsonResponse(
          { code: 0, data: { operatingList: [] } },
          { "x-user": JSON.stringify({ token: "guest" }) }
        );
      }
      if (url.includes("/subject/search")) {
        return jsonResponse(
          {
            code: 0,
            data: {
              items: [
                {
                  title: "Inception",
                  cover: { url: "https://img/inc.jpg" },
                  detailPath: "inception",
                  subjectId: "222",
                },
              ],
              pager: { totalCount: 1 },
            },
          },
          { "x-user": JSON.stringify({ token: "guest" }) }
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await mod.directSearch("inception", 2);

    expect(payload).toEqual({
      query: "inception",
      page: 2,
      total: 1,
      items: [
        {
          name: "Inception",
          poster_url: "https://img/inc.jpg",
          slug: "inception",
          subject_id: "222",
          badge: null,
          rating: null,
        },
      ],
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://bff.test/wefeed/home?host=moviebox.ph",
      "https://bff.test/wefeed/subject/search",
    ]);
    const [, init] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>).Authorization
    ).toBe("Bearer guest");
    expect(JSON.parse(String(init.body))).toEqual({
      keyword: "inception",
      page: 2,
      perPage: 20,
    });
  });

  it("refreshes an invalid guest token once", async () => {
    const mod = await loadDirect();
    let homeCalls = 0;
    let searchCalls = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/home")) {
          homeCalls++;
          const token = homeCalls === 1 ? "old" : "new";
          return jsonResponse(
            { code: 0, data: { operatingList: [] } },
            { "x-user": JSON.stringify({ token }) }
          );
        }
        if (url.includes("/subject/search")) {
          searchCalls++;
          if (searchCalls === 1) {
            return errorResponse(400, {
              code: 400,
              message: "invalid token",
            });
          }
          expect(
            (init?.headers as Record<string, string> | undefined)?.Authorization
          ).toBe("Bearer new");
          return jsonResponse(
            { code: 0, data: { items: [], pager: { totalCount: 0 } } },
            { "x-user": JSON.stringify({ token: "new" }) }
          );
        }
        throw new Error(`unexpected ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(mod.directSearch("inception")).resolves.toMatchObject({
      items: [],
    });

    expect(homeCalls).toBe(2);
    expect(searchCalls).toBe(2);
  });
});

describe("directDetail", () => {
  it("fetches a detail record by slug", async () => {
    const mod = await loadDirect();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/home")) {
        return jsonResponse(
          { code: 0, data: { operatingList: [] } },
          { "x-user": JSON.stringify({ token: "guest" }) }
        );
      }
      return jsonResponse(
        {
          code: 0,
          data: {
            subject: {
              subjectId: "222",
              detailPath: "inception",
              title: "Inception",
            },
          },
        },
        { "x-user": JSON.stringify({ token: "guest" }) }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await mod.directDetail("inception");

    expect(detail.data?.subject.title).toBe("Inception");
    const detailCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/detail")
    );
    if (!detailCall) throw new Error("detail request was not made");
    const [detailUrl, detailInit] = detailCall as unknown as [
      string,
      RequestInit,
    ];
    expect(detailUrl).toBe(
      "https://bff.test/wefeed/detail?detailPath=inception"
    );
    expect(detailInit.method).toBe("GET");
  });
});

describe("directCatalog", () => {
  it("maps the filter response and sends the tab id", async () => {
    const mod = await loadDirect();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/home")) {
        return jsonResponse(
          { code: 0, data: { operatingList: [] } },
          { "x-user": JSON.stringify({ token: "guest" }) }
        );
      }
      return jsonResponse(
        {
          code: 0,
          data: {
            items: [
              {
                title: "Film",
                cover: { url: "https://img/f.jpg" },
                detailPath: "film",
                subjectId: "333",
                releaseDate: "2024-01-01",
              },
            ],
            pager: { totalCount: 1 },
          },
        },
        { "x-user": JSON.stringify({ token: "guest" }) }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await mod.directCatalog("tv-series", { page: 2 });

    expect(page).toEqual({
      page: 2,
      per_page: 24,
      total: 1,
      items: [
        {
          name: "Film",
          poster_url: "https://img/f.jpg",
          slug: "film",
          subject_id: "333",
          badge: null,
          rating: null,
          year: "2024",
        },
      ],
    });
    const [, init] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      tabId: 5,
      page: 2,
      perPage: 24,
    });
  });
});

describe("catalogue transport", () => {
  it("routes the catalogue through the BFF when direct mode is enabled", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MOVIEBOX_DIRECT_BFF", "true");
    vi.stubEnv("VITE_MOVIEBOX_BFF_URL", "https://bff.test");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 0,
          data: {
            operatingList: [
              {
                type: "SUBJECTS_MOVIE",
                title: "Trending Movies",
                subjects: [
                  {
                    title: "Inception",
                    cover: { url: "https://img/inc.jpg" },
                    detailPath: "inception",
                    subjectId: "222",
                  },
                ],
              },
            ],
          },
        },
        { "x-user": JSON.stringify({ token: "guest" }) }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getHome } = await import("./streamvy");
    const home = await getHome(true);

    expect(home.sections[0].section).toBe("Trending Movies");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://bff.test/home?host=moviebox.ph"
    );
  });

  it("falls back to the catalogue origin when direct mode fails", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MOVIEBOX_DIRECT_BFF", "true");
    vi.stubEnv("VITE_MOVIEBOX_BFF_URL", "https://bff.test");
    vi.stubEnv("VITE_STREAMVY_API_BASE_URL", "https://backend.test");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://bff.test")) {
        throw new TypeError("Failed to fetch");
      }
      return jsonResponse({
        status: "success",
        sections: [
          {
            section: "Backend",
            items: [{ name: "Heat", slug: "heat", subject_id: "444" }],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getHome } = await import("./streamvy");
    const home = await getHome(true);

    expect(home.sections[0].section).toBe("Backend");
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://backend.test/home"
    );
  });
});
