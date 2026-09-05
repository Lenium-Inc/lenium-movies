# Lenflix SEO Architecture

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
