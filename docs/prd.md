# Stream Vy Product Requirements

## Product promise

Stream Vy helps a viewer **find a film, decide whether to watch it, watch it, and
remember what they liked**. The catalogue, the account, the daily allowance, and
playback are real and enforced on the server.

Stream Vy is **not** a licensed streaming service. It does not hold streaming
rights, does not run a rights-approval workflow, and does not host media. The
honest version of the promise is: *a free movie discovery and playback front end
that relays what public sources make publicly reachable.* [Content and
playback](content-rights.md) is the document that must be read before any
external claim is made.

## Who it is for

| Persona           | Primary need                            | Surface                                    |
| ----------------- | --------------------------------------- | ------------------------------------------ |
| Household viewer  | Several people with separate tastes     | Profiles, per-profile recommendations      |
| Returning viewer  | Their history, list, and ratings        | My List, history, profile                  |
| Sharer            | Watch a list with someone else          | Invite tokens, shared lists, member removal |
| Operator          | Keep the deployment running and honest  | Env config, deploy, account roster, DMCA takedown |

There is no creator, partner, moderator, or administrator persona. Those surfaces
do not exist and are not in scope until someone builds and staffs them.

The Operator is not one of those. It is the person who already has server
credentials, and the roster at `/admin/users` is the one question they could not
answer from the product itself. It is read-only and gated on the `ADMIN_EMAILS`
allowlist; see "No admin surface" below for what that deliberately leaves out.

## What the product does

**Discovery.** A live catalogue is fetched from TMDB on request. The SQLite
catalog is a write-through cache and the fallback when every upstream call fails.
Feeds (trending, popular, now playing, on the air), search, suggestions, discover
shelves, and TMDB's curated collections are all real endpoints. Genre, media
type, and sort filters run through `useCatalog` and apply to both shelf and paged
results.

**Accounts.** Email and password accounts with PBKDF2-HMAC-SHA256 hashing, opaque
bearer tokens, and 30-day session rows. Signup, login, current-user, logout, and
password-confirmed account deletion are implemented and tested. A local demo
session exists for trying the product without an account and is clearly labelled
as local-only.

**Profiles.** A household creates up to four PIN-locked profiles per account. Each
profile carries its own taste signals, play history, saved list, and ratings, and
can be renamed, recolored, reordered, or deleted.

**Recommendations.** `movie-backend/taste.py` is a deterministic decayed-counter
linear model keyed to `profile_id`. Genre, cast, and director mentions are
weighted 1.0 / 1.5 / 2.0, because a named person is a far stronger signal than a
genre every title shares. Only derived features persist: a search is reduced to
normalised tokens and never stored as text. `/api/recommendations/eval` exists so
the choice of model is falsifiable rather than a matter of taste.

**Allowance.** A real, server-enforced limit, not a decorative counter:

| Rule                      | Value                          |
| ------------------------- | ------------------------------ |
| Per profile per day       | 10 titles                      |
| Per account per day       | 20 titles                      |
| Reset                     | 00:00 UTC                      |
| Referral reward           | 1 uncapped day per acceptance, for both parties |

The client can display the remaining allowance. It cannot grant one. The previous
duplicate client-side 8-per-day cap was removed rather than kept as a second
source of truth.

**Playback.** The backend owns the whole provider chain. A title in the
Archive.org-backed direct catalog plays as a real MP4/HLS stream relayed through
the server, which is what makes seeking, range requests, and downloads work.
Everything else resolves to a third-party iframe embed, and the UI says which one
it is doing. A local per-provider health record with cooldowns means a failing
provider is skipped rather than re-probed on every request.

**Memory.** Watch history, My List, per-title progress, half-star ratings, and
shared lists with invite tokens are all server-backed and account-scoped.

## Non-goals

Stream Vy does not scrape stream indexes it was not given, bypass DRM, paywalls,
geo-restrictions, or access controls, download copyrighted media without
permission, fabricate ratings or reviews, present a dead play button as working
playback, or claim rights it cannot evidence.

## Known product gaps

These are gaps, not backlog items in progress:

- **No rights system.** No `RightsGrant`, no territory evaluation, no evidence
  store, no expiry job, no fail-closed policy. The old documentation described
  all of these as existing. They do not.
- **No SSR, sitemap, robots policy, or structured data.** It is a client-rendered
  SPA. `vercel.json` rewrites all routes to `index.html`.
- **No creator portal, uploads, reviews, ratings-by-others, or moderation.**
- **No admin surface, except one read-only roster.** `GET /api/admin/users`
  lists accounts and their counts, and `/admin/users` renders it. There is no
  catalogue correction UI — that is still a database edit — and no way to
  promote, suspend, or delete an account from the product. Authorization is the
  `ADMIN_EMAILS` allowlist, not a role column.
- **No analytics.** There is no product event pipeline, by choice — see
  [security](security.md).
- **No CI.** Every check in [testing](testing.md) is run by hand.

## Acceptance principles

Every user-facing feature must have a real state model, a server-side
authorization decision, honest loading, empty, error, and unavailable states, and
a test. A provider-dependent capability declares its provider and required
configuration before it is enabled. Nothing is labelled "ready" because a
`toast` fires.

## References

- [WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/)
