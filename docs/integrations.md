# Lenflix Integrations

| Integration | Purpose | Required configuration |
|---|---|---|
| Metadata provider | Licensed metadata and IDs | API key, provider terms, rate limits, attribution policy |
| Search engine | Fuzzy search and facets | Endpoint, admin key, index name, schema version |
| Object storage | Artwork, uploads, captions | Bucket, region, credentials, lifecycle policy |
| CDN | Public artwork and media delivery | Distribution, origin, cache policy, signed access |
| Video provider | HLS/DASH, packaging, captions, DRM | Account, signing secret, webhook secret, territories |
| Email provider | Verification, reset, notifications | API key, sending domain, templates, bounce handling |
| Error tracking | Application diagnostics | DSN, PII scrubbing rules, retention |
| Analytics | Product and playback measurement | Site ID, consent policy, event schema |
| Malware scanner | Upload quarantine | Service endpoint or worker package, timeout, retention |

The application must start in a safe state when a provider is not configured. A missing provider produces an honest unavailable state and an operator-facing configuration warning; it must never produce a successful fake response.

## Audit remediation: provider contracts

### Metadata provider contract

The adapter must expose rate limits, attribution requirements, terms version, locale coverage, stable external IDs, change timestamps, deletion signals, pagination limits, and webhook or polling behavior. Sync stores raw provider payloads in restricted storage when contractually allowed, plus normalized fields and field-level provenance. A provider outage freezes the last verified index rather than deleting catalogue records.

### Playback provider contract

The adapter must declare manifest type, DRM systems, token TTL, revocation support, caption and audio behavior, webhook verification, concurrency limits, regional availability, SLA, egress pricing, and data-processing terms. Provider health is checked without exposing media URLs. The application supports a per-title source preference and a controlled fallback only when the rights grant covers the fallback source.

### Integration exit criteria

No provider is production-approved until sandbox tests verify signed access expiry, revocation, rights denial, captions, audio selection, outage behavior, webhook replay protection, and export or migration of provider IDs. The provider registry stores contract version, review date, data residency, subprocessors, and deprecation plan.
