# Stream Vy Agent Instructions

## Non-negotiable rules

Do not present fixture titles, invented ratings, fake reviews, fake counts,
simulated playback, or unverified rights as product functionality. Do not scrape
unauthorized stream indexes, or bypass DRM, paywalls, geo-restrictions, or access
controls. Do not rename `freestream-*` localStorage keys or `lenium_*` database
namespaces: saved data and existing passwords depend on them.

## Before writing code

Read the relevant document in `docs/` first. The API, data model, security, and
content-and-playback documents describe the system as it is; keep them accurate
when you change code.

## Implementation order

Server enforcement before client affordance. A counter the client can grant is
not a limit. A provider abstraction before provider-dependent UI. Honest loading,
empty, error, and unavailable states for every provider boundary. If a capability
needs a decision nobody has made, surface the gap rather than inventing a
plausible-sounding default.

## Data discipline

Store timestamps in UTC. Persist only derived features for taste: a search is
reduced to tokens, never stored as text. Preserve the two existing caveats
explicitly when extending them: `watch_history` and `saved_media` store their own
title, year, and poster because there is no media foreign key, and `media_items`
is SQLite even on a Postgres deployment.

## Quality gates

Before delivering, run all four:

```bash
cd movie-backend && .venv/bin/python -m pytest -q
cd client && npx tsc --noEmit && npx vitest run
npm run check
npm run build
```

Run the whole backend suite in one process, not file by file.
`test_stream_errors.py` registers its routes at import time precisely because
isolated runs hide a registration-order bug.

## Documentation

A document that describes a system which does not exist is worse than no
document, because it makes the next reader confident. When you add a feature, add
it to [prd](prd.md) and [api](api.md) or [data model](data-model.md). When you
remove one, remove it from the docs in the same change.
