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
