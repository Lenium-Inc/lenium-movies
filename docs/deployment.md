# Stream Vy Deployment

The previous version of this file described isolated dev/staging/prod
environments with separate databases, buckets, search indexes, and OAuth apps; an
SSR/API gateway; background workers; PostgreSQL, Redis, object storage, search,
CDN, and video infrastructure; CI gating every deploy; SLOs and on-call
ownership; RPO 15 minutes / RTO 1 hour; quarterly restore drills; and monthly
budget envelopes. **None of that infrastructure or process exists.** What follows
is what is actually deployed and what an operator has to configure.

## What is deployed

| Component           | Where              | Configuration                                      |
| ------------------- | ------------------ | -------------------------------------------------- |
| SPA                 | Cloudflare Workers | `wrangler.jsonc`: `vite build`, `dist/public` uploads as static assets, unmatched routes fall back to `index.html` |
| Account API         | Same Worker        | `cf/worker.ts` routes `/api/*`; `pg` is aliased to the Neon driver by `cf/pg-shim.ts` |
| Catalogue/playback API | Cloud Run (Render optional) | Root `Dockerfile` (Flask + Chromium), 2 vCPU / 2 GiB, `ALLOWED_ORIGINS`, `DATABASE_URL` |
| Postgres            | Neon               | `DATABASE_URL`                                     |
| Catalogue cache     | SQLite on the Flask service's disk | `movie-backend/data/`                    |
| Express wrapper     | Optional           | Local dev, or a single-process alternative to the Vercel+Render split |

There is one branch, one backend service, and no staging environment. Preview
deployments read preview-scoped env vars, so a preview build can point at a
different backend — and can also silently read production values if the scope is
misconfigured. `VITE_*` variables are inlined at **build** time, so a changed
value requires a redeploy.

## Start command

Gunicorn writes `Server: gunicorn/<version>` at the HTTP layer, *below* the WSGI
application, so the header scrubber in `movie-backend/app.py` cannot remove it.
Only a server option can. `app.py` imports `authdb` / `catalog_*` as top-level
modules, and the directory name is not a valid Python package (`movie-backend`
contains a hyphen), so gunicorn has to start from `movie-backend/`:

```
cd movie-backend && gunicorn -c ../gunicorn.conf.py -b 0.0.0.0:$PORT app:app
```

`gunicorn.conf.py` sets `no_server_header = True` and deliberately does not set
`workers`, so it will not fight the process count configured in the Render
dashboard.

## Cloud Run (catalogue API)

`Dockerfile` at the repo root builds the Flask app on `python:3.11-slim` and
installs Playwright's Chromium with its system libraries. Cloud Build runs it
remotely, so no local Docker is needed. `gunicorn.conf.py` still governs the
server, and the container starts from `movie-backend/` because `app.py` imports
`authdb` / `catalog_*` as top-level modules.

SQLite holds only caches, so the container points both files at `/tmp`
(`CATALOG_DB_PATH`, `SQLITE_PATH`). A cold start therefore rebuilds the catalogue
cache instead of serving stale state — a slow first request, not data loss.

```bash
gcloud auth login
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# One-time: store the runtime secrets (values come from .env, never committed).
set -a; . ./.env; set +a
for name in DATABASE_URL TMDB_API_KEY; do
  printf '%s' "$(printenv "$name")" |
    gcloud secrets create "$name" --data-file=- --replication-policy=automatic
done
# Optional ones (OMDB_API_KEY, TRAKT_CLIENT_ID, ADMIN_EMAILS) follow the same
# shape; attach with `gcloud run services update --update-secrets`. To rotate:
# gcloud secrets versions add NAME --data-file=-

gcloud run deploy streamvy-api \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 2Gi --cpu 2 \
  --concurrency 16 --timeout 3600 --min-instances 0 --max-instances 4 \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,TMDB_API_KEY=TMDB_API_KEY:latest \
  --set-env-vars ALLOWED_ORIGINS=https://www.streamvy.me,https://streamvy.me,https://streamvy.samuelnganga7933.workers.dev,https://localhost,capacitor://localhost
```

`0` minimum instances keeps the bill at zero when idle, at the cost of a few
seconds of cold start; Chromium is what needs the 2 GiB. Cloud Run's maximum
request duration is 60 minutes, so a single `/api/v1/playback/media` relay of a
feature-length stream is the one request shape to watch.

To keep the existing origin, map the domain and point DNS at it (proxy disabled
so Cloudflare does not terminate the hostname before Cloud Run's mapping does):

```bash
gcloud run domain-mappings create --service streamvy-api \
  --domain movie-api.streamvy.me --region europe-west1
# then, in Cloudflare DNS: CNAME movie-api -> ghs.googlehosted.com, DNS only
```

Verify with `curl https://movie-api.streamvy.me/` → `{"status": "online"}`. The
SPA build already targets that origin, so no Worker redeploy is involved.

## Returning the Render service to service

`https://movie-api.streamvy.me` is the catalogue origin baked into the SPA build.
When it answers `402 Payment required` with `DEPLOYMENT_DISABLED`, Render has
suspended the service for billing, not because the code broke — the Cloudflare
Worker cannot replace it, because Flask, Chromium and the on-disk SQLite cache
have no equivalent there.

1. Resume the existing service in the Render dashboard. That keeps the custom
   domain, the disk, and the environment, so nothing else changes.
2. If the service no longer exists, create it from `render.yaml` (Blueprint), set
   the `sync: false` secrets, and re-add the custom domain
   `movie-api.streamvy.me` (CNAME to the Render hostname).
3. Check `ALLOWED_ORIGINS` lists the Worker's origin. The SPA runs on
   `https://streamvy.<account>.workers.dev`, and a missing entry there blocks the
   catalogue at the browser, not at the server.
4. `/` is the health check: `{"status": "online"}` means the app booted.
   Playback needs Chromium; if streams resolve to nothing, confirm the build log
   shows the `playwright install` step.

## `ALLOWED_ORIGINS`

CORS is exact-match, never a wildcard. `*.vercel.app` is not a safe shorthand:
every unrelated Vercel project owns a hostname on that domain, so a wildcard
there would let any of them act as a signed-in user. List origins explicitly:

```
ALLOWED_ORIGINS=https://your-app.vercel.app,https://your-staging-domain.example
```

Unlisted origins receive no `Access-Control-Allow-Origin` and are blocked by the
browser. Requests with no `Origin` header — including the Express wrapper's
server-to-server call into Flask — are unaffected.

## Account API origin

The account API (`/api/auth/*`) is served by this deployment, **not** by the
MovieBox catalogue API. The SPA resolves it separately:

| Build            | Value when `VITE_AUTH_API_BASE_URL` is unset |
| ---------------- | -------------------------------------------- |
| Production       | same origin (`/api/auth/*` on the Worker)     |
| Local development| `VITE_API_BASE_URL`, when it names a local account backend |

Set `VITE_AUTH_API_BASE_URL` to move the API to another origin. It is inlined at
build time, so changing it needs a redeploy. The retired Flask/Render service is
not a fallback.

The Capacitor APK loads the bundled SPA from `https://localhost`, so whatever
serves `/api/auth/*` must allow that origin (and `capacitor://localhost`).
Same-origin on the website does not carry over to the app.

The title page's trailer lookup (`/api/trailer`) needs `TMDB_API_KEY` on the
Worker. It answers `{ "trailer": null }` when no playable YouTube trailer
exists, so the page falls back to artwork.

## Cloudflare Workers

The site is one Worker: `cf/worker.ts` serves the APIs and delegates everything
else to the `ASSETS` binding, which holds the output of `vite build`. The route
table mirrors the files that used to sit under `api/`, most-specific first:

| Path                    | Handler                                   |
| ----------------------- | ----------------------------------------- |
| `/api/image`            | `cf/image.ts` (Workers-native, no `sharp`) |
| `/api/trailer`          | `api/trailer.ts` (unchanged Edge handler)  |
| `/api/android-version`  | `api/android-version.ts`                   |
| `/api/proxy/stream`     | `api/proxy/stream.ts`                      |
| `/api/proxy/download`   | `api/proxy/download.ts`                    |
| `/api`, `/api/*`        | `api/[...path].ts` through `cf/adapter.ts` |

`api/[...path].ts` is still written for a Node `(req, res)` pair, so
`cf/adapter.ts` builds that pair from a web `Request`, hands the body over as raw
text (the handler's `bodyOf` accepts strings), and turns `res.status/json/send`
back into a `Response`. The handler source is byte-identical on Vercel/Render.

The account API talks to Postgres through `pg.Pool`, including real
transactions. Workers cannot load the native driver, so `wrangler.jsonc` aliases
`pg` to `cf/pg-shim.ts`, which subclasses Neon's serverless `Pool` over
WebSockets. **This requires a Neon database** — the driver's WebSocket transport
is pointed at the Neon host in `DATABASE_URL`, not a generic Postgres proxy.

### Configuration

Runtime values are secrets, set once per environment and available to the
handlers as `process.env` via the `nodejs_compat` flag:

```
npx wrangler secret put DATABASE_URL      # Neon connection string
npx wrangler secret put TMDB_API_KEY
npx wrangler secret put ALLOWED_ORIGINS   # optional, comma-separated extra origins
```

`ALLOWED_ORIGINS` only needs the extra origins. The handler already allows
`https://localhost` and `capacitor://localhost` (the Capacitor WebView), and
same-origin requests need no entry.

Build-time values are inlined into `dist/public` by `vite build`:

| Variable                        | Production value                    |
| ------------------------------- | ----------------------------------- |
| `VITE_SITE_URL`                 | canonical origin, e.g. `https://streamvy.me` |
| `VITE_STREAMVY_PROXY_BASE_URL`  | `/api` (same-origin relays)         |
| `VITE_AUTH_API_BASE_URL`        | unset — same origin is correct      |
| `VITE_MOVIEBOX_DIRECT_BFF`      | on in production builds             |
| `VITE_MOVIEBOX_BFF_URL`         | unset — upstream default            |

The browser loads `/home`, `/search`, `/detail` and the catalog routes directly
from the MovieBox BFF in production. The BFF reflects the site origin through
CORS, so catalogue traffic uses the viewer's IP instead of the Worker's
rate-limited egress. Set `VITE_MOVIEBOX_DIRECT_BFF=false` to force those calls
back through `VITE_STREAMVY_API_BASE_URL`. Playback still uses the media relay
because the CDN requires a MovieBox `Referer` that a web page cannot set.

A custom domain is expected: the Android shell and `client/src/services/streamvy.ts`
default to `https://www.streamvy.me/api`, and that origin only works if the domain
points at the Worker.

### Local preview

```
cp .dev.vars.example .dev.vars   # fill in DATABASE_URL / TMDB_API_KEY
npm run preview:cf               # vite build && wrangler dev
```

`wrangler dev` runs on the local `workerd` runtime, which needs macOS 13.5+ (or
Linux with glibc 2.35+); `vite build` itself needs Node 20.19+ or 22.12+ for Vite
7. Without either, the offline check is `npm run check:cf`, which builds and
bundles the Worker with `wrangler deploy --dry-run` but does not execute it.

### Deploying

```
npx wrangler login           # or export CLOUDFLARE_API_TOKEN
npm run deploy:cf            # vite build && wrangler deploy
```

### Workers Builds (Git integration)

If the repo is connected in the Cloudflare dashboard instead of deployed from a
laptop, the project settings are:

| Setting        | Value                                       |
| -------------- | ------------------------------------------- |
| Root directory | repository root                             |
| Build command  | `npm run build:cf`                          |
| Deploy command | `npx wrangler deploy`                       |

Do not use the Python backend's `pip install -r requirements.txt certifi gunicorn`
command here. The Worker build only runs `vite build`; the Flask/Chromium
resolver is a separate service on Cloud Run/Render. The build environment must
also define the `VITE_*` values from the table above, because Vite inlines them
at build time — setting them only as Worker runtime secrets is too late.

The dry run is worth running first: it reports the bundle size (the free plan
allows 3 MB compressed, 10 MB paid) and surfaces anything that failed to bundle.

### Image route differences

`cf/image.ts` keeps the same host allowlist, query shape and cache headers as the
Node route, but cannot resize. TMDB artwork takes the same 307 redirect to the
matching `image.tmdb.org` rendition; other allowlisted hosts are streamed through
uncropped and immutable. If downscaling matters on Cloudflare, enable Image
Resizing on the zone, which is a paid feature.

## Headers Render injects after the app

`X-Render-Origin-Server` and `rndr-id` are added by Render's edge *after* this
process writes its response. No Flask or WSGI change can remove them, because the
application never sees them. They are listed in the scrubber defensively in case
a future proxy forwards them, but actually dropping them needs a hop in front of
Render that can rewrite response headers — a Cloudflare Worker, or routing
through the Vercel deployment.

Do not strip `rndr-id` blindly. Render uses it to route requests to the right
service; removing it can break routing rather than just hide a header. Verify on
a preview deployment first.

## `forwarded_allow_ips`

`gunicorn.conf.py` sets `forwarded_allow_ips = "*"`, which is what makes client
IPs correct behind Render's proxy and therefore what the wrapper's rate limiter
reads. It also means a caller reaching Gunicorn directly can spoof
`X-Forwarded-For`. This matters while rate limiting lives in the wrapper instead
of the app: see [security](security.md).

## No operational safety net

- **No CI.** Tests, type checking, the secret scan, and the build are manual.
- **No monitoring.** No error tracking, no uptime check, no alerting. An outage is
  discovered by users.
- **No backup verification.** Neon backups are provider defaults. Nobody has run a
  restore.
- **No rollback procedure beyond "redeploy the previous commit."** There is no
  migration to reverse, because there is no migration system.
- **No cost tracking.** Postgres, Cloudflare requests/bandwidth, and — significantly — video
  egress through the relay are the main variable costs, and the relay is
  unmetered by anything but the hosting bill.
- **The SQLite catalogue cache is on ephemeral service disk.** It is a cache and
  an outage fallback, so losing it costs a slow first request, not data.

## Before a public launch

1. Set `ALLOWED_ORIGINS` to the real origins. A wildcard is not acceptable.
2. Set `VITE_MOVIE_API_BASE_URL` to a domain you control, and confirm the
   deployment is redeployed afterward. See [environment](environment.md).
3. Set `TMDB_API_KEY` and confirm the commercial terms question is answered.
4. Configure the start command and verify `Server` is absent.
5. Run the four verification commands from [testing](testing.md) against the
   deployed build, not just locally.
6. Decide whether rate limiting at the app layer is acceptable to defer. It is the
   one gap here that a hostile caller can exploit directly.

## Artwork downscaling (`/api/image`)

The catalogue CDN (`pbcdn*.aoneroom.com`) serves one rendition per asset --
usually 3840px and several megabytes -- even for a poster painted into a 200px
card. `api/image.ts` is a Node-runtime function that fetches the source,
downscales it with `sharp` to the requested width, and returns WebP. Responses
are `immutable` and cached at the edge by URL + width, so the encode cost is
paid once per variant.

- `sharp` is a normal dependency, not a dev dependency; Vercel traces the
  Linux binary during the build. On the Cloudflare Worker the route is
  `cf/image.ts`, which redirects TMDB artwork and streams other allowlisted
  hosts without resizing — see the Cloudflare section above.
- Only `*.aoneroom.com` hosts are fetched server-side. TMDB URLs take a 307
  redirect to the matching `image.tmdb.org` rendition instead. Do not widen the
  allowlist -- the URL is caller-supplied, so the allowlist is the SSRF
  boundary.
- `VITE_IMAGE_PROXY_BASE_URL` overrides the proxy origin; on the web build the
  default is same-origin `/api`, and in the Capacitor shell it is the media
  relay origin.

## Android updates (sideloaded APK)

The APK is published to the rolling `android-latest` GitHub release by
`.github/workflows/android-apk.yml`. Android cannot update a sideloaded app by
itself, so the app compares its own `versionCode` with
`android-version.json` (published beside the APK) through
`/api/android-version` and offers the download when a newer build exists.

Two repository settings make install-over-the-top work:

1. **A stable signing key.** Without one, every CI runner generates a fresh
   debug keystore, Android rejects the update because the signature changed, and
   the only way forward is to uninstall — the exact problem this fixes. Add
   these Actions secrets:
   - `ANDROID_KEYSTORE_BASE64` — `base64 -i streamvy-release.keystore`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`

   The workflow decodes the keystore and signs the debug APK with it. Existing
   installs signed with the old ephemeral key need one final uninstall; every
   update after that installs over the previous build and keeps app data.

2. **A monotonic `versionCode`.** The workflow sets `CAP_VERSION_CODE` to the
   GitHub run number and `CAP_VERSION_NAME` to `1.<run>`, and `build.gradle`
   reads both. Every build therefore supersedes the last.

Do not reuse a versionCode. Android will treat a same-or-newer installed build
as "not an update" and the prompt will stay silent.
