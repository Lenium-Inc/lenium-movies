import { useEffect } from "react";
import { useLocation } from "wouter";
import { applyHeadTags } from "@/lib/head";
import { buildHeadTags, pageSeo, webSiteSchema } from "@/lib/seo";
import { siteUrl } from "@/lib/siteUrl";

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

  useEffect(() => {
    const seo = pageSeo(location);
    applyHeadTags([
      ...buildHeadTags(seo),
      { kind: "jsonld", id: "site-jsonld", data: webSiteSchema(siteUrl()) },
    ]);
  }, [location]);

  return null;
}

export default RouteSeo;
