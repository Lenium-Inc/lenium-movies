# Lenflix Agent Instructions

## Non-negotiable rules

Do not present fixture movies, invented ratings, fake reviews, fake counts, simulated playback, or unverified rights as production functionality. Do not scrape unauthorized streaming sites or bypass DRM, paywalls, geo-restrictions, or access controls.

## Implementation order

Read the relevant domain document before editing code. Establish schema and migrations before procedures. Add provider abstractions before provider-dependent UI. Implement rights policy before playback. Implement honest loading, empty, error, and unavailable states for every provider boundary.

## Data discipline

Preserve provenance for external metadata. Do not overwrite administrator edits blindly. Treat metadata, media, and rights as separate domains. Store timestamps in UTC. Use idempotency keys for ingestion and audit all publication and rights changes.

## Quality gates

Before delivery, run formatting, type checking, unit tests, integration tests, production build, accessibility checks, and relevant browser smoke tests. Verify indexable routes, structured data, robots, sitemap, authorization boundaries, rights expiry, signed access expiry, and provider outage behavior.

## Current project note

The existing WebDev app is a polished visual prototype. It is not yet a production streaming system. Its fixture catalogue must be replaced with real provider-backed records and its local save interactions must be connected to persistent authenticated procedures before production claims are made.
