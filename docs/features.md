# Stream Vy Feature Map

Status is honest: **REAL** means server-backed and tested. **REAL (client-only)**
means the behavior is genuine but lives only in the browser. **NOT BUILT** means
no code.

An earlier version of this file described creator submissions, rights
declarations, admin catalogue management, ratings and reviews, watch progress
sync, and a five-phase delivery table. None of that is implemented.

## Discovery — REAL

Live TMDB catalogue re-fetched per request. Trending, popular, now playing, and
on the air feeds. Search with suggestions. Discover shelves. TMDB curated
collections. A SQLite `media_items` cache doubles as the fallback when every
upstream call fails, with no nightly seeder: the catalogue is driven by real
traffic.

Genre, media-type, and sort filters run through `useCatalog` and apply to shelf
results and paged results alike. Two decorative filter dropdowns that changed
nothing were replaced with working controls, and an unreachable "View all" link
was removed rather than left as a dead affordance.

## Accounts — REAL

Email and password signup, login, current-user, logout, and **password-confirmed
account deletion** that removes every user-scoped row including the tables with
no user foreign key. PBKDF2-HMAC-SHA256, 210k iterations, opaque bearer tokens,
30-day session rows. All covered by `test_profiles_limits.py`.

**Missing:** no email verification, no password reset, no session management
screen, no data export.

## Profiles — REAL

Up to four PIN-locked profiles per account, each with its own avatar, name, and
sort order. A PIN is write-only: it is set or replaced, never returned, and an
empty PIN clears the lock. Unlock verifies the profile's own PIN and explicitly
does not accept the account password.

## Recommendations — REAL

`movie-backend/taste.py` is a deterministic decayed-counter linear model keyed to
`profile_id`, with genre/cast/director weights of 1.0/1.5/2.0. The same model the
client used to run in `sessionStorage`, moved server-side so the ordering a
profile sees does not change over time and is the same on every device.
`/api/recommendations/eval` makes the choice of model falsifiable. Only derived
features persist; raw search text is never stored.

## Allowance — REAL

10 titles per profile per day, 20 per account per day, resetting at 00:00 UTC,
enforced from `daily_plays` in the claim route. Referral codes grant one uncapped
day to both parties, with self-referral and double-claiming prevented by database
uniqueness. `STREAM_PROVIDER_*` aside, the client cannot grant an allowance.

**Removed:** the duplicate client-side 8-per-day cap and its modal. Two counters
disagreeing is worse than one counter.

## Playback — REAL, with a caveat

The backend owns an ordered provider chain. A title in the Archive.org-backed
direct catalog plays as a real stream relayed by our server, which is what makes
seeking, range requests, and downloads work. Everything else resolves to an
ordered list of third-party embeds, and the UI labels which it is doing. Per-
provider health with cooldowns means a failing provider is skipped, not re-probed.

The caveat: the direct catalog's public-domain claim is assumed, not verified, and
the embed tier is not under our control. See [content and
playback](content-rights.md).

## History, My List, sharing — REAL

Server-backed watch history with progress and completion, per-account My List,
and list sharing by invite token with member listing, member removal, and revoke.
Owner-only operations return 403 otherwise. A share grants read access to the
owner's list; nothing is copied.

## Local-only, honestly labelled — REAL (client-only)

- **Local demo session.** Works without an account, clearly marked `local-demo`.
- **Personal ratings.** Half-star scale, chronological list, in `localStorage`
  under `freestream-ratings-v1`. Not sent to the server, not shared, lost on a
  different device.
- **Viewing stats and achievements.** Hours watched, per-title progress,
  achievements. Local only. The 8/day cap they once displayed is gone; the
  display is now statistics, not a limit.
- **Theme and playback settings.** Local.

The `freestream-*` localStorage key prefixes are intentionally unchanged.
Renaming them to `stream-vy-*` would orphan every existing user's saved data.

## NOT BUILT

| Capability                | Notes                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| Rights management         | No grant, territory, evidence, expiry, or policy evaluation.       |
| SSR, sitemap, robots      | Client-rendered SPA; `vercel.json` rewrites everything to `index.html`. |
| Structured data / JSON-LD | None emitted.                                                      |
| Creator portal, uploads   | No submission, no media pipeline, no quarantine.                   |
| Reviews, ratings by others| Only the viewer's own local ratings exist.                        |
| Moderation, reporting     | Nothing to moderate.                                               |
| Admin surface             | No routes, no pages, no roles.                                     |
| Analytics                 | Deliberately none; see [security](security.md).                   |
| Rate limiting at the API  | Only in the Express wrapper; see [security](security.md).         |
| Notifications             | No event model.                                                    |
| Search engine             | In-process filtering is sufficient at this scale; not an oversight. |
| CI                        | None. See [testing](testing.md).                                   |
