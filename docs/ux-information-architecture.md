# LeNium Streaming Product UX Specification

## Executive direction

LeNium should operate as a **catalogue-first movie discovery application**. The interface should help a viewer move from opening the product to identifying a worthwhile title with minimal visual and cognitive friction.

The reference image is used only to study information architecture and interaction patterns. LeNium will not copy its branding, visual identity, content, artwork, layout details, or unauthorized streaming model. LeNium will retain its existing black, white, and refined grayscale brand palette.

The chosen direction is **Compact Catalog Shell**. It combines persistent application navigation, a collapsible desktop sidebar, a compact header, a reduced featured area, dense poster rows, and clear separation between metadata, trailers, watchlists, and authorized playback.

## Problems being corrected

The current product gives too much visual weight to one featured title. It uses large editorial typography and generous empty space before the catalogue becomes visible. This makes the product resemble a cinematic marketing site rather than a service used repeatedly for browsing.

The redesign reduces hero prominence, moves navigation and categories closer to the top of the viewport, increases poster density, and makes search available from every primary screen. Premium quality will come from consistent spacing, clear hierarchy, fast interactions, accessible contrast, and reliable content states rather than oversized type or ornamental layout.

## Information architecture

### Persistent application shell

The shell is present on authenticated and public catalogue routes. It provides a stable way to move between discovery contexts without returning to the homepage.

| Area | Desktop | Tablet | Mobile | Purpose |
|---|---|---|---|---|
| Sidebar | Expanded or collapsed | Collapsed by default | Replaced by bottom navigation and drawer | Primary catalogue navigation |
| Header | Brand, global search, profile | Brand, search, profile | Brand, search icon, menu | Global orientation and search |
| Main content | Dense rows and grids | Dense rows and grids | Swipeable rows and compact grids | Discovery and selection |
| Player state | Dedicated route or modal | Dedicated route or modal | Full-screen route or bottom sheet | Authorized playback only |

### Sidebar navigation

The expanded desktop sidebar is approximately **224–248 pixels wide**. It uses the existing dark surface and grayscale accent system. It should not visually dominate the catalogue.

| Navigation item | Route | Visibility | Behavior |
|---|---|---|---|
| Home | `/` | Public | Personalized or general discovery landing page |
| Movies | `/movies` | Public | Movie catalogue landing page |
| TV Shows | `/tv` | Public when TV records exist | TV catalogue landing page; do not show an empty fake section |
| New | `/recently-added` | Public | Recently ingested and approved records |
| Popular | `/popular` | Public | Provider-backed popularity ordering |
| Genres | `/genres` | Public | Genre directory with real counts only when counts exist |
| Collections | `/collections` | Public | Curated collections containing real records |
| My List | `/my-list` | Authenticated | Persisted watchlist; unauthenticated users see a sign-in explanation |

The sidebar includes no fabricated badges, watch counts, notification counts, or catalogue totals. If a destination has no records, the interface explains why and provides an appropriate next action.

### Compact header

The header is **56–64 pixels high** and remains sticky during catalogue browsing. It contains the LeNium mark, the current section label when useful, a search control, and the account control.

Search is always reachable. On desktop and tablet, the search field is visible in the header. On mobile, a search icon opens a full-width search surface with focus placed in the input. The search surface supports movies, actors, directors, and genres only when corresponding real records or provider results exist.

Notifications are not included in the first implementation. They should only be added when the product has a real notification event model, a persistence policy, and a clear user benefit.

## Homepage structure

The homepage is a discovery surface, not a marketing landing page.

```text
Persistent shell
├── Compact featured strip
├── Fast category chips
├── Trending Now
├── Popular on LeNium
├── Recently Added
├── Top Rated
├── Hidden Gems
├── Classic Cinema
├── Independent Films
└── Documentaries
```

### Featured strip

The featured area occupies approximately **280–390 pixels** depending on viewport height. It should occupy about **35–45% of the initial desktop viewport**, not most of the page.

It contains one real movie record at a time. The information hierarchy is:

1. Title.
2. Year, runtime, genres, and provider-backed rating where available.
3. A short synopsis from the metadata provider.
4. A details action.
5. A watch action only when an authorized playback source exists.
6. A list action only when watchlist persistence is available.

A trailer action is shown only when a verified `VideoAsset` exists. A trailer never implies that the movie itself is streamable.

### Category chips

Category chips appear immediately below the featured strip. They are horizontally scrollable on small screens. The initial set is derived from available real genres and should not display empty categories unless the product intentionally supports an empty-state directory.

Recommended initial chips are **All**, **Action**, **Adventure**, **Comedy**, **Crime**, **Drama**, **Family**, **Mystery**, **Romance**, **Science Fiction**, and **Thriller**. The API should return the available set rather than treating this list as a permanent hardcoded catalogue.

### Horizontal rows

Each row contains a title, optional description, a horizontal poster rail, and a restrained “View all” action. The rail should show approximately **6–8 cards on desktop**, **4–6 on tablet**, and **2–3 on mobile**.

Rows are populated from real provider or curated records. A row must be hidden, replaced with a useful empty state, or populated through a documented query when it has no records. The system must not duplicate cards merely to make the catalogue appear larger.

## Movie card specification

Posters are the primary visual object. Cards use a consistent **2:3 poster ratio**, a restrained radius, and a dark surface behind missing artwork. Cards should not use oversized title typography.

| Card element | Desktop | Tablet | Mobile |
|---|---|---|---|
| Poster width | 150–180px | 140–165px | 124–150px |
| Poster ratio | 2:3 | 2:3 | 2:3 |
| Visible metadata | Title, year, genre, score if available | Same | Title, year, score if available |
| Hover/focus action | Details, save, trailer if available | Focus-visible actions | Tap opens details |
| Motion | 150–220ms opacity/transform | Same | Minimal; respect reduced motion |

Ratings are displayed only when the source, scale, and provenance are known. Missing values use labels such as **Rating unavailable**, not invented numeric values. Watch counts, popularity claims, and review summaries are excluded unless backed by real data.

## Discovery architecture

The discovery experience is a dedicated route rather than a modal-only feature.

| Route | Main controls | Result shape |
|---|---|---|
| `/discover` | Genre, year, country, language, runtime, score, release date | Dense poster grid with result count only when real |
| `/search` | Query, result type, optional filters | Grouped results for movies, people, and genres |
| `/genres` | Genre directory | Real genre records and real movie links |
| `/collections` | Curated collection directory | Collection cards and real member titles |

Mood prompts such as **Something funny**, **Something scary**, **Something romantic**, **Something intense**, and **Under 90 minutes** are query shortcuts. They must resolve to documented filters or curated collections. A mood button must not pretend to use personalization when no behavioral model exists.

### Search behavior

Search should provide a focused input immediately, debounce requests, cancel stale requests, and show results without navigating through multiple empty intermediary screens. Results should distinguish exact title matches from people and genre matches.

Search URLs should be shareable but arbitrary search and filter combinations should remain `noindex` unless they meet the documented SEO threshold for unique, useful landing pages.

## Movie detail architecture

The movie detail page is allowed to be more cinematic than the homepage, but it remains task-oriented.

```text
Back link and breadcrumb
├── Backdrop and compact title block
├── Poster and core metadata
├── Synopsis and genres
├── Watch action when authorized playback exists
├── Trailer panel when verified VideoAsset exists
├── Add to My List when persistence exists
├── Cast and crew when real records exist
├── Similar movies from a documented query
└── Availability and rights status when known
```

The page must represent metadata, trailer, and stream as independent capabilities. It may state **Metadata available**, **Trailer available**, and **Playback unavailable** simultaneously. It must never turn a trailer into a watch button or infer rights from a metadata record.

## Responsive layout specification

### Desktop: 1280 pixels and wider

The shell uses a two-column layout. The sidebar is 224–248 pixels wide. The main content has a maximum width near 1480 pixels and uses 24–32 pixels of horizontal padding.

The featured strip spans the main content area and uses a restrained backdrop treatment. The first row begins within the initial viewport on typical laptop heights. Poster rails use horizontal overflow instead of shrinking cards below usable text and touch sizes.

On wide screens, the search field remains visible in the header. Hover actions may appear on cards, but every action must remain keyboard accessible through focus states.

### Tablet: 768–1279 pixels

The sidebar is collapsed into an icon rail or drawer. The header retains a visible search affordance. The main content uses 16–24 pixels of padding.

The featured strip is shorter than desktop. Rows show 4–6 posters. Filter controls may wrap to a second line, but the first screen must still expose categories and the beginning of the first content row.

### Mobile: 320–767 pixels

The sidebar becomes a drawer opened from the menu button. A compact bottom navigation may expose Home, Movies, Search, and My List. The header remains sticky and never consumes more than 56 pixels excluding the product announcement or status banner.

The featured strip is approximately 240–310 pixels tall. The synopsis is limited to a short excerpt. Category chips use horizontal scrolling. Rows show 2–3 posters, and poster cards use tap-first interaction rather than hover-only actions.

The mobile details surface may use a bottom sheet, but it must preserve an obvious close action, focus management, and a scrollable content region. Embedded trailers should not autoplay and must respect mobile data usage expectations.

## State and trust requirements

| State | Required interface behavior |
|---|---|
| Loading | Show stable skeletons that preserve row geometry |
| Empty catalogue | Explain the missing provider or records; do not show fixtures |
| Provider error | Preserve navigation and show retry guidance |
| Missing artwork | Show an explicit artwork-unavailable surface |
| Missing rating | Show “Rating unavailable” or omit the rating |
| Trailer unavailable | Omit the player and state that no verified trailer was found |
| Playback unavailable | Show a disabled or explanatory watch state; never simulate playback |
| Unauthorized My List | Explain sign-in and do not claim persistence |
| Deleted or expired record | Use redirect, 404, or 410 policy from the SEO specification |

## Implementation guardrails

The implementation must use the existing LeNium grayscale palette. It must not introduce copied branding or reference assets. It must not add unauthorized streaming sources, iframe players for unknown providers, fake counters, fake ratings, or hardcoded movie catalogue rows.

The first implementation should prioritize persistent navigation, real TMDB-backed movie rows, search, movie details, cached verified trailers, and truthful unavailable states. TV shows, personalization, notification systems, and richer collections should remain hidden until the corresponding real data and backend capabilities exist.

## Definition of done for the redesign

The redesign is ready for implementation when the following conditions are accepted:

1. The homepage exposes real catalogue rows before the fold ends.
2. Search is accessible from every primary viewport.
3. Sidebar, header, mobile drawer, and bottom navigation have clear route ownership.
4. Cards expose only data-backed metadata and actions.
5. Watch, trailer, and list capabilities are visually and technically independent.
6. Empty, loading, provider-error, and unavailable states are designed before feature coding.
7. Desktop, tablet, and mobile behavior follows the dimensions in this document.

## References

[1]: https://developer.themoviedb.org/docs/faq "TMDB API FAQ"
[2]: https://www.themoviedb.org/api-terms-of-use "TMDB API Terms of Use"
