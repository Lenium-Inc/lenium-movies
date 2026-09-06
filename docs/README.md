# Lenflix Production Documentation

This directory defines the production target for Lenflix, a high-performance movie discovery and authorized streaming platform. The documents intentionally precede further production coding because provider, rights, identity, infrastructure, and compliance decisions materially change the implementation.

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

## Current state

The deployed WebDev project is a visual prototype with development-only fixture cards and client-side interactions. It is useful for validating the black-and-white cinematic direction, but it does not claim to provide real catalogue data or playback. Production work begins after the unresolved decisions in `architecture.md`, `integrations.md`, and `content-rights.md` are approved.

## Immediate decisions

The owner must select the initial metadata provider, video provider, target territories, authentication policy, and whether creator uploads are part of the first production release. Once those choices are confirmed, the schema, provider adapters, environment contract, and deployment plan can be implemented without inventing external behavior.

## Audit

The cross-functional production audit is documented in [audit.md](audit.md). It records findings, severity, remediation, and launch blockers across rights, playback, CDN, search, SEO, security, privacy, accessibility, disaster recovery, monitoring, and cost.

## Performance audit

The latest measured performance audit, including before/after browser timings, image payloads, build sizes, scope limitations, and remaining production work, is documented in [performance-report.md](performance-report.md).

## Production-readiness audit

The evidence-based implementation audit, classification matrix, safe remediation record, and external blockers are documented in [production-readiness-audit.md](production-readiness-audit.md).
