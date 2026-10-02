import { useEffect } from "react";
import { useLocation } from "wouter";
import { applyHeadTags } from "@/lib/head";
import {
  MOVIE_JSONLD_ID,
  buildHeadTags,
  movieSchema,
  pageSeo,
  watchIdFromPath,
  webSiteSchema,
} from "@/lib/seo";
import { siteUrl } from "@/lib/siteUrl";
import { resetWatchSeo, useWatchSeo } from "@/lib/watchSeo";

/**
 * Keeps the document head in step with the route.
 *
 * This exists because `index.html` can only ever describe one URL. Everything
 * else -- `/terms`, `/privacy`, `/dmca`, and the private paths that must not be
 * indexed at all -- needs the head written after navigation, and until something
 * like this was mounted, the SEO helpers sat unused in the tree while every page
 * after the first announced itself as the homepage.
 *
 * Mounted once, inside the router, rather than per page. Per-page would mean
 * every new route had to remember to call it, and the first one that did not
 * would silently ship with the wrong title -- the failure mode is invisible
 * because the page looks fine.
 */
export function RouteSeo(): null {
  const [location] = useLocation();
  const movie = useWatchSeo();

  useEffect(() => {
    const origin = siteUrl();
    const watchId = watchIdFromPath(location.split(/[?#]/)[0] ?? "/");

    /*
     * A title page publishes its own metadata once loaded; everything else clears
     * whatever the last one left behind. Clearing on the way out is what stops
     * "The Matrix" following the viewer to the home page.
     */
    if (!watchId) resetWatchSeo();

    const seo = pageSeo(location, {
      movie: watchId ? (movie ?? undefined) : undefined,
    });
    const tags = buildHeadTags(seo, origin);

    if (watchId && movie) {
      tags.push({
        kind: "jsonld",
        id: MOVIE_JSONLD_ID,
        data: movieSchema(movie, origin),
      });
    }

    tags.push({
      kind: "jsonld",
      id: "site-jsonld",
      data: webSiteSchema(origin),
    });
    applyHeadTags(tags);
  }, [location, movie]);

  return null;
}

export default RouteSeo;
