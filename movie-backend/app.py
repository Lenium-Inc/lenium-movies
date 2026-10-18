"""
FreeStream Backend - TMDB-First Metadata & Native-HLS Streaming API.

All metadata from TMDB. All playback is native HLS/MP4 relayed through our own
origin -- no third-party iframes. Streams are resolved server-side, proxied
with the right Referer/UA, and handed to the client as m3u8 manifests.

Run:
    pip install -r requirements.txt
    python app.py                  # http://localhost:5000
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException

# Loaded first so the dotenv file is present before any module reads a secret.
from runtime_config import load_env_file, ssl_context, tmdb_api_key

load_env_file()

import authdb
import catalog_lib
import catalog_service
import hls_proxy
import stream_providers
import taste
import tmdb_service as tmdb
from proxy_util import playable, playable_sub

HERE = os.path.dirname(os.path.abspath(__file__))
TMDB_BASE_URL = "https://api.themoviedb.org/3"

app = Flask(__name__)
app.register_blueprint(hls_proxy.hls_bp)


# --------------------------------------------------------------------------- #
#  Direct (archive.org) catalog + caches                                       #
# --------------------------------------------------------------------------- #
def _load_direct_catalog() -> list[dict]:
    try:
        with open(os.path.join(HERE, "movies.json"), "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, list) else []
    except Exception as error:  # noqa: BLE001
        print(f"[Catalog] could not load movies.json: {error}")
        return []


_DIRECT_CATALOG = _load_direct_catalog()
_MISS_TTL_SECONDS = 300
_CACHE_MAX_ENTRIES = 2048
_direct_source_cache: dict[str, tuple[float, dict | None]] = {}
_direct_source_locks: dict[str, threading.Lock] = {}
_direct_source_globals = threading.Lock()


def _evict_direct_caches() -> None:
    if len(_direct_source_cache) <= _CACHE_MAX_ENTRIES:
        return
    for key in list(_direct_source_cache)[: len(_direct_source_cache) // 2]:
        _direct_source_cache.pop(key, None)
        _direct_source_locks.pop(key, None)


def _direct_lock_for(key: str) -> threading.Lock:
    with _direct_source_globals:
        lock = _direct_source_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _direct_source_locks[key] = lock
        return lock


def _direct_cache_get(key: str, refresh: bool) -> tuple[bool, dict | None]:
    with _direct_source_globals:
        record = _direct_source_cache.get(key)
    if record is None:
        return False, None
    stored_at, value = record
    if not refresh:
        return True, value
    if value is None and (time.time() - stored_at) < _MISS_TTL_SECONDS:
        return True, None
    return False, None


_SEASON_TTL_SECONDS = 6 * 3600
_season_cache: dict[str, tuple[float, dict | None]] = {}


def _season_cache_get(key: str) -> tuple[dict | None, bool]:
    record = _season_cache.get(key)
    if record is None:
        return None, False
    stored_at, value = record
    if (time.time() - stored_at) >= _SEASON_TTL_SECONDS:
        return None, False
    return value, True


def _season_cache_put(key: str, value: dict | None) -> None:
    if len(_season_cache) >= _CACHE_MAX_ENTRIES:
        for stale in list(_season_cache)[: len(_season_cache) // 2]:
            _season_cache.pop(stale, None)
    _season_cache[key] = (time.time(), value)


def _image_url(path, size: str) -> str:
    return f"https://image.tmdb.org/t/p/{size}{path}" if path else ""


def _find_catalog_entry(title: str, year) -> dict | None:
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
        if not catalog_lib.accept_candidate(requested_year, entry.get("year"), score):
            continue
        if best is None or score > best[0]:
            best = (score, entry)
    return best[1] if best else None


def _direct_source_for(title: str, year=None, refresh: bool = False) -> dict | None:
    if not title:
        return None
    key = catalog_lib.normalize_title(title) or title.lower().strip()
    hit, cached = _direct_cache_get(key, refresh)
    if hit:
        return cached
    with _direct_lock_for(key):
        hit, cached = _direct_cache_get(key, refresh)
        if hit:
            return cached
        entry = _find_catalog_entry(title, year)
        if entry is None:
            try:
                entry = catalog_lib.scrape_title(title, requested_year=year)
            except Exception as error:  # noqa: BLE001
                print(f"[Catalog] on-demand scrape failed for {title!r}: {error}")
                entry = None
        with _direct_source_globals:
            _direct_source_cache[key] = (time.time(), entry)
            _evict_direct_caches()
        return entry


# --------------------------------------------------------------------------- #
#  TMDB client                                                                 #
# --------------------------------------------------------------------------- #
def _tmdb_get(path: str, params: dict) -> dict | None:
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
    except Exception as e:  # noqa: BLE001
        print(f"[TMDB Fetch Error]: {e}")
        return None


def _parse_tmdb_id(raw) -> int | None:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if value <= 0 or value > 2**31 - 1:
        return None
    return value


def _json_error(message: str, status: int, **extra):
    return jsonify({"error": message, "status": status, "success": False, **extra}), status


def _normalize_media_type(value) -> str:
    return value if value in ("movie", "tv") else "movie"


def extract_year(date_str: str | None) -> str:
    if not date_str:
        return ""
    match = re.search(r"\b(19\d{2}|20\d{2})\b", str(date_str))
    return match.group(1) if match else ""


# --------------------------------------------------------------------------- #
#  CORS / errors / headers                                                     #
# --------------------------------------------------------------------------- #
_DEFAULT_ALLOWED_ORIGINS = (
    "https://streamvy.me,https://www.streamvy.me,https://streamvy.vercel.app,"
    "https://vy-virid.vercel.app,"
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5193,http://127.0.0.1:5193"
)


def _allowed_origins() -> frozenset[str]:
    raw = os.environ.get("ALLOWED_ORIGINS", "").strip() or _DEFAULT_ALLOWED_ORIGINS
    return frozenset(o.strip().rstrip("/").lower() for o in raw.split(",") if o.strip())


_ALLOWED_ORIGINS = _allowed_origins()


@app.errorhandler(HTTPException)
def _http_exception_handler(error: HTTPException):
    return _json_error(error.description or error.name, error.code or 500)


@app.errorhandler(Exception)
def _unhandled_exception_handler(error: Exception):
    app.logger.exception("unhandled error on %s %s", request.method, request.path)
    return _json_error("The movie backend could not fulfil this request.", 500)


@app.after_request
def add_cors_headers(response):
    origin = (request.headers.get("Origin") or "").strip().rstrip("/").lower()
    if origin and origin in _ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Range"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Max-Age"] = "600"
    response.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges, Content-Type"
    response.vary.add("Origin")
    response.headers.pop("X-Powered-By", None)
    return response


_SCRUBBED_HEADERS = frozenset({
    "server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version",
    "x-render-origin-server", "x-render-routing", "rndr-id", "x-request-id",
})


class _HeaderScrubber:
    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        def scrub(status, headers, exc_info=None):
            kept = [(k, v) for k, v in headers if k.lower() not in _SCRUBBED_HEADERS]
            return start_response(status, kept, exc_info)

        return self.wsgi_app(environ, scrub)


app.wsgi_app = _HeaderScrubber(app.wsgi_app)


# --------------------------------------------------------------------------- #
#  Auth helpers                                                                #
# --------------------------------------------------------------------------- #
def _auth_user() -> dict | None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[len("Bearer "):].strip()
    if not token:
        return None
    return authdb.get_store().user_by_token(token)


def _auth_error(message: str, code: int = 401):
    return jsonify({"error": message}), code


def _resolve_profile(user, payload=None):
    store = authdb.get_store()
    raw = (payload or {}).get("profile_id") or request.args.get("profile_id")
    if raw in (None, ""):
        profiles = store.list_profiles(user["id"])
        return profiles[0] if profiles else None
    return store.profile_by_id(raw, user["id"]) or False


# --------------------------------------------------------------------------- #
#  History payload validation                                                  #
# --------------------------------------------------------------------------- #
_HISTORY_TEXT_LIMITS = {"title": 300, "poster": 2048, "backdrop": 2048}
_MAX_SECONDS = 60 * 60 * 12


def _clean_text(payload: dict, key: str) -> str | None:
    raw = payload.get(key)
    if raw is None or not isinstance(raw, (str, int, float)):
        return None
    return str(raw).strip()[: _HISTORY_TEXT_LIMITS[key]] or None


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
    if not isinstance(payload, dict):
        return {}, "Body must be a JSON object."
    raw_key = payload.get("movie_key") or payload.get("id")
    if not isinstance(raw_key, (str, int, float)) or isinstance(raw_key, bool):
        return {}, "Missing movie key."
    movie_key = str(raw_key).strip()[:200]
    if not movie_key:
        return {}, "Missing movie key."
    title = _clean_text(payload, "title")
    try:
        year = int(payload.get("year")) if payload.get("year") not in (None, "") else None
    except (TypeError, ValueError):
        year = None
    if year is not None:
        year = max(1800, min(2200, year))
    return (
        {
            "movie_key": movie_key,
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


# --------------------------------------------------------------------------- #
#  Metadata / search                                                           #
# --------------------------------------------------------------------------- #
@app.route("/")
def health_check():
    return {"status": "online", "service": "vy-backend"}, 200


@app.route("/api/search", methods=["GET", "OPTIONS"])
def search_catalog():
    if request.method == "OPTIONS":
        return ("", 204)
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])
    results = tmdb.search_multi(query)
    catalog_service.ingest_tmdb_results(results)
    normalized = [tmdb.normalize_tmdb_item(i, i.get("media_type", "movie")) for i in results]
    return jsonify([n for n in normalized if n])


@app.route("/api/search/suggest", methods=["GET", "OPTIONS"])
def search_suggest():
    if request.method == "OPTIONS":
        return ("", 204)
    query = request.args.get("q", "").strip()
    if not query or len(query) < 2:
        return jsonify([])
    results = tmdb.search_multi(query)
    out = []
    for item in results[:8]:
        media_type = item.get("media_type")
        if media_type not in ("movie", "tv"):
            continue
        poster_path = item.get("poster_path")
        release = item.get("release_date") or item.get("first_air_date") or ""
        out.append({
            "id": str(item.get("id")),
            "title": item.get("title") or item.get("name") or "Untitled",
            "poster_url": f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else "",
            "year": release[:4] if len(release) >= 4 else "",
            "media_type": media_type,
        })
    return jsonify(out)


@app.route("/api/media/<id>", methods=["GET", "OPTIONS"])
def get_media_by_id(id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    tmdb_id = _parse_tmdb_id(id)
    if tmdb_id is None:
        return _json_error("Invalid TMDB ID", 400)

    movie_details = _tmdb_get(f"/movie/{tmdb_id}", {"append_to_response": "external_ids,credits,videos"})
    if movie_details:
        media_type, details = "movie", movie_details
    else:
        tv_details = _tmdb_get(f"/tv/{tmdb_id}", {"append_to_response": "external_ids,credits,videos"})
        if not tv_details:
            return _json_error(f"Media not found for ID {tmdb_id}", 404)
        media_type, details = "tv", tv_details

    release_date = details.get("release_date") or details.get("first_air_date", "")
    poster_path, backdrop_path = details.get("poster_path"), details.get("backdrop_path")
    result = {
        "id": str(tmdb_id),
        "title": details.get("title") or details.get("name"),
        "overview": details.get("overview") or "",
        "release_year": extract_year(release_date),
        "release_date": release_date,
        "vote_average": details.get("vote_average"),
        "imdb_id": details.get("external_ids", {}).get("imdb_id"),
        "genres": [g["name"] for g in details.get("genres", [])],
        "poster_url": _image_url(poster_path, "w500"),
        "backdrop_url": _image_url(backdrop_path, "w1280"),
        "popularity": details.get("popularity"),
        "runtime": details.get("runtime"),
        "media_type": media_type,
    }
    if media_type == "tv":
        seasons = [s for s in details.get("seasons", []) if s.get("season_number", 0) > 0]
        result["number_of_seasons"] = details.get("number_of_seasons") or len(seasons) or 1
        result["number_of_episodes"] = details.get("number_of_episodes") or 0
        result["seasons"] = seasons
    return jsonify(result)


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
    featured = [n for n in (tmdb.normalize_tmdb_item(i, i["media_type"]) for i in trending) if n][:18]
    recent = [n for n in (tmdb.normalize_tmdb_item(i, "movie") for i in popular_movies) if n][:24]
    popular = [n for n in (tmdb.normalize_tmdb_item(i, "tv") for i in popular_tv) if n][:24]
    return jsonify({"featured": featured, "recent": recent, "popular": popular})


@app.route("/api/trending", methods=["GET", "OPTIONS"])
def get_hero_trending():
    if request.method == "OPTIONS":
        return ("", 204)
    media_type = request.args.get("type", "all")
    time_window = request.args.get("time", "week")
    if time_window not in ("day", "week"):
        time_window = "week"
    if media_type not in ("all", "movie", "tv"):
        media_type = "all"
    data = _tmdb_get(f"/trending/{media_type}/{time_window}", {})
    if not data or "results" not in data:
        return _json_error("Failed to fetch trending metadata from TMDB", 502)
    out = []
    for item in data.get("results", []):
        item_type = item.get("media_type") or ("tv" if "first_air_date" in item else "movie")
        if item_type not in ("movie", "tv"):
            continue
        out.append({
            "id": str(item.get("id")),
            "title": item.get("title") or item.get("name") or "Untitled",
            "overview": item.get("overview", ""),
            "backdrop_url": _image_url(item.get("backdrop_path"), "original"),
            "poster_url": _image_url(item.get("poster_path"), "w500"),
            "vote_average": item.get("vote_average"),
            "release_date": item.get("release_date") or item.get("first_air_date") or "",
            "media_type": item_type,
        })
    return jsonify(out)


@app.route("/api/movies/trending", methods=["GET", "OPTIONS"])
def get_trending():
    if request.method == "OPTIONS":
        return ("", 204)
    time_window = request.args.get("time_window", "week")
    media_type = request.args.get("media_type", "all")
    if time_window not in ("day", "week"):
        time_window = "week"
    if media_type not in ("all", "movie", "tv"):
        media_type = "all"
    results = tmdb.get_trending_catalog(time_window, media_type)
    catalog_service.ingest_tmdb_results(results)
    normalized = [n for n in (tmdb.normalize_tmdb_item(i, i["media_type"]) for i in results) if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)
    return jsonify(normalized)


@app.route("/api/movies/popular", methods=["GET", "OPTIONS"])
def get_popular():
    if request.method == "OPTIONS":
        return ("", 204)
    media_type = request.args.get("media_type", "movie")
    page = request.args.get("page", 1, type=int)
    if media_type not in ("movie", "tv"):
        media_type = "movie"
    results = tmdb.get_popular(media_type, page)
    catalog_service.ingest_tmdb_results(results, media_type)
    normalized = [n for n in (tmdb.normalize_tmdb_item(i, media_type) for i in results) if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)
    return jsonify(normalized)


@app.route("/api/movies/now_playing", methods=["GET", "OPTIONS"])
def get_now_playing():
    if request.method == "OPTIONS":
        return ("", 204)
    page = request.args.get("page", 1, type=int)
    results = tmdb.get_now_playing(page)
    catalog_service.ingest_tmdb_results(results, "movie")
    normalized = [n for n in (tmdb.normalize_tmdb_item(i, "movie") for i in results) if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)
    return jsonify(normalized)


@app.route("/api/movies/on_the_air", methods=["GET", "OPTIONS"])
def get_on_the_air():
    if request.method == "OPTIONS":
        return ("", 204)
    page = request.args.get("page", 1, type=int)
    results = tmdb.get_on_the_air(page)
    catalog_service.ingest_tmdb_results(results, "tv")
    normalized = [n for n in (tmdb.normalize_tmdb_item(i, "tv") for i in results) if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)
    return jsonify(normalized)


@app.route("/api/catalog/discover", methods=["GET", "OPTIONS"])
def catalog_discover():
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
    return jsonify(catalog_service.discover(media_type=media_type, page=page, per_page=per_page, genre=genre))


@app.route("/api/catalog/search", methods=["GET", "OPTIONS"])
def catalog_search():
    if request.method == "OPTIONS":
        return ("", 204)
    query = request.args.get("q") or request.args.get("query") or ""
    media_type = request.args.get("media_type", "all")
    try:
        page = int(request.args.get("page", 1))
    except (TypeError, ValueError):
        page = 1
    return jsonify(catalog_service.search_media(query, media_type=media_type, page=page))


# --------------------------------------------------------------------------- #
#  Episodes / season                                                           #
# --------------------------------------------------------------------------- #
@app.route("/api/episodes", methods=["GET", "OPTIONS"])
def get_episode_details():
    if request.method == "OPTIONS":
        return ("", 204)
    parsed = _parse_tmdb_id(request.args.get("tmdb_id"))
    if parsed is None:
        return _json_error("Invalid ID", 400)
    season = request.args.get("season", 1, type=int)
    episode = request.args.get("episode", 1, type=int)

    cache_key = f"ep:{parsed}:{season}:{episode}"
    episode_data, hit = _season_cache_get(cache_key)
    if not hit or episode_data is None:
        try:
            episode_data = tmdb.fetch_episode_details(parsed, season, episode)
        except Exception as e:  # noqa: BLE001
            print(f"[Episode Fetch Error]: {e}")
            episode_data = None
        if episode_data:
            _season_cache_put(cache_key, episode_data)

    if not episode_data:
        return _json_error("Episode not found", 404)

    still_path = episode_data.get("still_path")
    return jsonify({
        "success": True,
        "episode": {
            "season": episode_data.get("season_number", season),
            "number": episode_data.get("episode_number", episode),
            "title": episode_data.get("name", f"Episode {episode}"),
            "overview": episode_data.get("overview", ""),
            "still_path": still_path,
            "still_url": _image_url(still_path, "w500"),
            "air_date": episode_data.get("air_date", ""),
            "runtime": episode_data.get("runtime"),
            "vote_average": episode_data.get("vote_average"),
        },
    })


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _build_season_payload(tmdb_id: int, season: int | None) -> dict | None:
    show = tmdb.fetch_media_details(tmdb_id, "tv")
    if not show:
        return None
    seasons = [s for s in (show.get("seasons") or []) if s.get("season_number", 0) > 0]
    if season is None:
        aired = [s for s in seasons if (s.get("air_date") or "") <= _today_iso()]
        pool = aired or seasons
        if not pool:
            return {"error": "No aired seasons"}
        season = max(s.get("season_number", 0) for s in pool)
    details = tmdb.fetch_season_details(tmdb_id, season)
    if not details:
        return {"error": "Season not found"}
    episodes = []
    for item in details.get("episodes") or []:
        still_path = item.get("still_path")
        episodes.append({
            "season": item.get("season_number", season),
            "number": item.get("episode_number"),
            "title": item.get("name") or f"Episode {item.get('episode_number')}",
            "overview": item.get("overview", ""),
            "still_path": still_path,
            "still_url": _image_url(still_path, "w500"),
            "air_date": item.get("air_date", ""),
            "runtime": item.get("runtime"),
            "vote_average": item.get("vote_average"),
        })
    return {
        "show": {"id": tmdb_id, "name": show.get("name") or "", "overview": show.get("overview", ""),
                 "poster_url": _image_url(show.get("poster_path"), "w500"),
                 "backdrop_url": _image_url(show.get("backdrop_path"), "w1280")},
        "season": {"number": details.get("season_number", season), "name": details.get("name") or "",
                   "episode_count": len(episodes), "poster_url": _image_url(details.get("poster_path"), "w500")},
        "episodes": episodes,
    }


@app.route("/api/season", methods=["GET", "OPTIONS"])
def get_season_details():
    if request.method == "OPTIONS":
        return ("", 204)
    parsed = _parse_tmdb_id(request.args.get("tmdb_id"))
    if parsed is None:
        return _json_error("Invalid ID", 400)
    raw_season = request.args.get("season")
    season = None
    if raw_season is not None:
        season = request.args.get("season", type=int)
        if season is None or season < 1:
            return _json_error("Invalid season", 400)
    cache_key = f"{parsed}:{'latest' if season is None else season}"
    payload, hit = _season_cache_get(cache_key)
    if not hit:
        payload = _build_season_payload(parsed, season)
        if payload and not payload.get("error"):
            _season_cache_put(cache_key, payload)
    if payload is None:
        return _json_error("Season not found", 404)
    if payload.get("error"):
        return _json_error(payload["error"], 404)
    return jsonify({"success": True, **payload})


# --------------------------------------------------------------------------- #
#  Trailer (site-agnostic)                                                     #
# --------------------------------------------------------------------------- #
def _pick_trailer(results: list) -> dict | None:
    def score(v):
        t = (v.get("type") or "").lower()
        s = 10 if t == "trailer" else 5 if t == "teaser" else 0
        s += 3 if v.get("official") else 0
        s += 2 if (v.get("site") or "").lower() == "youtube" else 0
        return s

    cands = [v for v in results if v.get("key") and v.get("site")]
    return max(cands, key=score) if cands else None


def _trailer_payload(video: dict | None) -> dict | None:
    if not video:
        return None
    site = (video.get("site") or "").lower()
    key = video.get("key")
    if site == "youtube":
        embed = f"https://www.youtube.com/embed/{key}?autoplay=1&rel=0"
    elif site == "vimeo":
        embed = f"https://player.vimeo.com/video/{key}?autoplay=1"
    else:
        embed = video.get("url") or ""
    return {"provider": site or "unknown", "id": key, "key": key, "embed_url": embed}


@app.route("/api/movies/trailer", methods=["GET", "OPTIONS"])
@app.route("/api/catalog/movieTrailer", methods=["GET", "OPTIONS"])
def get_trailer():
    """Trailer by id (+type) or by title (+year). Works for any video site."""
    if request.method == "OPTIONS":
        return ("", 204)
    raw_id = request.args.get("id")
    media_type = _normalize_media_type(request.args.get("type") or request.args.get("media_type") or "movie")

    if raw_id:
        tmdb_id = _parse_tmdb_id(raw_id)
        if not tmdb_id:
            return _json_error("Invalid id", 400)
    else:
        title = (request.args.get("title") or "").strip()
        if not title:
            return jsonify({"trailer": None}), 400
        results = tmdb.search_multi(title)
        valid = [r for r in results if r.get("media_type") in ("movie", "tv")]
        if not valid:
            return jsonify({"trailer": None}), 404
        target = valid[0]
        year = request.args.get("year")
        if year:
            for r in valid:
                rel = r.get("release_date") or r.get("first_air_date") or ""
                if rel.startswith(str(year)):
                    target = r
                    break
        tmdb_id = target.get("id")
        media_type = target.get("media_type", "movie")

    data = _tmdb_get(f"/{media_type}/{tmdb_id}/videos", {}) or {}
    payload = _trailer_payload(_pick_trailer(data.get("results", [])))
    return jsonify({"trailer": payload, "key": (payload or {}).get("key")})


# --------------------------------------------------------------------------- #
#  Playback — native HLS only                                                  #
# --------------------------------------------------------------------------- #
def _resolve_payload(tmdb_id: int, media_type: str, title: str, year, season: int, episode: int, runtime=None):
    """Run the resolver and shape a playable payload (all native, no iframes)."""
    resolution = stream_providers.resolve(
        _direct_source_for,
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=title,
        year=year,
        season=season,
        episode=episode,
        runtime=runtime,
    )
    if not resolution.ok:
        return None

    streams = resolution.streams
    default = streams[0]["url"] if streams else ""
    sources: list[str] = []
    for s in streams:
        if s["url"] not in sources:
            sources.append(s["url"])

    payload = {
        "success": True,
        "available": True,
        "activeSource": default,
        "sources": sources,
        "streams": streams,
        "mirrors": [{"name": s.get("label") or f"Server {i + 1}", "url": s["url"]}
                    for i, s in enumerate(streams)],
        "is_embed": False,
        "provider": resolution.provider,
    }
    if resolution.subtitles:
        payload["subtitles"] = resolution.subtitles
    return payload


@app.route("/api/movies/resolve", methods=["GET", "POST", "OPTIONS"])
def resolve_movie():
    if request.method == "OPTIONS":
        return ("", 204)

    payload = (request.get_json(silent=True) or {}) if request.method == "POST" else {}
    if not isinstance(payload, dict):
        return _json_error("Request body must be a JSON object.", 400)

    title = str(payload.get("title") or request.args.get("title", "")).strip()
    tmdb_id = payload.get("id") or payload.get("tmdb_id") or request.args.get("id")
    media_type = payload.get("media_type") or payload.get("type")
    year = payload.get("year") or request.args.get("year")
    try:
        season = int(payload.get("season") or request.args.get("season") or 1)
    except (TypeError, ValueError):
        season = 1
    try:
        episode = int(payload.get("episode") or request.args.get("episode") or 1)
    except (TypeError, ValueError):
        episode = 1

    if not title and not tmdb_id:
        return _json_error("Provide a title or a TMDB id.", 400)

    if tmdb_id:
        try:
            tmdb_id = int(tmdb_id)
        except (TypeError, ValueError):
            tmdb_id = None

    if not tmdb_id and title:
        results = tmdb.search_multi(title)
        valid = [r for r in results if r.get("media_type") in ("movie", "tv")]
        if valid:
            top = valid[0]
            tmdb_id = top["id"]
            media_type = top.get("media_type", "movie")
            title = top.get("title") or top.get("name") or title
            year = year or (top.get("release_date") or top.get("first_air_date") or "")[:4]

    if not tmdb_id:
        return _json_error(f"Could not find metadata for '{title}'", 404)

    media_type = _normalize_media_type(media_type)
    details = tmdb.fetch_media_details(tmdb_id, media_type)
    if not details:
        return _json_error(f"Could not fetch details for '{title}'", 404)

    if media_type == "tv":
        seasons_count = details.get("number_of_seasons", 1)
        season_details = _tmdb_get(f"/tv/{tmdb_id}/season/{season}", {}) or {}
        episodes = season_details.get("episodes", [])
        episodes_count = len(episodes) if episodes else 10
        if not year and details.get("release_date"):
            year = details["release_date"][:4]
        title_for_direct = details.get("name") or details.get("original_name") or title
        year_for_direct = None
    else:
        seasons_count = episodes_count = 1
        if not year and details.get("release_date"):
            year = details["release_date"][:4]
        title_for_direct = details.get("title") or title
        year_for_direct = year

    runtime = details.get("runtime")
    try:
        runtime = int(runtime) if runtime is not None else None
    except (TypeError, ValueError):
        runtime = None

    play = _resolve_payload(tmdb_id, media_type, title_for_direct, year_for_direct, season, episode, runtime)

    director = details.get("director")
    cast = details.get("cast", [])
    if not director and details.get("credits"):
        director, cast = tmdb.extract_director_and_cast(details.get("credits", {}))
    country = details.get("country")
    language = details.get("language")
    if not country or not language:
        ec, el = tmdb.extract_country_and_language(details)
        country = country or ec
        language = language or el

    movie_data = {
        "id": str(tmdb_id),
        "title": details.get("title") or title,
        "stream_url": (play or {}).get("activeSource", ""),
        "is_available": bool(play),
        "available": bool(play),
        "is_embed": False,
        "providers": (play or {}).get("sources", []),
        "streams": (play or {}).get("streams", []),
        "subtitles": (play or {}).get("subtitles", []),
        "year": str(year) if year else "",
        "media_type": media_type,
        "season": season if media_type == "tv" else 1,
        "episode": episode if media_type == "tv" else 1,
        "seasons": seasons_count,
        "episodes_per_season": episodes_count,
        "poster_url": details.get("poster_url", ""),
        "backdrop_url": details.get("backdrop_url", ""),
        "overview": details.get("overview", ""),
        "vote_average": details.get("vote_average"),
        "popularity": details.get("popularity"),
        "genres": details.get("genres", []),
        "runtime": runtime,
        "director": director,
        "cast": cast,
        "country": country,
        "language": language,
        "release_date": details.get("release_date"),
    }
    if media_type == "tv" and details.get("episodes"):
        movie_data["episodes"] = details["episodes"]

    return jsonify({"movie": movie_data, "exact": True, "available": bool(play)})


@app.route("/api/get-stream", methods=["GET", "OPTIONS"])
def get_stream_direct():
    if request.method == "OPTIONS":
        return ("", 204)

    parsed = _parse_tmdb_id(request.args.get("tmdb_id") or request.args.get("id"))
    if parsed is None:
        return _json_error("Invalid ID", 400)
    tmdb_id = parsed
    media_type = _normalize_media_type(request.args.get("media_type", "movie"))
    is_tv = media_type == "tv"

    try:
        episode_number = max(1, int(request.args.get("episode", 1)))
    except (TypeError, ValueError):
        episode_number = 1
    try:
        season_number = max(1, int(request.args.get("season", 1)))
    except (TypeError, ValueError):
        season_number = 1

    title, year, runtime_hint = "", None, None
    if not is_tv:
        details = _tmdb_get(f"/movie/{tmdb_id}", {}) or {}
        title = details.get("title") or ""
        if details.get("release_date"):
            year = details["release_date"][:4]
        runtime_hint = details.get("runtime")

    play = _resolve_payload(tmdb_id, media_type, title, year, season_number, episode_number, runtime_hint)
    if not play:
        return _json_error("No source could play this title.", 503, available=False)
    return jsonify(play)


@app.route("/api/movies/stream", methods=["GET", "OPTIONS"])
def stream_relay():
    """Same-origin relay for Archive.org bytes (CORS + range safe)."""
    if request.method == "OPTIONS":
        return ("", 204)
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing url parameter"}), 400
    try:
        status, headers, body = catalog_lib.open_archive_stream(url, request.headers.get("Range"))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:  # noqa: BLE001
        return jsonify({"error": f"Stream unavailable: {error}"}), 502
    response = Response(body or "", status=status)
    for key, value in headers.items():
        response.headers[key] = value
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


DOWNLOAD_NAME_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f"\\/:;*?<>|]')


def _safe_download_name(raw: str | None, fallback: str) -> str:
    candidate = DOWNLOAD_NAME_FORBIDDEN.sub("", raw or "").strip().strip(". ")
    candidate = re.sub(r"\s+", " ", candidate).strip()
    return candidate[:120] or fallback


@app.route("/api/movies/download", methods=["GET"])
@app.route("/api/v1/stream/download", methods=["GET"])
def movie_download():
    url = (request.args.get("url") or "").strip()
    if not url:
        return _json_error("Missing url", 400)
    fallback = os.path.basename(urllib.parse.urlparse(url).path) or "video"
    filename = _safe_download_name(request.args.get("filename"), fallback)
    try:
        status, headers, body = catalog_lib.open_archive_stream(url, None)
    except ValueError as error:
        return _json_error(str(error), 400)
    except Exception:  # noqa: BLE001
        return _json_error("Download source unavailable", 502)
    response = Response(body, status=status)
    for key, value in headers.items():
        if key.lower() != "content-disposition":
            response.headers[key] = value
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip() or "video"
    quoted = urllib.parse.quote(filename)
    response.headers["Content-Disposition"] = f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'
    response.headers["Cache-Control"] = "private, no-store"
    return response


@app.route("/api/subtitles", methods=["GET"])
def proxy_subtitles():
    """Archive.org subtitle -> WebVTT (kept for the archive tier)."""
    url = (request.args.get("url") or "").strip()
    if not url:
        return _json_error("Missing url", 400)
    try:
        text = catalog_lib.fetch_bounded_text(url, 15, 4 * 1024 * 1024)
    except ValueError as error:
        return _json_error(str(error), 400 if "archive.org" in str(error) else 502)
    except urllib.error.HTTPError as exc:
        return _json_error(f"Subtitle upstream returned {exc.code}", 502)
    except (urllib.error.URLError, TimeoutError, OSError):
        return _json_error("Subtitle upstream unavailable", 502)
    is_srt = urllib.parse.urlparse(url).path.lower().endswith(".srt")
    if is_srt or not text.lstrip("\ufeff").lstrip().upper().startswith("WEBVTT"):
        text = catalog_lib.srt_to_vtt(text)
    response = Response(text, mimetype="text/vtt")
    response.headers["Content-Type"] = "text/vtt; charset=utf-8"
    response.headers["Cache-Control"] = "public, max-age=300"
    return response


@app.route("/api/debug/providers")
def debug_providers():
    return jsonify({
        "tiers": ["extract", "archive"],
        "archive_first": stream_providers.ARCHIVE_FIRST,
        "extractors": [n for n, _ in __import__("extractors")._chain()],
    })


# --------------------------------------------------------------------------- #
#  Accounts                                                                    #
# --------------------------------------------------------------------------- #
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
        return jsonify({"error": "An error occurred during account creation. Please try again."}), 500
    return jsonify({"success": True, "token": token, "user": authdb.serialize_user(user)}), 201


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
        ok = store.verify_password(user, password) if user else False
        if not user or not ok:
            return _auth_error("Incorrect email or password.")
        token = store.create_session(user["id"])
    except Exception:
        app.logger.exception("login failed for %s", email)
        return jsonify({"error": "An error occurred during sign in. Please try again."}), 500
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


@app.route("/api/auth/account", methods=["DELETE", "OPTIONS"])
def api_delete_account():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to delete your account.")
    payload = request.get_json(silent=True) or {}
    if str(payload.get("email") or "").strip().lower() != str(user["email"]).lower():
        return _auth_error("Confirm the email address on the account.", 400)
    if not str(payload.get("password") or ""):
        return _auth_error("Enter your password to delete the account.", 400)
    if not authdb.get_store().verify_password(user, str(payload.get("password"))):
        return _auth_error("That password did not match.", 401)
    try:
        deleted = authdb.get_store().delete_user(user["id"])
    except Exception:
        app.logger.exception("account deletion failed")
        return _auth_error("Could not delete the account. Try again.", 500)
    if not deleted:
        return _auth_error("Could not delete the account. Try again.", 500)
    return jsonify({"success": True})


# --------------------------------------------------------------------------- #
#  Profiles                                                                    #
# --------------------------------------------------------------------------- #
def _serialize_profile(profile: dict) -> dict:
    return {
        "id": profile["id"],
        "name": profile.get("name") or "",
        "avatar": profile.get("avatar") or "",
        "avatar_id": profile.get("avatar_id"),
        "is_kids": bool(profile.get("is_kids")),
        "is_locked": bool(profile.get("is_locked")),
        "sort_order": profile.get("sort_order") or 0,
    }


@app.route("/api/profiles", methods=["GET", "POST", "OPTIONS"])
def api_profiles():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage profiles.")
    store = authdb.get_store()
    if request.method == "GET":
        return jsonify({"profiles": [_serialize_profile(p) for p in store.list_profiles(user["id"])],
                        "max": store.MAX_PROFILES})
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 40:
        return _auth_error("Enter a name of 1 to 40 characters.", 400)
    pin = str(payload.get("pin") or "")
    if pin and not re.match(r"^\d{4,8}$", pin):
        return _auth_error("A PIN must be 4 to 8 digits.", 400)
    if store.count_profiles(user["id"]) >= store.MAX_PROFILES:
        return _auth_error(f"A home can have up to {store.MAX_PROFILES} profiles.", 409)
    pin_hash = pin_salt = None
    if pin:
        pin_salt = secrets.token_hex(16)
        pin_hash = store.hash_secret(pin, pin_salt)
    try:
        profile = store.create_profile(user["id"], name,
                                       avatar=str(payload.get("avatar") or "")[:400],
                                       avatar_id=(str(payload.get("avatar_id"))[:40] or None),
                                       is_kids=1 if payload.get("is_kids") else 0,
                                       pin_hash=pin_hash, pin_salt=pin_salt)
    except Exception:
        app.logger.exception("profile create failed")
        return _auth_error("Could not create the profile. Try again.", 500)
    if not profile:
        return _auth_error(f"A home can have up to {store.MAX_PROFILES} profiles.", 409)
    return jsonify({"profile": _serialize_profile(profile)}), 201


@app.route("/api/profiles/<profile_id>", methods=["PATCH", "DELETE", "OPTIONS"])
def api_profile_item(profile_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage profiles.")
    store = authdb.get_store()
    if not store.profile_by_id(profile_id, user["id"]):
        return _auth_error("Unknown profile.", 404)
    if request.method == "DELETE":
        store.delete_profile(profile_id, user["id"])
        return jsonify({"success": True})
    payload = request.get_json(silent=True) or {}
    updates = {}
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name or len(name) > 40:
            return _auth_error("Enter a name of 1 to 40 characters.", 400)
        updates["name"] = name
    if "avatar" in payload:
        updates["avatar"] = str(payload.get("avatar") or "")[:400]
    if "avatar_id" in payload:
        updates["avatar_id"] = str(payload.get("avatar_id") or "")[:40] or None
    if "is_kids" in payload:
        updates["is_kids"] = 1 if payload.get("is_kids") else 0
    if "pin" in payload:
        pin = str(payload.get("pin") or "")
        if pin and not re.match(r"^\d{4,8}$", pin):
            return _auth_error("A PIN must be 4 to 8 digits.", 400)
        if pin:
            salt = secrets.token_hex(16)
            updates.update(pin_salt=salt, pin_hash=store.hash_secret(pin, salt), is_locked=1)
        else:
            updates.update(pin_hash=None, pin_salt=None, is_locked=0)
    try:
        updated = store.update_profile(profile_id, user["id"], **updates)
    except Exception:
        app.logger.exception("profile update failed")
        return _auth_error("Could not update the profile. Try again.", 500)
    return jsonify({"profile": _serialize_profile(updated)})


@app.route("/api/profiles/<profile_id>/unlock", methods=["POST", "OPTIONS"])
def api_profile_unlock(profile_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to unlock this profile.")
    store = authdb.get_store()
    profile = store.profile_by_id(profile_id, user["id"])
    if not profile:
        return _auth_error("Unknown profile.", 404)
    if not profile.get("is_locked"):
        return jsonify({"ok": True})
    pin = str((request.get_json(silent=True) or {}).get("pin") or "")
    if not store.verify_secret(pin, profile.get("pin_hash") or "", profile.get("pin_salt") or ""):
        return _auth_error("Incorrect PIN.", 401)
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
#  Allowance / referrals                                                       #
# --------------------------------------------------------------------------- #
def _allowance_payload(store, user, profile):
    day = authdb.utc_today()
    data = store.allowance(user["id"], profile["id"], day)
    reset = (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)).replace(tzinfo=timezone.utc)
    data["resets_at"] = reset.isoformat()
    data["timezone"] = "UTC"
    return data


@app.route("/api/allowance", methods=["GET", "OPTIONS"])
def api_allowance():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to see your daily allowance.")
    store = authdb.get_store()
    profiles = store.list_profiles(user["id"])
    if not profiles:
        reset = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        return jsonify({"allowance": {"used": 0, "remaining": 0, "per_profile_cap": 0, "account_cap": 0,
                                      "account_used": 0, "unlocked": False, "unlimited": False,
                                      "resets_at": reset.isoformat(), "timezone": "UTC"}, "profiles": []})
    active = _resolve_profile(user)
    if active is False or not isinstance(active, dict):
        active = profiles[0]
    payload = _allowance_payload(store, user, active)
    payload["profile_id"] = active["id"]
    return jsonify({"allowance": payload,
                    "profiles": [dict(_allowance_payload(store, user, p), profile_id=p["id"]) for p in profiles]})


@app.route("/api/allowance/claim", methods=["POST", "OPTIONS"])
def api_allowance_claim():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to start watching.")
    store = authdb.get_store()
    payload = request.get_json(silent=True) or {}
    profile = _resolve_profile(user, payload)
    if profile is False:
        return _auth_error("Unknown profile.", 403)
    if not profile:
        return _auth_error("Create a profile to start watching.", 409)
    movie_key = str(payload.get("movie_key") or "").strip()[:200]
    if not movie_key:
        return _auth_error("Missing a valid title.", 400)
    day = authdb.utc_today()
    if store.has_unlocked_day(user["id"], day):
        store.record_play(profile["id"], day, movie_key, user["id"], enforce_caps=False)
        return jsonify({"ok": True, "claimed": True, "allowance": _allowance_payload(store, user, profile)})
    claimed = store.record_play(profile["id"], day, movie_key, user["id"])
    if not claimed and not store.claimed_today(profile["id"], day, movie_key):
        return jsonify({"error": "You have used today's free titles. Refer a friend to unlock more.",
                        "code": "daily_limit", "allowance": _allowance_payload(store, user, profile)}), 429
    return jsonify({"ok": True, "claimed": claimed, "allowance": _allowance_payload(store, user, profile)})


@app.route("/api/referrals", methods=["GET", "OPTIONS"])
def api_referrals():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to refer friends.")
    store = authdb.get_store()
    stats = store.referral_stats(user["id"])
    day = authdb.utc_today()
    return jsonify({"code": stats["code"], "accepted": stats["accepted"], "granted_days": stats["granted_days"],
                    "unlocked_today": store.has_unlocked_day(user["id"], day),
                    "unlocks_per_referral": authdb.REFERRAL_UNLOCKS_PER_ACCEPT, "day": day})


@app.route("/api/referrals/apply", methods=["POST", "OPTIONS"])
def api_referrals_apply():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to use a referral code.")
    store = authdb.get_store()
    code = str((request.get_json(silent=True) or {}).get("code") or "").strip().upper()
    if not re.match(r"^LM[A-Z0-9]{8}$", code):
        return _auth_error("That referral code is not valid.", 400)
    if not store.accept_referral(user["id"], code):
        return _auth_error("That code has already been used, or it is your own.", 409)
    inviter_id = store.referrer_of(user["id"])
    for recipient in [user["id"], inviter_id]:
        if recipient is None:
            continue
        day = authdb.utc_today()
        for offset in range(0, authdb.REFERRAL_UNLOCKS_PER_ACCEPT):
            target = (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1 + offset)).strftime("%Y-%m-%d")
            if not store.has_unlocked_day(recipient, target):
                store.grant_day(recipient, target)
    stats = store.referral_stats(user["id"])
    return jsonify({"success": True, "code": stats["code"], "accepted": stats["accepted"],
                    "granted_days": stats["granted_days"]})


# --------------------------------------------------------------------------- #
#  History / my-list                                                           #
# --------------------------------------------------------------------------- #
@app.route("/api/auth/history", methods=["GET", "POST", "DELETE", "OPTIONS"])
def api_history():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to sync your watch history.")
    store = authdb.get_store()
    user_id = user["id"]
    payload = request.get_json(silent=True) or {}
    profile = _resolve_profile(user, payload)
    if profile is False:
        return _auth_error("Unknown profile.", 403)
    profile_id = profile["id"] if profile else None
    if request.method == "DELETE":
        store.clear_history(user_id, profile_id)
        return jsonify({"success": True})
    if request.method == "POST":
        fields, problem = _clean_history_fields(payload)
        if problem:
            return _auth_error(problem, 400)
        store.add_history(user_id, fields["movie_key"], fields, profile_id)
        return jsonify({"success": True})
    return jsonify({"history": store.history(user_id, profile_id=profile_id), "profile_id": profile_id})


@app.route("/api/auth/history/<path:movie_key>", methods=["DELETE", "OPTIONS"])
def api_history_remove(movie_key: str):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage your watch history.")
    payload = request.get_json(silent=True) or {}
    profile = _resolve_profile(user, payload)
    if profile is False:
        return _auth_error("Unknown profile.", 403)
    authdb.get_store().remove_history(user["id"], movie_key, profile["id"] if profile else None)
    return jsonify({"success": True})


@app.route("/api/auth/my-list", methods=["GET", "POST", "DELETE", "OPTIONS"])
def api_my_list():
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
        added = store.add_saved_media(user_id, media_id,
                                      _normalize_media_type(payload.get("media_type") or "movie"),
                                      str(payload.get("title") or "").strip(),
                                      payload.get("poster_path") or payload.get("poster_url") or None)
        return jsonify({"success": True, "added": added})
    return jsonify({"items": store.saved_media(user_id)})


@app.route("/api/auth/my-list/<int:media_id>", methods=["DELETE", "OPTIONS"])
def api_my_list_remove(media_id: int):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage your saved list.")
    authdb.get_store().remove_saved_media(user["id"], media_id)
    return jsonify({"success": True})


# --------------------------------------------------------------------------- #
#  Shares                                                                      #
# --------------------------------------------------------------------------- #
MAX_PENDING_INVITES = 20


def _share_view(invite: dict, include_email: bool) -> dict:
    return {"token": invite.get("token"), "email": invite.get("email") if include_email else None,
            "role": invite.get("role") or "viewer", "status": invite.get("status") or "pending",
            "created_at": authdb._to_iso(invite.get("created_at")),
            "expires_at": authdb._to_iso(invite.get("expires_at")),
            "accepted_at": authdb._to_iso(invite.get("accepted_at"))}


def _member_views(store, owner_id, requester_id) -> list[dict]:
    is_owner = str(owner_id) == str(requester_id)
    return [{"user_id": str(r.get("user_id")), "display_name": r.get("display_name") or "Viewer",
             "role": r.get("role") or "viewer", "email": r.get("email") if is_owner else None,
             "joined_at": authdb._to_iso(r.get("created_at"))} for r in store.share_members_of(owner_id)]


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
        for existing in store.share_invites_for_owner(owner_id):
            if ((existing.get("status") or "") == "pending" and (existing.get("email") or "") == (email or "")
                    and (existing.get("role") or "viewer") == role):
                return jsonify({"share": _share_view(existing, True), "reused": True})
        if store.count_pending_invites(owner_id) >= MAX_PENDING_INVITES:
            return _auth_error("You have too many active invites. Revoke one first.", 429)
        return jsonify({"share": _share_view(store.create_share_invite(owner_id, email=email, role=role), True),
                        "reused": False})
    return jsonify({
        "invites": [_share_view(i, True) for i in store.share_invites_for_owner(owner_id)],
        "members": _member_views(store, owner_id, owner_id),
        "shared_with_me": [{"owner_id": str(r.get("owner_id")), "owner_name": r.get("display_name") or "Someone",
                            "role": r.get("role") or "viewer"} for r in store.shared_profiles_for_user(owner_id)],
    })


@app.route("/api/auth/shares/<string:token>", methods=["GET", "OPTIONS"])
def api_share_preview(token: str):
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
    owner = store.user_by_id(invite.get("owner_id"))
    items = store.saved_media(invite.get("owner_id"), limit=200)
    payload = {"inviter_name": (owner or {}).get("display_name") or "Someone", "item_count": len(items),
               "role": invite.get("role") or "viewer", "expires_at": authdb._to_iso(invite.get("expires_at"))}
    viewer = _auth_user()
    if viewer:
        payload["already_member"] = store.is_share_member(invite.get("owner_id"), viewer["id"])
        payload["is_owner"] = str(invite.get("owner_id")) == str(viewer["id"])
    return jsonify(payload)


@app.route("/api/auth/shares/<string:token>/accept", methods=["POST", "OPTIONS"])
def api_share_accept(token: str):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to accept this invite.")
    invite, _ = authdb.get_store().accept_share_invite(token, user["id"], user.get("email") or "")
    if invite is None:
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
    owner_id = (store.share_invite_by_token(token) or {}).get("owner_id")
    if not owner_id:
        return _auth_error("This invite link is not valid.", 404)
    if str(owner_id) != str(user["id"]) and not store.is_share_member(owner_id, user["id"]):
        return _auth_error("You do not have access to this list.", 403)
    return jsonify({"members": _member_views(store, owner_id, user["id"])})


@app.route("/api/auth/shares/<string:token>/members/<string:member_id>", methods=["DELETE", "OPTIONS"])
def api_share_remove_member(token: str, member_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to manage sharing.")
    store = authdb.get_store()
    owner_id = (store.share_invite_by_token(token) or {}).get("owner_id")
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
    return jsonify({"items": store.saved_media(owner_id),
                    "owner": (owner or {}).get("display_name") or "Someone"})


# --------------------------------------------------------------------------- #
#  Taste / recommendations                                                     #
# --------------------------------------------------------------------------- #
def _taste_payload() -> tuple[dict | None, dict | None, object]:
    user = _auth_user()
    if not user:
        return None, None, {}
    payload = request.get_json(silent=True) or {}
    raw = payload.get("profile_id") or request.args.get("profile_id")
    if raw in (None, ""):
        profiles = authdb.get_store().list_profiles(user["id"])
        return user, (profiles[0] if len(profiles) == 1 else None), payload
    return user, authdb.get_store().profile_by_id(raw, user["id"]) or False, payload


def _clamp_int(raw, default: int, low: int, high: int) -> int:
    if raw in (None, ""):
        return default
    try:
        return max(low, min(high, int(str(raw).strip())))
    except (TypeError, ValueError):
        return default


@app.route("/api/taste", methods=["POST", "OPTIONS"])
def api_taste():
    if request.method == "OPTIONS":
        return ("", 204)
    user, profile, payload = _taste_payload()
    if not user:
        return _auth_error("Sign in to personalise your feed.")
    if profile is False:
        return _auth_error("Unknown profile.", 403)
    if not profile:
        return _auth_error("Create a profile to personalise your feed.", 409)
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in taste.KIND_WEIGHTS:
        return _auth_error("Unknown interaction type.", 400)
    store = authdb.get_store()
    profile_id = profile["id"]

    if kind == "search":
        query = str(payload.get("query") or "")
        key = taste.query_feature_key(query)
        if not key:
            return jsonify({"ok": True, "recorded": False})
        count = store.bump_search_token(profile_id, key)
        if count < taste.SEARCH_TOKEN_MIN_HITS or not taste.tokenise_query(query):
            return jsonify({"ok": True, "recorded": True, "applied": False})
        repeat_weight = store.search_token_weight(profile_id, key) or float(count)
        state = taste.fold_event_with_director(store.load_taste_state(profile_id), "search", [f"q:{key}"], [], weight=repeat_weight)
        store.save_taste_state(profile_id, state)
        return jsonify({"ok": True, "recorded": True, "applied": True})

    genres = payload.get("genres") or payload.get("genre") or []
    people = payload.get("people") or []
    cast = payload.get("cast") or []
    director = payload.get("director")
    if isinstance(genres, str):
        genres = [genres]
    genres = genres if isinstance(genres, list) else []
    people = people if isinstance(people, list) else []
    cast = cast if isinstance(cast, list) else []
    named = [str(p).strip() for p in (list(people) + list(cast)) if str(p).strip()]
    named = [p for p in named if p.lower() != str(director or "").strip().lower()][:3]
    if director:
        named.append(str(director).strip())
    weight = float(payload.get("weight") or 1.0)
    store.record_taste_event(profile_id, kind, genres=[str(g).strip() for g in genres][:8],
                             people=named, media_key=(str(payload.get("media_key"))[:200] or None), weight=weight)
    state = taste.fold_event_with_director(store.load_taste_state(profile_id), kind,
                                           [str(g).strip() for g in genres][:8], named, weight=weight)
    store.save_taste_state(profile_id, state)
    return jsonify({"ok": True, "recorded": True, "applied": True})


def _taste_state_payload(store, profile_id, state):
    return {"profile_id": profile_id, "state": state,
            "model_version": store.model_version(profile_id) or "linear-v1",
            "has_signal": taste.has_signal(state),
            "event_count": len(store.taste_events(profile_id))}


@app.route("/api/taste/state", methods=["GET", "POST", "OPTIONS"])
def api_taste_state():
    if request.method == "OPTIONS":
        return ("", 204)
    user, profile, _ = _taste_payload()
    if not user:
        return _auth_error("Sign in to see your profile.")
    if profile is False:
        return _auth_error("Unknown profile.", 403)
    if not profile:
        return _auth_error("Create a profile to personalise your feed.", 409)
    store = authdb.get_store()
    profile_id = profile["id"]
    if request.method == "POST":
        state = taste.empty_weights()
        for event in reversed(store.taste_events(profile_id)):
            state = taste.fold_event_with_director(state, event.get("kind", "play"),
                                                   [g for g in (event.get("genres") or "").split(",") if g],
                                                   [p for p in (event.get("people") or "").split(",") if p],
                                                   weight=event.get("weight", 1.0))
        for feature, hits in store.search_token_hits(profile_id).items():
            if hits < taste.SEARCH_TOKEN_MIN_HITS:
                continue
            state = taste.fold_event_with_director(state, "search", [f"q:{feature}"], [], weight=float(hits))
        store.save_taste_state(profile_id, state)
        return jsonify(dict(_taste_state_payload(store, profile_id, state), rebuilt=True))
    return jsonify(_taste_state_payload(store, profile_id, store.load_taste_state(profile_id)))


@app.route("/api/recommendations", methods=["GET", "OPTIONS"])
def api_recommendations():
    if request.method == "OPTIONS":
        return ("", 204)
    user, profile, _ = _taste_payload()
    page = _clamp_int(request.args.get("page"), 1, 1, 5)
    limit = _clamp_int(request.args.get("limit"), 20, 1, 40)
    kind = (request.args.get("kind") or "trending").strip().lower()
    if kind == "popular":
        items = tmdb.get_popular("movie", page) or []
    elif kind == "now_playing":
        items = tmdb.get_now_playing(page) or []
    else:
        items = tmdb.get_trending_catalog("week", "all") or []
    items = [tmdb.normalize_tmdb_item(i, i.get("media_type") or "movie") for i in items]
    items = [i for i in items if i]
    if not user or profile is False or not profile:
        return jsonify({"results": items[:limit], "personalised": False})
    store = authdb.get_store()
    state = store.load_taste_state(profile["id"])
    if not taste.has_signal(state):
        return jsonify({"results": items[:limit], "personalised": False})
    scores = taste.ranked_scores(state, items)
    if max(scores) <= 0.0:
        return jsonify({"results": items[:limit], "personalised": False})
    return jsonify({"results": taste.rank(state, items)[:limit], "personalised": True,
                    "top_score": round(max(scores), 4),
                    "model_version": store.model_version(profile["id"]) or "linear-v1"})


@app.route("/api/recommendations/eval", methods=["GET", "OPTIONS"])
def api_recommendations_eval():
    if request.method == "OPTIONS":
        return ("", 204)
    user, profile, _ = _taste_payload()
    if not user:
        return _auth_error("Sign in to see your evaluation.")
    if profile is False:
        return _auth_error("Unknown profile.", 403)
    if not profile:
        return _auth_error("Create a profile first.", 409)
    return jsonify(taste.evaluate(authdb.get_store().taste_events(profile["id"])))


# --------------------------------------------------------------------------- #
#  Admin                                                                       #
# --------------------------------------------------------------------------- #
def _admin_emails() -> set[str]:
    return {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}


@app.route("/api/admin/system/metrics", methods=["GET", "OPTIONS"])
def api_admin_metrics():
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user or user["email"].lower() not in _admin_emails():
        return _auth_error("Admins only.", 403)
    return jsonify({
        "tiers": ["extract", "archive"],
        "archive_first": stream_providers.ARCHIVE_FIRST,
        "direct_cache": len(_direct_source_cache),
        "season_cache": len(_season_cache),
    })


# --------------------------------------------------------------------------- #
#  Entrypoint — MUST stay last                                                 #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    _debug = os.environ.get("FLASK_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
    _host = "127.0.0.1" if _debug else "0.0.0.0"

    from werkzeug.serving import WSGIRequestHandler

    class _QuietRequestHandler(WSGIRequestHandler):
        def version_string(self) -> str:
            return "stream-vy"

    app.run(host=_host, port=int(os.environ.get("PORT", "5000")), debug=_debug,
            request_handler=_QuietRequestHandler)