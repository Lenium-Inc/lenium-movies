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
| SPA                 | Vercel             | `vercel.json`: `vite build`, output `dist/public`, every route rewritten to `index.html` |
| Flask API           | Render (Gunicorn)  | Start command below; `ALLOWED_ORIGINS`; `DATABASE_URL` |
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
Only a server option can:

```
gunicorn -c gunicorn.conf.py movie-backend.app:app
```

`gunicorn.conf.py` sets `no_server_header = True` and deliberately does not set
`workers`, so it will not fight the process count configured in the Render
dashboard.

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
| Production       | same origin (`/api/auth/*` on Vercel)        |
| Local development| `VITE_API_BASE_URL`, when it names a local account backend |

Set `VITE_AUTH_API_BASE_URL` to move the API to another origin. It is inlined at
build time, so changing it needs a redeploy. The retired Flask/Render service is
not a fallback.

The Capacitor APK loads the bundled SPA from `https://localhost`, so whatever
serves `/api/auth/*` must allow that origin (and `capacitor://localhost`).
Same-origin on the website does not carry over to the app.

The title page's trailer lookup (`/api/trailer`) needs `TMDB_API_KEY` on the
Vercel project. It is an Edge function and answers `{ "trailer": null }`
when no playable YouTube trailer exists, so the page falls back to artwork.

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
- **No cost tracking.** Postgres, Vercel bandwidth, and — significantly — video
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
card. `api/image.ts` is a Node-runtime Vercel function that fetches the source,
downscales it with `sharp` to the requested width, and returns WebP. Responses
are `immutable` and cached at the edge by URL + width, so the encode cost is
paid once per variant.

- `sharp` is a normal dependency, not a dev dependency; Vercel traces the
  Linux binary during the build. The function is configured in `vercel.json`
  with 1 GB of memory and a 30 s ceiling.
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
