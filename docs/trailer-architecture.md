# Trailer and video architecture

Lenium does not host a separate trailer-video system. Trailers are represented as provider-neutral `VideoAsset` records and embedded through the provider’s supported player.

## Lifecycle

`TMDB movie metadata → TMDB movie videos endpoint → normalize YouTube videos → select verified official asset → persist VideoAsset → movie details modal`

The `videoAssets` table preserves the movie provider ID, video provider, provider video ID, type, title, official flag, language, country, thumbnail, publication time, optional duration, embed URL, source URL, and timestamps. A unique key on `(movieId, provider, providerVideoId)` makes ingestion idempotent.

## Provider rules

YouTube is the first supported video provider. The server fetches TMDB’s `/movie/{id}/videos` endpoint only when a requested movie has no cached eligible asset. It never searches YouTube on every page request, downloads or re-hosts third-party videos, or exposes API credentials. The UI embeds `youtube-nocookie.com` and links to the source video.

Only official YouTube videos are eligible in the initial implementation. Selection priority is **Trailer**, then **Teaser**, then **Featurette**, then **Clip**. Fan trailers, reactions, reviews, recaps, unofficial edits, and other non-official content are excluded. If no eligible video exists, the movie page shows no trailer state rather than inventing one.

## Capability independence

Metadata, trailers, and streams are independent capabilities. A TMDB record can exist without a trailer; a trailer can exist while streaming rights and playback remain unavailable; and a licensed stream can exist without a trailer. The trailer endpoint never authorizes playback and the playback-unavailable state remains explicit.

## Verification

Tests cover official-video priority and unofficial-video exclusion. Live verification confirms TMDB video ingestion for Inception, YouTube embed and source URLs, and a second request returning the persisted asset from cache.
