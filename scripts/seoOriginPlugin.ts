/**
 * Makes the deployment's own origin the only origin the build emits.
 *
 * The problem
 * -----------
 * `index.html` and `sitemap.xml` are the two SEO surfaces a crawler reads
 * directly, and both have to be literal files -- there is no server to render
 * them. So the canonical URL, the `og:url`, the `<loc>` entries and the `Sitemap:`
 * line in `robots.txt` all have to name a host, and the obvious thing to write is
 * the production hostname.
 *
 * That is wrong for every environment that is not production. A Vercel preview
 * deploy then advertises `https://vy-virid.vercel.app` as the canonical URL of
 * every page on it, and as the location of every film, which tells a search engine
 * the preview *is* the live site. The same literal was independently duplicated in
 * `server/seo.ts` and `public/robots.txt`, so the host was in four places and
 * could only ever be right in one of them.
 *
 * The fix
 * -------
 * Two parts, and the second is the one that matters.
 *
 * 1. `index.html` writes a `__SITE_ORIGIN__` token which is substituted at build
 *    time from the same `VITE_SITE_URL` the client resolves in `siteUrl.ts` -- one
 *    env var, one origin.
 * 2. `sitemap.xml` and `robots.txt` are *generated* here, rather than being
 *    hand-maintained files in `public/`. Both are now derived from the route table
 *    in `client/src/lib/seo.ts`, so a new public route cannot be added without
 *    appearing in the sitemap, and a private route cannot leak into it. The old
 *    sitemap was a fourth hand-written copy of the route list, with the origin
 *    written into all four entries.
 *
 * With `VITE_SITE_URL` unset the origin becomes an empty string, leaving URLs
 * root-relative. A relative canonical is resolved against the document's own
 * origin and is accepted by every major engine, so an unconfigured build degrades
 * to "correct wherever this is served from" instead of "confidently wrong". Note
 * that a relative `<loc>` is *not* valid inside a sitemap -- the spec wants an
 * absolute URL -- so an unconfigured production deploy would ship a sitemap
 * engines may reject. That is the intended failure: a rejected sitemap costs
 * nothing, whereas a sitemap pointing at the wrong host canonicalises the wrong
 * URLs.
 */

import { execFileSync } from "node:child_process";
import { loadEnv, type Plugin } from "vite";
import { INDEXABLE_PATHS, ROBOTS_DISALLOW_PATHS } from "../client/src/lib/seo";

export const SITE_ORIGIN_TOKEN = "__SITE_ORIGIN__";

/**
 * Normalise a configured origin: trimmed, without a trailing slash.
 *
 * Exported separately from the plugin so it can be tested without constructing a
 * Vite build.
 */
export function normalizeOrigin(value: string | undefined | null): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

/**
 * Replace the token in a document.
 *
 * A single pass, so an origin that itself contains the token cannot be
 * substituted into again.
 */
export function injectOrigin(html: string, origin: string): string {
  if (!html.includes(SITE_ORIGIN_TOKEN)) return html;
  return html.split(SITE_ORIGIN_TOKEN).join(origin);
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * `sitemap.xml`, built from `INDEXABLE_PATHS`.
 *
 * `<loc>` must be an absolute URL -- the spec requires it, and a relative one is
 * a parse error that gets the whole file discarded. So when no origin is
 * configured this renders nothing at all rather than emitting `/terms` and
 * calling it a sitemap; see the plugin's `generateBundle` for why that is the
 * better of the two failures.
 *
 * On the other elements the previous file carried:
 *
 * - `changefreq` and `priority`, which Google's documentation states it ignores
 *   ("Google ignores the `changefreq` and `priority` tags"). They looked like
 *   tuning and were decoration. Worth noting they are also the tags most often
 *   advised as necessary, and the advice is simply wrong.
 * - an `image:image` entry pointing at the 32x32 SVG brand mark, on the
 *   homepage. Google Images wants raster, and an image entry is meant for a page
 *   whose primary content is that image; the homepage's primary content is a
 *   film catalogue.
 *
 * `lastmod` is emitted only for a path whose real last-modified date is known --
 * passed in from the caller, which reads it from git. Inventing one is worse
 * than omitting it: `lastmod` is a claim about when to re-crawl, so the old
 * file's blanket `2026-10-01` could talk a crawler out of re-fetching a page
 * that genuinely changed. `new Date()` at build time, the usual replacement, is
 * the same fabrication with a fresher timestamp.
 */
export function renderSitemap(
  paths: readonly string[] = INDEXABLE_PATHS,
  origin = "",
  lastmodByPath: Readonly<Record<string, string>> = {}
): string {
  const entries = paths
    .map(path => {
      const loc = `${origin}${path === "/" ? "/" : path}`;
      const lastmod = lastmodByPath[path];
      const lastmodTag = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : "";
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>${lastmodTag}\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

/**
 * Which source file each sitemapped page is rendered from, for `lastmod`.
 *
 * The last-modified date a crawler wants is when the *content* last changed, and
 * for a route rendered by one component, that is when that component's file was
 * last committed. `Home.tsx` changing is a real change to `/`.
 */
export const SITEMAP_SOURCES: Record<string, string> = {
  "/": "client/src/pages/Home.tsx",
  "/terms": "client/src/pages/Terms.tsx",
  "/privacy": "client/src/pages/Privacy.tsx",
  "/dmca": "client/src/pages/Dmca.tsx",
};

/**
 * Last commit date for each sitemapped path, as `YYYY-MM-DD`.
 *
 * Read from git rather than trusted, and tolerant of git being absent: Vercel
 * builds sometimes run against a shallow clone with no history, and a build that
 * fails because it could not date a file would be a worse outcome than a sitemap
 * without `lastmod`. Returns `{}` in that case and the elements are simply
 * omitted, which is valid.
 */
export function gitLastmodByPath(cwd: string): Record<string, string> {
  const dates: Record<string, string> = {};
  for (const [path, file] of Object.entries(SITEMAP_SOURCES)) {
    try {
      const stamp = execFileSync(
        "git",
        ["log", "-1", "--format=%cs", "--", file],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(stamp)) dates[path] = stamp;
    } catch {
      // No git, no history, or no such file. Omit rather than guess.
    }
  }
  return dates;
}

/**
 * `robots.txt`, built from `ROBOTS_DISALLOW_PATHS`.
 *
 * One `User-agent: *` group. The file also had an identical `Googlebot` group,
 * which is redundant rather than clarifying: a crawler picks the most specific
 * group that matches it and falls back to `*`, so where the two groups are the
 * same the second changes nothing while implying the first might not apply.
 */
export function renderRobots(
  disallow: readonly string[] = ROBOTS_DISALLOW_PATHS,
  origin = ""
): string {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    ...disallow.map(path => `Disallow: ${path}/`),
    "",
  ];
  /*
   * Only when there is a sitemap to point at. The spec wants an absolute URL here,
   * and a relative one is ignored -- so with no origin the line is dropped rather
   * than written as a reference to a file that does not exist. The disallow rules
   * above are unaffected; they are the part that does the work.
   */
  if (origin) lines.push(`Sitemap: ${origin}/sitemap.xml`, "");
  return lines.join("\n");
}

export function seoOriginPlugin(): Plugin {
  let origin = "";

  return {
    name: "streamvy:seo-origin",
    /*
     * `configResolved` rather than reading `process.env` inline: Vite does *not*
     * populate `process.env` from the `.env` files it loads, so a `VITE_SITE_URL`
     * committed in `.env` would reach the client through `import.meta.env` while
     * the static head silently kept its unresolved token. `loadEnv` is the
     * supported way to read the same files the client is built from, and reading
     * the real environment too means a platform-injected variable still wins.
     */
    configResolved(config) {
      const fromFile = loadEnv(config.mode, config.envDir, "VITE_SITE_URL");
      origin = normalizeOrigin(
        fromFile.VITE_SITE_URL ?? process.env.VITE_SITE_URL
      );
    },

    transformIndexHtml(html: string) {
      return injectOrigin(html, origin);
    },

    /*
     * Emitted rather than read from `public/`, so the file is derived from the
     * route table instead of maintained beside it.
     *
     * With no origin configured the sitemap is not written at all. A `<loc>` must
     * be absolute, so the alternative is a file full of `/terms` that engines
     * reject outright -- and a rejected sitemap is indistinguishable from no
     * sitemap, which means the misconfiguration stays invisible. Omitting it is
     * at least honest XML, and the warning below says why it is missing. The
     * fix is to set VITE_SITE_URL, which this build already needed for the
     * canonical URL in index.html.
     */
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: renderRobots(ROBOTS_DISALLOW_PATHS, origin),
      });

      if (!origin) {
        this.warn(
          "No VITE_SITE_URL set, so sitemap.xml was not written: a sitemap " +
            "needs absolute URLs and would be rejected if written with " +
            "relative paths. robots.txt has no sitemap URL for the same " +
            "reason. The canonical and og:url in index.html are relative for " +
            "the same reason."
        );
        return;
      }

      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: renderSitemap(
          INDEXABLE_PATHS,
          origin,
          gitLastmodByPath(process.cwd())
        ),
      });
    },

    /*
     * `npm run dev` gets both files, from the same functions, so a local run
     * shows what production will ship instead of a hand-written copy of it.
     *
     * The sitemap is withheld here too, for the same reason as in the build. In
     * dev the origin is usually unset anyway, and localhost is never crawled.
     */
    configureServer(server) {
      server.middlewares.use("/robots.txt", (_request, response) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(renderRobots(ROBOTS_DISALLOW_PATHS, origin));
      });

      if (!origin) return;
      server.middlewares.use("/sitemap.xml", (_request, response) => {
        response.setHeader("Content-Type", "application/xml; charset=utf-8");
        response.end(
          renderSitemap(
            INDEXABLE_PATHS,
            origin,
            gitLastmodByPath(process.cwd())
          )
        );
      });
    },
  };
}

export default seoOriginPlugin;
