import type { MetadataRoute } from "next";
import { absolute } from "@/lib/site";

/**
 * robots.txt for the public site.
 *
 * The rule that shapes this file: **a disallow is not access control.** It is a
 * note to a cooperating crawler, and nothing more. Anything genuinely secret has
 * to be enforced by the app or the origin, never by this file. So nothing here
 * leaks -- the blocked paths are all either empty of content or already
 * token-gated -- and the blocked set is chosen to save crawl budget rather than
 * to hide anything.
 *
 * The important consequence is that `/api/v1/*` is blocked but still reachable
 * by anyone who asks for it directly. If a proxy or stream endpoint is meant to
 * be private, it needs a signature or a session check at the route, not a line
 * in this file.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          // Everything under here is machine-facing: HLS manifests and segments,
          // stream resolution, signed downloads, proxy token exchange. A crawler
          // following these burns requests and puts meaningless URLs in a search
          // index. The segments are the worst of it -- one film is thousands of
          // them.
          "/api/",
          // Next.js internals. Not linked from anywhere, and the dev overlay and
          // RSC payloads should not be indexed.
          "/_next/",
          "/monitoring",
          // A search results page is not a document. Letting it through produces
          // near-duplicate titles differing only by a query string, which is the
          // classic way to get a site filtered as thin content.
          "/search",
        ],
      },
      /*
       * A second, stricter group for the crawlers that ignore `Disallow` unless
       * it is stated to their own name. `/watch/` stays allowed everywhere --
       * those are the pages the site actually wants indexed -- so the only
       * thing denied here is the machine surface again, named explicitly rather
       * than relying on a wildcard rule being honoured.
       */
      {
        userAgent: [
          "GPTBot",
          "CCBot",
          "anthropic-ai",
          "ClaudeBot",
          "Bytespider",
        ],
        allow: ["/", "/watch/"],
        disallow: ["/api/", "/_next/"],
      },
    ],
    sitemap: absolute("/sitemap.xml"),
    host: absolute("/"),
  };
}
