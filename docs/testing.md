# Stream Vy Testing

Both suites are run by hand. **There is no CI** — no `.github/` directory, no
workflow that runs on push or pull request. Every check below has been run
locally; none of it runs automatically.

## Commands

```bash
# Backend: 152 tests
cd movie-backend && .venv/bin/python -m pytest -q

# Client: 24 files, 301 tests
cd client && npx tsc --noEmit && npx vitest run

# Types + secret scan
npm run check

# Production build
npm run build
```

Use `movie-backend/.venv/bin/python`, not a system `python`. The venv is not
committed and its dependencies are not installed elsewhere.

## Backend coverage

| File                       | Covers                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `test_profiles_limits.py`  | Profile CRUD, PIN rules, the 10/20 caps, referral grants, **account deletion cleanup and session revocation** |
| `test_taste.py`            | Decayed-counter scoring, trimming, weight ordering, privacy of stored features |
| `test_shares.py`           | Invite creation, accept, members, owner-only revoke and removal    |
| `test_stream_providers.py` | Provider ordering, cooldowns, disable/order env handling           |
| `test_stream_errors.py`    | Error states and failover                                          |
| `test_subtitles_download.py` | Subtitle and download relay                                       |
| `test_hardening.py`        | Input validation, header scrubbing, CORS                           |
| `test_history_migration.py`| History schema migration                                            |

`test_stream_errors.py` registers its test routes at **import time** rather than
inside a fixture. It did not before: routes were added in a setup hook, so when
the full suite ran in one process the URLs were not yet registered and every
request 404'd. The file passes alone and failed in the suite. That is why "run the
whole suite" is a rule here.

## Client coverage

Tests sit next to the module they cover: `client/src/**/*.test.ts`. They cover
`useCatalog` filtering, `useEmbedFailure` failover, `localSession`, `api` base-URL
resolution, stream timeouts, trailers, `downloadSource`, `embedSources`,
`tmdbImages`, `format`, `watchRoute`, `safeRedirect`, `affinity`, `avatars`,
`lists`, and `profiles`.

## What is not covered

- No browser end-to-end tests. No Playwright, no Cypress.
- No accessibility tests, automated or manual with a recorded result.
- No load or soak test.
- No test against a real Postgres instance: the suite exercises the SQLite path,
  so the Postgres DDL in `authdb.py` is verified only by the same
  `CREATE TABLE IF NOT EXISTS` statements running on a live deployment.
- No contract test against TMDB, Archive.org, or any embed provider. A provider
  can change its response shape and the suite stays green.
- No performance regression guard.

## When adding a feature

Run all four commands. A feature that ships with a green client suite and an
untested server path is not done, and neither is one that ships with a passing
test that asserts a mock instead of the behavior.
