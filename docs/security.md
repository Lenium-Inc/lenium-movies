# Stream Vy Security

This document is split into **what is actually enforced** and **what is not**.
The previous version of this file described RBAC, deny-by-default permissions, an
upload quarantine state machine, MFA for administrators, signed short-lived
playback sessions, and a fail-closed rights policy. None of those exist. This one
does not claim them.

## Enforced today

**Passwords.** PBKDF2-HMAC-SHA256, 210,000 iterations, per-user random salt from
`secrets.token_urlsafe`, stored self-contained as `pbkdf2_sha256$salt$hex`.
Profile PINs use the same primitive via `hash_secret`. A PIN is set or replaced,
never read back: sending an empty PIN clears the lock.

**Sessions.** Opaque 32-byte URL-safe tokens backed by a `sessions` row with a
30-day expiry, checked server-side on every authenticated request. Logout and
account deletion revoke the row, not just the client copy. The client treats a
token that fails `/api/auth/me` as expired and clears it, so a server-revoked
token does not linger in storage forever.

**Authorization.** Every account-scoped route resolves the bearer token first and
returns 401 otherwise. Share member removal and revoke compare the caller's id
against the invite owner and return 403 on mismatch. Profile unlock verifies the
profile's own PIN; the account password is not accepted there. Account deletion
requires **both** email and password and deletes explicitly rather than relying
on cascades.

**Referral integrity.** `UNIQUE (code_id)` and `UNIQUE (referred_id)` on
`referral_uses` make self-referral and double-claiming impossible at the database
level.

**Allowance.** The cap is a database read of `daily_plays` keyed
`(profile_id, day, movie_key)` plus the account total, enforced in the claim
route. The client can display the remainder; it cannot grant one.

**Input validation.** History payloads are coerced defensively: strings capped
(`title` 300, `poster`/`backdrop` 2048), seconds clamped to 12 hours, a missing
title replaced with a placeholder rather than letting the NOT NULL constraint turn
a bad request into a 500. A JSON body that parses to a non-object (a string, an
array, a number) is rejected as 400 rather than raising on `.get()`.

**TLS and secrets.** `runtime_config.ssl_context()` always returns a *verifying*
context, preferring certifi's CA bundle and falling back to the system trust
store. It never falls back to `_create_unverified_context()`. `TMDB_API_KEY` is
read from the environment only, and a previous committed key literal was removed.
`scripts/check_secrets.py` blocks vendor-prefixed credentials, PEM blocks, and
env-style credential identifiers assigned digit-bearing literals; it is wired
into `npm run check`.

**Header scrubbing.** A WSGI middleware strips `Server`, `X-Powered-By`,
`X-AspNet-*`, `X-Render-*`, `rndr-id`, and `X-Request-Id` on every response
regardless of entrypoint, so `python app.py`, Gunicorn, and the test client all
behave the same. `gunicorn.conf.py` sets `no_server_header = True` for the header
Gunicorn writes below the application. See [deployment](deployment.md) for the
two headers that survive and why.

**CORS.** Exact-match against `ALLOWED_ORIGINS`, with `Vary: Origin`. A
wildcard is explicitly not used: every unrelated project on a shared domain owns a
hostname there.

**TLS verification of the outbound relay.** The Archive.org relay and TMDB calls
go through the verifying context above, so a response cannot be silently
downgraded to accept-any-certificate.

## Not enforced — read this before trusting a deployment

| Gap                                   | Consequence                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| **No rate limiting at the API layer** | The limiter lives in the Express wrapper. Hitting Flask's public URL directly bypasses it entirely. Auth, password reset, and playback endpoints are unthrottled. |
| **Session tokens stored unhashed**    | `sessions.token` is the raw bearer value. A database read is therefore a full account compromise. Hashing it is a small change and is listed in the roadmap. |
| **Token in `localStorage`**           | Any XSS becomes account takeover. Not fixable without an HttpOnly-cookie flow, which the client does not have. |
| **No CSRF tokens**                     | `DELETE`/`POST` endpoints are authenticated by a bearer header, which is not automatically sent by a browser, so this is partly mitigated. The download route is a `GET` and is not. |
| **No CSP, HSTS, or `Referrer-Policy`** | Headers are scrubbed, not added. Set them at the Vercel or Render edge. |
| **No rights enforcement**              | There is no rights model. See [content and playback](content-rights.md). |
| **No upload surface**                  | Nothing accepts a file, so the entire upload threat model is moot today. If one is added, the quarantined-scanning state machine in the old documentation was never built. |
| **No admin surface**                   | Nothing to authorize, so no admin auth, MFA, or audit log. Catalogue corrections are direct database edits. |
| **No audit log**                       | No record of who changed what, because there are no operator mutations. |
| **No monitoring or alerting**          | No error tracking, no uptime check, no log aggregation. |
| **No backups or restore drill**       | Postgres backups are whatever the provider does by default. Nobody has tested a restore. |
| **No CI**                             | Every check is manual. See [testing](testing.md). |
| **No data export**                     | Deletion exists; export does not. |
| **No email verification or reset**     | Signup accepts an address without proving control of it; there is no password-reset path at all. A user who forgets their password can only delete the account. |

## Analytics and privacy posture

**No analytics.** The template's Umami script and unconditional Cloudflare
analytics were removed from `client/index.html`. There is no product event
pipeline, no consent-gated tracking, and no third-party analytics script. This is
a deliberate choice, not a gap in a pipeline: the consent banner in
`CookieBanner.tsx` says there are no analytics, because there are none.

What the app does persist client-side is real and disclosed in
`client/src/pages/Privacy.tsx`: the bearer token and a user object in
`localStorage`, and local-only ratings, settings, and viewing stats under
`freestream-*` keys. Those keys are intentionally **not** renamed to `stream-vy-*`;
renaming them would orphan every existing user's saved data. External playback
providers set their own cookies when an embed loads, which the privacy notice
says in plain language.

## Credential handling

- `TMDB_API_KEY`, `OMDB_API_KEY`, `TRAKT_CLIENT_ID`, `DATABASE_URL`,
  `ALLOWED_ORIGINS`, `SQLITE_PATH`, `PORT`, `FLASK_DEBUG`, `STREAM_PROVIDER_*`
  are read by the backend. `VITE_MOVIE_API_BASE_URL` is inlined at **build** time
  by Vite.
- `.env` is gitignored; `.env.example` is sanitized.
- `LENIUM_SKIP_ENV_FILE=1` makes the process ignore both `.env` files, so an
  injected production environment always wins over a stray file.
- `VITE_MOVIE_API_BASE_URL` pointing at a host you do not control sends users'
  `Authorization: Bearer` tokens to that host. `.env.example` says so in detail,
  because the production fallback is a reclaimable `*.onrender.com` subdomain —
  if the Render project is deleted, the name is free for anyone to register, and
  the fallback would start POSTing real tokens to whoever answers.
