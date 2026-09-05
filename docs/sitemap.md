# Lenflix Sitemap

## Public, indexable routes

| Route | Purpose | Indexing |
|---|---|---|
| `/` | Home discovery | Index |
| `/browse` | Stable catalogue browse | Index when canonical filters are absent or approved |
| `/genre/{slug}` | Genre landing page | Index |
| `/collection/{slug}` | Curated collection | Index when published |
| `/movie/{slug}-{year}` | Movie detail | Index when published and not removed |
| `/person/{slug}` | Person filmography | Index only with sufficient unique content |
| `/about` | Organization information | Index |
| `/help` | Public help | Index |

## Private or non-indexable routes

`/login`, `/signup`, `/account`, `/watchlist`, `/history`, `/settings`, `/admin`, `/creator`, `/api`, `/playback`, temporary signed URLs, arbitrary query combinations, and personalized recommendation states must be blocked from indexing. Search result URLs should use `noindex,follow` unless a controlled landing page exists.

## Technical SEO rules

Every indexable page receives one canonical URL, unique title and description, Open Graph metadata, appropriate schema.org JSON-LD, breadcrumbs, and links to related canonical pages. A removed title returns 410 when permanent. A moved title returns a 301 redirect. Filter and pagination rules must avoid duplicate content and crawl traps.

## Internal linking

Home links to curated collections, genres, and featured movies. Movie pages link to genres, people, collections, and similar titles. Collections link back to genre and movie pages. The sitemap is generated from published records and uses database `updatedAt` or content-specific `lastModified` values.

## XML endpoints

`/robots.txt` declares the sitemap and disallows private and temporary routes. `/sitemap.xml` is sufficient for the initial catalogue and can become a sitemap index when URL count requires sharding. An optional image sitemap may include poster and backdrop URLs that are stable, public, and rights-cleared.

## Sitemap diagram

```mermaid
flowchart TD
  H[/] --> B[/browse]
  H --> G[/genre/{slug}]
  H --> C[/collection/{slug}]
  H --> M[/movie/{slug}-{year}]
  M --> P[/person/{slug}]
  H --> A[/about]
  H --> Z[/help]
  H -. noindex .-> X[/account, /admin, /creator, /playback]
```
