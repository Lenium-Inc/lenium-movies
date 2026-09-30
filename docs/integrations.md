# Stream Vy Integrations

Every external dependency the code actually has. The previous version of this
file listed a search engine, object storage, a CDN, a video provider, an email
provider, error tracking, analytics, and a malware scanner. **None of those
integrations exist in this codebase.**

| Integration          | Used by                          | Configuration            | Behavior when unconfigured                            |
| -------------------- | -------------------------------- | ------------------------ | ----------------------------------------------------- |
| TMDB                 | `tmdb_service.py`, `catalog_service.py` | `TMDB_API_KEY`   | Lookups skipped, warning printed, cached catalog served |
| Archive.org          | `stream_providers.py`, relay routes | none                | Direct tier unavailable; embeds carry the title       |
| TMDB curated collections | `/api/catalog/discover`    | none                    | Shelf omitted                                          |
| Trakt (optional)     | `catalog_service.py`             | `TRAKT_CLIENT_ID`       | Skipped                                                |
| OMDb (optional)      | `catalog_service.py`             | `OMDB_API_KEY`          | Skipped; not a fallback for OMDb-only results         |
| Postgres (optional)  | `authdb.Store`                   | `DATABASE_URL`          | Falls back to SQLite                                   |
| YouTube (via TMDB)   | Trailer routes                   | none                    | No-trailer state                                       |

## Rules this codebase follows

- A missing provider produces an **honest unavailable state** and an
  operator-facing warning, never a fabricated success.
- No secret is inlined into a `VITE_*` variable, and no provider is called
  directly from the browser.
- Outbound TLS is always verifying; see [environment](environment.md).

## Framework plumbing that is not an integration

`server/_core/oauth.ts`, `storageProxy.ts`, `imageGeneration.ts`, `llm.ts`,
`voiceTranscription.ts`, `map.ts`, and `dataApi.ts` are template framework
modules. The product has no OAuth login, no object storage, no image generation,
no LLM feature, and no maps. They are reachable only through `/api/trpc`, which
the client does not call.
