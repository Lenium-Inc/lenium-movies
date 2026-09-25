"""
Catalog aggregation service.

Every catalog request re-fetches the LATEST titles live from the upstream
providers (TMDB first, plus an optional Trakt breadth list and OMDB
enrichment/fallback), normalizes each response into the unified MediaItem
contract, and returns it — so as the user scrolls, every new page pulls fresh
trending/popular/newly-released content from the source APIs. The SQLite
catalog is a pure write-through cache: whatever gets served is persisted so
subsequent requests are fast and the library grows, and it doubles as a
graceful fallback when every upstream call fails. There is deliberately no
nightly seeder — the catalog is always current, driven by real traffic.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

import tmdb_service as tmdb
from runtime_config import ssl_context
from catalog_store import CatalogStore
from media_normalizer import (
    normalize_omdb,
    normalize_tmdb,
    normalize_trakt,
    to_api,
)

TRAKT_CLIENT_ID = os.environ.get("TRAKT_CLIENT_ID", "").strip()
OMDB_API_KEY = os.environ.get("OMDB_API_KEY", "").strip()

# Frontend genre filter names -> TMDB genre ids (reverse of tmdb_service.GENRE_MAP).
TMDB_GENRE_IDS = {
    "action": 28, "adventure": 12, "animation": 16, "comedy": 35, "crime": 80,
    "documentary": 99, "drama": 18, "family": 10751, "fantasy": 14, "history": 36,
    "horror": 27, "music": 10402, "mystery": 9648, "romance": 10749,
    "sci-fi": 878, "thriller": 53, "war": 10752, "western": 37,
}

DEFAULT_PAGE_SIZE = 24


def _http_json(url: str, headers: dict | None = None) -> dict | list | None:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "FreeStream/1.0"})
    try:
        with urllib.request.urlopen(req, context=ssl_context(), timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - an upstream failure degrades to cache-only
        print(f"[Catalog Aggregator] {error}")
        return None


def _media_param(value) -> str:
    return value if value in ("movie", "tv", "all") else "all"


def _genre_param(value) -> str | None:
    value = (value or "").strip()
    if not value or value.lower() == "all":
        return None
    return value


# ---------------------------------------------------------------------------
# Live upstream fetches
# ---------------------------------------------------------------------------

def _fetch_tmdb_page(media_type: str, page: int, genre: str | None):
    """One live TMDB page: genre discover when filtered, popular otherwise."""
    genre_id = TMDB_GENRE_IDS.get((genre or "").lower())
    if genre_id:
        results = tmdb.get_discover(media_type, genre_id, page)
    else:
        results = tmdb.get_popular(media_type, page)
    items = [normalize_tmdb(item, media_type) for item in results]
    items = [i for i in items if i]
    return items, len(results) >= 20


def _fetch_trakt_lists(movies: bool = True, limit: int = 100) -> list[dict]:
    """Trending titles from Trakt when a client id is configured."""
    if not TRAKT_CLIENT_ID:
        return []
    headers = {
        "User-Agent": "FreeStream/1.0",
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID,
    }
    path = "movies/trending" if movies else "shows/trending"
    url = f"https://api.trakt.tv/{path}?limit={limit}&extended=full"
    data = _http_json(url, headers)
    if not isinstance(data, list):
        return []
    media_type = "movie" if movies else "tv"
    items = []
    for entry in data:
        record = entry.get("movie") or entry.get("show") or entry
        normalized = normalize_trakt(record, media_type)
        if normalized:
            items.append(normalized)
        if len(items) >= limit:
            break
    return items


def _merge_uniq(items: list[dict], limit: int) -> list[dict]:
    """Dedupe across sources by title+year, keep highest popularity, cap."""
    seen: set[tuple[str, int | None]] = set()
    out: list[dict] = []
    for item in sorted(items, key=lambda i: i.get("popularity") or 0, reverse=True):
        key = (str(item.get("title") or "").lower(), item.get("year"))
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _auth_store():
    import authdb

    return authdb.get_store()


def _snapshot_to_cache(items: list[dict]) -> None:
    """Best-effort per-title JSONB snapshots (catalog_cache) of live items."""
    try:
        store = _auth_store()
        for item in items:
            tmdb_id = item.get("tmdb_id")
            if not tmdb_id:
                continue
            store.upsert_catalog_cache(
                int(tmdb_id),
                item.get("media_type") or "movie",
                item,
            )
    except Exception as error:  # noqa: BLE001 - JSONB caching is best-effort
        print(f"[Catalog Aggregator] snapshot failed: {error}")


def _snapshot_in_background(items: list[dict]) -> None:
    if not items:
        return

    def _write(batch: list[dict]) -> None:
        _snapshot_to_cache(batch)

    threading.Thread(
        target=_write, args=(items,), daemon=True, name="catalog-snapshot"
    ).start()


def _jsonb_cache_page(media_type: str, per_page: int) -> list[dict]:
    """Newest JSONB snapshots as a fallback page (Postgres-native cache)."""
    try:
        items = _auth_store().recent_catalog_cache(media_type, per_page)
        return [to_api(item) for item in items if to_api(item)]
    except Exception as error:  # noqa: BLE001 - cache fallback is best-effort
        print(f"[Catalog Aggregator] jsonb fallback failed: {error}")
        return []


def _refresh_in_background(media_type: str, page: int, per_page: int, genre: str | None):
    """After serving a cached page, refresh the cache on a daemon thread so the
    NEXT request sees current titles."""

    def _refresh():
        try:
            store = CatalogStore()
            items, _ = _fetch_live(media_type, page, per_page, genre)
            if items:
                store.upsert_items(items)
                _snapshot_to_cache(items)
        except Exception as error:  # noqa: BLE001 - refresh is best-effort
            print(f"[Catalog Aggregator] background refresh failed: {error}")

    threading.Thread(
        target=_refresh, args=(), daemon=True, name="catalog-refresh"
    ).start()


def _fetch_live(media_type: str, page: int, per_page: int, genre: str | None):
    """Concurrently fetch a fresh page from TMDB (movie + tv for `all`) and,
    on the first page, optional Trakt trending for extra breadth."""
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="catalog-live") as pool:
        if media_type == "all":
            movie_future = pool.submit(_fetch_tmdb_page, "movie", page, genre)
            tv_future = pool.submit(_fetch_tmdb_page, "tv", page, genre)
            movie_items, movie_more = movie_future.result()
            tv_items, tv_more = tv_future.result()
            combined = movie_items + tv_items
            has_more = movie_more or tv_more
        else:
            items, has_more = _fetch_tmdb_page(media_type, page, genre)
            combined = items

        trakt_items: list[dict] = []
        if TRAKT_CLIENT_ID and page == 1:
            movies_future = pool.submit(_fetch_trakt_lists, True, 100)
            shows_future = pool.submit(_fetch_trakt_lists, False, 100)
            trakt_items = (movies_future.result() + shows_future.result()) if media_type == "all" else movies_future.result()

    combined += [_t for _t in trakt_items if _t]
    return _merge_uniq(combined, per_page), has_more


# ---------------------------------------------------------------------------
# Search (live-first with cache fallback)
# ---------------------------------------------------------------------------

def search_media(query: str, media_type: str = "all", page: int = 1,
                 per_page: int = DEFAULT_PAGE_SIZE) -> dict:
    """Live multi-API search; hits are saved to the catalog so the library
    permanently grows and later lookups are instant. Falls back to the
    database cache only when every upstream source fails."""
    store = CatalogStore()
    query = (query or "").strip()
    if not query:
        return {"items": [], "page": page, "per_page": per_page, "total": 0, "has_more": False, "source": "cache"}

    items: list[dict] = []
    mt = _media_param(media_type)
    for result in tmdb.search_multi(query, page):
        item_mt = result.get("media_type") or mt
        if mt != "all" and item_mt != mt:
            continue
        normalized = normalize_tmdb(result, item_mt)
        if normalized:
            items.append(normalized)

    # Exotic/indie titles TMDB missed -> OMDB fallback.
    if not items and OMDB_API_KEY:
        omdb_search = _omdb_get(f"s={urllib.parse.quote(query)}", media_type="movie")
        search_hits = (omdb_search or {}).get("Search")
        if isinstance(search_hits, list) and search_hits:
            omdb = _omdb_get(
                f"i={urllib.parse.quote(search_hits[0].get('imdbID', ''))}",
                media_type="movie",
            )
            if omdb:
                normalized = normalize_omdb(omdb, "movie")
                if normalized:
                    items.append(normalized)

    if not items:  # upstream down/rate-limited — serve whatever is cached
        cached = store.search(query, mt, per_page)
        return {
            "items": [to_api(row) for row in cached],
            "page": page,
            "per_page": per_page,
            "total": len(cached),
            "has_more": False,
            "source": "cache",
        }

    store.upsert_items(items)
    _snapshot_in_background(items)
    return {
        "items": [to_api(item) for item in items[:per_page]],
        "page": page,
        "per_page": per_page,
        "total": len(items),
        "has_more": False,
        "source": "live",
    }


def _omdb_get(query: str, media_type: str = "movie") -> dict | None:
    if not OMDB_API_KEY:
        return None
    url = "https://www.omdbapi.com/?apikey={}&type={}&{}".format(
        urllib.parse.quote(OMDB_API_KEY),
        urllib.parse.quote(media_type),
        query,
    )
    data = _http_json(url)
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------------------
# Discover (live-first, write-through, cache fallback)
# ---------------------------------------------------------------------------

def discover(media_type: str = "movie", page: int = 1, per_page: int = DEFAULT_PAGE_SIZE,
             genre: str | None = None) -> dict:
    """Live aggregated catalog page.

    Hits the providers fresh on every call (the latest trending/popular titles
    as the user scrolls), writes the batch to the catalog cache, and returns
    it. When the upstream is unreachable it serves the previously-cached page
    so browsing never breaks."""
    store = CatalogStore()
    mt = _media_param(media_type)
    genre = _genre_param(genre)
    page = max(int(page) if str(page).isdigit() else 1, 1)
    per_page = max(int(per_page) if str(per_page).isdigit() else DEFAULT_PAGE_SIZE, 1)

    live_items, has_more = _fetch_live(mt, page, per_page, genre)
    if live_items:
        store.upsert_items(live_items)  # write-through cache
        _snapshot_in_background(live_items)  # JSONB snapshot (background)
        return {
            "items": [to_api(item) for item in live_items[:per_page]],
            "page": page,
            "per_page": per_page,
            "total": store.count(mt, genre),
            "has_more": has_more,
            "source": "live",
        }

    rows = store.page(mt, genre, page, per_page) or []
    source = "cache"
    if not rows:
        rows = _jsonb_cache_page(mt, per_page)
        source = "jsonb"
    total = store.count(mt, genre)
    _refresh_in_background(mt, page, per_page, genre)
    return {
        "items": [to_api(row) for row in rows],
        "page": page,
        "per_page": per_page,
        "total": total,
        "has_more": page * per_page < total,
        "source": source,
    }


# ---------------------------------------------------------------------------
# Opportunistic cache growth from the existing live endpoints
# ---------------------------------------------------------------------------

def ingest_tmdb_results(results: list[dict], media_type: str | None = None) -> None:
    """Write-through: store whatever the live endpoints already fetched so the
    catalog cache grows between requests. Runs on a daemon thread."""
    items = []
    for item in results:
        mt = media_type or item.get("media_type") or "movie"
        normalized = normalize_tmdb(item, mt)
        if normalized:
            items.append(normalized)
    if items:
        _upsert_in_background(items)


def _upsert_in_background(items: list[dict]) -> None:
    def _write(batch: list[dict]) -> None:
        try:
            CatalogStore().upsert_items(batch)
        except Exception as error:  # noqa: BLE001 - caching is best-effort
            print(f"[Catalog Aggregator] background upsert failed: {error}")

    threading.Thread(
        target=_write, args=(items,), daemon=True, name="catalog-upsert"
    ).start()