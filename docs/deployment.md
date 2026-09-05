# Lenflix Deployment Plan

## Environments

Use isolated development, staging, and production environments with separate databases, buckets, search indexes, provider credentials, and OAuth applications. Development may use labeled fixtures. Staging uses provider sandbox accounts. Production uses only verified rights and production credentials.

## Topology

The SSR/API application runs behind a managed HTTPS gateway. Background workers process ingestion, artwork, media, notifications, rights alerts, search reconciliation, and cleanup. PostgreSQL, Redis, object storage, search, CDN, and video infrastructure are managed services where possible.

## Delivery

CI runs formatting, type checks, tests, migrations in dry-run mode, security scans, build, and E2E smoke tests. Deployments are immutable and reversible. Database migrations are forward-compatible. Media and rights data are not deleted by application rollback.

## Operations

Define SLOs for page availability, search latency, playback-session creation, playback success, ingestion completion, and rights alert delivery. Monitor database connections, queue depth, provider errors, CDN errors, and media processing lag. Create runbooks for rollback, takedown, provider outage, credential rotation, and data restoration.
