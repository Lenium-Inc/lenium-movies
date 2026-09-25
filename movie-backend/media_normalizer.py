"""
Media normalizer — maps every upstream provider's JSON into one unified shape.

Every source (TMDB, OMDB, Trakt) produces a differently-shaped record. This
module normalizes each into a single `MediaItem` contract that `CatalogStore`
persists and the `/api/catalog/discover` endpoint serves:

    provider_id  unique namespaced id (tmdb-123 / omdb-tt1234567 / trakt-slug)
    title, media_type (movie|tv), year, poster_url, backdrop_url, overview,
    vote_average, popularity, genres[], runtime, director, cast[],
    country, language, release_date, imdb_id, tmdb_id, source, genres_key

`genres_key` is a lowercase comma-wrapped key (",sci-fi,thriller,") that lets
the SQLite store filter by genre portably (no JSON1 dependency).
"""

from __future__ import annotations

import json
import re

from tmdb_service import GENRE_MAP, get_genre_names, TMDB_IMAGE_BASE

# Frontend genre filters use "Sci-fi"; TMDB spells it "Sci-Fi".
_GENRE_ALIASES = {
    "sci-fi": "Sci-fi",
    "science fiction": "Sci-fi",
    "tv-movie": "TV Movie",
}


def canonical_genre(name: str) -> str:
    """Canonicalize a genre name so filters match across providers."""
    key = name.strip().lower()
    if key in _GENRE_ALIASES:
        return _GENRE_ALIASES[key]
    return name.strip()


def _genres_key(genres: list[str]) -> str:
    if not genres:
        return ""
    return "," + ",".join(g.lower() for g in genres if g) + ","


def _year_from(date_value) -> int | None:
    if not date_value:
        return None
    match = re.search(r"(19\d{2}|20\d{2})", str(date_value))
    return int(match.group(1)) if match else None


def _count(text: str | None) -> int | None:
    match = re.search(r"(\d+)", text or "")
    return int(match.group(1)) if match else None


# ---------------------------------------------------------------------------
# TMDB
# ---------------------------------------------------------------------------

def normalize_tmdb(item: dict, media_type: str = "movie") -> dict | None:
    """Normalize a TMDB list/search entry (raw or pre-shaped) to a MediaItem."""
    tmdb_id = item.get("id")
    if not tmdb_id:
        return None
    title = item.get("title") or item.get("name")
    if not title:
        return None

    genre_ids = item.get("genre_ids") or []
    genres = [canonical_genre(name) for name in get_genre_names(genre_ids)]
    listed = item.get("genres")
    if isinstance(listed, list):
        genres = [g.get("name") for g in listed if g.get("name")]
        genres = [canonical_genre(g) for g in genres if g]

    poster_path = item.get("poster_path")
    backdrop_path = item.get("backdrop_path")
    release_date = item.get("release_date") or item.get("first_air_date") or ""
    tv = media_type == "tv"

    return {
        "provider_id": f"tmdb-{tmdb_id}",
        "title": title,
        "media_type": "tv" if tv else "movie",
        "year": _year_from(release_date),
        "poster_url": f"{TMDB_IMAGE_BASE}/w500{poster_path}" if poster_path else "",
        "backdrop_url": f"{TMDB_IMAGE_BASE}/w1280{backdrop_path}" if backdrop_path else "",
        "overview": item.get("overview") or "",
        "vote_average": float(item["vote_average"]) if item.get("vote_average") is not None else None,
        "popularity": float(item["popularity"]) if item.get("popularity") is not None else None,
        "genres": genres,
        "genres_key": _genres_key(genres),
        "runtime": None,
        "director": None,
        "cast": [],
        "country": None,
        "language": None,
        "release_date": release_date or None,
        "imdb_id": item.get("imdb_id"),
        "tmdb_id": str(tmdb_id),
        "source": "tmdb",
    }


def enrich_tmdb_details(details: dict, item: dict) -> dict:
    """Merge a rich TMDB details/credits payload into an already-normalized item
    (used opportunistically when detail endpoints are queried)."""
    if not details:
        return item
    if not item.get("overview") and details.get("overview"):
        item["overview"] = details["overview"]
    if item.get("runtime") is None and details.get("runtime"):
        item["runtime"] = int(details["runtime"])
    if not item.get("imdb_id") and details.get("external_ids", {}).get("imdb_id"):
        item["imdb_id"] = details["external_ids"]["imdb_id"]
        if not item["provider_id"].startswith("tmdb-"):
            item["provider_id"] = f"tmdb-{item.get('tmdb_id')}"
    genres = details.get("genres")
    if isinstance(genres, list):
        item["genres"] = [canonical_genre(g["name"]) for g in genres if g.get("name")]
        item["genres_key"] = _genres_key(item["genres"])
    credits = details.get("credits", {})
    if credits:
        director = next(
            (p.get("name") for p in credits.get("crew", [])
             if p.get("job") == "Director" and p.get("name")),
            None,
        )
        if director and item.get("director") is None:
            item["director"] = director
        if not item.get("cast"):
            item["cast"] = [p["name"] for p in credits.get("cast", [])[:10] if p.get("name")]
    return item


# ---------------------------------------------------------------------------
# OMDB (enrichment + exotic-title fallback when a key is configured)
# ---------------------------------------------------------------------------

def normalize_omdb(data: dict, media_type: str = "movie") -> dict | None:
    """Normalize an OMDB record to a MediaItem (movies only; optional source)."""
    imdb_id = data.get("imdbID") or data.get("imdb_id")
    title = data.get("Title") or data.get("title")
    if not imdb_id or not title:
        return None

    genres = [
        canonical_genre(g.strip())
        for g in re.split(r",\s*", (data.get("Genre") or ""))
        if g.strip()
    ]
    rating = None
    try:
        rating = float(data.get("imdbRating"))
    except (TypeError, ValueError):
        rating = None
    poster = data.get("Poster") or data.get("poster") or ""
    if poster and not poster.startswith("http"):
        poster = ""
    release_date = (data.get("Released") or "").split("GMT")[0].strip()
    if len(release_date) > 10:
        release_date = release_date[:10] if release_date[:4].isdigit() else ""

    return {
        "provider_id": f"omdb-{imdb_id}",
        "title": title,
        "media_type": media_type,
        "year": _year_from(data.get("Year") or data.get("year")),
        "poster_url": poster,
        "backdrop_url": "",
        "overview": data.get("Plot") or data.get("overview") or "",
        "vote_average": rating,
        "popularity": None,
        "genres": genres,
        "genres_key": _genres_key(genres),
        "runtime": _count(str(data.get("Runtime") or "")),
        "director": data.get("Director") or data.get("director") or None,
        "cast": [
            c.strip() for c in re.split(r",\s*", (data.get("Actors") or data.get("cast") or ""))
            if c.strip()
        ],
        "country": data.get("Country") or data.get("country") or None,
        "language": data.get("Language") or data.get("language") or None,
        "release_date": release_date or None,
        "imdb_id": imdb_id,
        "tmdb_id": None,
        "source": "omdb",
    }


# ---------------------------------------------------------------------------
# Trakt (optional breadth source when TRAKT_CLIENT_ID is configured)
# ---------------------------------------------------------------------------

def normalize_trakt(item: dict, media_type: str = "movie") -> dict | None:
    """Normalize a Trakt list entry to a MediaItem.

    Trakt list endpoints don't ship poster paths, but they do carry the TMDB id
    for nearly every title — that keeps the entry playable through our TMDB-id
    resolution (posters resolve live at playback).
    """
    title = item.get("title") or item.get("name")
    if not title:
        return None
    ids = item.get("ids") or {}
    tmdb_id = ids.get("tmdb")
    if not tmdb_id:
        return None
    year = item.get("year")
    rating = None
    try:
        rating = float(item["rating"]) if item.get("rating") is not None else None
    except (TypeError, ValueError):
        rating = None

    return {
        "provider_id": f"trakt-{ids.get('slug') or ids.get('trakt')}",
        "title": title,
        "media_type": media_type,
        "year": int(year) if isinstance(year, int) else _year_from(year),
        "poster_url": "",
        "backdrop_url": "",
        "overview": item.get("overview") or "",
        "vote_average": rating,
        "popularity": item.get("votes") or None,
        "genres": item.get("genres") or [],
        "genres_key": _genres_key(item.get("genres") or []),
        "runtime": item.get("runtime"),
        "director": None,
        "cast": item.get("cast") or [],
        "country": item.get("country") or None,
        "language": item.get("language") or None,
        "release_date": item.get("first_aired") or None,
        "imdb_id": ids.get("imdb"),
        "tmdb_id": str(tmdb_id),
        "source": "trakt",
    }


def normalize_item(item: dict) -> dict | None:
    """Dispatch by `source` for records already shaped like a MediaItem."""
    source = item.get("source")
    if source in ("tmdb", "omdb", "trakt"):
        return item
    return None


# ---------------------------------------------------------------------------
# API payload
# ---------------------------------------------------------------------------

def _as_list(value, fallback=None):
    """Accept either a JSON-encoded array string or an already-parsed list."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else (fallback or [])
        except (TypeError, ValueError):
            return fallback or []
    return fallback or []


def to_api(row: dict) -> dict:
    """Render a stored row as the slim card JSON the frontend consumes."""
    genres = _as_list(row.get("genres"))
    cast = _as_list(row.get("cast"))
    tmdb_id = row.get("tmdb_id")
    imdb_id = row.get("imdb_id") or ""
    return {
        "id": row.get("provider_id"),
        "tmdb_id": tmdb_id,
        "imdb_id": imdb_id,
        "title": row.get("title"),
        "media_type": row.get("media_type") or "movie",
        "year": row.get("year"),
        "poster_url": row.get("poster_url") or "",
        "backdrop_url": row.get("backdrop_url") or "",
        "overview": row.get("overview") or "",
        "vote_average": row.get("vote_average"),
        "popularity": row.get("popularity"),
        "genres": genres,
        "runtime": row.get("runtime"),
        "director": row.get("director"),
        "cast": cast,
        "country": row.get("country"),
        "language": row.get("language"),
        "release_date": row.get("release_date"),
        "source": row.get("source") or "tmdb",
    }