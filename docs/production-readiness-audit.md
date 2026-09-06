# FreeStream Production-Readiness Audit

## Audit scope

This audit inspected the actual source tree, not screenshots. Evidence was traced through `client/src/pages/Home.tsx`, `client/src/App.tsx`, `client/src/_core/hooks/useAuth.ts`, `server/routers.ts`, `server/db.ts`, `drizzle/schema.ts`, `server/*.test.ts`, and the current project routes. The result is an audit of the present checkpoint, before the remediation changes listed later in this document.

## Executive verdict

FreeStream is a polished **visual prototype**, not a production movie platform. The only substantive production-backed feature is the framework-provided Manus authentication/session plumbing. The catalogue, search, movie details, save/list behavior, playback, history, rights, administration, ingestion, SEO, and ad/tracker protection are either fixture-driven, local-only, or absent. The project must not be marketed as a real streaming service until the blocked provider, rights, database, and infrastructure decisions are implemented.

## Classification summary

| Area | Classification | Evidence |
|---|---|---|
| Authentication | PARTIALLY REAL | `useAuth` calls `trpc.auth.me`; `server/routers.ts` exposes `auth.me` and `auth.logout`; Manus OAuth/session infrastructure exists. No product account/profile/session-management features exist. |
| Home/discovery shell | MOCKED | `Home.tsx` renders a hardcoded eight-item `movies` array and static editorial copy. |
| Search | PARTIALLY REAL | `useMemo` filters the fixture array with `matchesMovieSearch`; no search API, database query, index, pagination, provider, loading state, or server persistence. |
| Browse/category filters | PARTIALLY REAL | Category chips filter local fixture state only; no `/movies`, genre, year, country, language, browse API, or canonical route. |
| Movie data acquisition | MOCKED | No metadata provider adapter, credentials, ingestion job, provider ID, provenance, normalization, or movie tables exist. |
| Movie details | MOCKED | Details are a client modal over fixture objects; no movie route, database lookup, cast/crew records, availability lookup, or error boundary for provider data. |
| Watchlist | MOCKED | `savedIds` is React state initialized to `[4, 7]`; no watchlist table, API, auth guard, or persistence. |
| History/continue watching | MOCKED | Static “Soft Focus”, “32 min left”, and “Episode 01” values are rendered; no history/progress tables or procedures exist. |
| Playback | MOCKED | “Start watching” only calls `toast.success("Playback is ready for authorized titles")`; no player, source, rights check, session, signed access, captions, or telemetry. |
| Rights management | UNIMPLEMENTED | No rights tables, policy service, procedures, UI, evidence workflow, or tests exist. |
| Admin | UNIMPLEMENTED | Framework has `adminProcedure`, but no FreeStream admin routes, pages, entities, or mutations exist. |
| Ingestion | UNIMPLEMENTED | No provider adapter, queue, background worker, idempotency, retries, rate limiting, or ingestion procedures exist. |
| Search index | UNIMPLEMENTED | No search service, index state, indexing worker, reconciliation, or search router exists. |
| SEO/server rendering | UNIMPLEMENTED | `App.tsx` is a client-side Wouter shell; no server-rendered movie pages, dynamic metadata, canonical tags, Open Graph, Twitter metadata, or JSON-LD. |
| Sitemap | UNIMPLEMENTED | No sitemap route, generator, database-backed URL selection, or sitemap tests. |
| robots.txt | UNIMPLEMENTED | No dynamic or static robots policy exists. |
| Structured data | UNIMPLEMENTED | No JSON-LD or schema generation exists. |
| Ad/tracker protection | UNIMPLEMENTED | `AdBlockRule` exists only in documentation; no schema, evaluator, allowlist, admin UI, telemetry, or tests. |
| Security | PARTIALLY REAL | OAuth/session cookie helpers and `protectedProcedure`/`adminProcedure` exist in framework. Product authorization, rights enforcement, upload safety, provider webhook handling, rate limiting, CSP policy, and audit events are absent. |
| Performance | PARTIALLY REAL | Homepage was measured and image loading/bundle optimizations were applied. It remains a client fixture page with a large JS chunk; no real API/database/player performance exists. |
| Mobile UX | PARTIALLY REAL | Responsive homepage and mobile navigation exist and were screenshot-verified. Product mobile routes, player controls, account flows, and low-bandwidth states do not exist. |
| Accessibility | PARTIALLY REAL | Semantic headings, labels, buttons, and dialog roles exist. Focus management, keyboard-complete navigation, real player accessibility, captions, and automated a11y tests are absent. |
| Analytics | MOCKED/EXTERNAL TEMPLATE | `client/index.html` includes a template Umami script with environment placeholders; no product event taxonomy, consent, server events, or verified analytics configuration. |
| Tests | PARTIALLY REAL | Auth logout and pure local search-helper tests pass. There are no tests for catalogue, APIs, database, rights, playback, SEO, sitemap, robots, security, upload, or accessibility. |

## Feature-by-feature trace

### Authentication

**Classification: PARTIALLY REAL.** The frontend calls `trpc.auth.me.useQuery` and `trpc.auth.logout.useMutation` from `useAuth.ts`. The backend exposes `auth.me` and `auth.logout`, and the framework context/session cookie implementation exists. The logout test covers cookie clearing. However, there is no product account page, preferences, sessions, privacy, export/delete flow, creator identity, partner identity, or role-managed product surface. `useAuth` also writes serialized user data to `localStorage`, which is unnecessary persistence of identity data and should be removed.

### Search

**Classification: PARTIALLY REAL.** The input is controlled state. `Home.tsx` calls `matchesMovieSearch` against the constant `movies` array and matches title, genre, and director. There is no backend API, PostgreSQL query, search engine, debounce policy, query URL, loading state, provider error state, pagination, facets, suggestions, or empty catalogue state. Search is therefore a demo interaction, not production search.

### Movie data and details

**Classification: MOCKED.** Eight movies are hardcoded in `Home.tsx`, with invented titles, directors, scores, ratings, runtime, synopsis, and Unsplash image URLs. The database contains only `users`. There are no Movie, Genre, Person, Credit, MediaAsset, Provider, or provenance tables. The detail modal reads the selected client object and displays static “Audio”, “Subtitles”, and “Availability” claims. Those claims are misleading in production and have no supporting source.

### Watchlist

**Classification: MOCKED.** `savedIds` is initialized in memory and toggled locally. It resets on refresh, has no `watchlist` table, no authenticated API, no authorization check, no loading/error state, and only a local empty state. The UI visually suggests a real list but there is no persistence.

### History and progress

**Classification: MOCKED.** The homepage hardcodes “Soft Focus”, “32 min left”, and “Episode 01”. No history/progress schema, API, player heartbeat, resume write, retention policy, or authorization exists. The “See history” section heading is not a navigable route.

### Playback

**Classification: MOCKED and misleading.** The hero “Play trailer” opens the same movie detail modal. The modal “Start watching” button only displays a success toast: “Playback is ready for authorized titles.” There is no `PlaybackProvider`, `RightsGrant`, `PlaybackSource`, authorization check, session, signed URL, HLS/DASH player, captions, audio tracks, quality selection, resume, telemetry, or playback error handling. This violates the product’s own non-goal against fake play buttons.

### Rights, admin, and ingestion

**Classification: UNIMPLEMENTED.** `server/routers.ts` contains only system and auth routes. `schema.ts` contains only `users`. Although framework `adminProcedure` exists, no FreeStream admin operation calls it. No provider credentials, legal evidence, rights state, submission workflow, ingestion job, retry queue, rate limiter, or search reconciliation exists.

### SEO

**Classification: UNIMPLEMENTED.** The only route is `/` plus `/404` and a fallback NotFound route in client-side Wouter. There are no public movie/genre/person/collection routes, SSR output, dynamic title/description, canonical URL, Open Graph, Twitter tags, JSON-LD, sitemap, robots.txt, redirects, 404/410 policy, or database-backed indexable records. The existing fixture home content must not be treated as production indexable catalogue content.

### Ad/tracker protection

**Classification: UNIMPLEMENTED.** The requested `AdBlockRule` is only a documentation concept. There is no rule table, version evaluator, allowlist, safe fallback, admin workflow, blocked-resource telemetry, or tests. The template analytics script is not the requested first-party protection engine.

### Security and privacy

**Classification: PARTIALLY REAL.** Session cookies and server-side auth helpers are present. The product lacks resource-level authorization for all movie/account/admin domains because those domains do not exist. There are no upload routes, webhook verification, rate limits, rights policy, audit log, consent manager, privacy controls, or CSP configuration verified in the product code. `useAuth.ts` persists user info in localStorage, increasing client-side exposure without a feature need.

### Performance, mobile, and accessibility

**Classification: PARTIALLY REAL.** The homepage is responsive, uses lazy image loading, and has a measured performance report. It still loads a client-side fixture catalogue, has a large production JS chunk, and does not prove performance of real search, database queries, movie pages, or playback. Mobile screenshots show the homepage works at 375px, but no mobile player/account flows exist. Accessibility has useful labels and headings, but no automated audit, robust focus restoration for the custom modal, captions/player semantics, or full keyboard test.

## Issues that can be fixed without external credentials or business decisions

1. Remove the fake success semantics from “Play trailer” and “Start watching”. Replace them with an explicit “Playback unavailable” state until a real provider is configured.
2. Label the fixture catalogue as a non-production preview and remove unsupported claims such as “Streaming now”, fabricated rating/availability values, and fake continue-watching progress.
3. Remove unnecessary user-info persistence from `useAuth.ts`.
4. Add regression tests for the honest playback-unavailable state and fixture-labeling behavior.
5. Keep the existing performance optimizations and document the remaining unimplemented surfaces rather than implying they are complete.

## External blockers and exact remaining actions

| Blocker | Exact action |
|---|---|
| Metadata provider | Select a licensed provider, obtain production API credentials, confirm commercial terms, attribution, caching, image rights, rate limits, and provider IDs; implement adapter and ingestion jobs. |
| Artwork | Obtain a provider-approved image usage path or first-party licensed artwork storage; do not use fixture Unsplash art as catalogue artwork without confirming rights and attribution. |
| Authorized video | Select a managed video/DRM provider, configure account/signing/webhook secrets, define HLS/DASH/caption/audio capabilities, and pass signed-access/revocation tests. |
| Rights | Obtain contracts/evidence, territories, dates, platform restrictions, takedown contact, and legal approval; implement RightsGrant and policy evaluation. |
| Database/infrastructure | Provision production PostgreSQL, migrations, backups, object storage, CDN, queue workers, search, monitoring, and restore drills. |
| SEO/domain | Configure the canonical production domain, SSR runtime, sitemap/robots delivery, Search Console/Bing Webmaster verification, and redirect policy. |
| Privacy/analytics | Approve consent/lawful-basis policy, event taxonomy, retention, deletion/export behavior, and analytics processor configuration. |

## Required production gate

Do not claim production readiness until every item classified MOCKED or UNIMPLEMENTED has either become REAL/PARTIALLY REAL with evidence or is explicitly removed from the release scope. In particular, disable or relabel fixture playback and catalogue claims immediately.

## Safe remediation applied after the audit

The following issues were fixed without external credentials or business decisions:

- Replaced the misleading “Play trailer” CTA with “View preview details”.
- Replaced the fake “Playback is ready” success toast with a shared `provider_not_configured` state and an honest “Playback unavailable” message.
- Removed “Streaming now”, fake audio/subtitle availability, and unsupported watch-progress claims from the detail and home surfaces.
- Added a visible preview banner stating that the catalogue is fixture data with no real ratings, rights, or playback.
- Relabeled local save behavior as “Save in preview” and the detail badge as “Preview fixture”. It remains intentionally non-persistent until the watchlist API exists.
- Replaced hardcoded “32 min left / Episode 01” history content with an explicit unavailable state.
- Removed unnecessary `localStorage` persistence of authenticated user information from `useAuth.ts`.
- Added `server/playback.test.ts`; the complete test suite now passes 4 tests across 3 files.

## Post-fix verification

`pnpm test`, `pnpm check`, and `pnpm build` pass. The preview status reports running with no current TypeScript errors. Browser verification shows the preview banner, “View preview details”, “Save in preview”, unavailable history state, and no fake playback-success wording. The remaining MOCKED and UNIMPLEMENTED classifications in this report are intentional and still block production claims.
