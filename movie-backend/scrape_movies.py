"""
Catalog scraper for the movie backend.

Discovers public-domain feature films on Archive.org and writes the
verified-playable ones to `movies.json`. Each entry is tagged with one or more
feed `topics` so the app can serve "featured" (curated), "recent"
(newest-added), and "popular" (most-downloaded) shelves entirely from
playable titles.

Every written entry carries a `media_type` ("movie" or "tv") so the client can
branch movie vs series UI. Archive.org is overwhelmingly a movie container, so
films default to `media_type: "movie"`; any entry that also carries a
season/episode manifest (`seasons`/`episodes`) is promoted to "tv" so the
output JSON is able to hold both media types.

Run (from this directory):
    python scrape_movies.py          # writes movies.json

The Flask app (`app.py`) serves whatever is in `movies.json`, and `POST
/api/movies/resolve` scrapes titles on demand for anything not yet in the
catalog.
"""

from __future__ import annotations

import json
import sys

import catalog_lib as lib

OUTPUT = "movies.json"
SEARCH_QUERY = (
    "(collection:feature_films OR collection:silent_films OR "
    "collection:animationandcartoons) AND mediatype:movies"
)
SEARCH_ROWS = 60

FEED_SOURCES = {
    "recent": lambda: lib.discover_recent(rows=30),
    "popular": lambda: lib.discover_popular(rows=30),
}


def _dedupe(entries: list[dict]) -> list[dict]:
    """Merge feed entries by identifier, unioning topic tags and keeping the
    richest metadata (downloads/addeddate when present)."""
    by_id: dict[str, dict] = {}
    for entry in entries:
        ident = entry["id"]
        existing = by_id.get(ident)
        if existing is None:
            by_id[ident] = dict(entry)
            continue
        for topic in entry.get("topics", []):
            if topic not in existing.get("topics", []):
                existing.setdefault("topics", []).append(topic)
        for key in ("_downloads", "_addeddate"):
            if entry.get(key) and not existing.get(key):
                existing[key] = entry[key]
    return list(by_id.values())


def _tag_featured(entries: list[dict], rotate: int = 12) -> list[dict]:
    """Deterministically tag a rotating 'featured' subset (daily-pick pool)
    from the combined playable catalog, so the rating shelf is always populated
    even if Archive exposes no curated collection."""
    stable = sorted(entries, key=lambda e: e["id"])
    pick = {stable[i % len(stable)]["id"] for i in range(rotate)}
    for entry in entries:
        if entry["id"] in pick:
            entry.setdefault("topics", []).append("featured")
    return entries


def _tag_media_types(entries: list[dict]) -> list[dict]:
    """Normalize `media_type` across the output catalog.

    Archive.org containers are movies by default; entries that also expose a
    season/episode manifest are promoted to "tv" so both media types are
    represented in `movies.json`. Any entry missing the field gets "movie".
    """
    for entry in entries:
        if entry.get("seasons") and entry.get("episodes_per_season") and (
            entry["seasons"] > 1 or entry["episodes_per_season"] > 1
        ):
            entry["media_type"] = "tv"
        else:
            entry.setdefault("media_type", "movie")
            entry.setdefault("seasons", 1)
            entry.setdefault("episodes_per_season", 1)
    return entries


def main() -> int:
    lib.log("Discovering the Archive.org feature-film catalog…")
    results = lib.bulk_build(SEARCH_QUERY, rows=SEARCH_ROWS)

    lib.log("Resolving feed shelves (recent / popular)…")
    for topic, fetcher in FEED_SOURCES.items():
        try:
            feed = fetcher()
        except Exception as error:  # noqa: BLE001 - one bad feed must not abort
            lib.log(f"feed {topic!r} failed: {error}")
            continue
        lib.log(f"- {topic}: {len(feed)} playable")
        results.extend(feed)

    results = _dedupe(results)
    results = _tag_media_types(results)
    results = _tag_featured(results)
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        json.dump(results, handle, ensure_ascii=False, indent=2)
    lib.log(f"Wrote {len(results)} playable movies to {OUTPUT}.")
    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(main())
