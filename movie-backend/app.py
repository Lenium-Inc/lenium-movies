"""
FreeStream Backend - TMDB-First Metadata & Streaming API

Serves live TMDB search (GET /api/search), trending/popular/now_playing/on_the_air feeds,
playback resolution (POST /api/movies/resolve), direct stream sources (GET /api/get-stream),
trailer lookup (GET /api/movies/trailer), and episode details (GET /api/episodes).

All metadata comes exclusively from TMDB's official API. No static archives or fallbacks.

Run:
    pip install -r requirements.txt
    python app.py                  # listens on http://localhost:5000
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from flask import Flask, Response, jsonify, request

# Imported first so the dotenv file is loaded before any module reads a secret.
from runtime_config import load_env_file, ssl_context, tmdb_api_key

load_env_file()

import authdb
import catalog_lib
import catalog_service
import tmdb_service as tmdb

HERE = os.path.dirname(os.path.abspath(__file__))

TMDB_BASE_URL = "https://api.themoviedb.org/3"

app = Flask(__name__)

# Direct-playable (non-embed) catalog from Archive.org. Titles here resolve to
# real MP4 streams the HTML5 player can start instantly; everything else falls
# back to a third-party embed URL (which the player surfaces explicitly).
def _load_direct_catalog() -> list[dict]:
    try:
        with open(os.path.join(HERE, "movies.json"), "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, list) else []
    except Exception as error:  # noqa: BLE001 - missing/unreadable catalog degrades to empty
        print(f"[Catalog] could not load movies.json: {error}")
        return []

_DIRECT_CATALOG = _load_direct_catalog()
_direct_source_cache: dict[str, dict | None] = {}


def _find_catalog_entry(title: str, year) -> dict | None:
    """Best local (movies.json) match for the requested title/year."""
    requested_year = None
    try:
        requested_year = int(year) if year else None
    except (TypeError, ValueError):
        requested_year = None
    best: tuple[float, dict] | None = None
    for entry in _DIRECT_CATALOG:
        score = catalog_lib.match_title(title, entry.get("title", ""))
        if score < 0.7:
            continue
        if not catalog_lib.accept_candidate(requested_year, entry.get("year")):
            continue
        if best is None or score > best[0]:
            best = (score, entry)
    return best[1] if best else None


def _direct_source_for(title: str, year=None, refresh: bool = False) -> dict | None:
    """Prefer a direct, playable Archive.org source for a title; fall back to a
    live on-demand scrape when the local catalog has no confident match. Pass
    `refresh=True` to bypass the cache and scrape again (the frontend uses this
    while its stream-fallback loop is looking for a playable source)."""
    if not title:
        return None
    key = catalog_lib.normalize_title(title) or title.lower().strip()
    if refresh:
        _direct_source_cache.pop(key, None)
    if key in _direct_source_cache:
        return _direct_source_cache[key]
    entry = _find_catalog_entry(title, year)
    if entry is None:
        try:
            entry = catalog_lib.scrape_title(title, requested_year=year)
        except Exception as error:  # noqa: BLE001
            print(f"[Catalog] on-demand scrape failed for {title!r}: {error}")
            entry = None
    _direct_source_cache[key] = entry
    return entry


def _tmdb_get(path: str, params: dict) -> dict | None:
    """TMDB client wrapper for search & metadata lookup."""
    api_key = tmdb_api_key()
    if not api_key:
        return None
    try:
        url = f"{TMDB_BASE_URL}{path}?" + urllib.parse.urlencode(
            {"api_key": api_key, "language": "en-US", **params}
        )

        req = urllib.request.Request(url, headers={"User-Agent": "FreeStream/1.0"})
        with urllib.request.urlopen(req, context=ssl_context(), timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as e:
        print(f"[TMDB Fetch Error]: {e}")
        return None


def _get_tv_metadata(tmdb_id: int | str, current_season: int = 1) -> tuple[int, int, str]:
    """Fetch exact season count, episode count for the active season, and latest air year from TMDB."""
    details = _tmdb_get(f"/tv/{tmdb_id}", {}) or {}

    seasons = [s for s in details.get("seasons", []) if s.get("season_number", 0) > 0]
    total_seasons = details.get("number_of_seasons") or len(seasons) or 1

    last_air = details.get("last_air_date") or details.get("first_air_date") or ""
    release_year = extract_year(last_air)

    season_details = _tmdb_get(f"/tv/{tmdb_id}/season/{current_season}", {}) or {}
    episodes = season_details.get("episodes", [])
    episodes_count = len(episodes) if episodes else 10

    return total_seasons, episodes_count, release_year


# ---------------------------------------------------------------------------
# CORS
#
# This used to answer `Access-Control-Allow-Origin: *` to everything, on
# endpoints that read and write per-account state. A wildcard is only harmless
# for a token in the URL; the moment a browser is willing to attach credentials
# it becomes "any site on the internet may act as the signed-in user", and
# `*` cannot legally be combined with Allow-Credentials anyway.
#
# The rule is deliberately exact-match: reflect the origin only when it is on
# the allowlist, and send no CORS headers at all otherwise, so the browser
# blocks it. A wildcard on `*.vercel.app` is NOT a safe shortcut -- every
# unrelated Vercel project owns a hostname on that domain.
#
# Vary: Origin is not optional. Without it a shared cache can hand an allowlisted
# origin's response to a different origin, which is the same hole with extra
# steps.
# ---------------------------------------------------------------------------

_DEFAULT_ALLOWED_ORIGINS = (
    "https://vy-virid.vercel.app,http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5193,http://127.0.0.1:5193"
)


def _allowed_origins() -> frozenset[str]:
    raw = os.environ.get("ALLOWED_ORIGINS", "").strip() or _DEFAULT_ALLOWED_ORIGINS
    return frozenset(
        origin.strip().rstrip("/").lower()
        for origin in raw.split(",")
        if origin.strip()
    )


_ALLOWED_ORIGINS = _allowed_origins()


@app.after_request
def add_cors_headers(response):
    origin = (request.headers.get("Origin") or "").strip().rstrip("/").lower()
    if origin and origin in _ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        # The app authenticates with a bearer token rather than a cookie, so
        # this is not load-bearing today. It is set only alongside an
        # allowlisted origin, which is the only combination that is safe.
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Access-Control-Max-Age"] = "600"
    response.headers["Access-Control-Expose-Headers"] = "Content-Length, Accept-Ranges, Content-Type"
    response.vary.add("Origin")
    response.headers.pop("X-Powered-By", None)
    return response


# Headers the WSGI layer stamps on every response identify the exact server and
# Python build. Flask can only drop headers it owns, so filter the rest here.
#
# Scope note: this removes headers the application itself sets. `X-Render-
# Origin-Server` and `rndr-id` are injected by Render's edge *after* this
# process, so no in-process change can remove them -- see the deployment note
# in the README. They are listed defensively in case a future proxy in front of
# the app forwards them as ordinary response headers.
_SCRUBBED_HEADERS = frozenset(
    {
        "server",
        "x-powered-by",
        "x-aspnet-version",
        "x-aspnetmvc-version",
        "x-render-origin-server",
        "x-render-routing",
        "rndr-id",
        "x-request-id",
    }
)


class _HeaderScrubber:
    """Pass-through WSGI middleware that drops stack-fingerprinting headers."""

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        def scrub(status, headers, exc_info=None):
            kept = [
                (key, value)
                for key, value in headers
                if key.lower() not in _SCRUBBED_HEADERS
            ]
            return start_response(status, kept, exc_info)

        return self.wsgi_app(environ, scrub)


# Applied unconditionally so it covers every entrypoint -- `python app.py`,
# `gunicorn app:app`, and the test client alike.
app.wsgi_app = _HeaderScrubber(app.wsgi_app)


def _auth_user() -> dict | None:
    """Resolve the Authorization: Bearer <token> header to a user row, if any."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[len("Bearer "):].strip()
    if not token:
        return None
    return authdb.get_store().user_by_token(token)


def _normalize_media_type(value) -> str:
    return value if value in ("movie", "tv") else "movie"


# ---------------------------------------------------------------------------
# History payload validation
#
# The endpoint is authenticated, but "authenticated" is not "trusted": any
# signed-in client can send anything, and this one is called from a background
# buffer flush that can be interrupted mid-flight. Unvalidated input here was a
# reliable 500 generator -- `int()` on a junk string raised, and a missing
# title hit the NOT NULL constraint -- which turns a bad request into a server
# error and fills the logs with tracebacks.
#
# So: coerce defensively, clamp the numbers, cap the strings, and fall back to
# a placeholder title rather than letting the database reject the row.
# ---------------------------------------------------------------------------

_HISTORY_TEXT_LIMITS = {
    "title": 300,
    "poster": 2048,
    "backdrop": 2048,
}
# A watch position longer than this is a client bug, not a long film.
_MAX_SECONDS = 60 * 60 * 12


def _clean_text(payload: dict, key: str) -> str | None:
    raw = payload.get(key)
    if raw is None:
        return None
    if not isinstance(raw, (str, int, float)):
        return None
    text = str(raw).strip()
    return text[: _HISTORY_TEXT_LIMITS[key]] or None


def _clean_int(payload: dict, key: str, default: int, low: int, high: int) -> int:
    raw = payload.get(key)
    if raw is None or isinstance(raw, bool):
        return default
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


def _clean_history_fields(payload) -> tuple[dict, str]:
    """Return (fields, problem). `problem` is a client-safe message, or ""."""
    if not isinstance(payload, dict):
        return {}, "Body must be a JSON object."

    raw_key = payload.get("movie_key") or payload.get("id")
    if not isinstance(raw_key, (str, int, float)) or isinstance(raw_key, bool):
        return {}, "Missing movie key."
    movie_key = str(raw_key).strip()[:200]
    if not movie_key:
        return {}, "Missing movie key."

    title = _clean_text(payload, "title")
    year = payload.get("year")
    try:
        year = int(year) if year not in (None, "") else None
    except (TypeError, ValueError):
        year = None
    if year is not None:
        year = max(1800, min(2200, year))

    return (
        {
            "movie_key": movie_key,
            # NOT NULL in Postgres; a poster-only flush has no title.
            "title": title or movie_key,
            "year": year,
            "poster": _clean_text(payload, "poster"),
            "backdrop": _clean_text(payload, "backdrop"),
            "media_type": _normalize_media_type(payload.get("media_type")),
            "progress_seconds": _clean_int(payload, "progress_seconds", 0, 0, _MAX_SECONDS),
            "duration_seconds": _clean_int(payload, "duration_seconds", 0, 0, _MAX_SECONDS),
            "completed": 1 if payload.get("completed") else 0,
            "watched_at": _clean_int(payload, "watched_at", int(time.time() * 1000), 0, 2**53),
        },
        "",
    )


@app.route("/api/search", methods=["GET", "OPTIONS"])
def search_catalog():
    if request.method == "OPTIONS":
        return ("", 204)

    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

    results = tmdb.search_multi(query)
    catalog_service.ingest_tmdb_results(results)
    normalized = [tmdb.normalize_tmdb_item(item, item.get("media_type", "movie")) for item in results]
    normalized = [n for n in normalized if n]
    return jsonify(normalized)


@app.route("/api/search/suggest", methods=["GET", "OPTIONS"])
def search_suggest():
    """Live autocomplete suggestions for search input."""
    if request.method == "OPTIONS":
        return ("", 204)

    query = request.args.get("q", "").strip()
    if not query or len(query) < 2:
        return jsonify([])

    results = tmdb.search_multi(query)
    suggestions = []
    for item in results[:8]:
        media_type = item.get("media_type")
        if media_type not in ("movie", "tv"):
            continue

        tmdb_id = item.get("id")
        title = item.get("title") or item.get("name") or "Untitled"
        poster_path = item.get("poster_path")
        poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else ""
        release = item.get("release_date") or item.get("first_air_date") or ""
        year = release[:4] if len(release) >= 4 else ""

        suggestions.append({
            "id": str(tmdb_id),
            "title": title,
            "poster_url": poster_url,
            "year": year,
            "media_type": media_type,
        })

    return jsonify(suggestions)

@app.route('/')
def health_check():
    return {"status": "online", "service": "vy-backend"}, 200

@app.route("/api/movies/resolve", methods=["GET", "POST", "OPTIONS"])
def resolve_movie():
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(silent=True) or {} if request.method == "POST" else {}

    title = str(payload.get("title") or request.args.get("title", "")).strip()
    tmdb_id = payload.get("id") or payload.get("tmdb_id") or request.args.get("id")
    media_type = payload.get("media_type") or payload.get("type")

    try:
        season = int(payload.get("season") or request.args.get("season") or 1)
    except (ValueError, TypeError):
        season = 1

    try:
        episode = int(payload.get("episode") or request.args.get("episode") or 1)
    except (ValueError, TypeError):
        episode = 1

    year = payload.get("year") or request.args.get("year")

    # If we have a TMDB ID, fetch details directly
    if tmdb_id:
        try:
            tmdb_id = int(tmdb_id)
        except (ValueError, TypeError):
            tmdb_id = None
    
    if not tmdb_id and title:
        # Search for the title
        results = tmdb.search_multi(title)
        valid_results = [r for r in results if r.get("media_type") in ("movie", "tv")]
        if valid_results:
            top = valid_results[0]
            tmdb_id = top["id"]
            media_type = top.get("media_type", "movie")
            title = top.get("title") or top.get("name") or title
            year = year or (top.get("release_date") or top.get("first_air_date") or "")[:4]

    if not tmdb_id:
        return jsonify({"error": f"Could not find metadata for '{title}'"}), 404

    if not media_type:
        media_type = "movie"

    # Fetch full metadata from TMDB
    details = tmdb.fetch_media_details(tmdb_id, media_type)
    if not details:
        return jsonify({"error": f"Could not fetch details for '{title}'"}), 404

    if media_type == "tv":
        seasons_count = details.get("number_of_seasons", 1)
        # Get episode count for requested season
        season_details = _tmdb_get(f"/tv/{tmdb_id}/season/{season}", {}) or {}
        episodes = season_details.get("episodes", [])
        episodes_count = len(episodes) if episodes else 10
        
        # Use year from show's first air date if not provided
        if not year and details.get("release_date"):
            year = details["release_date"][:4]
        
        stream_url = f"https://vidsrc.me/embed/tv?tmdb={tmdb_id}&season={season}&episode={episode}"
        direct = None
    else:
        seasons_count = 1
        episodes_count = 1
        if not year and details.get("release_date"):
            year = details["release_date"][:4]
        title_for_direct = details.get("title") or title
        direct = _direct_source_for(title_for_direct, year)
        stream_url = (
            direct.get("stream_url")
            if direct
            else f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}"
        )

    # Extract runtime as number
    runtime = details.get("runtime")
    if runtime is not None:
        try:
            runtime = int(runtime)
        except (ValueError, TypeError):
            runtime = None

    # Extract director/cast from details (may come from credits append_to_response)
    director = details.get("director")
    cast = details.get("cast", [])
    if not director and details.get("credits"):
        director, cast = tmdb.extract_director_and_cast(details.get("credits", {}))
    genres = details.get("genres", [])
    country = details.get("country")
    language = details.get("language")
    if not country or not language:
        extracted_country, extracted_language = tmdb.extract_country_and_language(details)
        country = country or extracted_country
        language = language or extracted_language

    movie_data = {
        "id": str(tmdb_id),
        "title": details.get("title") or title,
        "stream_url": stream_url,
        "is_available": True,
        "available": True,
        "is_embed": not bool(direct),
        "year": str(year) if year else "",
        "media_type": media_type,
        "season": season if media_type == "tv" else 1,
        "episode": episode if media_type == "tv" else 1,
        "seasons": seasons_count,
        "episodes_per_season": episodes_count,
        "poster_url": details.get("poster_url", "") or (direct or {}).get("poster_url", ""),
        "backdrop_url": details.get("backdrop_url", ""),
        "overview": details.get("overview", ""),
        "vote_average": details.get("vote_average"),
        "popularity": details.get("popularity"),
        "genres": genres,
        "runtime": runtime,
        "director": director,
        "cast": cast,
        "country": country,
        "language": language,
        "release_date": details.get("release_date"),
    }

    if direct:
        movie_data["streams"] = direct.get("streams", [])
        if direct.get("subtitles"):
            movie_data["subtitles"] = direct["subtitles"]
        movie_data["topics"] = direct.get("topics", [])
        if direct.get("_downloads") is not None:
            movie_data["_downloads"] = direct["_downloads"]
        if direct.get("_addeddate"):
            movie_data["_addeddate"] = direct["_addeddate"]

    # Include full episode list for TV shows
    if media_type == "tv" and details.get("episodes"):
        movie_data["episodes"] = details["episodes"]

    return jsonify({"movie": movie_data, "exact": True, "available": True})


@app.route("/api/get-stream", methods=["GET", "OPTIONS"])
def get_stream_direct():
    if request.method == "OPTIONS":
        return ("", 204)

    tmdb_id = request.args.get("tmdb_id") or request.args.get("id")
    media_type = request.args.get("media_type", "movie")
    season = request.args.get("season", 1)
    episode = request.args.get("episode", 1)
    refresh = request.args.get("refresh", "") in ("1", "true", "yes")

    if not tmdb_id:
        return jsonify({"success": False, "error": "Invalid ID"}), 400

    media_type = _normalize_media_type(media_type)
    is_tv = media_type == "tv"

    # Prefer a direct, ad-free Archive.org MP4 for movies when one exists. The
    # viewer gets a real stream immediately; quality variants become mirrors.
    # With `refresh=1` the cache is bypassed so a retrying client can keep
    # asking until a playable source is found.
    direct = None
    if not is_tv:
        details = _tmdb_get(f"/movie/{tmdb_id}", {}) or {}
        title = details.get("title") or ""
        year = None
        if details.get("release_date"):
            year = details["release_date"][:4]
        if title:
            direct = _direct_source_for(title, year, refresh=refresh)

    if direct:
        streams = direct.get("streams") or []
        default = direct.get("stream_url", "")
        mirrors = [
            {"name": f"Server {index + 1}", "url": source["url"]}
            for index, source in enumerate(streams)
            if source.get("url") and source["url"] != default
        ]
        sources: list[str] = []
        for url in [default] + [s.get("url", "") for s in streams]:
            if url and url not in sources:
                sources.append(url)
        return jsonify({
            "success": True,
            "activeSource": default,
            "sources": sources,
            "mirrors": mirrors,
            "is_embed": False,
        })

    if is_tv:
        stream_url = f"https://vidsrc.me/embed/tv?tmdb={tmdb_id}&season={season}&episode={episode}"
        fallback = f"https://vidsrc.cc/v2/embed/tv/{tmdb_id}/{season}/{episode}"
    else:
        stream_url = f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}"
        fallback = f"https://vidsrc.cc/v2/embed/movie/{tmdb_id}"

    return jsonify({
        "success": True,
        "activeSource": stream_url,
        "sources": [stream_url] + [fallback] if fallback != stream_url else [stream_url],
        "is_embed": True,
        "mirrors": [
            {"name": "Server 1", "url": stream_url},
            {"name": "Server 2", "url": fallback},
        ]
    })


@app.route("/api/movies/stream", methods=["GET", "OPTIONS"])
def stream_relay():
    """Same-origin relay for Archive.org movie bytes (CORS + range safe)."""
    if request.method == "OPTIONS":
        return ("", 204)

    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing url parameter"}), 400

    try:
        status, headers, body = catalog_lib.open_archive_stream(
            url, request.headers.get("Range")
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:  # noqa: BLE001 - upstream failure is not ours
        return jsonify({"error": f"Stream unavailable: {error}"}), 502

    response = Response(body or "", status=status)
    for key, value in headers.items():
        response.headers[key] = value
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


@app.route("/api/movies/feeds", methods=["GET", "OPTIONS"])
def feeds():
    if request.method == "OPTIONS":
        return ("", 204)

    trending = tmdb.get_trending_catalog("week", "all")
    popular_movies = tmdb.get_popular("movie", 1)
    popular_tv = tmdb.get_popular("tv", 1)

    catalog_service.ingest_tmdb_results(trending)
    catalog_service.ingest_tmdb_results(popular_movies, "movie")
    catalog_service.ingest_tmdb_results(popular_tv, "tv")

    featured = [tmdb.normalize_tmdb_item(item, item["media_type"]) for item in trending][:18]
    recent = [tmdb.normalize_tmdb_item(item, "movie") for item in popular_movies][:24]
    popular = [tmdb.normalize_tmdb_item(item, "tv") for item in popular_tv][:24]

    # Filter out None values
    featured = [f for f in featured if f]
    recent = [r for r in recent if r]
    popular = [p for p in popular if p]

    return jsonify({
        "featured": featured,
        "recent": recent,
        "popular": popular,
    })


@app.route("/api/episodes", methods=["GET", "OPTIONS"])
def get_episode_details():
    if request.method == "OPTIONS":
        return ("", 204)

    tmdb_id = request.args.get("tmdb_id")
    season = request.args.get("season", 1, type=int)
    episode = request.args.get("episode", 1, type=int)

    if not tmdb_id:
        return jsonify({"success": False, "error": "Invalid ID"}), 400

    try:
        episode_data = tmdb.fetch_episode_details(int(tmdb_id), season, episode)
    except Exception as e:
        print(f"[Episode Fetch Error]: {e}")
        episode_data = None

    if not episode_data:
        return jsonify({"success": False, "error": "Episode not found"}), 404

    still_path = episode_data.get("still_path")
    still_url = f"https://image.tmdb.org/t/p/w500{still_path}" if still_path else ""

    return jsonify({
        "success": True,
        "episode": {
            "season": episode_data.get("season_number", season),
            "number": episode_data.get("episode_number", episode),
            "title": episode_data.get("name", f"Episode {episode}"),
            "overview": episode_data.get("overview", ""),
            "still_path": still_path,
            "still_url": still_url,
            "air_date": episode_data.get("air_date", ""),
            "runtime": episode_data.get("runtime"),
            "vote_average": episode_data.get("vote_average"),
        }
    })


@app.route("/api/movies/trending", methods=["GET", "OPTIONS"])
def get_trending():
    """Fetch trending movies/TV from TMDB (week)."""
    if request.method == "OPTIONS":
        return ("", 204)

    time_window = request.args.get("time_window", "week")
    media_type = request.args.get("media_type", "all")

    valid_windows = {"day", "week"}
    valid_media = {"all", "movie", "tv"}

    if time_window not in valid_windows:
        time_window = "week"
    if media_type not in valid_media:
        media_type = "all"

    results = tmdb.get_trending_catalog(time_window, media_type)
    catalog_service.ingest_tmdb_results(results)
    normalized = [tmdb.normalize_tmdb_item(item, item["media_type"]) for item in results]
    normalized = [n for n in normalized if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)

    return jsonify(normalized)


@app.route("/api/movies/popular", methods=["GET", "OPTIONS"])
def get_popular():
    """Fetch popular movies/TV from TMDB."""
    if request.method == "OPTIONS":
        return ("", 204)

    media_type = request.args.get("media_type", "movie")
    page = request.args.get("page", 1, type=int)

    if media_type not in ("movie", "tv"):
        media_type = "movie"

    results = tmdb.get_popular(media_type, page)
    catalog_service.ingest_tmdb_results(results, media_type)
    normalized = [tmdb.normalize_tmdb_item(item, media_type) for item in results]
    normalized = [n for n in normalized if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)

    return jsonify(normalized)


@app.route("/api/movies/now_playing", methods=["GET", "OPTIONS"])
def get_now_playing():
    """Fetch currently playing movies from TMDB."""
    if request.method == "OPTIONS":
        return ("", 204)

    page = request.args.get("page", 1, type=int)

    results = tmdb.get_now_playing(page)
    catalog_service.ingest_tmdb_results(results, "movie")
    normalized = [tmdb.normalize_tmdb_item(item, "movie") for item in results]
    normalized = [n for n in normalized if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)

    return jsonify(normalized)


@app.route("/api/movies/on_the_air", methods=["GET", "OPTIONS"])
def get_on_the_air():
    """Fetch currently airing TV shows from TMDB."""
    if request.method == "OPTIONS":
        return ("", 204)

    page = request.args.get("page", 1, type=int)

    results = tmdb.get_on_the_air(page)
    catalog_service.ingest_tmdb_results(results, "tv")
    normalized = [tmdb.normalize_tmdb_item(item, "tv") for item in results]
    normalized = [n for n in normalized if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)

    return jsonify(normalized)


@app.route("/api/catalog/discover", methods=["GET", "OPTIONS"])
def catalog_discover():
    """Aggregated, live-first catalog browse endpoint.

    Every page re-fetches the LATEST titles fresh from the upstream providers
    (TMDB, plus optional Trakt breadth on page one), normalizes each response
    into the unified MediaItem contract, persists the batch (write-through
    cache) and returns it — so infinite scrolling keeps pulling current
    trending/popular/newly-released content. The DB is only a fallback if the
    upstream is temporarily unreachable. `?media_type=movie|tv|all`,
    `?genre=<name>`, `?page=N`.
    """
    if request.method == "OPTIONS":
        return ("", 204)
    media_type = request.args.get("media_type", "movie")
    genre = request.args.get("genre") or None
    try:
        page = int(request.args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    try:
        per_page = int(request.args.get("per_page", 24))
    except (TypeError, ValueError):
        per_page = 24
    return jsonify(
        catalog_service.discover(
            media_type=media_type, page=page, per_page=per_page, genre=genre
        )
    )


@app.route("/api/catalog/search", methods=["GET", "OPTIONS"])
def catalog_search():
    """Live multi-API catalog search with cache fallback.

    Queries TMDB (then OMDB for obscure titles) live, saves every hit to the
    catalog cache, and returns it — permanently expanding the library. Falls
    back to cached results only if the upstream is unreachable."""
    if request.method == "OPTIONS":
        return ("", 204)
    query = request.args.get("q") or request.args.get("query") or ""
    media_type = request.args.get("media_type", "all")
    try:
        page = int(request.args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    return jsonify(
        catalog_service.search_media(query, media_type=media_type, page=page)
    )


@app.route("/api/movies/trailer", methods=["GET", "OPTIONS"])
def get_trailer():
    if request.method == "OPTIONS":
        return ("", 204)

    title = request.args.get("title", "").strip()
    year = request.args.get("year")

    if not title:
        return jsonify({"trailer": None}), 400

    results = tmdb.search_multi(title)
    valid_results = [r for r in results if r.get("media_type") in ("movie", "tv")]

    if not valid_results:
        return jsonify({"trailer": None}), 404

    target = valid_results[0]
    if year:
        for r in valid_results:
            release = r.get("release_date") or r.get("first_air_date") or ""
            if release.startswith(str(year)):
                target = r
                break

    tmdb_id = target.get("id")
    media_type = target.get("media_type", "movie")

    trailer_key = tmdb.get_trailer_key(tmdb_id, media_type)

    if not trailer_key:
        return jsonify({"trailer": None})

    return jsonify({"trailer": {"provider": "youtube", "id": trailer_key}})


def extract_year(date_str: str | None) -> str:
    """Extract 4-digit year from various date formats (YYYY-MM-DD, YYYY, etc.)."""
    if not date_str:
        return ""
    match = re.search(r'\b(19\d{2}|20\d{2})\b', str(date_str))
    return match.group(1) if match else ""


@app.route("/api/media/<id>", methods=["GET", "OPTIONS"])
def get_media_by_id(id: str):
    """Get media details by TMDB ID. Tries movie first, then TV as fallback."""
    if request.method == "OPTIONS":
        return ("", 204)

    tmdb_id = id
    try:
        tmdb_id = int(tmdb_id)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid TMDB ID"}), 400

    # Try movie first
    movie_details = _tmdb_get(f"/movie/{tmdb_id}", {"append_to_response": "external_ids,credits,videos,images,keywords"})
    
    if movie_details:
        media_type = "movie"
        details = movie_details
    else:
        # Fallback to TV
        tv_details = _tmdb_get(f"/tv/{tmdb_id}", {"append_to_response": "external_ids,credits,videos,images,keywords"})
        if not tv_details:
            return jsonify({"error": f"Media not found for ID {tmdb_id}"}), 404
        media_type = "tv"
        details = tv_details

    release_date = details.get("release_date") or details.get("first_air_date", "")
    release_year = extract_year(release_date)

    # Extract YouTube trailer key
    trailer_key = None
    videos = details.get("videos", {}).get("results", [])
    for v in videos:
        if v.get("type") == "Trailer" and v.get("site") == "YouTube":
            trailer_key = v.get("key")
            break
    if not trailer_key:
        for v in videos:
            if v.get("site") == "YouTube":
                trailer_key = v.get("key")
                break

    # Genres
    genres = [genre["name"] for genre in details.get("genres", [])]

    # Poster/backdrop
    poster_path = details.get("poster_path")
    backdrop_path = details.get("backdrop_path")

    result = {
        "id": str(tmdb_id),
        "title": details.get("title") or details.get("name"),
        "overview": details.get("overview") or "",
        "release_year": release_year,
        "release_date": release_date,
        "vote_average": details.get("vote_average"),
        "imdb_id": details.get("external_ids", {}).get("imdb_id"),
        "genres": genres,
        "poster_path": poster_path,
        "poster_url": f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else "",
        "backdrop_path": backdrop_path,
        "backdrop_url": f"https://image.tmdb.org/t/p/w1280{backdrop_path}" if backdrop_path else "",
        "trailer_key": trailer_key,
        "popularity": details.get("popularity"),
        "runtime": details.get("runtime"),
        "media_type": media_type,
    }

    # For TV shows, add season/episode info
    if media_type == "tv":
        seasons = details.get("seasons", [])
        valid_seasons = [s for s in seasons if s.get("season_number", 0) > 0]
        result["number_of_seasons"] = details.get("number_of_seasons") or len(valid_seasons) or 1
        result["number_of_episodes"] = details.get("number_of_episodes") or 0
        result["seasons"] = valid_seasons if valid_seasons else seasons

    # Build embed URLs with multiple providers
    if media_type == "tv":
        result["embed_urls"] = {
            "vidsrc": f"https://vidsrc.me/embed/tv?tmdb={tmdb_id}&season=1&episode=1",
            "vidsrc_cc": f"https://vidsrc.cc/v2/embed/tv/{tmdb_id}/1/1",
            "embed_su": f"https://embed.su/embed/tv/{tmdb_id}/1/1",
        }
        result["default_embed"] = result["embed_urls"]["vidsrc"]
    else:
        result["embed_urls"] = {
            "vidsrc": f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}",
            "vidsrc_cc": f"https://vidsrc.cc/v2/embed/movie/{tmdb_id}",
            "embed_su": f"https://embed.su/embed/movie/{tmdb_id}",
        }
        result["default_embed"] = result["embed_urls"]["vidsrc"]

    return jsonify(result)


# ---------------------------------------------------------------------------
# Accounts & per-account watch history
# ---------------------------------------------------------------------------

def _auth_error(message: str, code: int = 401):
    return jsonify({"error": message}), code


@app.route("/api/auth/signup", methods=["POST", "OPTIONS"])
def api_signup():
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(silent=True) or {}
    email = str(payload.get("email") or "").strip().lower()
    name = str(payload.get("name") or "").strip()
    password = str(payload.get("password") or "")

    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return _auth_error("Please enter a valid email address.", 400)
    if len(password) < 8:
        return _auth_error("Password must be at least 8 characters.", 400)
    if not name:
        return _auth_error("Please enter your name.", 400)

    # Every DB call below is wrapped: a driver error must never reach the
    # client as a SQL string or traceback. The detail goes to the server log.
    try:
        store = authdb.get_store()
        if store.user_by_email(email):
            return _auth_error("An account with this email already exists.", 409)

        user = store.create_user(email, name[:80], password)
        if not user:
            return _auth_error("Could not create the account. Try again.", 500)

        token = store.create_session(user["id"])
    except Exception:
        app.logger.exception("signup failed for %s", email)
        return (
            jsonify(
                {
                    "error": (
                        "An error occurred during account creation. Please try again."
                    )
                }
            ),
            500,
        )

    return (
        jsonify(
            {
                "success": True,
                "token": token,
                "user": authdb.serialize_user(user),
            }
        ),
        201,
    )


@app.route("/api/auth/login", methods=["POST", "OPTIONS"])
def api_login():
    if request.method == "OPTIONS":
        return ("", 204)

    payload = request.get_json(silent=True) or {}
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")

    try:
        store = authdb.get_store()
        user = store.user_by_email(email)
        # Run the KDF even when the account is unknown so a missing account and
        # a wrong password take a comparable amount of time.
        password_ok = store.verify_password(user, password) if user else False
        if not user or not password_ok:
            return _auth_error("Incorrect email or password.")

        token = store.create_session(user["id"])
    except Exception:
        app.logger.exception("login failed for %s", email)
        return (
            jsonify(
                {"error": "An error occurred during sign in. Please try again."}
            ),
            500,
        )

    return jsonify({"success": True, "token": token, "user": authdb.serialize_user(user)})


@app.route("/api/auth/me", methods=["GET", "OPTIONS"])
def api_me():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Not signed in.")
    return jsonify({"user": authdb.serialize_user(user)})


@app.route("/api/auth/logout", methods=["POST", "OPTIONS"])
def api_logout():
    if request.method == "OPTIONS":
        return ("", 204)
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        authdb.get_store().revoke_token(header[len("Bearer "):].strip())
    return jsonify({"success": True})


@app.route("/api/auth/history", methods=["GET", "POST", "DELETE", "OPTIONS"])
def api_history():
    if request.method == "OPTIONS":
        return ("", 204)

    # The user id comes from the verified bearer token and never from the
    # request body, so one account cannot write history into another's.
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to sync your watch history.")

    store = authdb.get_store()
    user_id = user["id"]

    if request.method == "DELETE":
        store.clear_history(user_id)
        return jsonify({"success": True})

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        fields, problem = _clean_history_fields(payload)
        if problem:
            return _auth_error(problem, 400)
        store.add_history(user_id, fields["movie_key"], fields)
        return jsonify({"success": True})

    history = store.history(user_id)
    return jsonify({"history": history})


@app.route("/api/auth/history/<path:movie_key>", methods=["DELETE", "OPTIONS"])
def api_history_remove(movie_key: str):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage your watch history.")
    authdb.get_store().remove_history(user["id"], movie_key)
    return jsonify({"success": True})


@app.route("/api/auth/my-list", methods=["GET", "POST", "DELETE", "OPTIONS"])
def api_my_list():
    """Per-account saved titles (My List on the frontend)."""
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to sync your saved list.")

    store = authdb.get_store()
    user_id = user["id"]

    if request.method == "DELETE":
        store.clear_saved_media(user_id)
        return jsonify({"success": True})

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        try:
            media_id = int(payload.get("media_id") or payload.get("id"))
        except (TypeError, ValueError):
            return _auth_error("Missing a valid media id.", 400)
        media_type = _normalize_media_type(payload.get("media_type") or "movie")
        title = str(payload.get("title") or "").strip()
        poster_path = payload.get("poster_path") or payload.get("poster_url") or None
        added = store.add_saved_media(
            user_id, media_id, media_type, title, poster_path
        )
        return jsonify({"success": True, "added": added})

    items = store.saved_media(user_id)
    return jsonify({"items": items})


@app.route("/api/auth/my-list/<int:media_id>", methods=["DELETE", "OPTIONS"])
def api_my_list_remove(media_id: int):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage your saved list.")
    authdb.get_store().remove_saved_media(user["id"], media_id)
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# Profile / list sharing
#
# A share grants read access to the owner's saved list. The list itself stays
# in `saved_media` and is never copied, so revoking access is a single DELETE
# on `share_members` and there is no second copy to keep in sync.
#
# Two separate ideas, deliberately kept apart:
#   * an *invite* is an outstanding, token-bearing offer (share_invites)
#   * a *member* is someone who redeemed one (share_members)
# Revoking an invite stops future redemptions; removing a member revokes access
# someone already has. Conflating them is how shared folders end up with ghosts.
# ---------------------------------------------------------------------------

MAX_PENDING_INVITES = 20


def _share_view(invite: dict, include_email: bool) -> dict:
    """Serialise an invite for the owner. The token is the whole credential,
    so it is only ever returned to the person who created it."""
    return {
        "token": invite.get("token"),
        "email": invite.get("email") if include_email else None,
        "role": invite.get("role") or "viewer",
        "status": invite.get("status") or "pending",
        "created_at": authdb._to_iso(invite.get("created_at")),
        "expires_at": authdb._to_iso(invite.get("expires_at")),
        "accepted_at": authdb._to_iso(invite.get("accepted_at")),
    }


def _share_preview(store, invite: dict) -> dict:
    """What an invitee sees before accepting. Deliberately thin: a display
    name and a count, never the list contents and never other members."""
    owner = store.user_by_id(invite.get("owner_id"))
    items = store.saved_media(invite.get("owner_id"), limit=200)
    return {
        "inviter_name": (owner or {}).get("display_name") or "Someone",
        "item_count": len(items),
        "role": invite.get("role") or "viewer",
        "expires_at": authdb._to_iso(invite.get("expires_at")),
    }


@app.route("/api/auth/shares", methods=["GET", "POST", "OPTIONS"])
def api_shares():
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to share your list.")

    store = authdb.get_store()
    owner_id = user["id"]

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        email = str(payload.get("email") or "").strip().lower() or None
        role = str(payload.get("role") or "viewer").strip()
        if role not in ("viewer", "editor"):
            return _auth_error("Role must be viewer or editor.", 400)

        # Reuse an equivalent pending invite instead of minting a second token
        # for the same address. This caps how fast anyone can manufacture
        # share links, without needing a separate rate limiter here.
        for existing in store.share_invites_for_owner(owner_id):
            if (
                (existing.get("status") or "") == "pending"
                and (existing.get("email") or "") == (email or "")
                and (existing.get("role") or "viewer") == role
            ):
                return jsonify({"share": _share_view(existing, True), "reused": True})

        if store.count_pending_invites(owner_id) >= MAX_PENDING_INVITES:
            return _auth_error(
                "You have too many active invites. Revoke one first.", 429
            )

        invite = store.create_share_invite(owner_id, email=email, role=role)
        return jsonify({"share": _share_view(invite, True), "reused": False})

    return jsonify(
        {
            "invites": [
                _share_view(i, True) for i in store.share_invites_for_owner(owner_id)
            ],
            "members": _member_views(store, owner_id, owner_id),
            "shared_with_me": [
                {
                    "owner_id": str(row.get("owner_id")),
                    "owner_name": row.get("display_name") or "Someone",
                    "role": row.get("role") or "viewer",
                }
                for row in store.shared_profiles_for_user(owner_id)
            ],
        }
    )


def _member_views(store, owner_id, requester_id) -> list[dict]:
    """Members of a shared list.

    Email addresses are the owner's business only. Handing them to every
    member would quietly turn a shared list into an address book."""
    is_owner = str(owner_id) == str(requester_id)
    return [
        {
            "user_id": str(row.get("user_id")),
            "display_name": row.get("display_name") or "Viewer",
            "role": row.get("role") or "viewer",
            "email": row.get("email") if is_owner else None,
            "joined_at": authdb._to_iso(row.get("created_at")),
        }
        for row in store.share_members_of(owner_id)
    ]


@app.route("/api/auth/shares/<string:token>", methods=["GET", "OPTIONS"])
def api_share_preview(token: str):
    """Preview an invite. No auth on purpose: the whole point is to show the
    page something useful before the person has signed in."""
    if request.method == "OPTIONS":
        return ("", 204)

    store = authdb.get_store()
    invite = store.share_invite_by_token(token)
    if not invite:
        return _auth_error("This invite link is not valid.", 404)
    if (invite.get("status") or "") == "revoked":
        return _auth_error("This invite has been revoked.", 410)
    if authdb._is_expired(invite.get("expires_at")):
        return _auth_error("This invite has expired.", 410)
    if (invite.get("status") or "") == "accepted" and not store.is_share_member(
        invite.get("owner_id"), (_auth_user() or {}).get("id")
    ):
        # Don't confirm to a stranger that a link was already used.
        return _auth_error("This invite is no longer available.", 410)

    payload = _share_preview(store, invite)
    viewer = _auth_user()
    if viewer:
        payload["already_member"] = store.is_share_member(
            invite.get("owner_id"), viewer["id"]
        )
        payload["is_owner"] = str(invite.get("owner_id")) == str(viewer["id"])
    return jsonify(payload)


@app.route("/api/auth/shares/<string:token>/accept", methods=["POST", "OPTIONS"])
def api_share_accept(token: str):
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to accept this invite.")

    store = authdb.get_store()
    invite, reason = store.accept_share_invite(token, user["id"], user.get("email") or "")
    if invite is None:
        # One message for every failure mode. Distinguishing "wrong address"
        # from "already used" turns this endpoint into an oracle for testing
        # whether an address has an account.
        return _auth_error("This invite cannot be accepted.", 400)
    return jsonify({"success": True, "role": invite.get("role") or "viewer"})


@app.route("/api/auth/shares/<string:token>/members", methods=["GET", "OPTIONS"])
def api_share_members(token: str):
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to see who you share with.")

    store = authdb.get_store()
    invite = store.share_invite_by_token(token)
    owner_id = (invite or {}).get("owner_id")
    if not owner_id:
        return _auth_error("This invite link is not valid.", 404)
    # The owner is not a row in their own share_members table, so they have to
    # be let through explicitly or they cannot see who they invited.
    if str(owner_id) != str(user["id"]) and not store.is_share_member(
        owner_id, user["id"]
    ):
        return _auth_error("You do not have access to this list.", 403)
    return jsonify({"members": _member_views(store, owner_id, user["id"])})


@app.route(
    "/api/auth/shares/<string:token>/members/<string:member_id>",
    methods=["DELETE", "OPTIONS"],
)
def api_share_remove_member(token: str, member_id: str):
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage sharing.")

    store = authdb.get_store()
    invite = store.share_invite_by_token(token)
    owner_id = (invite or {}).get("owner_id")
    if not owner_id:
        return _auth_error("This invite link is not valid.", 404)
    if str(owner_id) != str(user["id"]):
        return _auth_error("Only the owner can remove people from a shared list.", 403)
    if not store.remove_share_member(owner_id, member_id):
        return _auth_error("That person is not on this list.", 404)
    return jsonify({"success": True})


@app.route("/api/auth/shares/<string:token>/revoke", methods=["POST", "OPTIONS"])
def api_share_revoke(token: str):
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage sharing.")

    if not authdb.get_store().revoke_share_invite(token, user["id"]):
        return _auth_error("That invite is not active.", 404)
    return jsonify({"success": True})


@app.route("/api/auth/shared/<string:owner_id>/my-list", methods=["GET", "OPTIONS"])
def api_shared_my_list(owner_id: str):
    """Read someone else's saved list. Members only -- this is the route the
    whole feature exists for, so it is the one that most needs the check."""
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to see shared lists.")

    store = authdb.get_store()
    if str(owner_id) == str(user["id"]):
        return jsonify({"items": store.saved_media(user["id"]), "owner": "you"})
    if not store.is_share_member(owner_id, user["id"]):
        return _auth_error("You do not have access to this list.", 403)

    owner = store.user_by_id(owner_id)
    return jsonify(
        {
            "items": store.saved_media(owner_id),
            "owner": (owner or {}).get("display_name") or "Someone",
        }
    )


# ---------------------------------------------------------------------------
# Entrypoint
#
# This MUST stay at the bottom of the module. It used to sit above the account
# routes, where `app.run()` blocks and the decorators below it never executed
# -- so every /api/auth/* endpoint 404'd under `python app.py`. Production uses
# gunicorn (`gunicorn app:app`), which imports the module and is unaffected.
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # The Werkzeug debugger is a remote-code-execution surface, so it is opt-in
    # and only ever binds to loopback. Use gunicorn for anything real.
    _debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    _host = "127.0.0.1" if _debug else "0.0.0.0"

    from werkzeug.serving import WSGIRequestHandler

    class _QuietRequestHandler(WSGIRequestHandler):
        """Stops `BaseHTTPRequestHandler` from emitting
        "Server: Werkzeug/3.1.8 Python/3.9.6". That header is written by the
        HTTP handler, below the WSGI layer, so no app-level middleware can
        reach it."""

        def version_string(self) -> str:
            return "stream-vy"

    app.run(
        host=_host,
        port=int(os.environ.get("PORT", "5000")),
        debug=_debug,
        request_handler=_QuietRequestHandler,
    )