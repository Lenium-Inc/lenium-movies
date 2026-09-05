# Lenflix Deployment Plan

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
