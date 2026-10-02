import { describe, expect, it } from "vitest";
import {
  SITE_ORIGIN_TOKEN,
  injectOrigin,
  normalizeOrigin,
} from "./seoOriginPlugin";

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
