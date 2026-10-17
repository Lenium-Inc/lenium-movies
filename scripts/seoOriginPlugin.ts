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
import {
  INDEXABLE_PATHS,
  ROUTE_HEAD_END,
  ROUTE_HEAD_START,
  ROBOTS_DISALLOW_PATHS,
  applyRouteHead,
  injectBeforeHeadEnd,
  movieJsonLdHtml,
  pageSeo,
} from "../client/src/lib/seo";

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
 * The production origin Vercel injects at build time, or `""` outside one.
 *
 * This is the fallback for a build with no `VITE_SITE_URL`, and it exists
 * because the failure it prevents is silent: with no origin the plugin writes
 * no sitemap.xml at all, omits the `Sitemap` line from robots.txt, and leaves
 * `canonical` as a relative path -- so the site deploys looking healthy while
 * being effectively invisible to submission. Vercel already knows the
 * deployment's own production domain (`VERCEL_PROJECT_PRODUCTION_URL`), so a
 * production build can resolve its origin with no configuration rather than
 * depending on someone remembering an env var.
 *
 * Deliberately production-only. The `VERCEL_ENV=preview` case is where a
 * hardcoded host once caused real damage: every preview advertised itself as
 * the live site, which is exactly the bug `__SITE_ORIGIN__` was introduced to
 * remove. A preview therefore keeps the empty origin -- relative URLs and no
 * sitemap, which is honest -- rather than borrowing production's identity.
 *
 * The value is a bare domain with no scheme, so `https://` is added here;
 * defensive stripping of a scheme or trailing slash handles the case where a
 * future platform change reports it differently, since a doubled
 * `https://https://` in a sitemap would be a confidently broken file.
 */
export function vercelProductionOrigin(
  env: Record<string, string | undefined> = process.env
): string {
  if (env.VERCEL_ENV !== "production") return "";
  const host = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!host) return "";
  const bare = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return bare ? `https://${bare}` : "";
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

/**
 * The output file for a prerendered route.
 *
 * `/` is the SPA entry point itself; every other route becomes `<name>.html`,
 * which `vercel.json` rewrites to. Directories like `terms/index.html` were the
 * other option and would work too, but a rewrite is explicit about what it is
 * doing, whereas a directory relies on host-specific clean-URL behaviour.
 */
/**
 * Google's hard cap, and the reason the catalogue below is not paginated forever.
 */
export const MAX_SITEMAP_URLS = 50_000;

/**
 * Per-route crawl hints.
 *
 * `priority` is how a crawler should spend a finite per-domain crawl budget when
 * it cannot get to everything, so it is a statement about *this site's* shape
 * rather than about the pages in isolation. The homepage is the only page whose
 * absence would mean the site has no front door; the legal pages exist to be
 * reachable, not to compete for attention.
 *
 * `changefreq` is a hint, not a promise -- Google largely ignores it now -- so it
 * is only ever set to the truth. Nothing here is written `hourly`, because
 * nothing on this site changes hourly.
 */
export const ROUTE_CRAWL_HINTS: Record<
  string,
  { changefreq: "daily" | "weekly" | "monthly" | "yearly"; priority: number }
> = {
  "/": { changefreq: "daily", priority: 1 },
  "/terms": { changefreq: "yearly", priority: 0.3 },
  "/privacy": { changefreq: "yearly", priority: 0.3 },
  "/dmca": { changefreq: "yearly", priority: 0.3 },
};

/** Titles change when the catalogue gains one, so `weekly` is honest for them. */
const WATCH_HINT = { changefreq: "weekly" as const, priority: 0.8 };

/**
 * One film as the build knows it: enough for a sitemap `<loc>` and for the
 * head of a prerendered page.
 *
 * The catalogue endpoint already returns the title, synopsis, release year and
 * poster of every item; the walk used to keep only the id and throw the rest
 * away, which is why film pages could be listed in the sitemap but not given
 * their own `<title>` or description at build time.
 */
export interface CatalogueEntry {
  /** Bare TMDB id -- the catalogue prefixes it as `tmdb-969681`. */
  id: string;
  title: string;
  /** Release year, or null when the record has no usable date. */
  year: number | null;
  overview: string;
  posterUrl: string;
}

/** One `<url>` entry for a title page. */
function titleEntry(entry: CatalogueEntry, origin: string): string {
  const loc = escapeXml(`${origin}/title/${entry.id}`);
  return [
    "  <url>",
    `    <loc>${loc}</loc>`,
    `    <changefreq>${WATCH_HINT.changefreq}</changefreq>`,
    `    <priority>${WATCH_HINT.priority}</priority>`,
    "  </url>",
  ].join("\n");
}

export type Fetcher = (url: string) => Promise<unknown>;

/**
 * Fetch with a timeout and one retry, because this runs inside a build.
 *
 * The timeout is generous on purpose. The backend is on Render's free tier, so an
 * idle period spins the instance down and the next request pays a cold start --
 * measured at well over 20s, which is exactly what a too-tight deadline trips on.
 * A slow answer is still an answer; a failed build is not recoverable here.
 */
const REQUEST_TIMEOUT_MS = 60_000;

const defaultFetcher: Fetcher = async url => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

/**
 * Walk the catalogue and return one record per film.
 *
 * Renamed from `fetchCatalogueIds`: the walk used to keep only the id, which
 * was enough for a sitemap `<loc>` but not for the prerendered page that loc
 * points at -- a film page whose head carries the homepage's title describes
 * nothing to the crawler that reads the first HTML. The full record costs no
 * extra requests; it is the same payload, minus the deletion.
 */
export async function fetchCatalogue(
  apiBase: string,
  fetcher: Fetcher = defaultFetcher,
  concurrency = 8
): Promise<CatalogueEntry[]> {
  const base = apiBase.replace(/\/+$/, "");
  const pageUrl = (page: number) => `${base}/api/catalog/discover?page=${page}`;
  type CatalogueItem = {
    id?: unknown;
    title?: unknown;
    year?: unknown;
    release_date?: unknown;
    overview?: unknown;
    poster_url?: unknown;
  };
  type Page = {
    items?: CatalogueItem[];
    has_more?: boolean;
    total?: number;
    per_page?: number;
  };

  const entry = (item: CatalogueItem): CatalogueEntry | null => {
    // The catalogue prefixes ids as `tmdb-969681`; the title route uses the
    // bare TMDB id, which is what `buildTitlePath` produces.
    const raw = String(item?.id ?? "");
    const id = raw.startsWith("tmdb-") ? raw.slice(5) : raw;
    if (!id) return null;

    const title = typeof item.title === "string" ? item.title.trim() : "";
    // `year` is the resolved number; `release_date` is the raw date it came
    // from. Both are checked because a record missing one usually has the
    // other, and a page titled only "Watch Free on Stream Vy" is worse than
    // no page at all.
    const year =
      typeof item.year === "number" && Number.isFinite(item.year)
        ? item.year
        : /^(\d{4})/.exec(String(item.release_date ?? ""))?.[1]
          ? Number(/^(\d{4})/.exec(String(item.release_date ?? ""))![1])
          : null;

    return {
      id,
      title,
      year,
      overview: typeof item.overview === "string" ? item.overview.trim() : "",
      posterUrl:
        typeof item.poster_url === "string" ? item.poster_url.trim() : "",
    };
  };

  const entries = (page: Page) =>
    (page.items ?? [])
      .map(entry)
      .filter((item): item is CatalogueEntry => item !== null);

  const first = (await fetcher(pageUrl(1))) as Page;
  const perPage = first.per_page ?? entries(first).length ?? 1;
  /*
   * Walk the catalogue with concurrent batches until the backend stops saying
   * `has_more`, rather than trusting `total`.
   *
   * `total` reads back as different numbers on different calls -- 66 and 1971 for
   * the same catalogue were both observed -- so deriving the page count from it
   * silently produced sitemaps that varied by several hundred URLs depending on
   * what a given response happened to say. `has_more` has been consistent, and the
   * batch loop keeps ~99 round trips down to a handful of seconds.
   *
   * `total` still sets the starting batch size, since when it is right it is a
   * useful hint; it just no longer decides when to stop.
   */
  const hintedPages =
    typeof first.total === "number" && first.total > 0
      ? Math.ceil(first.total / (perPage || 1))
      : 1;

  const items: CatalogueEntry[] = [];
  const seen = new Set<string>();
  const add = (values: CatalogueEntry[]) => {
    let added = 0;
    for (const item of values) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
        added += 1;
      }
    }
    return added;
  };
  add(entries(first));

  let page = 2;
  let more = first.has_more !== false;
  let staleBatches = 0;
  const hardCap = Math.ceil(MAX_SITEMAP_URLS / (perPage || 1));

  while (more && page <= hardCap && page <= 10_000) {
    const batchSize = Math.min(
      concurrency,
      Math.max(1, hintedPages - page + 1) || concurrency
    );
    const batch = Array.from({ length: batchSize }, (_, i) => page + i);
    /*
     * Each page fails on its own, and a failed page is treated as an empty one.
     *
     * `Promise.all` used to reject the whole batch the moment any single page
     * threw, and the loader caught that by returning no records at all -- so one
     * 500 or one 60s timeout on the Render free tier emptied the sitemap of every
     * title, which is the entire point of walking the catalogue. The measured
     * behaviour confirms this is not hypothetical: a walk of ~160 pages hit
     * timeouts at page ~122 under 8-way concurrency, which under the old code
     * would have shipped a four-URL sitemap.
     *
     * An empty result still feeds the staleness backstop below: a batch that
     * fails *and* contributes nothing counts toward `staleBatches`, so a backend
     * that has gone away ends the walk after two tries instead of paging on into
     * the timeout.
     */
    const fetched = await Promise.all(
      batch.map(async (p): Promise<Page | null> => {
        try {
          return (await fetcher(pageUrl(p))) as Page;
        } catch {
          return null;
        }
      })
    );

    let added = 0;
    let sawMore = false;
    for (const result of fetched) {
      if (!result) continue;
      added += add(entries(result));
      if (result.has_more !== false) sawMore = true;
    }
    more = sawMore;
    page += batch.length;

    /*
     * A batch that contributes nothing new means the backend has started repeating
     * itself, so the walk is finished even if it still claims there is more. This
     * is the backstop that stops an inconsistent `has_more` from paging forever.
     */
    staleBatches = added === 0 ? staleBatches + 1 : 0;
    if (staleBatches >= 2) break;
    if (items.length >= MAX_SITEMAP_URLS) break;
  }

  return items.slice(0, MAX_SITEMAP_URLS);
}

/** The static routes plus one entry per film. */
export function renderCatalogueSitemap(
  entries: readonly CatalogueEntry[],
  origin: string,
  lastmodByPath: Readonly<Record<string, string>> = {}
): string {
  const urls = INDEXABLE_PATHS.map(path => {
    const loc = `${origin}${path === "/" ? "/" : path}`;
    const lastmod = lastmodByPath[path];
    // A path with no entry here is still listed, just without hints -- which
    // beats dropping it, since an unlisted page is invisible and an unhinted one
    // is merely unprioritised.
    const hint = ROUTE_CRAWL_HINTS[path];
    return [
      "  <url>",
      `    <loc>${escapeXml(loc)}</loc>`,
      lastmod ? `    <lastmod>${lastmod}</lastmod>` : "",
      hint ? `    <changefreq>${hint.changefreq}</changefreq>` : "",
      hint ? `    <priority>${hint.priority}</priority>` : "",
      "  </url>",
    ]
      .filter(Boolean)
      .join("\n");
  });
  urls.push(...entries.map(entry => titleEntry(entry, origin)));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join(
    "\n"
  )}\n</urlset>\n`;
}

export function prerenderFileName(path: string): string {
  if (path === "/") return "index.html";
  return `${path.replace(/^\/+|\/+$/g, "")}.html`;
}

/**
 * One HTML document per sitemapped route.
 *
 * Without this the SPA has a single indexable URL. Every route returns the same
 * `index.html`, whose canonical is `/`, so a crawler is told that `/terms` is a
 * duplicate of the homepage -- and the sitemap's `<loc>https://.../terms</loc>`
 * then contradicts the page it points at, which is how three legal pages ended up
 * submitted, canonicalised away, and dropped.
 *
 * Hydration is unaffected: the prerendered files differ only in the marked head
 * region, and `RouteSeo` still rewrites the head on navigation. The static copy is
 * there for crawlers that do not execute JavaScript, and for the first paint.
 */
export function prerenderRoutes(
  html: string,
  origin: string,
  paths: readonly string[] = INDEXABLE_PATHS
): Array<{ fileName: string; source: string }> {
  return paths.map(path => ({
    fileName: prerenderFileName(path),
    source: injectOrigin(applyRouteHead(html, pageSeo(path), origin), origin),
  }));
}

/**
 * One real HTML document per film, at the URL the sitemap lists for it.
 *
 * Without this a film page ships the homepage's `<title>` and no description:
 * the first HTML a crawler reads says "Stream Vy -- Watch Free Movies Online"
 * for every film on the site, and only a JavaScript-executing crawler ever
 * learns otherwise, on a second pass, for each page. The head is built by the
 * same `pageSeo` the live app uses, so the static copy and the hydrated one
 * cannot drift apart, and the Movie JSON-LD goes in with the same
 * `data-jsonld` id `head.ts` writes at runtime -- so hydration updates the
 * block in place rather than adding a second script beside it.
 *
 * The URL is `/title/:id`, never `/watch/:id`: the details page is the one
 * with a synopsis and a poster, it is what every click routes through, and
 * the player is `noindex` so listing it would point crawlers at a page that
 * asks not to be indexed.
 */
export function prerenderTitlePages(
  html: string,
  origin: string,
  catalogue: readonly CatalogueEntry[]
): Array<{ fileName: string; source: string }> {
  return catalogue
    // A film with no title cannot be given a truthful `<title>` tag -- the
    // head would fall back to naming the site alone, which every other page
    // already does better. Skipping it costs one URL in the sitemap that
    // resolves through the SPA to the live head, which is the state every
    // film page was in before this existed.
    .filter(entry => entry.title)
    .map(entry => {
      const path = `/title/${entry.id}`;
      const movie = {
        id: entry.id,
        title: entry.title,
        description: entry.overview || undefined,
        image: entry.posterUrl || undefined,
        year: entry.year,
      };
      const withHead = applyRouteHead(html, pageSeo(path, { movie }), origin);
      const withJsonLd = injectBeforeHeadEnd(
        withHead,
        movieJsonLdHtml(movie, origin)
      );
      return {
        fileName: prerenderFileName(path),
        source: injectOrigin(withJsonLd, origin),
      };
    });
}

/**
 * The catalogue, read once per build.
 *
 * Failure is a warning, not an error: a build that cannot reach the backend should
 * still produce a site, and a sitemap of the static routes is still correct if
 * incomplete. What it must not do is fail silently -- a catalogue that quietly
 * emptied out would drop every film from the index with nothing in the log.
 */
async function loadCatalogue(plugin: {
  warn: (message: string) => void;
  info: (message: string) => void;
}): Promise<CatalogueEntry[]> {
  const apiBase = (
    process.env.VITE_MOVIE_API_BASE_URL ??
    process.env.MOVIE_API_BASE_URL ??
    ""
  ).trim();
  if (!apiBase || apiBase === "/") {
    plugin.warn(
      "No absolute VITE_MOVIE_API_BASE_URL set, so film pages are neither in " +
        "sitemap.xml nor prerendered. The static routes are still listed."
    );
    return [];
  }
  try {
    const catalogue = await fetchCatalogue(apiBase);
    plugin.info(
      `Sitemap: ${catalogue.length} title pages from the catalogue.`
    );
    return catalogue;
  } catch (error) {
    plugin.warn(
      `Could not read the catalogue for sitemap.xml (${String(error)}). ` +
        "The static routes are still listed; title pages will be missing " +
        "until a build can reach the backend."
    );
    return [];
  }
}

export function seoOriginPlugin(): Plugin {
  let origin = "";
  let catalogue: CatalogueEntry[] = [];

  return {
    name: "streamvy:seo-origin",
    /*
     * `post` because the prerender step reads `index.html` out of the bundle, and
     * Vite's own HTML plugin emits it during its `generateBundle`. Without this
     * the bundle is still missing the file and nothing gets prerendered -- which
     * fails silently into a site with one indexable URL again.
     */
    enforce: "post",
    async buildStart() {
      catalogue = await loadCatalogue(this);
    },
    /*
     * `configResolved` rather than reading `process.env` inline: Vite does *not*
     * populate `process.env` from the `.env` files it loads, so a `VITE_SITE_URL`
     * committed in `.env` would reach the client through `import.meta.env` while
     * the static head silently kept its unresolved token. `loadEnv` is the
     * supported way to read the same files the client is built from, and reading
     * the real environment too means a platform-injected variable still wins.
     *
     * The Vercel fallback is last so an explicit `VITE_SITE_URL` always beats
     * the platform's own idea of the domain -- the operator may deliberately
     * serve from a different host (a www/apex split, a stable alias) than the
     * one Vercel reports, and the sitemap must name the host the site is
     * actually read at.
     */
    configResolved(config) {
      const fromFile = loadEnv(config.mode, config.envDir, "VITE_SITE_URL");
      origin =
        normalizeOrigin(fromFile.VITE_SITE_URL ?? process.env.VITE_SITE_URL) ||
        vercelProductionOrigin();
    },

    transformIndexHtml(html: string) {
      return injectOrigin(html, origin);
    },

    /*
     * A real HTML document per sitemapped route. `transformIndexHtml` above only
     * ever sees the entry `index.html`, so without this step `/terms`, `/privacy`
     * and `/dmca` would ship the homepage's title and `canonical="/"`, and the
     * sitemap would be listing URLs that disown themselves.
     *
     * The markers are checked rather than assumed: if someone edits the region out
     * of `index.html`, the pages would silently keep the homepage's head, so this
     * fails the build instead.
     */
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        chunk => chunk.type === "asset" && chunk.fileName === "index.html"
      ) as { source: string } | undefined;

      if (entry) {
        if (
          !entry.source.includes(ROUTE_HEAD_START) ||
          !entry.source.includes(ROUTE_HEAD_END)
        ) {
          this.error(
            `index.html no longer contains the ${ROUTE_HEAD_START} / ${ROUTE_HEAD_END} markers. ` +
              "Without them the prerendered routes cannot be given their own " +
              "title or canonical, and every route ships as a copy of the homepage."
          );
        }

        for (const page of prerenderRoutes(
          injectOrigin(entry.source, origin),
          origin
        )) {
          this.emitFile({ type: "asset", ...page });
        }

        /*
         * Only when there is an origin to name: a prerendered film page with a
         * relative canonical is a page that disowns itself, which is the exact
         * failure the static routes were fixed for. With no origin the film
         * pages fall through to the SPA, whose live head is still better than a
         * confidently wrong static one.
         */
        if (origin && catalogue.length > 0) {
          const pages = prerenderTitlePages(
            injectOrigin(entry.source, origin),
            origin,
            catalogue
          );
          for (const page of pages) {
            this.emitFile({ type: "asset", ...page });
          }
          this.info(
            `Prerendered ${pages.length} film pages with their own title, ` +
              "description and Movie JSON-LD."
          );
        }
      } else {
        this.warn(
          "index.html was not found in the bundle; nothing prerendered."
        );
      }

      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: renderRobots(ROBOTS_DISALLOW_PATHS, origin),
      });

      if (!origin) {
        this.warn(
          "No VITE_SITE_URL set (and not a Vercel production build), so " +
            "sitemap.xml was not written: a sitemap needs absolute URLs and " +
            "would be rejected if written with relative paths. robots.txt has " +
            "no sitemap URL for the same reason. The canonical and og:url in " +
            "index.html are relative for the same reason."
        );
        return;
      }

      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: renderCatalogueSitemap(
          catalogue,
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
