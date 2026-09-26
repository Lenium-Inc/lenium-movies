# FreeStream Deployment Plan

## Environments

Use isolated development, staging, and production environments with separate databases, buckets, search indexes, provider credentials, and OAuth applications. Development may use labeled fixtures. Staging uses provider sandbox accounts. Production uses only verified rights and production credentials.

## Topology

The SSR/API application runs behind a managed HTTPS gateway. Background workers process ingestion, artwork, media, notifications, rights alerts, search reconciliation, and cleanup. PostgreSQL, Redis, object storage, search, CDN, and video infrastructure are managed services where possible.

## Delivery

CI runs formatting, type checks, tests, migrations in dry-run mode, security scans, build, and E2E smoke tests. Deployments are immutable and reversible. Database migrations are forward-compatible. Media and rights data are not deleted by application rollback.

## Operations

Define SLOs for page availability, search latency, playback-session creation, playback success, ingestion completion, and rights alert delivery. Monitor database connections, queue depth, provider errors, CDN errors, and media processing lag. Create runbooks for rollback, takedown, provider outage, credential rotation, and data restoration.

## Audit remediation: recovery, observability, and cost

### Disaster recovery

Define a production RPO of 15 minutes for transactional data and a 1-hour RTO for the primary region as initial targets. Back up PostgreSQL with point-in-time recovery plus daily encrypted snapshots, replicate critical rights evidence and configuration to a separate account or region, version object storage, and export search indexes because search remains rebuildable. Redis is treated as recoverable cache unless it contains session state that has not been externalized.

Restore drills run quarterly and after major schema changes. A drill must restore a sanitized copy, replay outbox events, rebuild search, verify rights records, and document actual RPO/RTO. Backups are encrypted, access-controlled, retention-managed, and tested for deletion or corruption scenarios.

### Monitoring and ownership

Track SLIs for public page availability, search p95, API error rate, playback-session success, playback startup, rebuffering, ingestion age, rights-alert delivery, queue age, CDN error rate, backup freshness, and restore-test success. Page the on-call owner for rights-policy failure, provider outage, backup staleness, abnormal playback denial, and security events. Dashboards separate product, platform, provider, and rights health.

### Cost governance

Create monthly budget envelopes for compute, database, search, storage, CDN egress, video processing, provider API usage, observability, and email. Attribute cost by environment, provider, title/media pipeline, and traffic class. Apply storage lifecycle rules, image/video derivative limits, provider quotas, CDN egress alerts, and emergency feature flags that disable expensive non-critical processing without disabling rights enforcement. Review unit cost per published title, search session, and playback hour before scaling.

## Render hardening: what the application cannot do alone

Three fingerprinting and policy items are only partly fixable in-process. The
application-side changes are in the code; the rest needs the Render service
configuration.

### Start command

Gunicorn writes `Server: gunicorn/<version>` at the HTTP layer, *below* the WSGI
application, so the header scrubber in `movie-backend/app.py` cannot remove it.
Only a server option can. Set the Render start command to:

```
gunicorn -c gunicorn.conf.py movie-backend.app:app
```

`gunicorn.conf.py` sets `no_server_header = True` and deliberately does not set
`workers`, so it will not fight the process count already configured in the
dashboard.

### `ALLOWED_ORIGINS`

CORS is exact-match, never a wildcard. `*.vercel.app` is not a safe shorthand:
every unrelated Vercel project owns a hostname on that domain, so a wildcard
there would let any of them act as a signed-in user. List origins explicitly:

```
ALLOWED_ORIGINS=https://vy-virid.vercel.app,https://your-staging-domain.example
```

Unlisted origins receive no `Access-Control-Allow-Origin` at all and are blocked
by the browser. Requests with no `Origin` header — including the server-to-server
call the Vercel proxy makes into Flask — are unaffected.

### Headers Render injects after the app

`X-Render-Origin-Server` and `rndr-id` are added by Render's edge *after* this
process writes its response. No Flask or WSGI change can remove them, because the
application never sees them. They are listed in the scrubber defensively in case
a future proxy forwards them, but to actually drop them you need a hop in front
of Render that can rewrite response headers:

- a Cloudflare Worker or similar, or
- the Vercel deployment, if requests are routed through it.

Do not strip `rndr-id` blindly. Render uses it to route requests to the right
service; removing it can break routing rather than just hiding a header. Verify
behaviour on a preview deployment first.
