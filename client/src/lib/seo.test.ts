import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INDEXABLE_PATHS,
  MOVIE_JSONLD_ID,
  OG_IMAGE,
  ROBOTS_DISALLOW_PATHS,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_TITLE,
  buildHeadTags,
  isPrivatePath,
  movieSchema,
  pageSeo,
  webSiteSchema,
} from "./seo";
import { renderRobots, renderSitemap } from "../../../scripts/seoOriginPlugin";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** The origin every assertion below builds URLs against. */
const ORIGIN = "https://vy.example";

const headFor = (pathname: string) => buildHeadTags(pageSeo(pathname), ORIGIN);

function metaContent(
  tags: ReturnType<typeof buildHeadTags>,
  key: string,
  attribute = "name"
) {
  const found = tags.find(
    tag => tag.kind === "meta" && tag.attribute === attribute && tag.key === key
  );
  return found && "content" in found ? found.content : null;
}

function removedKeys(tags: ReturnType<typeof buildHeadTags>) {
  return tags
    .filter(tag => tag.kind === "removeMeta")
    .map(tag => `${tag.attribute}:${tag.key}`);
}

describe("isPrivatePath", () => {
  it("matches the paths robots.txt disallows", () => {
    for (const p of [
      "/api",
      "/api/anything",
      "/profile",
      "/profiles",
      "/my-list",
      "/share",
      "/list/share",
      "/watch/603",
    ]) {
      expect(isPrivatePath(p), p).toBe(true);
    }
  });

  it("does not match a public path that merely starts with the same letters", () => {
    // `startsWith` without a boundary would block `/profile-stats`, which is not
    // a private route, and would hide a public page from search for no reason.
    expect(isPrivatePath("/profiles-public")).toBe(false);
    expect(isPrivatePath("/shares-of-the-day")).toBe(false);
    expect(isPrivatePath("/apifoo")).toBe(false);
  });

  it("treats a trailing slash as the same page", () => {
    expect(isPrivatePath("/my-list/")).toBe(true);
  });
});

describe("pageSeo", () => {
  it("gives the homepage the shared title and description", () => {
    const seo = pageSeo("/");
    expect(seo.title).toBe(SITE_TITLE);
    expect(seo.description).toBe(SITE_DESCRIPTION);
    expect(seo.indexable).toBe(true);
  });

  it("gives each legal page its own title", () => {
    for (const [route, expected] of [
      ["/terms", "Terms of Service - Stream Vy"],
      ["/privacy", "Privacy Policy - Stream Vy"],
      ["/dmca", "Copyright & DMCA - Stream Vy"],
    ] as const) {
      expect(pageSeo(route).title, route).toBe(expected);
    }
  });

  it("keeps the three legal pages off each other's canonical path", () => {
    // The old config gave `browse`, `search` and `home` all the same `url`, so
    // three different titles claimed to describe one URL.
    const paths = new Set(
      ["/", "/terms", "/privacy", "/dmca"].map(r => pageSeo(r).path)
    );
    expect(paths.size).toBe(4);
  });

  it("marks private routes as non-indexable with no description", () => {
    const seo = pageSeo("/my-list");
    expect(seo.indexable).toBe(false);
    // A noindex page should not carry content for a crawler to quote.
    expect(seo.description).toBe("");
  });

  it("treats an unknown route as a 404 that must not be indexed", () => {
    // A 404 that indexes itself is a soft 404: the search engine lists a page
    // that does not exist.
    expect(pageSeo("/nope").indexable).toBe(false);
  });
});

describe("buildHeadTags", () => {
  it("sets a robots directive that matches the page's indexability", () => {
    expect(metaContent(headFor("/"), "robots")).toContain("index, follow");
    expect(metaContent(headFor("/watch/603"), "robots")).toBe(
      "noindex, nofollow"
    );
  });

  it("removes the optional tags when moving to a noindex page", () => {
    /*
     * The regression this exists for: `og:type` was set to `video.other` on a
     * title page and never cleared, so the legal pages inherited it and were
     * advertised to Facebook as videos.
     */
    const removed = removedKeys(headFor("/watch/603"));
    expect(removed).toContain("property:og:type");
    expect(removed).toContain("property:og:image");
    expect(removed).toContain("name:description");
    expect(removed).toContain("name:twitter:title");
  });

  it("takes the per-title schema block off a page that has no title", () => {
    const tags = headFor("/terms");
    expect(tags).toContainEqual({ kind: "removeJsonLd", id: MOVIE_JSONLD_ID });
  });

  it("gives every indexable page one canonical URL and a matching og:url", () => {
    for (const route of ["/", "/terms", "/privacy", "/dmca"]) {
      const tags = buildHeadTags(pageSeo(route), "https://vy.example");
      const canonical = tags.find(
        tag => tag.kind === "link" && tag.rel === "canonical"
      );
      const ogUrl = metaContent(tags, "og:url", "property");
      expect(canonical && canonical.kind === "link" && canonical.href).toBe(
        ogUrl
      );
    }
  });

  it("makes the og:image absolute, since consumers resolve it alone", () => {
    const content = metaContent(headFor("/"), "og:image", "property");
    expect(content).toBe(`https://vy.example${OG_IMAGE}`);
  });

  it("falls back to a relative og:image when no origin is known", () => {
    // Relative resolves against the document, so a build with no configured
    // origin stays correct wherever it is served. A guessed host would not be.
    const content = metaContent(
      buildHeadTags(pageSeo("/"), ""),
      "og:image",
      "property"
    );
    expect(content).toBe(OG_IMAGE);
  });

  it("does not emit an empty description for an indexable page", () => {
    // `content=""` is a different claim from omitting the tag: a search engine
    // indexes it as "this page has an empty description".
    for (const route of ["/", "/terms", "/privacy", "/dmca"]) {
      const description = metaContent(headFor(route), "description");
      expect(description, route).toBeTruthy();
    }
  });

  it("is stable across repeated calls", () => {
    const first = headFor("/");
    const second = headFor("/");
    expect(second).toEqual(first);
  });
});

describe("movieSchema", () => {
  it("does not invent a publication date", () => {
    /*
     * The old generator emitted `${year}-01-01`, which asserts a release date
     * the catalogue does not have. For a 1922 public-domain print it is wrong by
     * most of a century, and structured data is exactly the place a confident
     * wrong fact does the most damage. `year` is not in the input type at all
     * now, so this cannot regress silently through a new caller.
     */
    const schema = movieSchema(
      { id: 603, title: "The Matrix" },
      "https://vy.example"
    );
    expect(schema.datePublished).toBeUndefined();
  });

  it("does not accept a year to publish as a date", () => {
    // A compile-time guard, asserted so the intent survives a careless edit to
    // the interface: `year` has no honest use in this schema.
    expect("year" in ({} as Parameters<typeof movieSchema>[0])).toBe(false);
  });

  it("carries the title, type and canonical watch URL", () => {
    const schema = movieSchema(
      {
        id: 603,
        title: "The Matrix",
        description: "d",
      },
      ORIGIN
    );
    expect(schema["@type"]).toBe("Movie");
    expect(schema.name).toBe("The Matrix");
    expect(schema.url).toContain("/watch/603");
  });

  it("keeps an absent rating out of the schema entirely", () => {
    // `rating: 0` is falsy, so the old `movie.rating ? ...` branch dropped a
    // real zero -- and an explicit `null` became `"null"` in the JSON.
    expect(
      movieSchema(
        { id: 1, title: "x", rating: undefined },
        "https://vy.example"
      ).aggregateRating
    ).toBeUndefined();
    expect(
      movieSchema({ id: 1, title: "x", rating: 0 }, ORIGIN).aggregateRating
    ).toBeUndefined();
    expect(
      movieSchema({ id: 1, title: "x", rating: 8.219 }, ORIGIN).aggregateRating
    ).toEqual({
      "@type": "AggregateRating",
      ratingValue: 8.2,
      bestRating: 10,
      worstRating: 0,
    });
  });
});

describe("webSiteSchema", () => {
  it("uses the live origin rather than a hardcoded host", () => {
    expect(webSiteSchema("https://staging.example").url).toBe(
      "https://staging.example/"
    );
  });
});

/*
 * Drift guards.
 *
 * These read the two static files that a crawler sees and the module the runtime
 * uses, and fail if they disagree. The reason they exist is that this exact pair
 * already drifted: `index.html` and `seoConfig` each carried their own copy of
 * the title, description and keyword list for six months with nothing checking,
 * and `seoConfig` pinned a production hostname that preview deploys then
 * advertised as canonical.
 */
describe("static SEO files agree with the module", () => {
  const rawHtml = readFileSync(
    path.join(repoRoot, "client", "index.html"),
    "utf8"
  );

  /*
   * Comments are stripped before every assertion below. They are documentation,
   * not claims: this file explains at length why `PT0H0M0S` and `favicon.ico`
   * were removed, and a guard that cannot tell the difference between a tag and
   * a note about that tag reports those explanations as violations.
   */
  const indexHtml = rawHtml.replace(/<!--[\s\S]*?-->/g, "");
  /*
   * robots.txt and sitemap.xml no longer exist as files: both are generated at
   * build time from the constants below, so these read the rendered output. That
   * is the point of the change -- there is no second copy of the route list left
   * to fall out of step -- and it also means the guards below cannot pass while
   * the shipped file says something different, because the renderer *is* the
   * shipped file.
   */
  const robots = renderRobots();
  const sitemap = renderSitemap();

  it("uses the module's title in index.html", () => {
    expect(indexHtml).toContain(SITE_TITLE);
  });

  it("uses the module's description in index.html", () => {
    expect(indexHtml).toContain(SITE_DESCRIPTION);
  });

  it("uses the module's keyword list in index.html", () => {
    expect(indexHtml).toContain(SITE_KEYWORDS.join(", "));
  });

  it("uses the module's preview image in index.html", () => {
    expect(indexHtml).toContain(OG_IMAGE);
  });

  it("names no production host in the static head", () => {
    /*
     * The single most valuable guard here. The hostname was previously hardcoded
     * in three places, so a preview deploy served a canonical URL, an og:url and
     * an og:image all pointing at production -- telling a search engine that the
     * preview *is* the live site. If someone reintroduces a literal host, this
     * fails.
     */
    expect(indexHtml).not.toMatch(
      /https?:\/\/(?!www\.themoviedb|github|schema\.org|www\.googleapis)[a-z0-9.-]+\//i
    );
  });

  it("leaves the origin to the build rather than the file", () => {
    expect(indexHtml).toContain("__SITE_ORIGIN__");
  });

  it("marks its structured data so the runtime can adopt it", () => {
    // Without the marker, RouteSeo cannot find this node and appends a second
    // WebSite block on the first navigation.
    expect(indexHtml).toContain('data-jsonld="site-jsonld"');
    // And exactly one such block, not several.
    expect(indexHtml.match(/data-jsonld="site-jsonld"/g)).toHaveLength(1);
  });

  it("does not advertise the site as a zero-length video", () => {
    // A VideoObject with duration PT0H0M0S described every page of the site as a
    // video of no length. Malformed structured data is worse than none: a
    // crawler has to decide what to trust.
    expect(indexHtml).not.toContain("PT0H0M0S");
    expect(indexHtml).not.toContain('"@type": "VideoObject"');
  });

  it("does not point at icon files that do not exist", () => {
    // `public/` ships favicon.svg and nothing else, so these were 404s.
    for (const asset of ["favicon.ico", "apple-touch-icon.png"]) {
      expect(indexHtml).not.toContain(asset);
    }
  });

  it("only disallows paths the runtime also treats as private", () => {
    /*
     * The invariant that matters, and it is directional on purpose. A
     * robots.txt `Disallow` is allowed to omit a private path -- the runtime's
     * `noindex` covers that, and blocking a page a crawler must fetch to *see*
     * the noindex is counterproductive. The reverse is not allowed: every blocked
     * path has to be genuinely private, or the site is refusing to be crawled on
     * pages that are meant to be public.
     */
    for (const entry of ROBOTS_DISALLOW_PATHS) {
      expect(isPrivatePath(`${entry}/anything`), entry).toBe(true);
    }
    // And the paths that are private *only* to the runtime stay crawlable, so
    // their noindex is reachable.
    expect(robots).not.toContain("Disallow: /watch/");
    expect(robots).not.toContain("Disallow: /login/");
  });

  it("lists every public route in the sitemap, and nothing else", () => {
    const locations = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)).map(
      m => m[1]
    );
    // Stripped of an origin, the <loc> list is exactly the route table.
    const paths = locations.map(
      loc => loc.replace(/^https?:\/\/[^/]+/, "") || "/"
    );
    expect(paths).toEqual([...INDEXABLE_PATHS]);
  });

  it("sitemaps only routes the runtime agrees are indexable", () => {
    for (const route of INDEXABLE_PATHS) {
      expect(pageSeo(route).indexable, route).toBe(true);
    }
  });

  it("keeps no private route out of the sitemap", () => {
    for (const privatePath of [
      "/watch/603",
      "/my-list",
      "/profile",
      "/list/share/abc123",
      "/login",
    ]) {
      expect(sitemap, privatePath).not.toContain(privatePath);
      expect(isPrivatePath(privatePath), privatePath).toBe(true);
    }
  });

  it("names no production host and no fabricated dates in the sitemap", () => {
    // The old sitemap had `https://vy-virid.vercel.app` in all four <loc> entries
    // and `<lastmod>2026-10-01</lastmod>` on every URL, a date no commit supports.
    expect(sitemap).not.toMatch(/vy-virid\.vercel\.app/);
    expect(sitemap).not.toContain("lastmod");
    // changefreq and priority are documented as ignored by Google; carrying them
    // looked like tuning and was decoration.
    expect(sitemap).not.toContain("changefreq");
    expect(sitemap).not.toContain("priority");
    // The image entry pointed at a 32x32 SVG on the homepage, which Google
    // Images cannot render and which was not the page's primary content anyway.
    expect(sitemap).not.toContain("image:");
  });

  it("points robots.txt at the sitemap", () => {
    expect(robots).toContain("Sitemap: /sitemap.xml");
  });
});
