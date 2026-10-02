import { describe, expect, it } from "vitest";
import {
  SITE_ORIGIN_TOKEN,
  injectOrigin,
  normalizeOrigin,
  prerenderFileName,
  prerenderRoutes,
  renderRobots,
  renderSitemap,
} from "./seoOriginPlugin";
import { INDEXABLE_PATHS, ROBOTS_DISALLOW_PATHS } from "../client/src/lib/seo";

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
