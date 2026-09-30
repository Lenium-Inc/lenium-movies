# Stream Vy Trailers

An earlier version of this document described a `videoAssets` table with a unique
key on `(movieId, provider, providerVideoId)`, idempotent ingestion, a
`TMDB → videos → normalize → persist → modal` lifecycle, and tests covering
official-video priority and unofficial-video exclusion. **There is no
`videoAssets` table and no such test.** Trailers are resolved per request.

## What happens

```text
GET /api/movies/trailer         (title or tmdb id)
GET /api/catalog/movieTrailer   (tmdb id)
  -> TMDB /movie/{id}/videos
  -> select an official YouTube video: Trailer > Teaser > Featurette > Clip
  -> return an embed URL and a source link
```

The client embeds `youtube-nocookie.com` and links to the source video. If no
eligible video exists, the page shows a no-trailer state rather than inventing
one.

## Provider rules

Only official YouTube videos are eligible. Fan trailers, reactions, reviews,
recaps, and unofficial edits are excluded. TMDB is queried on request rather than
from a cache, so a movie page makes an upstream call it previously would not have
— a real cost that a persisted `videoAssets` table would remove.

## Capability independence

Metadata, trailers, and streams are independent. A TMDB record can exist without
a trailer; a trailer can exist while playback is unavailable; a direct stream can
exist without a trailer. The trailer endpoint never authorizes playback.

## Gaps

- No persistence, so no idempotent ingestion and no cache hit rate.
- No duration, language, or caption metadata stored.
- No test coverage for official-video selection, because there is no selection
  module — the filtering is inline in `app.py`.
