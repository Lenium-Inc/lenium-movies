# Stream Vy Metadata Provider

## What is actually wired

TMDB, called **from the Python backend only**: `movie-backend/tmdb_service.py`
for TMDB's API and `movie-backend/catalog_service.py` for aggregation across TMDB,
an optional Trakt breadth list, and optional OMDb enrichment and fallback. The
browser never calls TMDB, and `TMDB_API_KEY` never reaches a `VITE_*` variable.

An earlier version of this document said the adapter lives in
`server/providers/tmdb.ts` and is exposed through tRPC procedures
`catalog.status`, `catalog.popular`, `catalog.search`, and `catalog.movieById`.
Those procedures do exist in `server/routers.ts`, but **nothing calls them** — the
client has no tRPC client, and the `/api` proxy points at Flask, which serves no
`/api/trpc` route. The file remains as dead template framework code.

## Configuration

`TMDB_API_KEY` in the environment or `movie-backend/.env`. Unset is not fatal:
auth and the local catalog keep working, live lookups are skipped, and a warning
prints once. The previous version of this file claimed the environment contained
no secret and the UI showed `Metadata provider not connected`; the key is now
read from the environment, and the fallback is a warning plus the cached catalog,
not a fixture list.

## Normalization

Every upstream response is normalized into one `MediaItem` shape before it leaves
the backend, so the client never parses a provider payload. `movie-backend/
movies.json` supplies the direct-playback catalog. `media_items` stores the result
write-through and is the outage fallback.

TLS is always verifying: `runtime_config.ssl_context()` prefers certifi's CA
bundle, falls back to the system trust store, and never falls back to
`_create_unverified_context()`. That last one matters — the old code fell back to
accept-any-certificate, which would have exposed the API key in transit.

## Licensing and attribution

TMDB's own terms state that free API access is for non-commercial use with
attribution, and that commercial use requires contacting them. Before a
revenue-generating deployment, obtain written commercial approval and configure
the approved attribution. `client/src/pages/Home.tsx` carries the TMDB
attribution now, alongside the disclosure that the app does not host media.

- [TMDB API FAQ](https://developer.themoviedb.org/docs/faq)
- [TMDB API terms](https://www.themoviedb.org/api-terms-of-use)

TMDB metadata does not grant streaming rights. It is not a rights record and
nothing in the code treats it as one.

## Fallback policy

There is no silent fixture fallback. When TMDB is unreachable, the endpoint
serves the persisted `media_items` cache and the UI shows the cached state. A
future second metadata provider must implement the same normalized contract,
preserve its own external IDs, and be approved for the intended use first.
