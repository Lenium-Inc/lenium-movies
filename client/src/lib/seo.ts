/**
 * Every string and every head tag this site emits, in one place.
 *
 * Why this module exists
 * ----------------------
 * Three files used to answer "what is this page called, and what does the
 * crawler see": the static head in `index.html`, a `seoConfig` object of
 * per-page copy, and a runtime tag writer. None of them knew about the others.
 * The static head and the config carried the same title, description and keyword
 * list twice, so a copy edit in one place silently left the other lying; and
 * `server/seo.ts` hardcoded `https://vy-virid.vercel.app`, so every preview and
 * staging deploy advertised the production origin as canonical.
 *
 * The rule now: this module owns the copy, `head.ts` owns the DOM, and
 * `index.html` carries a static copy of the homepage's tags purely because
 * crawlers read the initial HTML before any JavaScript runs. That copy is not
 * left to memory -- `seo.test.ts` asserts it still matches what is generated
 * here, so the two cannot drift apart again.
 *
 * Why it is pure
 * --------------
 * Nothing in this file touches `document`, `window` or `import.meta.env`. It
 * takes an origin and a pathname and returns a list of plain descriptors. That is
 * what makes the interesting parts -- which routes are indexable, what the
 * canonical URL is, which tags must be *removed* on the way to a page that does not
 * have them -- testable in a plain Node environment, with no DOM and no mocking.
 * The file that does touch the DOM (`head.ts`) is deliberately dumb enough that
 * there is little left in it to want a test.
 *
 * The origin is a required argument rather than a default read from `siteUrl`,
 * which is the other half of that. A default would have made this file import
 * `siteUrl`, and `siteUrl` reads `import.meta.env` -- at which point this module
 * could not be loaded by the build plugin that generates `sitemap.xml`, because
 * the `@/` alias does not exist outside the client's bundler. Depending on the
 * origin instead of reading it keeps one module as the single authority on routes
 * that both the browser and the build can load.
 */

export const SITE_NAME = "Stream Vy";
export const SITE_TAGLINE = "Your screen, your stories";
export const SITE_TITLE = `${SITE_NAME} — ${SITE_TAGLINE}`;

/**
 * Shown as the description for the homepage and as the fallback for every route
 * that has nothing better to say.
 */
export const SITE_DESCRIPTION =
  "High-end minimalist VOD streaming platform.";

/**
 * `keywords` is not a ranking signal, and no major engine has read it in over a
 * decade. It is kept here, and emitted, only because it is already in
 * `index.html` and removing it would be a copy change rather than a code one.
 * If this list is ever touched, deleting it entirely is the better edit.
 */
export const SITE_KEYWORDS = [
  "free movies",
  "stream movies online",
  "public domain movies",
  "free streaming",
  "watch movies free",
  "public domain films",
  "movie database",
];

/**
 * The brand mark, as an SVG.
 *
 * NOTE: Facebook, X/Twitter and LinkedIn do not render SVG in `og:image` and
 * `twitter:image` -- they require a raster image, at least 1200x630. These tags
 * are therefore correct-by-spec but will produce a card with no picture on those
 * platforms until a real preview image exists. `OG_IMAGE` is the single place to
 * change when it does: point it at a PNG, and the drift test will then require
 * `index.html` to match.
 */
export const OG_IMAGE = "/lenium-mark.svg";

/** Routes that must never be indexed, mirroring `public/robots.txt`. */
const PRIVATE_PREFIXES = [
  "/api",
  "/profile",
  "/profiles",
  "/login",
  "/signup",
  "/my-list",
  "/share",
  "/list/share",
] as const;

/*
 * `/watch` is deliberately NOT private.
 *
 * A title page is this site's only content -- a catalogue of public-domain and
 * openly licensed films -- and leaving it noindex means the work of loading and
 * hosting every film buys no organic traffic at all. It was noindex while
 * `index.html` was served for every route, because a page whose canonical pointed
 * at `/` cannot be indexed honestly; now that a watch page carries its own title,
 * description and canonical, that objection no longer applies.
 *
 * `robots.txt` also still permits `/watch`, and that is required rather than
 * incidental: a crawler has to be able to fetch the page to see the `index` that
 * replaces the old `noindex`.
 */

/**
 * Paths `robots.txt` refuses to let a crawler fetch.
 *
 * A deliberately shorter list than `PRIVATE_PREFIXES`, and the difference is the
 * point rather than an oversight. `Disallow` stops a crawler *fetching* a URL; it
 * does not remove it from an index, because a crawler can still reach a blocked
 * URL by following a link to it. So blocking a page that exists only to be
 * `noindex` is counterproductive: it stops the crawler reaching the very tag that
 * would have dropped the page, and can leave the URL sitting in the index as
 * "blocked by robots.txt".
 *
 * These are the paths that carry nothing a crawler should have -- an API surface
 * and per-account or per-token pages. `/login`, `/signup` and `/watch` are
 * `noindex` through their meta tag instead, which is the control that works.
 * `seo.test.ts` asserts every entry here is genuinely private, so this list cannot
 * quietly start blocking pages it should not.
 */
export const ROBOTS_DISALLOW_PATHS = [
  "/api",
  "/profile",
  "/profiles",
  "/my-list",
  "/share",
  "/list/share",
] as const;

/**
 * Every URL that belongs in `sitemap.xml`.
 *
 * Exported because the sitemap is generated from it at build time (see
 * `scripts/seoOriginPlugin.ts`) rather than hand-maintained. The previous sitemap
 * was a literal file listing four `<loc>` entries with the production hostname
 * written into each one, which is a fourth copy of the route table to keep in
 * step with `pageSeo` below -- and a fourth copy of an origin that is wrong in
 * every other environment.
 *
 * Movie pages are absent, and that is a real limitation rather than an oversight:
 * `/watch/:id` is `noindex`, so listing it would invite crawlers to index pages
 * this app tells them not to index. A catalogue of several thousand titles is
 * also well past the point where a hand-written file is the right shape. The
 * honest version of that feature is to index the title pages and generate the
 * sitemap from the catalogue, in that order.
 */
export const INDEXABLE_PATHS = ["/", "/terms", "/privacy", "/dmca"] as const;

/**
 * `robots.txt` and this list have to agree.
 *
 * `Disallow` in `robots.txt` stops a crawler *fetching* a path; it does not
 * guarantee the path is dropped from an index, because a crawler can reach a
 * blocked URL through a link without fetching the block. A `noindex` meta tag on
 * the page itself is the control that actually works, which is why this returns
 * a page for private paths too -- one carrying `noindex, nofollow` and nothing
 * else. `seo.test.ts` reads `robots.txt` and fails if the two lists diverge.
 */
export function isPrivatePath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return PRIVATE_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/**
 * Resolve `path` against `origin`.
 *
 * Written out rather than delegating to `absoluteUrl`, because this module is
 * pure and takes its origin as an argument -- which is what lets the tests state
 * "og:image is absolute" as an assertion instead of hoping a build-time env var
 * happened to be set. With no trustworthy origin the path is returned relative,
 * which is the same deliberate choice `siteUrl` documents: a relative URL is
 * visibly wrong, a guessed hostname is confidently wrong.
 */
function resolve(pathOrUrl: string, origin: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl)) return pathOrUrl;
  if (!origin) return pathOrUrl;
  return `${origin.replace(/\/+$/, "")}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

/** Trim a trailing slash so `/terms/` and `/terms` resolve to one page. */
function normalizePath(pathname: string): string {
  const [path] = (pathname || "/").split(/[?#]/);
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** What a title page knows about itself, for its head and its Movie schema. */
export interface WatchSeoContext {
  id: string | number;
  title: string;
  /** TMDB's overview. Absent when the lookup has not landed yet. */
  description?: string;
  image?: string;
  year?: string | number | null;
}

/** The tmdb id in `/watch/:id`, or null if this is not a watch path. */
export function watchIdFromPath(path: string): string | null {
  const match = /^\/watch\/([^/]+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

export interface PageSeo {
  /** Canonical path for this page, without the origin. */
  path: string;
  title: string;
  description: string;
  keywords?: string[];
  /** Absolute or root-relative preview image. */
  image?: string;
  type?: "website" | "article" | "video.other";
  /** False for a page that must not be indexed. */
  indexable: boolean;
}

/**
 * The metadata for a route.
 *
 * Only routes that exist as their own URL appear here. `browse`, `search` and
 * the catalogue's other views are *not* separate URLs -- they are one client-side
 * route rendered at `/` -- so giving them their own title and description would
 * have meant three different pages claiming to be `/`, which is the same
 * canonical-URL conflict the old config had.
 */
export function pageSeo(
  pathname: string,
  context: { movie?: WatchSeoContext } = {}
): PageSeo {
  const path = normalizePath(pathname);
  const watchId = watchIdFromPath(path);

  /*
   * A watch page before its details have loaded has no title and no description,
   * and inventing either would put a wrong string in a search result. So it stays
   * noindex until the lookup lands, then becomes indexable. A crawler that runs
   * JavaScript -- which Googlebot does -- sees the indexed version.
   */
  if (watchId) {
    const movie = context.movie;
    if (!movie) {
      return { path, title: `${SITE_NAME} - Loading`, description: "", indexable: false };
    }
    const year = movie.year ? ` (${movie.year})` : "";
    return {
      path,
      title: `${movie.title}${year} - Watch Free on ${SITE_NAME}`,
      description:
        movie.description ||
        `Watch ${movie.title}${year} free on ${SITE_NAME}, the free movie streaming platform for public domain and openly licensed films.`,
      keywords: SITE_KEYWORDS,
      image: movie.image || OG_IMAGE,
      type: "video.other",
      indexable: true,
    };
  }
  const originless = (
    title: string,
    description: string,
    extra: Partial<PageSeo> = {}
  ): PageSeo => ({
    path,
    title,
    description,
    keywords: SITE_KEYWORDS,
    image: OG_IMAGE,
    type: "website",
    indexable: true,
    ...extra,
  });

  if (isPrivatePath(path)) {
    /*
     * No title, no description, no image. A `noindex` page should carry nothing
     * that looks like content: the copy would only ever be read by someone who
     * deliberately opened the source.
     */
    return { path, title: SITE_NAME, description: "", indexable: false };
  }

  switch (path) {
    case "/":
      return originless(SITE_TITLE, SITE_DESCRIPTION);
    case "/terms":
      return originless(
        `Terms of Service - ${SITE_NAME}`,
        `The terms that apply to using ${SITE_NAME}, the free movie streaming platform for public domain and openly licensed films.`
      );
    case "/privacy":
      return originless(
        `Privacy Policy - ${SITE_NAME}`,
        `What ${SITE_NAME} stores, what it does not, and how to delete your account and everything attached to it.`
      );
    case "/dmca":
      return originless(
        `Copyright & DMCA - ${SITE_NAME}`,
        `Copyright and takedown policy for ${SITE_NAME}.`
      );
    default:
      // An unknown path is a 404, and a 404 that indexes is a soft 404.
      return {
        path,
        title: `Not Found - ${SITE_NAME}`,
        description: "",
        indexable: false,
      };
  }
}

/** One head tag, as a descriptor. Nothing here is a DOM node. */
export type HeadTag =
  | { kind: "title"; content: string }
  | {
      kind: "meta";
      attribute: "name" | "property";
      key: string;
      content: string;
    }
  | { kind: "link"; rel: string; href: string }
  | { kind: "jsonld"; id: string; data: unknown }
  | { kind: "removeMeta"; attribute: "name" | "property"; key: string }
  | { kind: "removeJsonLd"; id: string };

/** Id of the single per-title JSON-LD block the app manages. */
export const MOVIE_JSONLD_ID = "movie-jsonld";

export interface MovieSchemaInput {
  id: string | number;
  title: string;
  description?: string;
  image?: string;
}

/**
 * schema.org metadata for one title.
 *
 * There is deliberately no `datePublished` and no `aggregateRating`.
 *
 * `datePublished` was synthesised as `${year}-01-01` from the release year, which
 * asserts a publication date the catalogue does not have -- for most
 * public-domain prints it is wrong by most of a century -- and structured data is
 * the one place where a confident wrong fact is read as authoritative. It is
 * absent from `MovieSchemaInput` so no future caller can reintroduce it by
 * accident.
 *
 * `aggregateRating` was emitted from TMDB's `vote_average` with no `ratingCount`.
 * The API exposes no vote count, and Google treats a rating with no count as
 * invalid structured data rather than as a rating -- so the tag was a way of
 * publishing a number nobody could audit, from a sample size nobody knew. The
 * score still shows in the UI, where it is presented as what it is; structured
 * data is held to a stricter standard than a badge on a card.
 */
export function movieSchema(
  movie: MovieSchemaInput,
  origin: string
): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: movie.title,
    url: resolve(`/watch/${movie.id}`, origin),
  };

  if (movie.description) schema.description = movie.description;
  if (movie.image) schema.image = movie.image;
  return schema;
}

/** The site-level structured data, used on every page. */
export function webSiteSchema(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: origin ? `${origin}/` : "/",
    description: SITE_DESCRIPTION,
  };
}

/**
 * The full set of head tags for a page.
 *
 * Optional tags are always emitted as either a value or an explicit `remove`.
 * That is the difference between idempotent and merely idempotent-by-luck: the
 * old writer set `og:type` on a movie page and left it there on `/terms`, so a
 * legal page inherited `video.other` from whatever the viewer watched before it.
 */
export function buildHeadTags(seo: PageSeo, origin: string): HeadTag[] {
  const canonical = resolve(seo.path, origin);
  const tags: HeadTag[] = [{ kind: "title", content: seo.title }];

  // A noindex page still needs this tag; nothing else about it matters.
  tags.push({
    kind: "meta",
    attribute: "name",
    key: "robots",
    content: seo.indexable
      ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
      : "noindex, nofollow",
  });

  if (!seo.indexable) {
    /*
     * Deliberately minimal. There is no description to offer a crawler for a
     * page that must not be indexed, and a stale `og:title` left over from the
     * last film the viewer watched would be worse than nothing -- so every
     * optional tag is removed rather than set to an empty string.
     */
    tags.push({ kind: "removeMeta", attribute: "name", key: "description" });
    tags.push({ kind: "removeMeta", attribute: "name", key: "keywords" });
    tags.push({ kind: "removeMeta", attribute: "property", key: "og:title" });
    tags.push({
      kind: "removeMeta",
      attribute: "property",
      key: "og:description",
    });
    tags.push({ kind: "removeMeta", attribute: "property", key: "og:type" });
    tags.push({ kind: "removeMeta", attribute: "property", key: "og:url" });
    tags.push({ kind: "removeMeta", attribute: "property", key: "og:image" });
    tags.push({ kind: "removeMeta", attribute: "name", key: "twitter:title" });
    tags.push({
      kind: "removeMeta",
      attribute: "name",
      key: "twitter:description",
    });
    tags.push({ kind: "removeMeta", attribute: "name", key: "twitter:image" });
    tags.push({ kind: "removeJsonLd", id: MOVIE_JSONLD_ID });
    return tags;
  }

  tags.push({
    kind: "meta",
    attribute: "name",
    key: "description",
    content: seo.description,
  });
  if (seo.keywords?.length) {
    tags.push({
      kind: "meta",
      attribute: "name",
      key: "keywords",
      content: seo.keywords.join(", "),
    });
  }

  const type = seo.type ?? "website";
  const image = resolve(seo.image ?? OG_IMAGE, origin);
  tags.push(
    {
      kind: "meta",
      attribute: "property",
      key: "og:site_name",
      content: SITE_NAME,
    },
    { kind: "meta", attribute: "property", key: "og:type", content: type },
    {
      kind: "meta",
      attribute: "property",
      key: "og:title",
      content: seo.title,
    },
    {
      kind: "meta",
      attribute: "property",
      key: "og:description",
      content: seo.description,
    },
    { kind: "meta", attribute: "property", key: "og:url", content: canonical },
    { kind: "meta", attribute: "property", key: "og:image", content: image },
    {
      kind: "meta",
      attribute: "name",
      key: "twitter:card",
      content: "summary_large_image",
    },
    {
      kind: "meta",
      attribute: "name",
      key: "twitter:title",
      content: seo.title,
    },
    {
      kind: "meta",
      attribute: "name",
      key: "twitter:description",
      content: seo.description,
    },
    { kind: "meta", attribute: "name", key: "twitter:image", content: image },
    { kind: "link", rel: "canonical", href: canonical }
  );

  // Exactly one Movie block may exist, and it only belongs on a title page.
  tags.push({ kind: "removeJsonLd", id: MOVIE_JSONLD_ID });

  return tags;
}

/** Markers delimiting the region of `index.html` that describes the route. */
export const ROUTE_HEAD_START = "seo:route-head:start";
export const ROUTE_HEAD_END = "seo:route-head:end";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Serialise head descriptors back to HTML.
 *
 * The inverse of what `head.ts` does to a live DOM, and it exists for the same
 * reason: `index.html` can only describe one URL, so a build has to write a real
 * HTML document per route for a crawler to see anything but the homepage.
 *
 * `remove` descriptors are dropped rather than emitted -- there is no HTML for
 * "absent", and a prerendered page should simply not carry the tag. `jsonld` is
 * skipped for the same reason it is absent from the marked region: the site-level
 * and Organization blocks are identical on every route, so they stay literal in
 * `index.html` rather than being regenerated here and drifting from the copy that
 * documents them.
 */
export function renderHeadHtml(seo: PageSeo, origin: string): string {
  return buildHeadTags(seo, origin)
    .map(tag => {
      switch (tag.kind) {
        case "title":
          return `    <title>${escapeHtml(tag.content)}</title>`;
        case "meta":
          return `    <meta ${tag.attribute}="${escapeHtml(tag.key)}" content="${escapeHtml(tag.content)}" />`;
        case "link":
          return `    <link rel="${escapeHtml(tag.rel)}" href="${escapeHtml(tag.href)}" />`;
        case "jsonld":
        case "removeJsonLd":
        case "removeMeta":
          return null;
      }
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Replace the route-varying region of `index.html` with one route's head.
 *
 * Only the tags between the markers are rewritten. Everything else in the file --
 * the icons, the Search Console verification token, the site-wide JSON-LD -- is
 * identical on every page, and rewriting it would mean two copies of it to keep in
 * step. Returns the input unchanged if the markers are missing, which is treated
 * as a build failure by the caller rather than silently shipping a page whose
 * title is still the homepage's.
 */
export function applyRouteHead(
  html: string,
  seo: PageSeo,
  origin: string
): string {
  const start = html.indexOf(`<!-- ${ROUTE_HEAD_START} -->`);
  const end = html.indexOf(`<!-- ${ROUTE_HEAD_END} -->`);
  if (start < 0 || end < 0 || end < start) return html;

  const head = renderHeadHtml(seo, origin);
  return (
    html.slice(0, start) +
    `<!-- ${ROUTE_HEAD_START} -->\n` +
    head +
    `\n    <!-- ${ROUTE_HEAD_END} -->` +
    html.slice(end + `<!-- ${ROUTE_HEAD_END} -->`.length)
  );
}

export default pageSeo;
