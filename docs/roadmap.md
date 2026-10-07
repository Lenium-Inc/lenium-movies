# Stream Vy Roadmap

Ordered by dependency, not by aspiration. Each item names the gap it closes and
the doc that currently overstates or omits it. Nothing here is in progress.

## Blocking correctness

1. **Hash session tokens at rest.** `sessions.token` is the raw bearer value, so
   a database read is a full account compromise. One column, one lookup change.
   [security](security.md), [data model](data-model.md).
2. **Rate-limit the API layer.** The limiter lives in the Express wrapper, so
   hitting Flask's public URL directly bypasses it. Auth and playback endpoints
   are unthrottled today.
3. **Keep `VITE_MOVIE_API_BASE_URL` off the reclaimable fallback.** The blank-value
   fallback points at a `*.onrender.com` origin that anyone can register after the
   project is deleted. A custom domain removes the exposure. The code warns; it
   does not refuse.
4. **Add CSP, HSTS, and `Referrer-Policy`.** Currently the app scrubs headers and
   adds none. Set them at the Vercel or Render edge.
5. **Password reset and email verification.** Neither exists. A user who forgets
   their password can only delete the account.
6. **Data export.** Deletion exists; export does not, and the privacy notice does
   not promise it.

## Operations

7. **CI.** No workflow runs tests, type checking, the secret scan, or the build on
   push. All four are manual today. [testing](testing.md).
8. **Schema migrations.** Schema is duplicated `CREATE TABLE IF NOT EXISTS` DDL for
   Postgres and SQLite, edited by hand in both dialects. [data
   model](data-model.md).
9. **Unify the two stores.** Accounts are Postgres while the catalogue cache is
   always SQLite, so a production deployment has two databases.
10. **Monitoring and alerting.** No error tracking, uptime check, or log
    aggregation. A backend outage is discovered by users.
11. **Backups and a restore drill.** Provider defaults only, never tested.
12. **API contract tests against TMDB, Archive.org, and the embed providers.** A
    provider can change its response shape and the suite stays green.

## Product

13. **Trailer persistence.** A `videoAssets` table removes the per-request TMDB
    call and makes ingestion idempotent. [trailers](trailer-architecture.md).
14. **Persistent ratings.** Currently local-only, so they do not follow a viewer
    across devices.
15. **Search result quality.** In-process filtering is fine at this catalogue
    size. A search engine earns its place only when measured, not by default.
16. **Remove the unused client dependencies.** `vite-plugin-manus-runtime`,
    `@trpc/client`, `@trpc/react-query`, and `@tanstack/react-query` have no
    callers. The uninstall failed on a pre-existing peer conflict involving
    `@builder.io/vite-plugin-jsx-loc`; resolve that rather than forcing it.

## Explicitly not planned

Rights management, creator submissions, uploads, a video pipeline, DRM, a CDN, an
admin surface, reviews, moderation, notifications, and a CDN-backed media
delivery tier. Each needs a person, a budget, and a legal decision. The
specifications for several of them exist in the historical audits; those documents
describe a system nobody has built, and are kept as records rather than as
requirements.

"An admin surface" here means a mutation surface — catalogue correction, account
suspension, role management. The read-only account roster at `/admin/users` does
exist, and is not on this list: answering "who has an account" needs no budget and
no legal decision, only the read access an operator already has.

## Verified gaps worth naming

`gunicorn.conf.py` sets `forwarded_allow_ips = "*"`, which trusts
`X-Forwarded-For` from any client. That is required for correct client IPs behind
Render, but it also means a direct-to-Flask caller can spoof its address — which
matters more while the rate limiter lives in the wrapper rather than the app.
