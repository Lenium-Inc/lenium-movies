# Next.js VOD streaming core

The App Router streaming core is an incremental migration alongside the existing
Vite + Flask app. Run it with `npm run dev:next`; build and start it with
`npm run build:next` and `npm run start:next`. The existing scripts remain
unchanged until the rest of the application is migrated.

## Authorized catalog setup

Set `VOD_PROXY_SECRET` to at least 32 random characters. Set
`VOD_ALLOWED_ORIGINS` to a comma-separated list of exact HTTPS origins that
belong to your organization or media delivery provider. The proxy will not
follow redirects or make requests to other origins.

Set `VOD_CATALOG_JSON` to a JSON array maintained by your service. Each item
must identify the title, metadata, HLS master playlist, and an affirmative
rights verification:

```json
[
  {
    "titleId": "film-001",
    "title": "Example Film",
    "synopsis": "A film from the organization's authorized catalog.",
    "kind": "movie",
    "year": 2025,
    "rating": "PG",
    "genres": ["Drama"],
    "cast": ["Example Performer"],
    "posterUrl": "https://images.example.org/film-001-poster.jpg",
    "backdropUrl": "https://images.example.org/film-001-backdrop.jpg",
    "masterPlaylist": "https://media.example.org/hls/film-001/master.m3u8",
    "fallbackPlaylists": [
      "https://backup-media.example.org/hls/film-001/master.m3u8"
    ],
    "distribution": "owned_or_licensed",
    "rightsVerified": true,
    "downloads": {
      "720p": "https://media.example.org/files/film-001-720.mp4"
    }
  }
]
```

For series, use `"kind": "series"` and provide an `episodes` array. Each episode
has `season`, `episode`, `title`, an authorized `playlistUrl`, and optional
`downloads` keyed by `480p`, `720p`, or `1080p`.

Only titles marked as owned or licensed with `rightsVerified: true` are served.
Only explicitly listed progressive media files are downloadable. HLS segments
are streamed to the player but are not stitched into downloadable copies. The
proxy uses encrypted, expiring same-origin tokens and never accepts a URL from
the browser as a fetch target. Upstream `Referer` and `Origin` headers are not
forged to defeat source restrictions.

This initial migration slice does not replace login, profiles, billing, viewer
entitlements, or the legacy catalog. Before exposing private titles, add the
organization's authentication and entitlement check to both the resolve and
download routes; a source allowlist is not viewer authorization.
