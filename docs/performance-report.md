# FreeStream Performance Audit Report

## Scope and conclusion

This audit evaluated the current FreeStream WebDev prototype, not a production streaming system. The homepage was measurable. Search, browse, movie detail, watchlist, player, database queries, search service latency, and cache-hit rate are not implemented in the current checkpoint, so those surfaces are reported as **not available**, not estimated. No feature work was added.

The highest-impact measured issue was image payload. The second was unnecessary client/runtime weight from an unused global tooltip provider. Both were addressed without adding arbitrary caching or changing product behavior.

## Before and after measurements

Measurements were collected from the live preview in a Chromium browser. Before values were captured on the same homepage before the performance changes; after values were captured after the changes and a fresh preview navigation.

| Metric                             |        Before |         After | Result                                                      |
| ---------------------------------- | ------------: | ------------: | ----------------------------------------------------------- |
| TTFB                               |         31 ms |         20 ms | 35% lower; preview variance, not attributed to code         |
| First Paint                        |        388 ms |        276 ms | 29% lower                                                   |
| First Contentful Paint             |        584 ms |        276 ms | 53% lower in this run; validate with repeated field samples |
| DOMContentLoaded                   |        579 ms |        184 ms | 68% lower in this run                                       |
| Load event                         |        880 ms |        195 ms | 78% lower in this run                                       |
| Browser resource count             |            62 |            62 | unchanged                                                   |
| Fresh first-viewport image payload | 761,691 bytes | 628,371 bytes | 17% lower                                                   |
| Production JS bundle               | 678,329 bytes | 637,196 bytes | 6% lower minified; 182.30 KB gzip                           |
| Production CSS bundle              | 118,753 bytes | 118,753 bytes | unchanged; 19.41 KB gzip                                    |
| API requests                       |             0 |             0 | no production catalogue API exists yet                      |
| Database query latency             |           N/A |           N/A | no catalogue queries exist yet                              |
| Search latency                     |           N/A |           N/A | search service does not exist yet                           |
| Cache hit rate                     |           N/A |           N/A | no application cache exists yet                             |

The aggregate image payload was measured with uncached browser `fetch` requests against the exact rendered image URLs. The browser resource timing API reported zero transfer bytes on the second navigation because those images were already cached; therefore the uncached fetch measurement is the authoritative after value.

## Implemented fixes

### Image delivery

The shared image helper now requests 1,280-pixel backdrops at quality 78 and 420-pixel posters at quality 68 instead of 1,600/620-pixel assets at quality 85. Non-hero images use `loading="lazy"` and `decoding="async"`. The hero image is marked eager with high fetch priority so the LCP candidate is not delayed by lazy loading.

### Client bundle

The unused global `TooltipProvider` was removed from the application shell. This reduced the production JavaScript asset from 678,329 to 637,196 bytes in the measured build. The production build still emits a warning for a JavaScript chunk over 500 KB; route-level code splitting and icon/component import review should be the next optimization once real routes exist.

### Deliberately not changed

No blanket caching was added. No database or search optimization was fabricated because the current prototype does not execute catalogue queries. No player optimization was claimed because there is no real player or video provider configured. No fake watch flow was introduced.

## Surface audit

| Surface         | Current state                                             | Audit result                                                                |
| --------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Homepage        | Implemented client-rendered fixture experience            | Measured and optimized                                                      |
| Search          | Input exists, local fixture filtering only                | No API/search latency to measure; not production-ready                      |
| Movie page      | Modal detail view only                                    | No crawlable route or server-rendered page                                  |
| Browse          | Category chips filter local data                          | No paginated browse API or database query                                   |
| Watchlist       | Local client state                                        | No persistence, request, or DB latency                                      |
| Player          | No real player; interaction is a prototype toast          | No playback startup, rebuffering, or telemetry metrics                      |
| Mobile          | Responsive homepage                                       | Screenshot verified at 375×812; horizontal genre rail intentionally scrolls |
| Slow network    | No browser throttling available in this audit environment | Not measured; must be run in CI/device lab before launch                    |
| Empty catalogue | Not represented by current fixture UI                     | Requires a production empty-state test                                      |
| Large catalogue | Not represented; six fixture movies                       | Requires load testing against real query/index plans                        |

## Findings that remain

The homepage is still a client-heavy prototype and returns fixture content. The production build has a large JavaScript chunk and does not yet provide route-level splitting. Images are external Unsplash URLs rather than first-party optimized assets. The HTML is not server-rendered from real movie records. These are architectural/product gaps, not safe performance claims to hide.

Before production, measure p75/p95 LCP, CLS, and INP with repeated mobile field samples; run throttled 4G and offline tests; add real catalogue queries with `EXPLAIN ANALYZE`; measure search and API p95; and load-test large catalogues and player session creation. Add performance budgets to CI after those real routes exist.

## Verification

`pnpm test` passed with 3 tests across 2 files. `pnpm check` passed. `pnpm build` passed. The preview remained running and desktop/mobile screenshots were captured after the fixes.
