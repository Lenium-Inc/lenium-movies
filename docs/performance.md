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
