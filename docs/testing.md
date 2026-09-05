# Lenflix Testing Strategy

## Test layers

Unit tests cover rights evaluation, slug generation, normalization, provenance conflict handling, search ranking helpers, upload validation, ad-block rule matching, and access-control predicates. Integration tests cover database constraints, provider adapters, search synchronization, playback-session creation, webhook verification, and queue retries.

End-to-end tests cover signup, login, search, canonical movie pages, watchlist, playback authorization, progress persistence, resume behavior, admin publishing, rights expiry, creator submission, review moderation, sitemap generation, robots rules, and private-route noindex behavior.

## Critical rights scenario

The test fixture must create a movie, playback source, rights grant, and user territory. Playback succeeds only while the grant is active. After expiry, new sessions fail with `RIGHTS_UNAVAILABLE`, the movie page shows an unavailable state, and the audit log records the policy transition.

## Security tests

Test authorization across roles and ownership boundaries, CSRF or token protections, rate limits, XSS encoding, upload quarantine, signed URL expiry, webhook replay rejection, and administrative audit coverage.

## Quality gates

Every pull request runs formatting, type checking, unit tests, integration tests, and a production build. Release candidates add browser E2E, accessibility checks, sitemap and structured-data validation, migration checks, and a smoke test against configured providers.
