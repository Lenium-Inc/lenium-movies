# Stream Vy Performance

The previous version of this file specified p75 LCP/INP/CLS budgets, AVIF and
WebP derivative pipelines with focal-point metadata, Redis caching, CDN edge
caching, AVIF placeholders, and Core Web Vitals tracking. There is no image
processing pipeline, no Redis, no CDN, and no real-user monitoring in this
codebase. Those budgets are aspirations; this document records what is measured.

## What was measured

The last measurement was taken against an earlier fixture-driven prototype and is
preserved in [performance-report.md](performance-report.md) as a historical
record. **It is no longer a description of this application**: it reports six
fixture movies, no catalogue API, no player, and a 3-test suite, and it measures
a home page that no longer exists in that form.

It is not the place to claim a current number. There is no performance
instrumentation, no budget enforcement, and no baseline for the real catalogue,
the relay, or the player.

## What is known about the real request path

- Every catalogue request re-fetches from TMDB, normalizes, and writes through to
  `media_items`. This is a deliberate freshness choice: the catalogue is always
  current, driven by real traffic, with no nightly seeder. It also means catalogue
  latency is upstream latency, plus a write.
- Search and catalog queries run against SQLite with indexes on
  `(media_type, year DESC)`, `(popularity DESC)`, and `genres_key`. Adequate at
  this catalogue size; a search engine is not needed and adding one would be
  premature.
- The direct playback path proxies bytes through Flask. That is a deliberate
  trade: it is what makes seeking, range requests, and downloads work. It also
  means video egress is our server's, not a CDN's.
- The build emits a chunk over 500 KB and Vite warns about it. Route-level code
  splitting is the obvious next step and has not been done.

## Known costs, in priority order

1. Video egress through the relay rather than a CDN.
2. No route-level code splitting in the client bundle.
3. A TMDB call on every catalogue request, by design.
4. A TMDB call per trailer request, which a `videoAssets` table would remove.
5. Images requested from TMDB's CDN at 1,280px backdrops / 420px posters, with
   non-hero images lazy-loaded. There is no first-party derivative generation.

## Before any performance claim is made

Measure p75 LCP, INP, and CLS with repeated mobile field samples. Throttle 4G.
Add catalogue queries with `EXPLAIN ANALYZE`. Measure relay throughput and range
latency against real Archive.org responses. Load-test a large catalogue. Until
then, a number in this document would be a guess.
