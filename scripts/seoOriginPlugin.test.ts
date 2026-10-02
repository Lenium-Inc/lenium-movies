import { describe, expect, it } from "vitest";
import {
  SITE_ORIGIN_TOKEN,
  injectOrigin,
  normalizeOrigin,
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

  it("omits lastmod rather than asserting one", () => {
    /*
     * The previous sitemap put <lastmod>2026-10-01</lastmod> on every URL. A
     * wrong lastmod is not harmless the way a wrong changefreq is: it is a claim
     * about how often to re-crawl, so a crawler that trusts it can skip a page
     * that actually changed. With no reliable modification date, the element is
     * left out.
     */
    const xml = renderSitemap(INDEXABLE_PATHS, "https://vy.example");
    expect(xml).not.toContain("lastmod");
    expect(xml).not.toContain("2026-");
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
