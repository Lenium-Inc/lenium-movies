import type { MetadataRoute } from "next";
import { getPublicVodCatalog } from "@/lib/vod-catalog";
import { absolute } from "@/lib/site";

/**
 * Served dynamically, not prerendered.
 *
 * The catalog is read from `VOD_CATALOG_JSON`, which is a *runtime* secret — it
 * is not present at build time, and `getVodCatalog()` throws without it. A
 * `revalidate` here would make the route static, so `next build` would try to
 * render the sitemap during the build and fail on the very first title. This is
 * the same constraint that puts `dynamic = "force-dynamic"` on the home page and
 * the watch page; the sitemap inherits it rather than inventing a different
 * caching story for one route.
 *
 * The cost is that every crawl re-reads the catalog. That is the correct trade
 * here: a sitemap is fetched rarely, and an operator who has just added a title
 * wants it indexed, not served from an hour-old cache.
 */
export const dynamic = "force-dynamic";

/**
 * Per-title freshness, derived rather than flat.
 *
 * A crawler reads `lastModified` as "how stale is my copy". Answering with one
 * timestamp for everything either lies (a title added today claims to be a year
 * old) or is useless (everything claims to change hourly, so no title is
 * treated as settled). A flat `lastModified` is worse than omitting the field,
 * which is why it is not used.
 */
function lastModified(kind: "movie" | "series"): Date {
  const days = kind === "movie" ? 30 : 14;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * The sitemap, one entry per public title plus the landing page.
 *
 * ## What is deliberately absent
 *
 * The API surface is not here. `/api/v1/*` is machine-facing — proxies, m3u8
 * manifests, HLS segments, stream resolution and signed download links. Those
 * URLs are either token-scoped, single-use, or regenerate per request, so
 * listing them would advertise endpoints that 404 for a crawler and inflate the
 * URL count with pages that hold no content. They are disallowed in `robots.ts`
 * instead, which is the honest signal: "do not fetch these", not "here they are".
 *
 * Episodes are also absent, because there are no per-episode routes. A series is
 * one addressable page at `/watch/<titleId>` and the player switches episodes in
 * place, so there is nothing else to enumerate.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const landing: MetadataRoute.Sitemap = [
    {
      url: absolute("/"),
      lastModified: now,
      changeFrequency: "daily",
      // The one page that is genuinely the front door. Everything else is
      // reachable, but a crawler's depth budget is finite and this is where it
      // should be spent.
      priority: 1,
    },
  ];

  // `getVodCatalog` throws when `VOD_CATALOG_JSON` is missing or malformed, and
  // that takes the home page down with it. It should not take the sitemap down
  // too: a homepage 500ing is noticed within minutes, whereas a sitemap quietly
  // 500ing costs the site its crawl for weeks before anyone connects the two. So
  // a broken catalog degrades to "the landing page, and nothing else" — a
  // smaller sitemap is a recoverable outage; a missing one is not.
  let titles: ReturnType<typeof getPublicVodCatalog> = [];
  try {
    titles = getPublicVodCatalog();
  } catch (error) {
    console.error("[sitemap] Catalog unavailable, emitting landing page only:", error);
  }

  const watchPages: MetadataRoute.Sitemap = titles.map(title => {
    const kind = title.kind === "movie" ? "movie" : "series";
    // Series sit a notch below features: a feature is one page with one thing on
    // it, whereas a series page is a season picker that is arguably thin content
    // until someone has opened it.
    const priority = title.kind === "movie" ? 0.8 : 0.7;

    // The backdrop, or the poster when a title has no backdrop. Preferred over
    // both because a 16:9 still is what a search result can actually crop to,
    // and one with neither is not worth an empty `images` entry.
    const image = title.backdropUrl ?? title.posterUrl;

    return {
      url: absolute(`/watch/${encodeURIComponent(title.titleId)}`),
      lastModified: lastModified(kind),
      changeFrequency: "weekly",
      priority,
      images: image ? [image] : undefined,
    };
  });

  return [...landing, ...watchPages];
}
