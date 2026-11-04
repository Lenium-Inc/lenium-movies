# Stream Vy Environment

The authoritative list is what the code reads. The previous version of this file
invented `SESSION_SECRET`, `REDIS_URL`, `SEARCH_URL`, `OBJECT_STORAGE_BUCKET`,
`VIDEO_PROVIDER_SIGNING_SECRET`, `ANALYTICS_SITE_ID`, and eleven more. **None of
those exist in this codebase** — there is no Redis, no search service, no object
storage, no email provider, no error tracking, and no analytics.

## Precedence

`runtime_config.load_env_file()` reads `movie-backend/.env` then `./.env`, and
**only fills keys not already in the environment**, so injected production values
always win. Double quotes are stripped because `neon link` writes them. Set
`LENIUM_SKIP_ENV_FILE=1` to ignore both files entirely.

## Backend (`movie-backend/*.py`)

| Variable                  | Required | Effect when unset                                                        |
| ------------------------- | -------- | ------------------------------------------------------------------------ |
| `TMDB_API_KEY`            | no       | Live TMDB lookups skipped; auth and the local catalog keep working. Warns once at startup. |
| `DATABASE_URL`            | no       | Falls back to SQLite at `movie-backend/data/`.                           |
| `SQLITE_PATH`             | no       | Overrides the SQLite file path.                                          |
| `ALLOWED_ORIGINS`         | no       | CORS allow-list. Unset means no cross-origin browser requests succeed.   |
| `PORT`                    | no       | Listen port; defaults to 5000.                                           |
| `FLASK_DEBUG`             | no       | `1` enables the debugger and binds to `127.0.0.1` only.                 |
| `STREAM_PROVIDER_ORDER`   | no       | Comma-separated provider ids defining playback priority.                |
| `STREAM_PROVIDER_DISABLED`| no       | Comma-separated provider ids to remove entirely.                         |
| `OMDB_API_KEY`            | no       | Skips OMDb enrichment.                                                   |
| `TRAKT_CLIENT_ID`         | no       | Skips the optional Trakt breadth list.                                   |
| `LENIUM_SKIP_ENV_FILE`    | no       | `1` disables dotenv loading.                                             |

`STREAM_PROVIDER_ORDER` naming a provider absent from the built-in manifest is
ignored; manifest providers left unnamed keep their default relative order.

## Frontend (build time)

| Variable                  | Effect                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | Absolute origin of the deployed Flask backend. Legacy aliases `VITE_MOVIE_API_BASE_URL` and `VITE_API_URL` are also read. Inlined by Vite at **build** time, so changing it requires a redeploy, scoped per environment. |

Set this to the absolute HTTPS origin of a backend you control, and include the
frontend's exact origin in the backend `ALLOWED_ORIGINS` list. The API base is
publicly visible in the JavaScript bundle and requests can carry bearer tokens, so
never point it at a third-party host. If the variable is missing or blank, the
client falls back to `http://127.0.0.1:8001`; that is suitable only when the
backend is actually running on the same machine as the browser (normally local
development), not for a deployed site. The documented Vercel deployment rewrites
unknown paths to `index.html`; setting the API base to `/` therefore returns the
SPA shell for `/api/*`, not backend JSON. Vite variables are build-time values, so
fixing a Production or Preview setting requires rebuilding/redeploying that
environment.

Vercel builds now fail fast if none of the supported API-origin variables is set,
or if the value is a relative path such as `/`. This prevents deploying a frontend
that appears healthy behind an SPA fallback but cannot reach the movie API.

## Express wrapper (`server/_core/index.ts`)

| Variable           | Default                 | Effect                          |
| ------------------ | ----------------------- | ------------------------------- |
| `FLASK_URL`        | `http://127.0.0.1:5000` | Flask upstream for the `/api` proxy |
| `PORT`             | `3000`                  | Wrapper listen port; scans up to 20 ports for a free one |
| `NODE_ENV`         | —                       | `development` attaches Vite middleware |
| `TRUST_PROXY_HOPS` | `1`                     | Proxy hops to trust for client IPs in rate limiting |

`server/_core/context.ts` and related framework files also read
`DATABASE_URL`, `OAUTH_SERVER_URL`, `JWT_SECRET`, `OMDB_API_KEY`, `TMDB_API_KEY`,
`VITE_APP_ID`, `OWNER_OPEN_ID`, `BUILT_IN_FORGE_API_*`, and
`MOVIE_BACKEND_URL`. The OAuth and storage-proxy paths are template framework
plumbing, not product features: the product has no Manus OAuth and no file
storage, and the client never calls `/api/trpc`.

## Not used

`IMDB_API_KEY`, `VITE_ANALYTICS_ENDPOINT`, and `VITE_ANALYTICS_WEBSITE_ID` are
still listed in `.env.example` but nothing reads them — analytics were removed
deliberately. They can be dropped from the example file.

## Rules

- Never commit `.env`. It is gitignored; `.env.example` is sanitized.
- `npm run check` runs `scripts/check_secrets.py`, which blocks vendor-prefixed
  credentials, PEM private-key blocks, and env-style credential identifiers
  assigned digit-bearing literals. The digit requirement is what separates a real
  key from a `localStorage` key *name*.
- A `VITE_*` variable is public. It is inlined into the bundle; a secret put in
  one is a disclosed secret.
