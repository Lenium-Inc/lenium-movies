# FreeStream SEO Architecture

## Crawlable content

Public movie, genre, collection, person, and stable browse pages render their basic content on the server. Client JavaScript enhances interactions but is not required to discover the title, synopsis, canonical URL, and availability state.

## Metadata

Each indexable page receives a unique title, description, canonical URL, Open Graph image, Twitter/X card, language metadata, and structured data appropriate to the content. Movie pages may emit `Movie`, `BreadcrumbList`, and `Organization` JSON-LD only when the underlying fields are real and verified. Availability and offers must not be invented.

## Index controls

Private account, admin, creator, search state, filter combinations, temporary playback URLs, duplicate slugs, and thin pages use `noindex` or are disallowed. Pagination follows a consistent canonical strategy. Search and filter parameters do not create indexable pages unless a deliberately curated landing page exists.

## Sitemap and redirects

The sitemap is generated from published database records, uses last modification timestamps, and excludes removed or private records. Permanent removals return 410. Slug changes return a 301 from the previous canonical URL. Robots rules reference the sitemap and do not block important public assets or pages.

## Internal linking and quality

Home links to current collections and featured titles. Movie pages link to genres, people, related titles, and collections. Collection and genre pages link to canonical movie pages. Structured data validation, canonical checks, broken-link checks, and sitemap tests are release gates.

## Audit remediation: URL governance

| URL class         | Canonical policy                                             | Index policy                                             |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| Movie slug        | One lowercase, Unicode-normalized slug with year when needed | Index if published and rights/publication policy permits |
| Genre/collection  | One stable slug; only published pages                        | Index                                                    |
| Search query      | Canonical to `/search`; preserve query for UX only           | `noindex,follow`                                         |
| Facet combination | Canonical to approved landing page or self with noindex      | Noindex by default                                       |
| Sort/page cursor  | Canonical to base landing page                               | Noindex; never expose cursor URLs in sitemap             |
| Locale variant    | `hreflang` only for supported, materially translated pages   | Index each supported locale                              |
| Removed title     | Preserve a controlled redirect or 410 decision               | Exclude from sitemap                                     |

Structured data is emitted only from verified database fields. Do not output invented aggregate ratings, offers, review counts, availability, actor claims, or release dates. `Movie` markup is omitted when required fields are absent. Breadcrumbs reflect the canonical internal path. Organization and WebSite markup are site-level, not copied into every entity as a substitute for entity data.

Sitemap generation is a database job with a lastmod source, checksum, shard limit, and publication atomics. The generator validates canonical URLs, status, duplicate URLs, robots consistency, and response codes before replacing the previous sitemap. Robots rules allow public HTML and stable artwork, disallow private/API/playback paths, and never use a broad disallow that blocks CSS or images required for rendering.
