# FreeStream Production Documentation

This directory defines the production target for FreeStream, a high-performance movie discovery and authorized streaming platform. The documents intentionally precede further production coding because provider, rights, identity, infrastructure, and compliance decisions materially change the implementation.

## Documents

1. [Architecture](architecture.md)
2. [Product requirements](prd.md)
3. [Features](features.md)
4. [Sitemap](sitemap.md)
5. [User journeys](userjourney.md)
6. [Use cases](usecases.md)
7. [Data model](data-model.md)
8. [API](api.md)
9. [Security](security.md)
10. [SEO](seo.md)
11. [Performance](performance.md)
12. [Testing](testing.md)
13. [Content rights](content-rights.md)
14. [Ad blocking](ad-blocking.md)
15. [Integrations](integrations.md)
16. [Deployment](deployment.md)
17. [Environment](environment.md)
18. [Roadmap](roadmap.md)
19. [Agent instructions](agent.md)
20. [Metadata provider](metadata-provider.md)
21. [Trailer architecture](trailer-architecture.md)

## Current state

The deployed WebDev project now consumes live TMDB metadata through a server-only provider adapter and supports cached, official YouTube trailer assets. It still does not claim to provide licensed streaming playback, rights, or availability; those remain separate production capabilities.

## Immediate decisions

The owner must complete TMDB commercial licensing and attribution review, confirm target territories, authentication policy, and playback provider before public launch. The schema, provider adapters, environment contract, and deployment plan must remain aligned with those decisions.

## Audit

The cross-functional production audit is documented in [audit.md](audit.md). It records findings, severity, remediation, and launch blockers across rights, playback, CDN, search, SEO, security, privacy, accessibility, disaster recovery, monitoring, and cost.

## Performance audit

The latest measured performance audit, including before/after browser timings, image payloads, build sizes, scope limitations, and remaining production work, is documented in [performance-report.md](performance-report.md).

## Production-readiness audit

The evidence-based implementation audit, classification matrix, safe remediation record, and external blockers are documented in [production-readiness-audit.md](production-readiness-audit.md).
