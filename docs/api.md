# Stream Vy API

All routes are served by the single Flask app in `movie-backend/app.py`. There is
no version prefix, no tRPC surface, and no GraphQL. Any document describing
`catalog.home`, `playback.createSession`, or a rights error code
(`RIGHTS_UNAVAILABLE`, `TERRITORY_RESTRICTED`, `MEDIA_NOT_READY`,
`PROVIDER_UNAVAILABLE`) describes a system that does not exist — those procedures
and error codes are not in this codebase.

## Conventions

- **Auth**: `Authorization: Bearer <token>` from `/api/auth/login` or `/signup`.
  Tokens are opaque `secrets.token_urlsafe` values backed by a `sessions` row
  with a 30-day expiry. The token itself is what the client stores; profile PINs
  are never returned by any endpoint.
- **CORS**: exact-match against `ALLOWED_ORIGINS`. Requests with no `Origin`
  header — including the Express wrapper's server-to-server call — are unaffected.
- **Errors**: JSON `{"error": "..."} `with a real HTTP status. There is no
  error-code enum; the previous `*_UNAVAILABLE` taxonomy was invented.
- **Allowance**: play and claim paths are server-enforced at 10 titles per
  profile per day and 20 per account per day, resetting at 00:00 UTC. A referral
  acceptance grants one uncapped day to both parties.

## Public catalogue

| Route                          | Method       | Purpose                                            |
| ------------------------------ | ------------ | -------------------------------------------------- |
| `/`                            | GET          | Health check. Returns `{"status": "online", ...}`  |
| `/api/search`                  | GET          | TMDB search                                        |
| `/api/search/suggest`          | GET          | Search suggestions                                 |
| `/api/movies/feeds`            | GET          | Trending / popular / now playing / on the air      |
| `/api/movies/trending`         | GET          | Trending only                                      |
| `/api/movies/popular`          | GET          | Popular only                                       |
| `/api/movies/now_playing`      | GET          | Now playing only                                   |
| `/api/movies/on_the_air`       | GET          | On the air only                                    |
| `/api/catalog/discover`        | GET          | Discover shelves                                   |
| `/api/catalog/search`          | GET          | Cached catalogue search                            |
| `/api/media/<id>`              | GET          | One catalog record by id                           |
| `/api/movies/resolve`          | GET, POST    | Resolve a title to a playable state                |
| `/api/episodes`                | GET          | Season/episode details for a series                |
| `/api/movies/trailer`          | GET          | Trailer for a title                                |
| `/api/catalog/movieTrailer`    | GET          | Trailer by TMDB id                                 |
| `/api/subtitles`               | GET          | Subtitle relay                                     |

## Playback

| Route                        | Method    | Notes                                                          |
| ---------------------------- | --------- | -------------------------------------------------------------- |
| `/api/get-stream`            | GET       | Direct (Archive.org) source, ordered candidates                 |
| `/api/movies/stream`         | GET       | Byte relay for range requests and seeking                       |
| `/api/movies/download`       | GET       | Explicit download path; a **GET**, so it is not CSRF-relevant  |

`stream_providers.resolve()` returns the first playable provider plus the
remaining ordered candidates. The client renders the first and may fail over
client-side. `STREAM_PROVIDER_DISABLED` and `STREAM_PROVIDER_ORDER` reshape the
chain without a code change.

## Accounts

| Route                      | Method     | Notes                                                     |
| -------------------------- | ---------- | --------------------------------------------------------- |
| `/api/auth/signup`         | POST       | Creates the account                                       |
| `/api/auth/login`          | POST       | Returns a bearer token                                    |
| `/api/auth/me`             | GET        | Current user and profile summary                          |
| `/api/auth/logout`         | POST       | Revokes the session row                                   |
| `/api/auth/account`        | DELETE     | Requires email **and** password; deletes everything (§below) |

`DELETE /api/auth/account` explicitly deletes profiles, history, daily plays,
allowance, taste signals and events, saved media, shares, invitations, referral
uses, and sessions — including rows in tables that have no foreign key to
`users`, which is why an explicit list is used instead of relying on cascade.
Accounts with an account-wide history cannot be deleted by the generic endpoint
and must go through the account flow.

## Profiles and taste

| Route                            | Method     | Notes                                |
| -------------------------------- | ---------- | ------------------------------------ |
| `/api/profiles`                  | GET, POST  | List or create; max 4 per account    |
| `/api/profiles/<profile_id>`     | PATCH, DELETE | Rename, recolor, reorder, PIN, delete |
| `/api/profiles/<profile_id>/unlock` | POST    | Verifies the child-level PIN         |
| `/api/taste`                     | POST       | Record a signal                      |
| `/api/taste/state`               | GET, POST  | Read and replace derived state       |
| `/api/recommendations`           | GET        | Ranked titles for the active profile |
| `/api/recommendations/eval`      | GET        | Offline evaluation of the model      |

A profile PIN is a household lock, not the account password. The account password
is not accepted at the unlock route.

## Allowance and referrals

| Route                     | Method | Notes                                              |
| ------------------------- | ------ | -------------------------------------------------- |
| `/api/allowance`          | GET    | Per-profile and per-account remaining today        |
| `/api/allowance/claim`    | POST   | Consumes a play; the only path that decrements     |
| `/api/referrals`          | GET    | This account's code and status                    |
| `/api/referrals/apply`    | POST   | Redeem a code; unlocks a day for both parties      |

## History, list, and sharing

| Route                                        | Method            |
| -------------------------------------------- | ----------------- |
| `/api/auth/history`                          | GET, POST, DELETE |
| `/api/auth/history/<path:movie_key>`         | DELETE            |
| `/api/auth/my-list`                          | GET, POST, DELETE |
| `/api/auth/my-list/<int:media_id>`           | DELETE            |
| `/api/auth/shares`                           | GET, POST         |
| `/api/auth/shares/<token>`                   | GET               |
| `/api/auth/shares/<token>/accept`            | POST              |
| `/api/auth/shares/<token>/members`           | GET               |
| `/api/auth/shares/<token>/members/<member_id>` | DELETE          |
| `/api/auth/shares/<token>/revoke`            | POST              |
| `/api/auth/shared/<owner_id>/my-list`        | GET               |

Share tokens are readable by anyone holding the link; the token is the
capability, which is why the client accepts two URL shapes
(`/list/share/:token` and `/share/:token`) for links minted outside the app.
Member removal and revoke are owner-only and return 403 otherwise.

## Gaps

- No rate limiting, idempotency keys, or signed cursors at the API layer. The
  rate limiter lives in the Express wrapper, so hitting Flask directly bypasses
  it. This is a real exposure, not a design choice.
- No request IDs or structured error codes.
- No webhooks.
- No admin routes.
