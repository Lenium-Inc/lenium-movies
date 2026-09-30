# Stream Vy User Journeys

Flows that work end to end. The previous version of this file described
server-rendered home pages, signed-in continue-watching with resume positions,
reviews with spoiler labels entering moderation, a creator upload pipeline, and an
administrator ingestion job with rights approval. None of those exist.

## Viewer: discover to play

Open `/`. The SPA loads, the client requests a feed, the backend re-fetches live
TMDB titles, normalizes them, and persists them write-through. Filter by genre,
media type, or sort through `useCatalog`; both the shelves and the paged results
respond. Pick a title. The client calls `/api/movies/resolve`; the server walks
the provider chain.

- **Direct hit:** the player plays an Archive.org-backed stream through the
  server relay, so seeking and range requests work. Download is available.
- **No direct hit:** an ordered list of embeds comes back; the first is rendered
  in an iframe and the UI states that it is a third-party embed.
- **Everything fails:** an honest unavailable state, not a dead play button.

Playing consumes one daily allowance unit, enforced server-side.

## Viewer: remember

Progress and history are written to the server keyed to the active profile, with
sizes clamped and strings capped so a bad payload cannot 500. Returning viewers
see their history and progress across devices, because the records are
server-side. My List persists per account. Personal ratings are local only and do
not follow the viewer to another device — the UI does not claim they do.

## Household: separate profiles

Create up to four profiles, each with an optional PIN. A PIN is a child-level
household lock; the account password is explicitly rejected at the unlock route.
Each profile gets its own recommendations, history, and daily allowance, so
switching profile is what changes the feed.

## Sharer: watch a list together

An owner mints an invite token and shares the link. A recipient signs in and
accepts; the token is the capability, which is why the client accepts two URL
shapes. Members can be listed and removed, and the invite can be revoked. Both
operations are owner-only. A share grants read access to the owner's list;
nothing is copied into the member's own list.

## Referral

A viewer shares their referral code. On acceptance, both parties get one uncapped
day. `UNIQUE (code_id)` and `UNIQUE (referred_id)` make self-referral and
double-claiming impossible at the database level, not in application logic.

## Account deletion

`Profile` exposes a disclosure-gated panel. Deletion requires typing the email
**and** the password, then removes profiles, history, plays, taste, saved media,
shares, invitations, members, referral rows, and sessions, and finally the user.
The session is cleared client-side and the viewer is returned to `/`. The user is
told what is removed before it happens.
