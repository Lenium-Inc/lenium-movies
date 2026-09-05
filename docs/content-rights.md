# Lenflix Content and Rights Model

## Allowed sources

Lenflix may distribute licensed titles, public-domain works after verification, creator-submitted works with documented rights, and authorized partner catalogues. Metadata may be synchronized from legitimate providers, but the provider record is not proof of streaming rights.

## Rights record

Every streamable title requires rights owner or provider, contract/reference ID, territory, start and end dates, permitted playback method, platform and monetization restrictions, playback provider, status, evidence reference, and audit history. Rights are separate from movie metadata and media assets.

## Verification workflow

An operator or partner submits evidence. A rights reviewer validates scope and dates. The system stores the decision and evidence reference. A playback source is attached only after approval. Publication requires an active rights grant for at least one configured territory and a ready media source.

## Takedown and expiry

A rights takedown immediately blocks new sessions and removes or marks the public availability state according to policy. A scheduled expiry blocks new playback after the end timestamp. Operators receive advance alerts and all changes are audited.

## Prohibited acquisition

The product must not scrape unauthorized stream indexes, download unauthorized movies, bypass DRM, bypass geo-restrictions, or infer a right to stream from a public URL. Provider adapters must require explicit credentials and contract metadata before enabling playback.

## Audit remediation: evidence and conflict controls

### Evidence package

A rights grant is not valid until its evidence package records the rights owner, chain of title or public-domain basis, signed agreement reference, permitted territories, dates in UTC, platforms, monetization permissions, language and subtitle permissions, DRM requirements, takedown contact, and reviewer decision. Evidence files are private, versioned, access-controlled, virus-scanned, and retained according to legal policy.

### Overlap and precedence

The system rejects overlapping grants that create ambiguous authority for the same movie, territory, platform, and time window unless an administrator records an explicit precedence rule. Takedown overrides publication and all ordinary grants. The policy engine evaluates deny, takedown, expiry, territory, platform, and source state in that order.

### Operational targets

Rights expiry alerts run at 90, 30, and 7 days. A takedown request is acknowledged within one business hour and blocks new playback as soon as the authorized operator or verified webhook confirms it. Public metadata remains available only when contractually permitted; otherwise the page is unpublished, redirected, or returned as 410 according to the legal decision.

### Legal gates

A legal or rights reviewer must approve the evidence model, standard contract fields, public-domain verification method, notice-and-takedown process, territorial policy, and retention schedule before production ingestion is enabled.
