# Lenflix Performance Plan

## Budgets

Target a fast first meaningful render on mid-tier mobile, a responsive search interaction, and a movie page that does not wait on playback-provider calls. Establish measured budgets for HTML, critical CSS, JavaScript, image bytes, API latency, and search latency before launch.

## Rendering

Server-render public movie, collection, genre, and browse pages where crawlability and first paint benefit. Keep personalization and private account state client-enhanced. Avoid request waterfalls by loading canonical metadata and availability in one server boundary.

## Media and images

Store originals privately, generate responsive derivatives, use modern formats, lazy-load below-the-fold artwork, and preload only the hero asset. Video should flow from the CDN or managed provider rather than through the application server.

## Data and cache

Index catalogue queries, cache stable public responses at the edge, cache hot metadata in Redis, and invalidate by movie or collection version. Do not cache personalized responses across users. Search uses its own derived index and is reconciled through a background job.

## Measurement

Track Core Web Vitals, search latency, movie-page response time, playback startup, rebuffering, error rate, and provider latency by device class and region. Use synthetic checks and real-user measurements with privacy review.

## Audit remediation: measurable budgets

Initial release budgets are: p75 LCP under 2.5 seconds on mobile, p75 INP under 200 ms, p75 CLS under 0.1, public HTML under 100 KB compressed where practical, critical JavaScript under 180 KB compressed, search p95 under 300 ms for cached/common queries, and movie-page p95 under 800 ms excluding third-party playback startup. Budgets are measured in CI and real-user monitoring; exceptions require an owner and expiry date.

Artwork processing creates AVIF and WebP derivatives at named widths, preserves focal point metadata, strips unnecessary metadata, and records source rights. The UI uses `srcset`/`sizes`, explicit dimensions, alt text from verified title data, and a low-quality placeholder only when it is generated from the same approved asset. Hero art is preloaded only on the route where it is the LCP candidate.

Network-aware UX uses low-data artwork, poster-only rows, retry controls, and no autoplay by default. The player does not compete with page-critical resources. Caches use stale-while-revalidate for stable catalogue data and never share user-specific watch state.
