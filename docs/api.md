# FreeStream API Contract

## Principles

The API is versioned, typed, authenticated by session, and organized by domain. Browser clients do not call metadata providers directly. The server owns caching, provenance, rights evaluation, and provider credentials.

## Public procedures

| Procedure | Input | Output |
|---|---|---|
| `catalog.home` | locale, optional cursor | featured rows and stable collection references |
| `catalog.search` | query, facets, sort, cursor | results, facets, suggestions, zero-result hints |
| `catalog.movieBySlug` | slug | canonical movie data, availability state, structured metadata |
| `catalog.collectionBySlug` | slug, cursor | published collection and items |
| `catalog.personBySlug` | slug | filmography when indexable |

## Authenticated procedures

`account.me`, `account.updatePreferences`, `watchlist.list`, `watchlist.add`, `watchlist.remove`, `history.list`, `history.remove`, `history.clear`, `progress.upsert`, `rating.upsert`, and `review.create/update/delete/report`.

## Playback procedures

`playback.createSession` accepts movie ID, device context, and optional resume position. It returns a session ID, signed manifest access, expiry, caption tracks, and allowed capabilities. It must return a typed denial such as `RIGHTS_UNAVAILABLE`, `TERRITORY_RESTRICTED`, `MEDIA_NOT_READY`, or `PROVIDER_UNAVAILABLE` without leaking secrets. `playback.heartbeat` and `playback.complete` accept the session ID and validated telemetry fields.

## Admin procedures

Admin APIs cover movies, providers, rights, submissions, collections, reviews, search indexing, ingestion jobs, ad-blocking rules, audit logs, and system health. Every mutating procedure checks role and writes an audit event.

## Provider interfaces

```ts
interface MetadataProvider {
  search(input: ProviderSearchInput): Promise<ProviderMovieRef[]>;
  getMovie(externalId: string): Promise<ProviderMovieRecord>;
}

interface PlaybackProvider {
  createAccess(input: PlaybackAccessInput): Promise<PlaybackAccess>;
  revokeAccess(input: RevokeAccessInput): Promise<void>;
}

interface SearchIndex {
  upsert(document: SearchDocument): Promise<void>;
  delete(id: string): Promise<void>;
}
```

Provider adapters must expose health, retry, timeout, and provenance behavior. Development adapters may return clearly labeled fixtures only in non-production environments.

## Audit remediation: API safety

All mutating procedures accept an idempotency key where retries could duplicate an action. Cursor pagination uses opaque, signed cursors tied to the query shape; offset pagination is not used for high-volume feeds. Public search inputs have maximum length, facet count, page size, timeout, and rate limits. API responses use stable error codes, request IDs, and no provider secret or internal contract detail.

Playback session creation is rate limited per account, device fingerprint policy, and IP risk signal without using invasive tracking as a default. Session tokens are one-time or short-lived where possible, cannot be replayed after expiry, and are revoked on rights takedown. Progress writes are throttled and idempotent.

The API publishes deprecation dates and version headers. Webhooks are isolated from browser procedures, validate signatures and timestamps, reject replays, and write an audit event before applying state changes.
