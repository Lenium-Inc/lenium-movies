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

import requests
from datetime import datetime, timedelta, timezone

from flask import Flask, Response, jsonify, redirect, request, stream_with_context
from werkzeug.exceptions import HTTPException

from cachetools import TTLCache

# Loaded first so the dotenv file is present before any module reads a secret.
from runtime_config import load_env_file, ssl_context, tmdb_api_key

load_env_file()

import authdb
import caption_engine
import catalog_lib
import catalog_service
import geo_locale
import hls_proxy
import playback_tokens
import proxy_util
import stream_providers
import taste
import telemetry
import tmdb_service as tmdb
from proxy_util import format_of_handle, playable, playable_sub, raw_url_of

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
#: Every module-level cache below is a `TTLCache` with this `maxsize`. The
#: service is capped at 512 MB of RAM on Render, and these caches are keyed by
#: something a client controls (a normalised title), so an unbounded dict is a
#: slow OOM: one entry per distinct title anyone ever asked for, each holding a
#: nested payload, for the life of the worker. The bound plus a TTL makes the
#: worst case a fixed number of entries regardless of traffic.
CACHE_MAX_SIZE = 1000
#: TTL for a cache entry whose staleness is harmless if it lingers.
CACHE_TTL_SECONDS = 3600
_direct_hit_cache: TTLCache = TTLCache(maxsize=CACHE_MAX_SIZE, ttl=CACHE_TTL_SECONDS)
_direct_miss_cache: TTLCache = TTLCache(maxsize=CACHE_MAX_SIZE, ttl=_MISS_TTL_SECONDS)
_direct_source_locks: dict[str, threading.Lock] = {}
_direct_source_globals = threading.Lock()


# A hit and a miss are cached in separate containers because they have opposite
# expiry requirements. A miss must be short-lived: it is a claim that this title
# has no direct source, and the frontend's fallback loop retries with
# refresh=True precisely because it expects that answer to change. A hit can be
# long-lived, because an archive item that resolved once keeps resolving.
#
# A single dict -- which is what this was -- can only carry one TTL, and the
# longer of the two was the one being paid. Negative caching is the reason the
# refresh storm was ever bounded in the first place, so it keeps the short TTL.
#


def _direct_lock_for(key: str) -> threading.Lock:
    with _direct_source_globals:
        lock = _direct_source_locks.get(key)
        if lock is None:
            # The lock map is keyed by the same titles as the caches, so it needs
            # the same bound. `TTLCache` cannot own it -- the lock has to outlive
            # the cache entry it guards, because a scrape in progress must finish
            # even if its result is evicted -- so it is capped directly, and only
            # when it is actually over. A lock is ~50 bytes against a ~92 MB
            # memory budget, so the cap is set generously above the cache's.
            if len(_direct_source_locks) > 2 * CACHE_MAX_SIZE:
                for stale in list(_direct_source_locks)[: CACHE_MAX_SIZE]:
                    _direct_source_locks.pop(stale, None)
            lock = threading.Lock()
            _direct_source_locks[key] = lock
        return lock


def _direct_cache_get(key: str, refresh: bool) -> tuple[bool, dict | None]:
    """Return (hit, value). A refresh bypasses a live hit but not a
    just-recorded miss -- otherwise the refresh storm is unbounded again.

    Membership is tested rather than truthiness so that a recorded miss counts
    as a hit in both modes: a caller that is not refreshing has no reason to
    re-scrape a title it has already been told is unavailable, and it certainly
    has no reason to do the scrape twice concurrently.
    """
    with _direct_source_globals:
        if refresh:
            if key in _direct_miss_cache:
                return True, None
        else:
            if key in _direct_hit_cache:
                return True, _direct_hit_cache[key]
            if key in _direct_miss_cache:
                return True, None
    return False, None


def _direct_cache_put(key: str, value: dict | None) -> None:
    with _direct_source_globals:
        if value is None:
            _direct_miss_cache[key] = None
        else:
            _direct_hit_cache[key] = value


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


def _exact_title_match(results: list[dict], title: str, year) -> dict | None:
    """The one search result that *is* the requested title, or `None`.

    Matching is on the normalised form the direct catalog already compares
    with -- lowercase, punctuation and years stripped, stopwords dropped -- so
    "The Fast and the Furious" and "Fast & Furious" score the same film while
    "No Greater Love" and "Son of Samson" do not, no matter where either sits
    in TMDB's ranking.

    The year then has to survive `accept_candidate`, which is the same trust
    check `_find_catalog_entry` applies: a known year with a contradicting
    candidate rejects the candidate, and an unknown candidate year is only
    admitted because the title matched exactly. Absence of evidence is not
    evidence of a different film; a contradiction is.

    `None` means "nothing here is that title", and the caller turns that into a
    404. It never means "take the first one".
    """
    wanted = catalog_lib.normalize_title(title)
    if not wanted:
        return None
    try:
        requested_year = int(year) if year else None
    except (TypeError, ValueError):
        requested_year = None

    for candidate in results:
        name = candidate.get("title") or candidate.get("name") or ""
        if catalog_lib.normalize_title(name) != wanted:
            continue
        release = candidate.get("release_date") or candidate.get("first_air_date") or ""
        raw = release[:4]
        candidate_year = int(raw) if raw.isdigit() else None
        if catalog_lib.accept_candidate(requested_year, candidate_year, 1.0):
            return candidate
    return None


def _direct_source_for(title: str, year=None, refresh: bool = False) -> dict | None:
    """Prefer a direct, playable Archive.org source for a title; fall back to a
    live on-demand scrape when the local catalog has no confident match. Pass
    `refresh=True` to bypass a cached hit and scrape again (the frontend uses
    this while its stream-fallback loop is looking for a playable source).

    Serialised per title so N simultaneous viewers of the same uncached title
    produce one scrape, not N. Negative results are cached for a short window
    so a retry loop cannot turn a known miss into minutes of upstream traffic.
    """
    if not title:
        return None
    key = catalog_lib.normalize_title(title) or title.lower().strip()

    hit, cached = _direct_cache_get(key, refresh)
    if hit:
        return cached

    with _direct_lock_for(key):
        # Another request may have finished the scrape while we waited.
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
        # Records the hit or the miss; the cache routes it to the container whose
        # TTL matches what kind of answer this is. `TTLCache` evicts on its own,
        # so there is no size check to keep in step here.
        _direct_cache_put(key, entry)
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


# A sheet open asks for two things a browser render has no business answering:
# the rest of the record, and a shelf of neighbours. One TMDB details call
# already appends `recommendations`, so both ride back together.
#
#: Every module-level cache below is a `TTLCache` with this `maxsize`. The
#: service is capped at 512 MB of RAM, and these caches are keyed by something
#: a client controls (a TMDB id and a media type), so an unbounded dict is a
#: slow OOM: one entry per distinct title anyone ever asked for, each holding a
#: nested payload, for the life of the worker. The bound plus a TTL makes the
#: worst case a fixed number of entries regardless of traffic.

_meta_cache: TTLCache = TTLCache(maxsize=CACHE_MAX_SIZE, ttl=CACHE_TTL_SECONDS)
#: `TTLCache` is not internally synchronised, and gunicorn runs this app with
#: several workers, so the lock outlives any single cache entry.
_meta_cache_lock = threading.Lock()


def _similar_wall(details: dict, media_type: str) -> list[dict]:
    """Compact records for the title page's More Like This shelf.

    `fetch_media_details` appends `recommendations`, so the common case costs
    no extra request. An empty list falls back to `/similar`, which answers for
    the long tail of titles TMDB has recommendations for on only one side --
    either neighbour list is a better wall than none. Capped well below what
    TMDB returns: the shelf scrolls, it does not paginate.
    """
    results = (details.get("recommendations") or {}).get("results") or []
    if not results:
        fallback = _tmdb_get(f"/{media_type}/{details.get('id')}/similar", {}) or {}
        results = fallback.get("results") or []
    wall: list[dict] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        raw_id = item.get("id")
        title = item.get("title") or item.get("name")
        if raw_id is None or not title:
            continue
        # Poster or nothing: a neighbour the viewer cannot recognise in the
        # wall does not earn a slot, and TMDB's results carry a null path for
        # exactly the titles least likely to mean anything to them.
        if not item.get("poster_path"):
            continue
        date = item.get("release_date") or item.get("first_air_date") or ""
        wall.append(
            {
                "id": str(raw_id),
                "title": title,
                "year": int(date[:4]) if date[:4].isdigit() else None,
                "poster_path": item.get("poster_path"),
                "backdrop_path": item.get("backdrop_path"),
                "vote_average": item.get("vote_average"),
                "media_type": media_type,
                "overview": item.get("overview") or "",
            }
        )
        if len(wall) >= 18:
            break
    return wall


def _meta_response(payload: dict):
    """Answer `/api/movies/meta` with a header a shared cache may obey.

    The record is public TMDB data -- the same bytes for every viewer, with no
    session in it -- and the client asks for it with GET, so `public` lets a
    CDN answer a repeat open from its edge instead of paying the round trip.
    Five minutes is generous for a synopsis and well inside the process-local
    `TTLCache` that sits behind it.
    """
    response = jsonify(payload)
    response.headers["Cache-Control"] = "public, max-age=300"
    return response


@app.route("/api/movies/meta", methods=["GET", "POST", "OPTIONS"])
def movie_meta():
    """Full metadata plus a similar-titles wall, without resolving anything.

    This is the cheap sibling of `/api/movies/resolve`: the same movie record
    resolution would build, minus every stream field, joined by the shelf of
    neighbours the title page shows underneath it. Answered from
    `tmdb.fetch_media_details` (one TMDB call, recommendations appended) so the
    sheet can open and enrich itself in milliseconds instead of queueing behind
    a headless-browser render that exists only to decide what to play.

    404 `TITLE_NOT_FOUND` mirrors the resolve route's identity rule: TMDB may
    redirect a merged id to a different record, and that record is not the
    title the request named.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        raw_id = body.get("id")
        media_type = body.get("media_type") or "movie"
    else:
        raw_id = request.args.get("id")
        media_type = request.args.get("media_type") or "movie"

    if raw_id is None or str(raw_id) == "":
        return _json_error("Missing id", 400)
    try:
        tmdb_id = int(raw_id)
    except (ValueError, TypeError):
        return _json_error("Invalid id", 400)
    if media_type not in ("movie", "tv"):
        media_type = "movie"

    cache_key = f"{media_type}:{tmdb_id}"
    with _meta_cache_lock:
        cached = _meta_cache.get(cache_key)
    if cached is not None:
        return _meta_response(cached)

    details = tmdb.fetch_media_details(tmdb_id, media_type)
    if not details or str(details.get("id")) != str(tmdb_id):
        return _json_error(
            "Could not find metadata for that title", 404, code="TITLE_NOT_FOUND"
        )

    runtime = details.get("runtime")
    if runtime is not None:
        try:
            runtime = int(runtime)
        except (ValueError, TypeError):
            runtime = None

    year = details.get("release_year") or ((details.get("release_date") or "")[:4])
    is_tv = media_type == "tv"

    # The cast row on the title page: people, not names -- the id is what a
    # person's link is built from, and the photo is what makes a row of them
    # read as a cast rather than a list. Capped where the flattened `cast`
    # list is capped, so the two never disagree about the billing.
    cast_members: list[dict] = []
    for person in (details.get("credits") or {}).get("cast") or []:
        if not isinstance(person, dict) or not person.get("name"):
            continue
        if person.get("id") is None:
            continue
        cast_members.append(
            {
                "id": str(person["id"]),
                "name": str(person["name"]),
                "character": str(person.get("character") or ""),
                "profile_path": person.get("profile_path"),
            }
        )
        if len(cast_members) >= 10:
            break

    movie = {
        "id": str(tmdb_id),
        "title": details.get("title") or "",
        "year": str(year) if year else "",
        "media_type": media_type,
        "seasons": details.get("number_of_seasons", 1) if is_tv else 1,
        "episodes_per_season": (
            details.get("number_of_episodes") or None if is_tv else None
        ),
        "poster_url": details.get("poster_url", ""),
        "backdrop_url": details.get("backdrop_url", ""),
        "overview": details.get("overview", ""),
        "vote_average": details.get("vote_average"),
        "popularity": details.get("popularity"),
        "genres": details.get("genres", []),
        "runtime": runtime,
        "director": details.get("director"),
        "cast": details.get("cast", []),
        "cast_members": cast_members,
        "country": details.get("country"),
        "language": details.get("language"),
        "release_date": details.get("release_date") or details.get("first_air_date"),
    }
    payload = {
        "success": True,
        "movie": movie,
        "similar": _similar_wall(details, media_type),
    }
    with _meta_cache_lock:
        _meta_cache[cache_key] = payload
    return _meta_response(payload)


# The hero reads its accent colour from the featured backdrop's own pixels, but
# the browser cannot do that against TMDB directly: `image.tmdb.org` sends no
# `Access-Control-Allow-Origin`, so drawing the artwork into a canvas taints it
# and the colour read throws. The accent was therefore stuck on its hardcoded
# fallback on every slide. Relaying the one host the sampler needs, same-origin,
# is what lets the canvas be read at all.
#
# This is deliberately NOT a general proxy. The path is pinned to TMDB's
# `/t/p/<size>/<file>` shape and the host to `image.tmdb.org`, so no other URL
# can be aimed through it -- the same rule the playback relays follow. Without
# that pin it would be an open relay that any site could put in front of a
# victim's browser.
# ---------------------------------------------------------------------------

TMDB_IMAGE_HOST = "image.tmdb.org"
TMDB_IMAGE_PATH = re.compile(r"^/t/p/[A-Za-z0-9_]+/[^/].*$")
TMDB_IMAGE_TIMEOUT_SECONDS = 10
# A backdrop at `original` is a few megabytes; this ceiling stops the route
# being used to pull an arbitrary large file through the process.
TMDB_IMAGE_MAX_BYTES = 8 * 1024 * 1024


@app.route("/api/image", methods=["GET", "OPTIONS"])
def proxy_tmdb_image():
    if request.method == "OPTIONS":
        return ("", 204)

    raw = (request.args.get("url") or "").strip()
    if not raw:
        return _json_error("Missing url parameter", 400)
    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return _json_error("Invalid url parameter", 400)
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() != TMDB_IMAGE_HOST
        or not TMDB_IMAGE_PATH.match(parsed.path)
    ):
        return _json_error(
            "Only TMDB artwork may be relayed", 400, code="URL_NOT_ALLOWED"
        )

    try:
        upstream = requests.get(
            raw, timeout=TMDB_IMAGE_TIMEOUT_SECONDS, stream=True
        )
    except requests.Timeout:
        return _json_error("Artwork upstream timed out", 504)
    except requests.RequestException:
        return _json_error("Artwork upstream unavailable", 502)

    with upstream:
        if upstream.status_code != 200:
            return _json_error(
                f"Artwork upstream returned {upstream.status_code}", 502
            )
        body = upstream.content
        content_type = upstream.headers.get("Content-Type", "image/jpeg")
    if len(body) > TMDB_IMAGE_MAX_BYTES:
        return _json_error("Artwork is too large", 502)

    # Allowlist-exact CORS via the shared hook: the sampler's `crossOrigin`
    # image read succeeds because the frontend origin is reflected here.
    response = Response(body, status=200)
    response.headers["Content-Type"] = content_type
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response


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
    # The shared ranker, not an inline copy: `/api/media` used to score trailers
    # with its own buggy ranking, which preferred "Behind the Scenes" clips.
    videos = (details.get("videos") or {}).get("results") or []
    picked = _pick_trailer(videos)
    result["trailer_key"] = picked.get("key") if picked else None
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
def get_trailer():
    """Trailer by title (+year). Works for any video site."""
    if request.method == "OPTIONS":
        return ("", 204)
    title = (request.args.get("title") or "").strip()
    if not title:
        return _json_error("Missing title", 400)
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


@app.route("/api/catalog/movieTrailer", methods=["GET", "OPTIONS"])
def get_trailer_by_tmdb_id():
    """Fetch a trailer straight from a TMDB id (used by fetchTrailerByTmdbId).

    The id form is what the Spotlight uses, because it rotates through whatever
    the catalog handed it and cannot re-derive a title/year pair that matches
    the same film. This route was deleted in 33bd5c7 as collateral damage from an
    otherwise client-only change, which left every trailer request 404ing and
    the hero silently falling back to backdrop art.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    raw_id = request.args.get("id")
    media_type = request.args.get("media_type") or "movie"

    if not raw_id:
        return _json_error("Missing id", 400)

    try:
        tmdb_id = int(raw_id)
    except (ValueError, TypeError):
        return _json_error("Invalid id", 400)

    # A TMDB id is only meaningful against its own media type. 1396 is Breaking
    # Bad on TMDB, yet asking the movie endpoint for it answers with a real but
    # different title's trailer -- a wrong trailer, not an error.
    if media_type not in ("movie", "tv"):
        media_type = "movie"

    trailer_key = tmdb.get_trailer_key(tmdb_id, media_type)
    if not trailer_key:
        return jsonify({"trailer": None})

    return jsonify({"trailer": {"provider": "youtube", "id": trailer_key}})


@app.route("/api/v1/media/trailer", methods=["GET", "OPTIONS"])
def media_trailer():
    """Ranked trailers for a title, resolved server-side.

    The player used to receive a bare `{provider, id}` and build the embed URL
    from its own provider table. That made two server answers look identical --
    "no trailer" and "a trailer from a site this build has no builder for" --
    and the second rendered as a blank frame. Every player URL is constructed
    here now, so an unsupported site is dropped before the client ever sees it,
    and a ranker can be improved without a frontend change.

    `200` with `trailer: null` is the normal answer for most titles: TMDB has no
    playable upload for a large share of the catalog, and that is not an error.
    It is also answered for an unknown id, because "we could not find a trailer
    for that" is true regardless of whether the id exists.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    parsed = _parse_tmdb_id(request.args.get("id") or request.args.get("tmdb_id"))
    if parsed is None:
        return _json_error("Invalid id", 400)

    media_type = request.args.get("media_type") or request.args.get("type") or "movie"
    if media_type not in ("movie", "tv"):
        media_type = "movie"

    try:
        limit = min(5, max(1, request.args.get("limit", default=5, type=int)))
    except (TypeError, ValueError):
        limit = 5

    trailers = tmdb.resolve_trailers(parsed, media_type, limit=limit)

    return jsonify(
        {
            "success": True,
            "tmdb_id": parsed,
            "media_type": media_type,
            "trailer": trailers[0] if trailers else None,
            "alternatives": trailers[1:],
        }
    )


# --------------------------------------------------------------------------- #
#  Playback — tokenised same-origin legs                                       #
# --------------------------------------------------------------------------- #
SUBTITLE_TIMEOUT_SECONDS = 15
SUBTITLE_MAX_BYTES = 4 * 1024 * 1024


def _source_format(url: str) -> str:
    """`"hls"` or `"mp4"` -- what the player must load, by container.

    The only trustworthy signal a URL carries is its path: an `.m3u8` needs
    hls.js, anything else is progressive and goes straight to a media element.
    This is reported to the client as `format` and is authoritative there --
    the relay URLs issued below are opaque paths, so the client must stop
    inferring format from URL shape.
    """
    path = urllib.parse.urlparse(url or "").path.lower()
    return "hls" if path.endswith((".m3u8", ".m3u")) else "mp4"


def _play_url(url: str, region: str | None = None) -> tuple[str, str]:
    """`(same-origin play URL, format)` for a direct media URL.

    HLS goes behind the manifest relay (its segments are rewritten onto the
    segment relay as the playlist is served); progressive files go behind the
    media relay, which passes Range through so seeking still works.
    """
    if not url:
        return "", "mp4"
    if _source_format(url) == "hls":
        token = playback_tokens.issue(
            playback_tokens.KIND_PROXY, url, meta={"region": region or ""}
        )
        return f"/api/proxy/manifest?token={token}", "hls"
    token = playback_tokens.issue(
        playback_tokens.KIND_MEDIA, url, meta={"region": region or ""}
    )
    return f"/api/v1/playback/media?token={token}", "mp4"


def _frame_url(url: str, region: str | None = None) -> str:
    """A redirecting frame route for an embed target.

    The embed page is opened *by the browser* following this route's redirect,
    so the provider still frames exactly the URL it expects -- it simply never
    crosses our wire as data, and the handle only ever answers `302`.
    """
    if not url:
        return ""
    token = playback_tokens.issue(
        playback_tokens.KIND_FRAME, url, meta={"region": region or ""}
    )
    return f"/api/v1/playback/frame?token={token}"


def _caption_tracks(subtitles, region: str | None = None) -> list[dict]:
    """Subtitle descriptors with their fetch leg replaced by a caption handle.

    Only the fields the player needs travel: label, language, and our route.
    The upstream URL stays in the handle's meta; `format` (srt/vtt) does not
    travel either, because the caption route sniffs the body -- the container
    hint was only ever there to decide conversion, which is now unconditional.
    """
    tracks: list[dict] = []
    for entry in subtitles or []:
        if not isinstance(entry, dict):
            continue
        url = str(entry.get("url") or "")
        if not url:
            continue
        label = str(entry.get("label") or "").strip()[:80]
        lang = str(entry.get("lang") or "").strip()[:24]
        token = playback_tokens.issue(
            playback_tokens.KIND_CAPTION,
            url,
            meta={"label": label, "lang": lang, "region": region or ""},
        )
        tracks.append(
            {
                "label": label or lang,
                "lang": lang or "eng",
                "url": f"/api/v1/playback/captions?track={token}",
            }
        )
    return tracks


def _download_filename(title: str, quality: str, url: str) -> str:
    """Server-derived save name: the title's own words plus the tier.

    The client used to compose this from the raw URL; with no URL at the
    client, the name is built where the URL still exists. `_safe_download_name`
    sanitises it for the header at serve time.
    """
    ext = os.path.splitext(urllib.parse.urlparse(url).path)[1][:8] or ".mp4"
    base = (title or "").strip() or "video"
    return f"{base} ({quality}){ext}" if quality else f"{base}{ext}"


def _download_url(url: str, filename: str, region: str | None = None) -> str | None:
    """A download handle for `url`, or None when this host cannot be downloaded.

    Downloadability is decided here because the client can no longer classify a
    URL it never sees: `null` is the honest answer for a tier the download route
    would refuse, rather than a handle that 400s when clicked.

    Two facts decide it. First the container: an HLS or DASH manifest is a list
    of segment URLs, not a single file, and saving it as one would require a
    server-side remux this host does not do -- so a manifest is always `None`,
    never a broken button. Second the host: a progressive file on the archive
    allowlist gets the long-standing archive download handle; a progressive file
    elsewhere (an extracted provider's MP4) is reachable only through the media
    relay, so its handle is minted with `any_host` and the download route serves
    it the same way that relay does -- gated on the unforgeable handle, which a
    client cannot mint.
    """
    # A manifest is never a download, whatever its host.
    if proxy_util.stream_format(url) in ("hls", "dash"):
        return None
    try:
        catalog_lib.validate_archive_url(url, require_download_path=True)
        meta: dict = {"filename": filename, "region": region or ""}
    except Exception:  # noqa: BLE001 - off-list host, not an error
        meta = {"filename": filename, "region": region or "", "any_host": True}
    token = playback_tokens.issue(playback_tokens.KIND_DOWNLOAD, url, meta=meta)
    return f"/api/v1/playback/download?token={token}"


# Common caption display names, lowercased, mapped to ISO-639-2 codes. Provider
# captions arrive with a label and no language; defaulting every one of them to
# "eng" made the client's language-keyed dedupe keep only the first track, so a
# title with English/Spanish/French captions offered one row.
_SUBTITLE_LANG_BY_LABEL = {
    "english": "eng",
    "en": "eng",
    "eng": "eng",
    "spanish": "spa",
    "español": "spa",
    "espanol": "spa",
    "es": "spa",
    "spa": "spa",
    "french": "fre",
    "français": "fre",
    "francais": "fre",
    "fr": "fre",
    "fre": "fre",
    "german": "ger",
    "deutsch": "ger",
    "de": "ger",
    "ger": "ger",
    "italian": "ita",
    "italiano": "ita",
    "it": "ita",
    "ita": "ita",
    "portuguese": "por",
    "português": "por",
    "portugues": "por",
    "pt": "por",
    "por": "por",
    "russian": "rus",
    "русский": "rus",
    "ru": "rus",
    "rus": "rus",
    "japanese": "jpn",
    "日本語": "jpn",
    "ja": "jpn",
    "jpn": "jpn",
    "korean": "kor",
    "한국어": "kor",
    "ko": "kor",
    "kor": "kor",
    "chinese": "chi",
    "中文": "chi",
    "zh": "chi",
    "chi": "chi",
    "hindi": "hin",
    "हिन्दी": "hin",
    "hi": "hin",
    "hin": "hin",
    "arabic": "ara",
    "العربية": "ara",
    "ar": "ara",
    "ara": "ara",
    "dutch": "dut",
    "nederlands": "dut",
    "nl": "dut",
    "dut": "dut",
    "polish": "pol",
    "polski": "pol",
    "pl": "pol",
    "pol": "pol",
    "turkish": "tur",
    "türkçe": "tur",
    "turkce": "tur",
    "tr": "tur",
    "tur": "tur",
    "swedish": "swe",
    "svenska": "swe",
    "sv": "swe",
    "swe": "swe",
    "norwegian": "nor",
    "norsk": "nor",
    "no": "nor",
    "nor": "nor",
    "danish": "dan",
    "dansk": "dan",
    "da": "dan",
    "dan": "dan",
    "finnish": "fin",
    "suomi": "fin",
    "fi": "fin",
    "fin": "fin",
    "greek": "gre",
    "ελληνικά": "gre",
    "el": "gre",
    "gre": "gre",
    "czech": "cze",
    "čeština": "cze",
    "cestina": "cze",
    "cs": "cze",
    "cze": "cze",
    "hungarian": "hun",
    "magyar": "hun",
    "hu": "hun",
    "hun": "hun",
    "romanian": "rum",
    "română": "rum",
    "romana": "rum",
    "ro": "rum",
    "rum": "rum",
    "ukrainian": "ukr",
    "українська": "ukr",
    "uk": "ukr",
    "ukr": "ukr",
    "hebrew": "heb",
    "עברית": "heb",
    "he": "heb",
    "heb": "heb",
    "thai": "tha",
    "ไทย": "tha",
    "th": "tha",
    "tha": "tha",
    "vietnamese": "vie",
    "tiếng việt": "vie",
    "vi": "vie",
    "vie": "vie",
    "indonesian": "ind",
    "bahasa indonesia": "ind",
    "id": "ind",
    "ind": "ind",
}


def _subtitle_lang(raw_lang: object, label: str) -> str:
    """A language code for a caption row, never a fabricated duplicate.

    A real code from the resolver wins. Failing that, the display label is
    looked up; failing that, "eng" -- which is what the previous code did
    unconditionally, collapsing every provider caption set to one track.
    """
    lang = str(raw_lang or "").strip()[:24]
    if lang:
        return lang
    return _SUBTITLE_LANG_BY_LABEL.get(label.strip().lower(), "eng")


def _init_inputs() -> tuple[dict | None, tuple | None]:
    """Read and strictly validate `/api/v1/playback/init` parameters.

    GET carries them in the query string (prefetch, link shares); POST carries
    a JSON object (the player). Both are folded into one dict and then judged
    by the same rules, so the two entry points cannot disagree about what is
    valid. Returns `(params, None)` or `(None, error_response)`.
    """
    if request.method == "POST":
        if request.data and not request.is_json:
            return None, _json_error("Content-Type must be application/json.", 400)
        body = request.get_json(silent=True)
        if body is None and request.data:
            return None, _json_error("Request body must be valid JSON.", 400)
        if body is not None and not isinstance(body, dict):
            return None, _json_error("Request body must be a JSON object.", 400)
    else:
        body = {}
    raw = {key: request.args.get(key) for key in request.args}
    raw.update(body or {})

    params: dict = {}

    tmdb_raw = raw.get("tmdb_id", raw.get("id"))
    if tmdb_raw not in (None, ""):
        parsed = _parse_tmdb_id(tmdb_raw)
        if parsed is None:
            return None, _json_error("Invalid ID", 400)
        params["tmdb_id"] = parsed

    title = str(raw.get("title") or "").strip()
    if len(title) > 300:
        return None, _json_error("title must be 300 characters or fewer.", 400)
    params["title"] = title
    if not params.get("tmdb_id") and not title:
        return None, _json_error("Provide a title or a TMDB id.", 400)

    media_type = raw.get("media_type", raw.get("type"))
    media_type = "movie" if media_type in (None, "") else str(media_type).strip().lower()
    if media_type not in ("movie", "tv"):
        return None, _json_error("media_type must be 'movie' or 'tv'.", 400)
    params["media_type"] = media_type

    for name in ("season", "episode"):
        value = raw.get(name)
        if value in (None, ""):
            params[name] = 1
            continue
        try:
            number = int(str(value).strip())
        except (TypeError, ValueError):
            return None, _json_error(f"{name} must be a positive integer.", 400)
        if number < 1 or number > 9999:
            return None, _json_error(f"{name} must be between 1 and 9999.", 400)
        params[name] = number

    year = raw.get("year")
    if year in (None, ""):
        params["year"] = None
    else:
        try:
            parsed_year = int(str(year).strip())
        except (TypeError, ValueError):
            return None, _json_error("year must be a number.", 400)
        if parsed_year < 1870 or parsed_year > 2200:
            return None, _json_error("year must be between 1870 and 2200.", 400)
        params["year"] = parsed_year

    refresh = raw.get("refresh")
    if refresh in (None, False, "", 0, "0", "false", "no"):
        params["refresh"] = False
    elif refresh is True or refresh in ("1", "true", "yes") or refresh == 1:
        params["refresh"] = True
    else:
        return None, _json_error("refresh must be a boolean.", 400)

    return params, None


@app.route("/api/v1/playback/init", methods=["GET", "POST", "OPTIONS"])
def playback_init():
    """Resolve a title once: metadata, provider chain, and tokenised legs.

    Answers 200 with `available` and an ordered chain when every provider was
    walked and none could serve the title (the client shows its own state and
    keeps the chain), 404 `TITLE_NOT_FOUND` only when the title does not
    exist, and 404 `PROVIDERS_EXHAUSTED` when the address itself resolved but
    no source did. Both 404s carry `code` so the client never has to infer a
    decision from prose.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    params, error = _init_inputs()
    if error is not None:
        return error

    tmdb_id = params.get("tmdb_id")
    title = params["title"]
    media_type = params["media_type"]
    season = params["season"]
    episode = params["episode"]
    year = params["year"]
    refresh = params["refresh"]

    # A title without an id is a search, and a search answers with ranked
    # guesses -- the first of them is an answer only when it names the same
    # film. Exact match on the normalised title, same year-trust rule as the
    # direct catalog; nothing matching means nothing to play, and that is a
    # 404 rather than the top of somebody else's list.
    if not tmdb_id and title:
        results = tmdb.search_multi(title)
        valid_results = [r for r in results if r.get("media_type") in ("movie", "tv")]
        top = _exact_title_match(valid_results, title, year)
        if top is None:
            return _json_error(
                f"Could not find metadata for '{title}'", 404, code="TITLE_NOT_FOUND"
            )
        tmdb_id = top["id"]
        media_type = top.get("media_type") or media_type
        title = top.get("title") or top.get("name") or title
        year = year or (top.get("release_date") or top.get("first_air_date") or "")[:4] or None

    details = tmdb.fetch_media_details(tmdb_id, media_type)
    if not details:
        return _json_error(
            f"Could not fetch details for '{title}'", 404, code="TITLE_NOT_FOUND"
        )
    # TMDB can answer a lookup with a different id than the one asked for (a
    # redirect on a merged or replaced entry). The request named one title; a
    # second one is not it, and quietly playing it is the same defect as the
    # index-0 fallback above.
    if str(details.get("id")) != str(tmdb_id):
        return _json_error(
            f"Could not find metadata for '{title}'", 404, code="TITLE_NOT_FOUND"
        )

    if media_type == "tv":
        seasons_count = details.get("number_of_seasons", 1)
        season_details = _tmdb_get(f"/tv/{tmdb_id}/season/{season}", {}) or {}
        episodes_list = season_details.get("episodes", [])
        episodes_count = len(episodes_list) if episodes_list else 10
        if not year and details.get("first_air_date"):
            year = details["first_air_date"][:4]
        # The show's name identifies the archive query; the year must not
        # constrain it -- the item carrying S01E07 is dated to that episode's
        # own air year, so `accept_candidate` would reject the correct file for
        # every episode after the first.
        title_for_direct = details.get("name") or details.get("original_name") or title
        year_for_direct = None
    else:
        seasons_count = 1
        episodes_count = 1
        if not year and details.get("release_date"):
            year = details["release_date"][:4]
        title_for_direct = details.get("title") or title
        year_for_direct = year

    # Where the viewer is -- the seed for default tracks, reported on every
    # answer so the player opens on the right audio and subtitle language
    # instead of whichever one hls.js lists first. A signed-in profile's saved
    # language wins over the geo seed: the viewer already told us.
    locale = geo_locale.detect_locale(request)
    language = locale["language"]
    user = _auth_user()
    if user:
        profile = _resolve_profile(user)
        if isinstance(profile, dict) and profile.get("preferred_language"):
            language = str(profile["preferred_language"])
    region = locale["country"] or ""

    # Runtime is the trailer guard's budget signal: a 90-minute film and a
    # 4-minute clip are told apart by duration, and the duration check lives in
    # the resolution chain -- so it has to be in hand before resolution runs.
    runtime = details.get("runtime")
    if runtime is not None:
        try:
            runtime = int(runtime)
        except (ValueError, TypeError):
            runtime = None

    resolution = stream_providers.resolve(
        _direct_source_for,
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=title_for_direct,
        year=year_for_direct,
        season=season,
        episode=episode,
        refresh=refresh,
        runtime=runtime,
    )

    if not resolution.ok:
        # 404 with an explicit code, not 503: every tier was walked and none
        # could serve the title, so re-asking only re-walks what just failed.
        # The attempt log is still handed back so a client walking on its own
        # timer has a reason to show rather than a bare failure.
        return _json_error(
            "No active stream sources",
            404,
            code="PROVIDERS_EXHAUSTED",
            available=False,
            providers=[],
            provider_attempts=resolution.attempts,
        )

    # Resolution hands back handles, never raw URLs: every entry in
    # `resolution.streams` was already exchanged for a same-origin leg by
    # `proxy_util.playable`, with the upstream Referer carried inside it. So
    # this section only orders them and labels them, and recovers the two
    # facts the client cannot derive from an opaque path -- the container, and
    # whether the underlying file may be downloaded at all.
    streams: list[dict] = []
    mirrors: list[dict] = []
    sources: list[str] = []
    subtitles: list[dict] = []

    # A trailer must never reach the main player (it belongs only in the
    # "Trailers" tab, which fetches separately via the trailer routes). The
    # resolution chain rejects a short *manifest*, but a progressive file has
    # no cheap duration probe -- so the URL is recovered from the handle it
    # arrived on and checked here as a final guard.
    def _is_trailer_endpoint(raw: str) -> bool:
        lowered = raw.lower()
        if any(
            host in lowered
            for host in ("youtube.com", "youtu.be", "youtube-nocookie.com")
        ):
            return True
        path = urllib.parse.urlparse(raw).path.lower()
        return any(token in path for token in ("/trailer", "trailer.", "/clip", "featurette"))

    # One entry per raw URL, not per call: the same file named twice must not
    # mint two handles, or the client's URL Set sees two distinct strings and
    # offers the viewer the identical source under different labels.
    seen_sources: set[str] = set()
    for index, stream in enumerate(resolution.streams):
        play = str(stream.get("url") or "")
        if not play:
            continue
        raw = proxy_util.raw_url_of(play)
        if raw and _is_trailer_endpoint(raw):
            print(f"[Catalog] discarded trailer-like direct stream for {title!r}: {raw}")
            continue
        if play not in seen_sources:
            seen_sources.add(play)
            sources.append(play)
        label = str(stream.get("label") or "")
        try:
            height = int(stream.get("height") or 0)
        except (TypeError, ValueError):
            height = 0
        try:
            size = int(stream.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        streams.append(
            {
                "quality": label,
                "height": height,
                "width": stream.get("width") or 0,
                "size": size,
                "url": play,
                "format": str(stream.get("format") or "") or proxy_util.format_of_handle(play),
                "download_url": (
                    _download_url(raw, _download_filename(title, label, raw), region)
                    if raw
                    else None
                ),
            }
        )
        if index:
            # "Server N" rather than a provider name: the viewer used to pick
            # an iframe host here, and there is no host to name any more --
            # these are mirrors of one file, not different sources.
            mirrors.append({"name": f"Server {index}", "url": play})

    subtitles = []
    for entry in resolution.subtitles:
        if not entry.get("url"):
            continue
        label = str(entry.get("label") or "").strip()[:80]
        subtitles.append(
            {
                "label": label,
                "lang": _subtitle_lang(entry.get("lang"), label),
                "url": str(entry.get("url") or ""),
            }
        )

    if not sources:
        # Every stream the chain produced was rejected by the trailer guard, so
        # the resolution's "ok" is not an answer the player can use. It becomes
        # the same exhaustion the client already knows how to show, rather than
        # a 200 with a `stream_url` the player would boot and stall on.
        return _json_error(
            "No active stream sources",
            404,
            code="PROVIDERS_EXHAUSTED",
            available=False,
            providers=[],
            provider_attempts=resolution.attempts,
        )

    primary_url = sources[0]
    primary_format = (
        next(
            (str(s["format"]) for s in streams if s["url"] == primary_url),
            "mp4",
        )
        if primary_url
        else "mp4"
    )
    is_embed = resolution.is_embed
    provider_id = resolution.provider

    # No embed chain. A resolution that produced no direct stream already
    # answered 404 above, so this is unreachable -- it stays an explicit empty
    # rather than a planned-chain fallback, because the client walks this
    # array and there is nothing left for it to walk.
    providers: list[dict] = []

    director = details.get("director")
    cast = details.get("cast", [])
    if not director and details.get("credits"):
        director, cast = tmdb.extract_director_and_cast(details.get("credits", {}))
    country = details.get("country")
    language_detail = details.get("language")
    if not country or not language_detail:
        extracted_country, extracted_language = tmdb.extract_country_and_language(details)
        country = country or extracted_country
        language_detail = language_detail or extracted_language

    movie = {
        "id": str(tmdb_id),
        "title": details.get("title") or title,
        "stream_url": primary_url,
        "format": primary_format,
        "is_embed": is_embed,
        "available": resolution.ok,
        "provider": provider_id,
        "sources": sources,
        "mirrors": mirrors,
        "streams": streams,
        "subtitles": subtitles,
        "providers": providers,
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
        "language": language_detail,
        "release_date": details.get("release_date")
        or details.get("first_air_date"),
    }
    if media_type == "tv" and details.get("episodes"):
        movie["episodes"] = details["episodes"]

    # Count the session against the primary leg, and against the viewer's
    # country for the regional view. The token is what later media/segment
    # requests touch, so "active" means bytes are actually flowing.
    primary_token = _token_of(primary_url)
    if primary_token:
        telemetry.open_stream(
            primary_token,
            user_id=user["id"] if user else None,
            region=region or None,
        )
    telemetry.record_event("playback_init")

    response = jsonify(
        {
            "success": True,
            "exact": True,
            "available": True,
            "format": primary_format,
            "provider": provider_id,
            "language": language,
            "country": region,
            "movie": movie,
        }
    )
    # This route answers GET as well as POST, and its payload is a fistful of
    # per-request handles that expire: `no-store` is what stops an intermediary
    # (or the browser's own heuristic cache) replaying yesterday's tokens to
    # today's viewer.
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/movies/resolve", methods=["GET", "POST", "OPTIONS"])
def resolve_movie():
    """Compatibility alias for /api/v1/playback/init.

    The web client still calls this path from two places -- the stream
    resolver (`api.ts resolveStream`) and the details sheet's warm resolve --
    with the pre-v1 field names (`id`/`title`/`year`/`season`/`episode`),
    which `_init_inputs` already accepts as aliases. The v1 response is a
    strict superset of the old contract (`movie` + `exact` + `language` are
    all present), so the same handler answers both paths and nothing on the
    client needs to change to stop the 404 this route's removal caused on
    every cold open. Metadata-only callers (the watch page, the sheet's
    enrichment) belong on `/api/movies/meta` below, which never walks a
    provider chain.
    """
    return playback_init()


def _token_of(play_url: str) -> str | None:
    """The handle inside one of our own playback URLs, or None.

    Used only on URLs this process just minted, so the query string is known
    to carry `token=` (proxy/media/frame/download) or `track=` (captions).
    """
    if not play_url:
        return None
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(play_url).query)
    except ValueError:
        return None
    for key in ("token", "track"):
        values = query.get(key)
        if values and values[0]:
            return values[0]
    return None


# ---------------------------------------------------------------------------
# The remaining playback legs. Each is a thin handle reader -- the handle is
# the whole authorisation: it names one URL, carries the headers it needs
# server-side, and expires on its own. None of them accepts a URL from the
# caller, so none of them can be pointed anywhere new.
# ---------------------------------------------------------------------------


@app.route("/api/v1/playback/frame", methods=["GET", "OPTIONS"])
def playback_frame():
    """Redirect to the embed page the frame handle names.

    A redirect rather than a body, for three reasons that all matter: the
    browser ends up framing the provider's own URL from its own address bar,
    so referer checks and X-Frame-Options see what they expect; the URL never
    crosses our wire as data -- we answer handles, not URLs, from here on; and
    the handle expires on its own, so a leaked frame URL stops resolving while
    a leaked embed URL would live forever in a client bundle.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = playback_tokens.resolve(token, playback_tokens.KIND_FRAME)
    if entry is None:
        return _json_error(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )
    telemetry.record_event("frame")
    # For an embed-only title this handle *is* the primary leg, so the view it
    # opened at init is kept alive by the viewer actually walking into the
    # provider; for a direct title it is an unplayed failover candidate and
    # touch is a no-op until opened.
    telemetry.touch_stream(token)
    response = redirect(entry["url"], code=302)
    # The provider's URL must not sit in a shared cache or in history.
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/v1/playback/captions", methods=["GET", "OPTIONS"])
def playback_captions():
    """Serve the handle's caption file as sanitised, same-origin WebVTT.

    A `<track>` element fetches its `src` with CORS, and archive download nodes
    return neither `Access-Control-Allow-Origin` nor a WebVTT content type --
    pointing a track straight at them fails silently in the browser, so the UI
    reports a subtitle as selected while no cue ever fires. Fetching here is
    what makes subtitles actually play, and it is also where the body is
    sanitised: cue payload overrides and unknown tags are stripped before the
    text reaches the player, because this content is untrusted like any other
    body we relay.

    Upstream may be SubRip or WebVTT and may be mislabelled either way, so the
    body is sniffed and parsed uniformly -- `.srt` cannot render in a browser
    at all, and a `.vtt` served as `text/plain` still needs the right type on
    this origin. Host and size limits are enforced by `fetch_bounded_text`,
    whose allowlist is the same one the media relay uses.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("track") or ""
    entry = playback_tokens.resolve(token, playback_tokens.KIND_CAPTION)
    if entry is None:
        return _json_error(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )
    url = entry["url"]
    meta = entry.get("meta") or {}
    region = meta.get("region") or None

    try:
        text = catalog_lib.fetch_bounded_text(
            url,
            SUBTITLE_TIMEOUT_SECONDS,
            SUBTITLE_MAX_BYTES,
            # A provider caption's CDN is never on the archive allowlist. The
            # handle carries the resolver's `any_host` opt-in; without honouring
            # it here, every provider track returned a 400 and the player showed
            # a subtitle menu that could never fire a cue.
            allow_any_host=bool(meta.get("any_host")),
        )
    except catalog_lib.ArchiveUrlRejected as error:
        # Keyed on the exception type, not on wording: a refusal worded
        # differently (a scheme, a port, a credential in the authority) used to
        # surface as a 502, which reads as archive.org being down rather than
        # as a request this server declined.
        return _json_error(str(error), 400)
    except ValueError as error:
        # The byte cap: upstream would not hand over the whole file, so this
        # is an upstream failure rather than a bad request.
        return _json_error(str(error), 502)
    except urllib.error.HTTPError as exc:
        return _json_error(f"Caption upstream returned {exc.code}", 502)
    except (urllib.error.URLError, TimeoutError, OSError):
        return _json_error("Caption upstream unavailable", 502)

    try:
        vtt = caption_engine.convert(text)
    except caption_engine.CaptionError:
        # An asset that parses to no cues is not a caption track. Serving the
        # raw text anyway would render nothing while the UI keeps showing the
        # track as available; a 502 lets the player drop the track honestly.
        return _json_error("Caption asset has no playable cues", 502)

    telemetry.record_event("caption")
    telemetry.record_bytes(len(vtt), region)
    telemetry.touch_stream(token, count=len(vtt))

    response = Response(vtt, mimetype="text/vtt")
    response.headers["Content-Type"] = "text/vtt; charset=utf-8"
    # Cues are immutable for a given archive item, but the upstream node
    # rotates; a short shared cache absorbs repeated seeks without pinning
    # stale data.
    response.headers["Cache-Control"] = "public, max-age=300"
    return response


def _open_any_host_stream(url: str, range_header: str | None, referer: str):
    """A bounded, range-safe relay for a host the archive allowlist refuses.

    Reached only for a handle this process minted with `meta["any_host"]` --
    and a handle cannot be minted by a client, so this is an explicit opt-in by
    the resolver rather than a hole a request can aim through. Range is passed
    through verbatim and the upstream's status and Content-Range come back
    unchanged, so the media element still sees one honest, seekable resource.

    This is the same contract `open_archive_stream` gives the archive leg; only
    the host check differs, and that check is what the `any_host` flag already
    settled server-side.
    """
    headers = {"User-Agent": hls_proxy.HLS_PROXY_USER_AGENT, "Accept": "*/*"}
    if range_header:
        headers["Range"] = range_header
    if referer:
        headers["Referer"] = referer
    upstream = requests.get(url, headers=headers, timeout=hls_proxy.HLS_PROXY_TIMEOUT, stream=True)
    if upstream.status_code not in (200, 206):
        upstream.close()
        raise ValueError(f"Stream upstream returned {upstream.status_code}")
    headers_out: dict[str, str] = {}
    for header in ("Content-Length", "Content-Type", "Accept-Ranges", "Content-Range"):
        value = upstream.headers.get(header)
        if value:
            headers_out[header] = value

    def chunks(read_size: int = 256 * 1024):
        try:
            for block in upstream.iter_content(read_size):
                if block:
                    yield block
        finally:
            upstream.close()

    return upstream.status_code, headers_out, chunks()


@app.route("/api/v1/playback/media", methods=["GET", "OPTIONS"])
def playback_media():
    """Relay the handle's progressive bytes: same-origin, range-safe.

    The bytes come through this origin so the player gets `Access-Control-
    Allow-Origin` and a `Range` that the upstream actually honours -- seeking a
    cross-origin file without both is a full re-download or a dead scrubber.
    Range is passed through exactly as the browser sent it, and the upstream's
    status (200 or 206) and Content-Range come back unchanged, so the media
    element sees one honest, seekable resource.

    Archive.org download URLs are the default and are checked per request by
    `open_archive_stream`. A source the resolver found elsewhere -- an
    extracted provider's progressive file -- arrives on a handle minted with
    `any_host`, and only that handle is relayed outside the allowlist.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = playback_tokens.resolve(token, playback_tokens.KIND_MEDIA)
    if entry is None:
        return _json_error(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )
    url = entry["url"]
    region = entry.get("meta", {}).get("region") or None

    try:
        try:
            status, headers, body = catalog_lib.open_archive_stream(
                url, request.headers.get("Range")
            )
        except ValueError:
            # The allowlist refuses an off-list host by design. When the
            # resolver already decided this title's only source lives there,
            # it minted the handle with `any_host` -- that flag is the one
            # signal that the refusal is expected rather than an attempt to
            # turn this route into a general fetcher.
            if not entry.get("meta", {}).get("any_host"):
                raise
            status, headers, body = _open_any_host_stream(
                url, request.headers.get("Range"), entry.get("referer") or ""
            )
    except ValueError as error:
        return _json_error(str(error), 400)
    except Exception as error:  # noqa: BLE001 - upstream failure is not ours
        return _json_error(f"Stream unavailable: {error}", 502)

    telemetry.record_event("media")

    def counted():
        sent = 0
        try:
            for chunk in body:
                sent += len(chunk)
                yield chunk
        finally:
            if sent:
                telemetry.record_bytes(sent, region)
                telemetry.touch_stream(token, count=sent)

    response = Response(counted(), status=status)
    for key, value in headers.items():
        response.headers[key] = value
    # Whatever CORS the upstream happened to send is not ours to pass on; the
    # shared hook re-adds the one allowlisted answer if any applies.
    response.headers.pop("Access-Control-Allow-Origin", None)
    # CORS is the shared hook's job (allowlist-exact), not a wildcard: see the
    # CORS section. Range headers still need exposing, which the hook does.
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


@app.route("/api/v1/playback/download", methods=["GET", "OPTIONS"])
def playback_download():
    """Relay the handle's file to the browser as an attachment.

    The bytes come through this origin rather than as a redirect so the
    `Content-Disposition` header is same-origin and the save dialog appears
    instead of the browser navigating away to the archive node. Scope stays
    narrow on purpose: the handle names one URL, and `open_archive_stream`
    re-checks that URL against the Archive.org allowlist on the way out, so a
    token is not a way around the allowlist -- it is only the pointer.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = playback_tokens.resolve(token, playback_tokens.KIND_DOWNLOAD)
    if entry is None:
        return _json_error(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )
    url = entry["url"]

    # init derived the name from the title while the URL still existed there;
    # the archive basename is only the fallback for a handle minted without one.
    fallback = os.path.basename(urllib.parse.urlparse(url).path) or "video"
    filename = _safe_download_name(entry.get("meta", {}).get("filename"), fallback)

    try:
        try:
            status, headers, body = catalog_lib.open_archive_stream(url, None)
        except ValueError:
            # The allowlist refuses an off-list host by design. A progressive
            # provider file is relayed through the media route under the same
            # `any_host` opt-in -- a handle a client cannot mint -- so the
            # download uses that identical leg rather than a second, narrower
            # allowlist that would reject the very source playback just served.
            if not entry.get("meta", {}).get("any_host"):
                raise
            status, headers, body = _open_any_host_stream(
                url, None, entry.get("referer") or ""
            )
    except ValueError as error:
        return _json_error(str(error), 400)
    except Exception:  # noqa: BLE001 - upstream failure is not ours
        return _json_error("Download source unavailable", 502)

    region = entry.get("meta", {}).get("region") or None
    telemetry.record_event("download")

    def counted():
        sent = 0
        try:
            for chunk in body:
                sent += len(chunk)
                yield chunk
        finally:
            if sent:
                telemetry.record_bytes(sent, region)

    response = Response(counted(), status=status)
    for key, value in headers.items():
        if key.lower() == "content-disposition":
            continue
        response.headers[key] = value
    # RFC 6266: a plain `filename` is ASCII; the `filename*` form carries UTF-8
    # titles correctly for non-Latin scripts.
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip() or "video"
    quoted = urllib.parse.quote(filename)
    response.headers["Content-Disposition"] = (
        f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'
    )
    response.headers["Cache-Control"] = "private, no-store"
    return response


DOWNLOAD_NAME_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f"\\/:;*?<>|]')


def _safe_download_name(raw: str | None, fallback: str) -> str:
    candidate = DOWNLOAD_NAME_FORBIDDEN.sub("", raw or "").strip().strip(". ")
    candidate = re.sub(r"\s+", " ", candidate).strip()
    return candidate[:120] or fallback


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


@app.route("/api/admin/users", methods=["GET", "OPTIONS"])
def api_admin_users():
    """One page of accounts, with per-account counts and database totals.

    Read-only, and deliberately so: it answers "who has an account", the one
    operational question the product cannot answer about itself, and it writes
    nothing. The gate is the `ADMIN_EMAILS` allowlist, evaluated here on every
    request from the token's own user row -- not from a query parameter, not
    from a role column, and not from anything the client sent.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Not signed in.")

    # 403, not 401, for a signed-in account that is not on the allowlist. The
    # client's fetch wrapper treats a 401 on an authenticated request as a dead
    # session and clears the stored token, so answering "not an admin" with 401
    # would sign the operator out of their own account the moment they opened
    # the wrong page. The distinction is also the honest one: the session is
    # valid, the permission is not.
    if not authdb.is_admin_email(user.get("email")):
        return _auth_error("You do not have access to this page.", 403)

    # Clamped rather than validated. `limit` bounds how much of the roster one
    # request can pull; `offset` is a position, so a negative one is meaningless
    # rather than dangerous, and both are read as ints because an unparseable
    # value should page the list, not 500 the endpoint.
    try:
        limit = max(1, min(200, int(request.args.get("limit", 50))))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(0, int(request.args.get("offset", 0)))
    except (TypeError, ValueError):
        offset = 0
    search = (request.args.get("q") or "").strip()[:200]

    try:
        store = authdb.get_store()
        rows = store.admin_users(search=search, limit=limit, offset=offset)
        totals = store.admin_user_totals()
    except Exception:
        # A driver error must not reach the client as a SQL string. The detail
        # goes to the log, which is where the operator debugging this is.
        app.logger.exception("admin user list failed")
        return _auth_error("Could not load the account list. Try again.", 500)

    return jsonify(
        {
            "users": [
                {
                    "id": str(row.get("id")),
                    "email": row.get("email"),
                    "name": row.get("display_name") or "",
                    # Normalized the same way as `/api/auth/me`, because the same
                    # value is shown in two places and a raw driver datetime next
                    # to an ISO string reads as two different accounts.
                    "created_at": authdb._to_iso(row.get("created_at")),
                    "profile_count": int(row.get("profile_count") or 0),
                    "history_count": int(row.get("history_count") or 0),
                    "saved_count": int(row.get("saved_count") or 0),
                    "active_sessions": int(row.get("active_sessions") or 0),
                    "last_active": authdb._to_iso(row.get("last_active")),
                }
                for row in rows
            ],
            "totals": totals,
            "limit": limit,
            "offset": offset,
            "search": search,
        }
    )


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