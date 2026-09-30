# Stream Vy UX and Information Architecture

This describes the interface as built. The previous version specified a
224–248px persistent sidebar, a 56–64px sticky header, a `/discover` route, a
`/genres` directory, a `/collections` directory, mood prompts, `VideoAsset`-backed
trailer panels, and pixel budgets for every breakpoint. **None of that is what
ships.** There is no sidebar, no separate browse route, and no mood prompt.

## Shape of the app

Discovery is a **single page with a view state**, not a route per destination.
`Navbar` sets a `View` value (`home`, `movies`, `tv`, `trending`, plus internal
`new`, `popular`, `genres`, `collections`) and `Home` renders accordingly. The
public navigation exposes four: **Home, Explore, Trending, Shows.** My List is a
real route at `/my-list`.

The one true exception: `/hero`, a scratch design page with fifteen hardcoded
fake titles, invented genre taxonomies, and a raw `alert()` as its details view,
served on a public route with no auth guard. It looked like the product and was
not, so it was removed rather than hidden.

## Home

```text
Navbar (brand, search, view links, account)
├── hero backdrop wash (80vh, blurred, from the featured record only)
├── Spotlight          -> owns the page h1 (the featured title)
├── Discover section   -> h2, filter panel + InfiniteMovieGrid
├── poster rows        -> MovieRow per shelf
├── TMDB attribution
└── allowance + hosting disclosure
```

The `h1`/heading discipline is deliberate. The Spotlight owns the page `h1` on
the home view; the Discover and row sections use `h2`. A duplicate `h1` on the
same page was a real defect and was fixed rather than left because two headings
looked similar.

## Navigation

`Navbar` carries the brand mark, a search field (`NavbarSearch`), the four view
links, a My List link, and the account control (`ProfileMenu`). A menu button
handles narrow viewports. Search is reachable from every view; a search pushed
back from the navbar is applied to the shared catalogue state rather than opening
a separate results route.

## Catalogue filters

`DiscoverDropdown` owns **genre, media type, and sort order** as one panel with a
draft state and an explicit Apply, and it forwards all three to `useCatalog`.

This panel used to own `selectedSort` and `selectedType` as local state while its
Apply handler only ever forwarded `genre` — so choosing "Top Rated" or "Shows"
did nothing at all. Every option now does what its label says, applied to both
the shelf views and the paged browse grid. A label that does nothing is worse
than a missing control.

## Cards

`MediaCard` / `MovieCard` render a 2:3 poster with title, year, and score when
the source provides one. Ratings are shown only when provenance and scale are
known; a missing value is omitted rather than replaced with a number. There are no
watch counts, review summaries, or popularity claims anywhere in the UI.

`SkeletonMovieCard` preserves row geometry during load. `CatalogEmptyState`
explains an empty or failed catalogue instead of padding it with fixtures.

## Watch

`/watch/:id` is the only playback surface. Resolution order:

1. A direct source renders `VideoPlayer` with quality variants and subtitle
   tracks, streamed through the server relay so seeking and range requests work.
2. If the chain settles on an embed provider, `EmbedPlayer` renders it and the
   page states that it is a third-party embed rather than native playback.
3. `AllowanceMeter` and `DailyLimitNotice` show the real server allowance and what
   happens when it is spent.

`useEmbedFailure` drives client-side failover when a source dies mid-playback.
`WatchTVControls` and `EpisodeMatrix` cover series.

## Accounts and household

| Route        | Component        | Notes                                                     |
| ------------ | ---------------- | --------------------------------------------------------- |
| `/login`     | `AuthPage`       | Shared component, `mode` prop                             |
| `/signup`    | `AuthPage`       | Same                                                       |
| `/profiles`  | `ProfilesPage`   | Create, order, avatar, PIN                                |
| `/profile`   | `Profile`        | Account, allowance, referral, ratings, **account deletion** |
| `/my-list`   | `MyList`         | Server-backed list                                         |

`ShareListDialog` mints and manages invite tokens. `AddProfileForm`,
`AvatarPicker`, and `EditProfileModal` own profile editing. The account-deletion
panel is disclosure-gated: it states exactly what is removed, and requires the
email **and** the password.

## Legal surfaces

`/terms`, `/privacy`, and `/dmca` render through `LegalLayout`, linked from the
footer. `Privacy.tsx` states that there are no analytics, lists the actual
`localStorage` keys, and explains that external playback providers set their own
cookies. `Terms.tsx` and `Dmca.tsx` disclose the Archive.org relay, the embed
tier, downloads, and stored viewing data.

## State requirements

| State                | Behavior                                                            |
| -------------------- | ------------------------------------------------------------------- |
| Loading              | `SkeletonMovieCard`; `TopProgressBar` while any request is in flight  |
| Empty catalogue      | `CatalogEmptyState` explains it; no fixtures                         |
| Provider error       | Navigation preserved, retry offered, no fake data                    |
| Missing artwork      | Explicit artwork-unavailable surface                                 |
| Missing rating       | Omitted                                                              |
| Trailer unavailable  | No player; states that no trailer was found                          |
| Playback unavailable | Explained, never simulated                                          |
| Allowance spent      | `DailyLimitNotice`, from the real server allowance                   |
| Unauthorized list    | Explains sign-in; does not claim persistence                          |
| Unknown route        | `NotFound`                                                           |

## Guardrails

Keep the grayscale palette. Do not introduce copied branding or reference
assets. Do not add unauthorized stream sources, unknown-provider iframes, fake
counters, fake ratings, or hardcoded catalogue rows. Do not ship a control whose
label does not match its behavior.

## Gaps

- No dedicated browse, genre, or collection route: they are view states inside
  `/`, so none of them is independently linkable or shareable.
- `genres` and `collections` views render an explicit explanation that real
  records have not been imported, rather than an empty grid.
- No route-level code splitting; the build emits one large chunk.
- The 2:3 poster rails use horizontal overflow rather than shrinking cards below
  a usable touch target on mobile.
