import { describe, expect, it } from "vitest";
import {
  SITE_ORIGIN_TOKEN,
  fetchCatalogue,
  injectOrigin,
  normalizeOrigin,
  prerenderFileName,
  prerenderRoutes,
  prerenderTitlePages,
  renderCatalogueSitemap,
  renderRobots,
  renderSitemap,
  vercelProductionOrigin,
  type CatalogueEntry,
  type Fetcher,
} from "./seoOriginPlugin";
import { INDEXABLE_PATHS, ROBOTS_DISALLOW_PATHS } from "../client/src/lib/seo";

describe("fetchCatalogue", () => {
  /*
   * The failure this guards against: one page of the catalogue walk 500s or
   * times out, and the whole sitemap loses every title. That is not
   * hypothetical -- the Render free tier drops requests under 8-way
   * concurrency, and a walk of ~160 pages hit timeouts partway through. Under
   * the old `Promise.all`, a single rejection emptied the sitemap entirely.
   */
  const item = (id: string, title = `Film ${id}`) => ({
    id: `tmdb-${id}`,
    title,
    year: 2024,
    overview: `Overview of ${title}.`,
    poster_url: `https://image.tmdb.org/t/p/w500/${id}.jpg`,
    media_type: "movie",
  });
  const page = (
    ids: string[],
    hasMore: boolean,
    make: (id: string) => Record<string, unknown> = item
  ) => ({
    items: ids.map(id => make(id)),
    has_more: hasMore,
    per_page: 2,
  });

  it("keeps the pages it can read when one page in the batch fails", async () => {
    const fetcher: Fetcher = async url => {
      const n = Number(new URL(url).searchParams.get("page"));
      if (n === 2) throw new Error("500 from the backend");
      if (n === 1) return page(["100", "200"], true);
      return page([], false);
    };

    // Page 2 is the flaky one; pages 1 and 3 must still contribute.
    const catalogue = await fetchCatalogue("https://api.example", fetcher, 8);

    expect(catalogue.map(entry => entry.id)).toEqual(["100", "200"]);
  });

  it("propagates a first-page failure, which loadCatalogue turns into a warning", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("backend gone");
    };

    /*
     * Page 1 is the walk's only source of `per_page` and `has_more`, so there is
     * nothing to resume from when it fails -- the walk rejects rather than
     * guessing. `loadCatalogue` is the catcher: it logs a warning and returns
     * no records, so the build still ships a static-routes sitemap instead of
     * failing outright.
     */
    await expect(
      fetchCatalogue("https://api.example", fetcher, 8)
    ).rejects.toThrow("backend gone");
  });

  it("strips the catalogue's tmdb- prefix so ids match the title route", async () => {
    const fetcher: Fetcher = async url => {
      const n = Number(new URL(url).searchParams.get("page"));
      if (n === 1) return page(["969681"], false);
      return page([], false);
    };

    const catalogue = await fetchCatalogue("https://api.example", fetcher, 8);

    expect(catalogue.map(entry => entry.id)).toEqual(["969681"]);
  });

  it("keeps the title, synopsis, year and poster each page already carries", async () => {
    /*
     * The endpoint always returned these; the walk used to delete them, which
     * is why a prerendered film page had nothing truthful to put in its
     * `<title>` or description. One request, same payload -- minus the
     * deletion.
     */
    const fetcher: Fetcher = async () => page(["1236045"], false);

    const [entry] = await fetchCatalogue("https://api.example", fetcher, 8);

    expect(entry).toEqual({
      id: "1236045",
      title: "Film 1236045",
      year: 2024,
      overview: "Overview of Film 1236045.",
      posterUrl: "https://image.tmdb.org/t/p/w500/1236045.jpg",
    });
  });

  it("falls back to release_date when year is absent, and keeps an untitled record out of no page's way", async () => {
    const fetcher: Fetcher = async () =>
      page(["1"], false, () => ({
        id: "tmdb-1",
        title: "  ",
        release_date: "1922-04-06",
        overview: null,
        poster_url: null,
      }));

    const [entry] = await fetchCatalogue("https://api.example", fetcher, 8);

    // No usable year from `year`, but the raw date still yields one.
    expect(entry.year).toBe(1922);
    // Blank strings normalise to empty, so the prerender can skip a page it
    // cannot title.
    expect(entry.title).toBe("");
    expect(entry.overview).toBe("");
    expect(entry.posterUrl).toBe("");
  });
});

describe("normalizeOrigin", () => {
  it("trims whitespace and trailing slashes", () => {
    // A trailing slash would compose into `https://host//watch/1`, which is a
    // different URL to anything that normalises paths.
    expect(normalizeOrigin("  https://vy.example/  ")).toBe(
      "https://vy.example"
    );
    expect(normalizeOrigin("https://vy.example///")).toBe("https://vy.example");
  });

  it("treats an absent value as no origin at all", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(normalizeOrigin(value)).toBe("");
    }
  });
});

describe("vercelProductionOrigin", () => {
  /*
   * The failure this guards against was observed on the live site: a build with
   * no origin wrote no sitemap.xml at all (the request fell through to the SPA
   * rewrite and answered text/html), dropped the Sitemap line from robots.txt,
   * and left `canonical="/"` -- while the deploy itself looked completely
   * healthy. Vercel injects its own production domain, so a production build
   * can resolve an origin with nobody remembering an env var.
   */
  it("resolves the platform's production domain on a production build", () => {
    expect(
      vercelProductionOrigin({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "www.streamvy.me",
      })
    ).toBe("https://www.streamvy.me");
  });

  it("never lends production's identity to a preview build", () => {
    /*
     * The bug `__SITE_ORIGIN__` exists to prevent: every preview advertising
     * itself as the live site. A preview keeps an empty origin instead --
     * relative URLs and no sitemap, which is honest.
     */
    expect(
      vercelProductionOrigin({
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_PRODUCTION_URL: "lenium-git-fix.vercel.app",
      })
    ).toBe("");
  });

  it("stays empty when the platform reports no host", () => {
    expect(vercelProductionOrigin({ VERCEL_ENV: "production" })).toBe("");
    expect(vercelProductionOrigin({})).toBe("");
    expect(
      vercelProductionOrigin({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "   ",
      })
    ).toBe("");
  });

  it("adds the scheme, and never doubles one", () => {
    // The platform reports a bare domain today; a future change reporting a
    // full URL would otherwise produce `https://https://...` in every <loc>.
    expect(
      vercelProductionOrigin({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "https://streamvy.me/",
      })
    ).toBe("https://streamvy.me");
  });
});

describe("injectOrigin", () => {
  it("substitutes the token wherever it appears", () => {
    const html = `<link href="${SITE_ORIGIN_TOKEN}/" /><meta content="${SITE_ORIGIN_TOKEN}/mark.svg" />`;
    expect(injectOrigin(html, "https://vy.example")).toBe(
      '<link href="https://vy.example/" /><meta content="https://vy.example/mark.svg" />'
    );
  });

  it("degrades to root-relative URLs when no origin is configured", () => {
    /*
     * The point of substituting a token rather than writing a production URL: an
     * unconfigured build stays correct wherever it is served, because a relative
     * canonical resolves against the document. A hardcoded hostname does not.
     */
    const html = `<link rel="canonical" href="${SITE_ORIGIN_TOKEN}/" />`;
    expect(injectOrigin(html, "")).toBe('<link rel="canonical" href="/" />');
  });

  it("substitutes once, so an origin containing the token cannot loop", () => {
    const html = `${SITE_ORIGIN_TOKEN}/x`;
    expect(injectOrigin(html, `https://${SITE_ORIGIN_TOKEN}.example`)).toBe(
      `https://${SITE_ORIGIN_TOKEN}.example/x`
    );
  });

  it("leaves a document with no token untouched", () => {
    const html = "<head><title>Stream Vy</title></head>";
    expect(injectOrigin(html, "https://vy.example")).toBe(html);
  });
});

describe("renderSitemap", () => {
  const locations = (xml: string) =>
    Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map(m => m[1]);

  it("emits one absolute <loc> per indexable route", () => {
    const xml = renderSitemap(INDEXABLE_PATHS, "https://vy.example");
    expect(locations(xml)).toEqual([
      "https://vy.example/",
      "https://vy.example/terms",
      "https://vy.example/privacy",
      "https://vy.example/dmca",
    ]);
  });

  it("keeps the root's slash, so it is not a bare origin", () => {
    // "https://vy.example" and "https://vy.example/" are different strings to a
    // crawler reading <loc>, and the canonical this file has to agree with is
    // the one with the slash.
    expect(locations(renderSitemap(["/"], "https://vy.example"))).toEqual([
      "https://vy.example/",
    ]);
  });

  it("omits lastmod rather than inventing one", () => {
    /*
     * `new Date()` at build time is the usual substitute and it is still a lie:
     * every page would report the moment the build ran. The previous sitemap put
     * a single blanket `2026-10-01` on all four URLs, which can talk a crawler
     * out of re-fetching a page that genuinely changed. With no known date, the
     * element is left out and the file stays valid.
     */
    const xml = renderSitemap(INDEXABLE_PATHS, "https://vy.example");
    expect(xml).not.toContain("lastmod");
    expect(xml).not.toContain("2026-");
  });

  it("emits lastmod only for paths whose date is known", () => {
    const xml = renderSitemap(["/", "/terms"], "https://vy.example", {
      "/terms": "2026-09-30",
    });
    // /terms carries a real date from git; / has none supplied, so none is claimed.
    const terms = xml.slice(xml.indexOf("/terms"), xml.indexOf("/terms") + 120);
    expect(terms).toContain("<lastmod>2026-09-30</lastmod>");
    expect(xml.slice(0, xml.indexOf("/terms"))).not.toContain("<lastmod>");
  });

  it("escapes XML metacharacters in an origin", () => {
    // Not reachable through normalizeOrigin in practice, but a malformed
    // sitemap.xml makes engines discard the whole file.
    expect(renderSitemap(["/"], "https://vy.example/?a=1&b=<2")).toContain(
      "&amp;"
    );
  });

  it("degrades to relative <loc> when no origin is configured", () => {
    expect(locations(renderSitemap(["/"], ""))).toEqual(["/"]);
  });
});

describe("renderRobots", () => {
  it("disallows each private path with a trailing slash", () => {
    // Matching "/profile" exactly would also block "/profile-anything", which is
    // why the separator is part of the pattern.
    const robots = renderRobots(ROBOTS_DISALLOW_PATHS, "https://vy.example");
    for (const entry of ROBOTS_DISALLOW_PATHS) {
      expect(robots).toContain(`Disallow: ${entry}/`);
    }
  });

  it("points at an absolute sitemap URL", () => {
    expect(renderRobots(ROBOTS_DISALLOW_PATHS, "https://vy.example")).toContain(
      "Sitemap: https://vy.example/sitemap.xml"
    );
  });

  it("names no sitemap when there is no origin for one", () => {
    // A relative Sitemap URL is ignored by every engine, so writing one would
    // point crawlers at a file this build does not emit.
    expect(renderRobots(ROBOTS_DISALLOW_PATHS, "")).not.toContain("Sitemap:");
    // The disallow rules are the part that matters, and they stay.
    expect(renderRobots(ROBOTS_DISALLOW_PATHS, "")).toContain(
      "Disallow: /api/"
    );
  });

  it("uses a single wildcard group, which is what Googlebot falls back to", () => {
    // There was also an identical Googlebot group. A crawler takes the most
    // specific matching group, so with identical contents the second group
    // changed nothing while implying the first might not apply.
    const robots = renderRobots(ROBOTS_DISALLOW_PATHS, "https://vy.example");
    expect(robots.match(/^User-agent:/gm)).toHaveLength(1);
    expect(robots).toContain("User-agent: *");
  });

  it("does not block the paths that rely on noindex instead", () => {
    // Blocking these would stop a crawler reaching the very tag meant to drop
    // the page, which can leave the URL in the index as "blocked by robots.txt".
    const robots = renderRobots(ROBOTS_DISALLOW_PATHS, "https://vy.example");
    for (const path of ["/watch", "/login", "/signup"]) {
      expect(robots).not.toContain(`Disallow: ${path}/`);
    }
  });

  it("names no production host", () => {
    expect(
      renderRobots(ROBOTS_DISALLOW_PATHS, "https://vy.example")
    ).not.toMatch(/vy-virid\.vercel\.app/);
  });
});

describe("prerenderRoutes", () => {
  const template = [
    "<head>",
    "    <!-- seo:route-head:start -->",
    "    <title>Homepage</title>",
    '    <link rel="canonical" href="__SITE_ORIGIN__/" />',
    "    <!-- seo:route-head:end -->",
    '    <meta name="google-site-verification" content="tok" />',
    "</head>",
  ].join("\n");

  const head = (html: string) =>
    html.slice(html.indexOf("<head>"), html.indexOf("</head>"));

  it("gives each route its own title and canonical", () => {
    const pages = prerenderRoutes(template, "https://vy.example");
    expect(pages.map(p => p.fileName)).toEqual([
      "index.html",
      "terms.html",
      "privacy.html",
      "dmca.html",
    ]);

    const terms = pages.find(p => p.fileName === "terms.html")!.source;
    expect(terms).toContain("<title>Terms of Service - Stream Vy</title>");
    expect(terms).toContain('rel="canonical" href="https://vy.example/terms"');
    // ...and not the homepage's, which is the whole point: every route used to
    // serve this, so the site had exactly one indexable URL.
    expect(terms).not.toContain("<title>Homepage</title>");
  });

  it("keeps the tags that do not vary by route", () => {
    // The verification token, icons and site-level JSON-LD live outside the
    // markers and must survive: rewriting them per route would mean a second
    // copy to keep in step for no benefit.
    for (const page of prerenderRoutes(template, "https://vy.example")) {
      expect(page.source, page.fileName).toContain(
        'name="google-site-verification" content="tok"'
      );
    }
  });

  it("resolves the origin token, since the template still holds it", () => {
    const home = prerenderRoutes(template, "https://vy.example")[0].source;
    expect(home).not.toContain(SITE_ORIGIN_TOKEN);
    expect(home).toContain('href="https://vy.example/"');
  });

  it("leaves the head untouched when the markers are missing", () => {
    // The plugin turns this case into a build error; the pure function just does
    // not invent a page, so it cannot be tested by asserting a throw here.
    const stripped = template.replace(
      / *<!-- seo:route-head:(start|end) -->\n?/g,
      ""
    );
    for (const page of prerenderRoutes(stripped, "https://vy.example")) {
      // Still the homepage's title, i.e. no prerender happened.
      expect(head(page.source), page.fileName).toContain(
        "<title>Homepage</title>"
      );
    }
  });

  it("names the SPA entry index.html and every other route <path>.html", () => {
    expect(prerenderFileName("/")).toBe("index.html");
    expect(prerenderFileName("/terms")).toBe("terms.html");
    expect(prerenderFileName("/terms/")).toBe("terms.html");
  });

  it("emits no noindex on a prerendered page", () => {
    for (const page of prerenderRoutes(template, "https://vy.example")) {
      expect(page.source, page.fileName).not.toContain("noindex");
      expect(page.source, page.fileName).toContain("index, follow");
    }
  });
});

describe("renderCatalogueSitemap", () => {
  const film = (id: string, title = `Film ${id}`): CatalogueEntry => ({
    id,
    title,
    year: 2024,
    overview: `Overview of ${title}.`,
    posterUrl: `https://image.tmdb.org/t/p/w500/${id}.jpg`,
  });

  it("lists each film at /title/:id, the page that is actually indexed", () => {
    /*
     * `/watch/:id` used to be the listed URL, from when the player was the only
     * film page. The details page is the one with a synopsis and a poster, it
     * is what every click routes through, and the player is `noindex` -- so
     * listing it pointed crawlers at a page that asks not to be indexed.
     */
    const xml = renderCatalogueSitemap(
      [film("1236045", "Animals")],
      "https://vy.example"
    );
    expect(xml).toContain("<loc>https://vy.example/title/1236045</loc>");
    expect(xml).not.toContain("/watch/");
  });

  it("keeps the static routes ahead of the catalogue entries", () => {
    const xml = renderCatalogueSitemap([film("1")], "https://vy.example");
    const locations = Array.from(
      xml.matchAll(/<loc>([^<]+)<\/loc>/g)
    ).map(match => match[1]);
    expect(locations.slice(0, INDEXABLE_PATHS.length)).toEqual([
      "https://vy.example/",
      "https://vy.example/terms",
      "https://vy.example/privacy",
      "https://vy.example/dmca",
    ]);
    expect(locations).toContain("https://vy.example/title/1");
  });

  it("escapes an origin with metacharacters in every <loc>", () => {
    const xml = renderCatalogueSitemap([film("1")], "https://vy.example/?a=1&b=<2");
    expect(xml).toContain("&amp;");
  });
});

describe("prerenderTitlePages", () => {
  const template = [
    "<head>",
    "    <!-- seo:route-head:start -->",
    "    <title>Homepage</title>",
    '    <link rel="canonical" href="__SITE_ORIGIN__/" />',
    "    <!-- seo:route-head:end -->",
    '    <meta name="google-site-verification" content="tok" />',
    "  </head>",
    "  <body></body>",
  ].join("\n");

  const animals: CatalogueEntry = {
    id: "1236045",
    title: "Animals",
    year: 2026,
    overview: "Two friends go looking for a stolen elephant.",
    posterUrl: "https://image.tmdb.org/t/p/w500/poster.jpg",
  };

  it("emits one file per film at title/<id>.html", () => {
    const pages = prerenderTitlePages(template, "https://vy.example", [
      animals,
    ]);
    expect(pages.map(page => page.fileName)).toEqual(["title/1236045.html"]);
  });

  it("gives the page the film's own title, description and canonical", () => {
    const [page] = prerenderTitlePages(template, "https://vy.example", [
      animals,
    ]);

    expect(page.source).toContain(
      "<title>Animals (2026) - Watch Free on Stream Vy</title>"
    );
    expect(page.source).toContain(
      "Two friends go looking for a stolen elephant."
    );
    expect(page.source).toContain(
      'rel="canonical" href="https://vy.example/title/1236045"'
    );
    // ...and not the homepage's, which is the whole point: without this every
    // film page served a copy of the homepage head.
    expect(page.source).not.toContain("<title>Homepage</title>");
    expect(page.source).toContain('index, follow');
  });

  it("carries Movie JSON-LD a crawler can read without running JavaScript", () => {
    const [page] = prerenderTitlePages(template, "https://vy.example", [
      animals,
    ]);

    // The same id head.ts writes at runtime, so hydration updates this block
    // in place instead of appending a second script beside it.
    expect(page.source).toContain('data-jsonld="movie-jsonld"');
    expect(page.source).toContain('"@type":"Movie"');
    expect(page.source).toContain('"name":"Animals"');
    expect(page.source).toContain(
      '"url":"https://vy.example/title/1236045"'
    );
    expect(page.source).toContain(
      '"image":"https://image.tmdb.org/t/p/w500/poster.jpg"'
    );
  });

  it("resolves the origin token and keeps the tags that do not vary by film", () => {
    const [page] = prerenderTitlePages(template, "https://vy.example", [
      animals,
    ]);
    expect(page.source).not.toContain(SITE_ORIGIN_TOKEN);
    expect(page.source).toContain('name="google-site-verification" content="tok"');
  });

  it("skips a film with no title rather than shipping a page it cannot name", () => {
    // A blank title would produce "Watch Free on Stream Vy" as the whole
    // <title>, which every other page already does better. The id still
    // resolves through the SPA, whose live head is strictly better than a
    // confidently wrong static one.
    const pages = prerenderTitlePages(template, "https://vy.example", [
      { ...animals, title: "" },
    ]);
    expect(pages).toEqual([]);
  });

  it("falls back to a description that does not invent a synopsis", () => {
    const [page] = prerenderTitlePages(template, "https://vy.example", [
      { ...animals, overview: "" },
    ]);
    expect(page.source).toContain("Watch Animals (2026) free on Stream Vy");
    expect(page.source).not.toContain("Two friends");
  });
});
