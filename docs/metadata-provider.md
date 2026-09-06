# Lenium metadata provider

## Primary provider

Lenium now uses a server-side **TMDB adapter** for movie metadata. The adapter is provider-neutral at the application boundary: the UI consumes normalized `MetadataMovie` records, while TMDB-specific IDs, URLs, and response fields remain inside `server/providers/tmdb.ts`.

The server exposes `catalog.status`, `catalog.popular`, `catalog.search`, and `catalog.movieById` through tRPC. Provider credentials never reach the browser. Search input is length-limited and the provider request is made only from the server.

## Required configuration

Set the server-only secret `TMDB_API_KEY`. Do not place it in `VITE_*` variables, client code, committed `.env` files, or browser requests. The current environment does not contain this secret, so the application honestly shows `Metadata provider not connected` instead of rendering fixture movies.

## Commercial and attribution requirements

TMDB’s official FAQ states that its free API access is for non-commercial use with attribution, while commercial projects must contact TMDB for a commercial license. Before enabling this provider for a public or revenue-generating Lenium deployment, obtain written commercial approval from TMDB and configure the approved attribution/branding. See [TMDB API FAQ](https://developer.themoviedb.org/docs/faq) and [TMDB API terms](https://www.themoviedb.org/api-terms-of-use).

TMDB metadata does not grant streaming rights. Rights grants, playback sources, captions, availability, and authorization remain separate Lenium capabilities and must not be inferred from a TMDB record. Images are returned through TMDB image URLs only after the appropriate license and usage review; production artwork handling should be finalized before broad launch.

## Fallback policy

There is no silent fixture fallback. If TMDB is unavailable or unconfigured, Lenium shows an explicit empty/provider state. A future fallback provider must implement the same normalized contract, preserve its own provider IDs and provenance, and be approved for the intended commercial use before activation.
