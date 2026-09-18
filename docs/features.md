# FreeStream Feature Map

## Public discovery

Home contains featured content, trending and recently added rows, verified collections, genre entry points, and continue-watching for authenticated viewers. Search supports title, person, genre, language, country, year, rating, runtime, sort, fuzzy matching, suggestions, history, and zero-result recovery. Browse pages must be canonical and indexable only when their result set is stable and useful.

## Movie experience

A movie page contains canonical title data, original title, artwork, synopsis, release information, runtime, age rating, language, country, cast, crew, trailer, gallery, ratings, reviews, watchlist state, related titles, and rights-aware availability. The player is a separate capability. The page must distinguish trailer playback, authorized full playback, unavailable content, expired rights, and provider outage.

## Account and memory

Authenticated viewers can manage profile, preferences, languages, genres, sessions, privacy, watchlist, watched state, playback progress, history, ratings, and reviews. Private pages are not indexable.

## Creator and admin operations

Creators submit metadata and media with rights declarations. Administrators validate, moderate, attach rights, manage playback sources, publish collections, operate the search index, review reports, inspect ingestion jobs, and access audit logs. Admin actions require role checks and append an audit event.

## Production state rule

The existing UI is a visual prototype with development-only fixture cards. Before launch, fixture records must be removed or visibly labeled in a non-production environment. No fixture may be presented as licensed, rated, reviewed, or playable production content.

## Delivery sequence

| Phase | Scope                                       | Exit condition                                      |
| ----- | ------------------------------------------- | --------------------------------------------------- |
| 1     | Catalogue, rights, search, movie pages      | Real provider records are searchable and crawlable  |
| 2     | Auth, watchlist, progress, playback session | Rights policy gates every play request              |
| 3     | Admin, ingestion, collections, moderation   | Operators can publish without direct database edits |
| 4     | Creator portal and reviews                  | Rights evidence and moderation are auditable        |
| 5     | Advanced recommendations and monetization   | Business and privacy review complete                |

## Audit remediation: population without fake content

The first production catalogue is a controlled batch, not a hardcoded UI array. Each title must enter through a provider adapter or approved admin import, carry provenance, pass duplicate detection, receive validated artwork and availability, and remain unpublished until rights and media state are ready. Empty catalogue, provider outage, metadata conflict, and rights-pending states are first-class UI states.

Metadata refreshes are incremental and idempotent. A field-level conflict queue prevents an external provider from silently overwriting administrator edits. Operators can preview a proposed import, compare changed fields, reject records, and replay failed jobs without creating duplicates.
