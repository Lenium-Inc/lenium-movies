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
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException

# Imported first so the dotenv file is loaded before any module reads a secret.
from runtime_config import load_env_file, ssl_context, tmdb_api_key

load_env_file()

import authdb
import catalog_lib
import catalog_service
import stream_providers
import taste
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
# Cache of resolved direct sources, including negative results.
#
# A miss used to be cached as a bare `None`, which is indistinguishable from
# "not looked up yet". The frontend's fallback loop calls with refresh=True
# three times in a row precisely because a miss means "no direct source", so
# every miss re-triggered a full Archive.org scrape -- up to five candidate
# identifiers, each a 30s x 2 metadata fetch plus a 25s stream probe. One
# request could burn ~7 minutes of a worker.
#
# Two things fix that: remember misses for a short window so a refresh storm
# cannot multiply the work, and collapse concurrent lookups of the same title
# onto one in-flight scrape instead of one per viewer.
_MISS_TTL_SECONDS = 300
_direct_source_cache: dict[str, tuple[float, dict | None]] = {}
_direct_source_locks: dict[str, threading.Lock] = {}
_direct_source_globals = threading.Lock()


# Both dicts below are keyed by normalised title, so a long-lived worker
# accumulates one entry per distinct title anyone ever searched. Left unbounded
# that is a slow leak on a popular title, so the caches are capped and the
# oldest half is dropped once the cap is hit. (The lock map is small next to
# the cache, but the same reasoning applies and it shares the eviction.)
_CACHE_MAX_ENTRIES = 2048


def _evict_direct_caches() -> None:
    """Caller must hold `_direct_source_globals`."""
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
    """Return (hit, value). A refresh bypasses a live entry but not a
    just-recorded miss -- otherwise the refresh storm is unbounded again."""
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


# Season payloads, keyed by "id:season" (or "id:latest"). A season's episode list
# is fixed once it has aired, so this is the one TMDB response on this path that
# can be held for hours rather than seconds -- and the episode shelf asks for
# several shows on every page load, so without it every viewer would pay for the
# same handful of lookups. Misses are never cached, which matters most for the
# "latest" key: a show with no aired season yet has to start resolving the
# moment its season drops rather than at the end of a TTL.
_SEASON_TTL_SECONDS = 6 * 3600
_season_cache: dict[str, tuple[float, dict | None]] = {}


def _image_url(path, size: str) -> str:
    return f"https://image.tmdb.org/t/p/{size}{path}" if path else ""


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
        if not catalog_lib.accept_candidate(requested_year, entry.get("year"), score):
            continue
        if best is None or score > best[0]:
            best = (score, entry)
    return best[1] if best else None


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
        with _direct_source_globals:
            _direct_source_cache[key] = (time.time(), entry)
            _evict_direct_caches()
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


# ---------------------------------------------------------------------------
# Error responses are always JSON
#
# An unhandled exception used to produce Werkzeug's HTML 500 page. The client's
# `response.json()` then threw `SyntaxError: Unexpected token '<'`, which
# matched none of the branches in its error classifier, so it fell through to
# "unknown, recoverable" and the watch page re-scheduled a retry every second,
# forever. An HTML error page is therefore not cosmetic: it is what turns one
# server-side bug into an infinite client loop with no error shown.
#
# Returning JSON with a real status means the client can classify the failure
# and, at the limit, stop and show the user something.
# ---------------------------------------------------------------------------


def _parse_tmdb_id(raw) -> int | None:
    """Return a sane TMDB id, or None if `raw` is not one.

    The id reaches both a TMDB URL path and an embed URL, so an unchecked value
    previously produced a confident 200 carrying a stream that can never play.
    Two distinct mistakes are covered:

    - not a number, or <= 0: rejected as a malformed request
    - absurdly large: Python ints are unbounded, so a 40-digit value parses
      cleanly and would just be a guaranteed upstream 404

    Shared by /api/get-stream and /api/episodes so both classify a bad id the
    same way instead of one 400-ing and the other 404-ing with a message that
    blames the title.
    """
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if value <= 0 or value > 2**31 - 1:
        return None
    return value


def _json_error(message: str, status: int, **extra):
    payload = {"error": message, "status": status, "success": False, **extra}
    return jsonify(payload), status


@app.errorhandler(HTTPException)
def _http_exception_handler(error: HTTPException):
    return _json_error(error.description or error.name, error.code or 500)


@app.errorhandler(Exception)
def _unhandled_exception_handler(error: Exception):
    # Log the detail server-side; return a generic message so internals are not
    # echoed to the client. 500 rather than 502: nothing upstream failed, we
    # did. The client treats any 5xx the same way, so this is about the status
    # being truthful to anyone reading the response or the logs.
    app.logger.exception("unhandled error on %s %s", request.method, request.path)
    return _json_error("The movie backend could not fulfil this request.", 500)


# Cap the upstream subtitle fetch so a slow Archive.org node cannot pin a
# worker thread. Subtitle files are small (tens of KB), so a hard byte ceiling
# also prevents this endpoint being used to pull an arbitrary large file.
SUBTITLE_TIMEOUT_SECONDS = 15
SUBTITLE_MAX_BYTES = 4 * 1024 * 1024


@app.route("/api/subtitles", methods=["GET"])
def proxy_subtitles():
    """Serve a subtitle track as CORS-enabled WebVTT.

    A `<track>` element fetches its `src` with CORS, and Archive.org's download
    nodes return neither `Access-Control-Allow-Origin` nor a WebVTT content
    type (they serve `text/plain`). Pointing a track straight at the archive
    therefore fails silently in the browser: the track is rejected, no cues
    ever fire, and the UI still reports a subtitle as "selected". Proxying the
    file server-side is what makes subtitles actually work.

    `.srt` upstreams are converted to WebVTT here, because a browser cannot
    render SubRip at all. Only archive.org hosts are accepted, matching the
    stream proxy, so this cannot be turned into a general-purpose fetcher.
    """
    url = (request.args.get("url") or "").strip()
    if not url:
        return _json_error("Missing url", 400)

    # Host and scheme validation happens inside `fetch_bounded_text`, which
    # shares its allowlist with the stream relay.
    try:
        text = catalog_lib.fetch_bounded_text(
            url, SUBTITLE_TIMEOUT_SECONDS, SUBTITLE_MAX_BYTES
        )
    except ValueError as error:
        # Host allowlist rejection and the byte cap both land here.
        message = str(error)
        if "archive.org" in message:
            return _json_error(message, 400)
        return _json_error(message, 502)
    except urllib.error.HTTPError as exc:
        return _json_error(f"Subtitle upstream returned {exc.code}", 502)
    except (urllib.error.URLError, TimeoutError, OSError):
        return _json_error("Subtitle upstream unavailable", 502)

    # The upstream extension is only a hint: archive.org serves `.srt` files as
    # `text/plain` and occasionally mislabels the container, so the body is
    # sniffed for the WEBVTT signature and converted when it is missing.
    is_srt = urllib.parse.urlparse(url).path.lower().endswith(".srt")
    if is_srt or not text.lstrip("\ufeff").lstrip().upper().startswith("WEBVTT"):
        text = catalog_lib.srt_to_vtt(text)

    response = Response(text, mimetype="text/vtt")
    response.headers["Content-Type"] = "text/vtt; charset=utf-8"
    # Cues are immutable for a given archive item, but the upstream node
    # rotates; a short shared cache absorbs repeated seeks without pinning
    # stale data.
    response.headers["Cache-Control"] = "public, max-age=300"
    return response


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

    # `silent=True` only suppresses the *parse* failure. A syntactically valid
    # body that is not an object -- "x", [1,2], 5 -- stays truthy and then
    # .get() raises, turning a bad request into a 500. Reject it as a 400.
    if not isinstance(payload, dict):
        return _json_error("Request body must be a JSON object.", 400)

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

    # Nothing to look up. Previously this fell through to the metadata lookup
    # and answered 404 "Could not find metadata for ''" -- the wrong class for a
    # request that never named a title, and a message that told the client
    # nothing about what it got wrong.
    if not title and not tmdb_id:
        return _json_error("Provide a title or a TMDB id.", 400)

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

        # Series used to be excluded from the direct catalog outright, by
        # handing the resolver an empty title. An episode is addressable now --
        # Archive.org indexes public-domain shows one item per episode -- so the
        # show's own name is passed instead.
        title_for_direct = details.get("name") or details.get("original_name") or title
        # ...but the year is not. `year` here is the show's first-air year, while
        # the item carrying S01E07 is dated to that episode's own air year, and
        # `accept_candidate` compares the two directly. Feeding it the show's
        # start year would reject the correct file for every episode after the
        # first, so the constraint is dropped for series and the episode token in
        # the title carries the identity instead.
        year_for_direct = None
    else:
        seasons_count = 1
        episodes_count = 1
        if not year and details.get("release_date"):
            year = details["release_date"][:4]
        title_for_direct = details.get("title") or title
        year_for_direct = year

    # One provider chain, walked once, for both media types.
    #
    # This used to hardcode a single `vidsrc.me` embed and report the title as
    # playable regardless of whether that host was up. The client had no way to
    # know otherwise, so "provider down" surfaced as a dead player with a
    # "Try another source" button. `resolve_direct` now tries the direct catalog
    # first and then every configured embed in priority order, and only comes
    # back empty when all of them are exhausted.
    resolution = stream_providers.resolve_direct(
        _direct_source_for,
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=title_for_direct,
        year=year_for_direct,
        season=season,
        episode=episode,
        refresh=False,
    )
    direct = resolution.winner.payload if resolution.winner and resolution.winner.kind == "direct" else None
    stream_url = resolution.url
    provider_candidates = resolution.candidate_urls()

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
        # `available` is now a real answer from the provider chain rather than a
        # constant. The metadata is still valid, so an unplayable title is
        # reported in-band (a 200 with `available: false`) and the client shows
        # its own state; a 404 here is reserved for "this title does not exist".
        "is_available": resolution.ok,
        "available": resolution.ok,
        "is_embed": resolution.is_embed,
        "providers": provider_candidates,
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

    return jsonify({"movie": movie_data, "exact": True, "available": resolution.ok})


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
        return _json_error("Invalid ID", 400)

    parsed = _parse_tmdb_id(tmdb_id)
    if parsed is None:
        return _json_error("Invalid ID", 400)
    tmdb_id = parsed

    media_type = _normalize_media_type(media_type)
    is_tv = media_type == "tv"

    # Direct-catalog lookup needs a title, and the id alone does not carry one.
    # A TMDB failure here is not fatal: the embed chain below does not need a
    # title, so a title-less request still resolves rather than 404-ing on a
    # metadata outage the player could have worked around.
    title = ""
    year = None
    if not is_tv:
        details = _tmdb_get(f"/movie/{tmdb_id}", {}) or {}
        title = details.get("title") or ""
        if details.get("release_date"):
            year = details["release_date"][:4]

    try:
        episode_number = max(1, int(episode))
    except (TypeError, ValueError):
        episode_number = 1
    try:
        season_number = max(1, int(season))
    except (TypeError, ValueError):
        season_number = 1

    # Server-side failover. Every configured provider is tried in priority
    # order -- direct catalog first, then each embed -- and only when all of
    # them are unreachable or empty does this answer "unavailable". The client
    # no longer has to ask for a second source.
    resolution = stream_providers.resolve_direct(
        _direct_source_for,
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=title,
        year=year,
        season=season_number,
        episode=episode_number,
        refresh=refresh,
    )

    if not resolution.ok:
        # 503 rather than 404: the title exists and was looked up correctly, but
        # no provider can currently serve it. `attempts` carries the per-provider
        # outcome so this is diagnosable from the client's own terminal state
        # rather than being an opaque "nothing worked".
        return _json_error(
            "No streaming provider could serve this title.",
            503,
            available=False,
            providers=[],
            provider_attempts=resolution.attempts,
        )

    winner = resolution.winner
    direct = winner.payload if winner.kind == "direct" else None
    candidates = resolution.candidate_urls()

    # Quality variants of the winning direct source are the player's mirrors;
    # the remaining providers are the failover chain, ordered after them.
    mirrors: list[dict] = []
    sources: list[str] = []
    if direct:
        streams = direct.get("streams") or []
        default = direct.get("stream_url", "")
        mirrors = [
            {"name": f"Server {index + 1}", "url": source["url"]}
            for index, source in enumerate(streams)
            if source.get("url") and source["url"] != default
        ]
        for url in [default] + [s.get("url", "") for s in streams] + candidates:
            if url and url not in sources:
                sources.append(url)
    else:
        # Embed failover: the chain is the source list, and each entry is also
        # offered as a named mirror so the player can rotate without a resolve.
        sources = list(candidates)
        mirrors = [
            {"name": candidate.label, "url": candidate.url}
            for candidate in resolution.candidates
        ]

    payload = {
        "success": True,
        "available": True,
        "activeSource": resolution.url,
        "sources": sources,
        "mirrors": mirrors,
        "is_embed": resolution.is_embed,
        "provider": winner.id,
    }
    # The player reads tracks from whichever payload it was handed, and
    # `/api/get-stream` is what a re-resolve actually returns. Omitting
    # subtitles here is what made the track list vanish on refresh even
    # though `/api/movies/resolve` reported it.
    if direct and direct.get("subtitles"):
        payload["subtitles"] = direct["subtitles"]
    return jsonify(payload)


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


# `Content-Disposition` is the only reliable way to make a browser save a
# cross-origin file. An <a download> attribute is ignored for a cross-origin
# href, so the save has to originate from a response header the backend sets.
#
# A deny-list, not an allow-list: quoting the header proves what the *safe* set
# is, while an allow-list silently drops every non-ASCII character and would
# turn "Amelie" into "Amlie" in the UTF-8 `filename*` form that exists
# precisely to carry those titles. So only characters that can break out of the
# header or the filesystem are removed.
DOWNLOAD_NAME_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f"\\/:;*?<>|]')


def _safe_download_name(raw: str | None, fallback: str) -> str:
    """Reduce a caller-supplied filename to something safe for a header.

    Strips control characters (so no CR/LF header injection), quotes (which
    would terminate the `filename="..."` value), and the path separators and
    `:` that have no business in a media filename. Leading and trailing
    dots/spaces are dropped because a name of `..` or a trailing space is
    ambiguous on the receiving filesystem.
    """
    candidate = DOWNLOAD_NAME_FORBIDDEN.sub("", raw or "").strip()
    candidate = candidate.strip(". ")
    # Collapse internal runs of whitespace, which headers fold to nothing.
    candidate = re.sub(r"\s+", " ", candidate).strip()
    if not candidate:
        return fallback
    # Keep the header well under any proxy's limit and leave room for the
    # extension the caller appended.
    return candidate[:120]


@app.route("/api/movies/download", methods=["GET"])
def movie_download():
    """Stream a direct Archive.org file to the browser as an attachment.

    Scope is deliberately narrow: only archive.org hosts (enforced by
    `open_archive_stream`) and only a GET. The bytes are relayed rather than
    redirected so the `Content-Disposition` header is same-origin and the save
    dialog appears instead of the browser navigating away to the archive node.
    """
    url = (request.args.get("url") or "").strip()
    if not url:
        return _json_error("Missing url", 400)

    # Prefer a name the caller derived from the title, otherwise fall back to
    # the archive filename so the saved file is not called "download".
    fallback = os.path.basename(urllib.parse.urlparse(url).path) or "video"
    filename = _safe_download_name(request.args.get("filename"), fallback)

    try:
        status, headers, body = catalog_lib.open_archive_stream(url, None)
    except ValueError as error:
        return _json_error(str(error), 400)
    except Exception:  # noqa: BLE001 - upstream failure is not ours
        return _json_error("Download source unavailable", 502)

    response = Response(body, status=status)
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

    # Validated up front rather than inside the try below: int() raising was
    # swallowed into "Episode not found", which tells the client the show is
    # missing when really the request was malformed.
    parsed = _parse_tmdb_id(tmdb_id)
    if parsed is None:
        return _json_error("Invalid ID", 400)

    try:
        episode_data = tmdb.fetch_episode_details(parsed, season, episode)
    except Exception as e:
        print(f"[Episode Fetch Error]: {e}")
        episode_data = None

    if not episode_data:
        return _json_error("Episode not found", 404)

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


@app.route("/api/season", methods=["GET", "OPTIONS"])
def get_season_details():
    """A whole season of a series, for the episode-level shelves.

    `/api/episodes` answers "tell me about S01E07" because the watch page needs
    one episode's title and still. Nothing could answer "what are the newest
    episodes of the shows on air", which is what the "New episodes" shelf is
    made of -- and that shelf fans out to several shows per page load, so
    resolving each episode individually would be one TMDB round trip per card.

    `season` is optional. Omitting it resolves the newest aired season, so the
    caller does not have to know how many seasons a show has or which one is
    current, and a show that airs a new season tomorrow is picked up without the
    shelf having to be taught about it.
    """
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
        # Only a resolved season is pinned. A cached miss would freeze the
        # "newest aired season" answer for the whole TTL, so a show that airs a
        # new season keeps serving the old one for hours after it does -- which
        # is the one thing this route is asked for.
        if payload and not payload.get("error"):
            _season_cache_put(cache_key, payload)

    if payload is None:
        return _json_error("Season not found", 404)
    if payload.get("error"):
        return _json_error(payload["error"], 404)
    return jsonify({"success": True, **payload})


def _build_season_payload(tmdb_id: int, season: int | None) -> dict | None:
    """Resolve and shape a season, or return None when the show is unknown."""
    show = tmdb.fetch_media_details(tmdb_id, "tv")
    if not show:
        return None

    seasons = [s for s in (show.get("seasons") or []) if s.get("season_number", 0) > 0]
    if season is None:
        # Newest first, and an aired season only: TMDB pre-announces upcoming
        # seasons with no episodes, and a shelf of empty seasons is worse than a
        # shelf that is one season behind.
        aired = [s for s in seasons if (s.get("air_date") or "") <= _today_iso()]
        pool = aired or seasons
        if not pool:
            return {"error": "No aired seasons"}
        season = max(s.get("season_number", 0) for s in pool)

    details = tmdb.fetch_season_details(tmdb_id, season)
    if not details:
        return {"error": "Season not found"}

    raw_episodes = details.get("episodes") or []
    episodes = []
    for item in raw_episodes:
        still_path = item.get("still_path")
        episodes.append(
            {
                "season": item.get("season_number", season),
                "number": item.get("episode_number"),
                "title": item.get("name") or f"Episode {item.get('episode_number')}",
                "overview": item.get("overview", ""),
                "still_path": still_path,
                "still_url": f"https://image.tmdb.org/t/p/w500{still_path}" if still_path else "",
                "air_date": item.get("air_date", ""),
                "runtime": item.get("runtime"),
                "vote_average": item.get("vote_average"),
            }
        )

    return {
        "show": {
            "id": tmdb_id,
            "name": show.get("name") or show.get("original_name") or "",
            "overview": show.get("overview", ""),
            "poster_url": _image_url(show.get("poster_path"), "w500"),
            "backdrop_url": _image_url(show.get("backdrop_path"), "w1280"),
        },
        "season": {
            "number": details.get("season_number", season),
            "name": details.get("name") or "",
            "episode_count": len(episodes),
            "poster_url": _image_url(details.get("poster_path"), "w500"),
        },
        "episodes": episodes,
    }


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


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
    trailer_key = tmdb.select_trailer_key(details.get("videos", {}).get("results", []))

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

    # Embed URLs for every provider in the chain, keyed by provider id.
    #
    # This dict used to be a hand-written literal naming three hosts, one of
    # which (`vidsrc.me`) no longer resolves, and the client's source selector
    # was built from the manifest rather than from it -- so the two disagreed and
    # the retired host still reached the player. It is generated from the
    # manifest now, so a provider cannot exist on only one side.
    embed_urls = {}
    for provider in stream_providers.active_embed_providers():
        url = provider.build(tmdb_id, media_type, 1, 1)
        if url:
            embed_urls[provider.id] = url
    result["embed_urls"] = embed_urls
    result["default_embed"] = next(iter(embed_urls.values()), "")

    return jsonify(result)


# ---------------------------------------------------------------------------
# Accounts & per-account watch history
# ---------------------------------------------------------------------------

def _auth_error(message: str, code: int = 401):
    return jsonify({"error": message}), code


def _resolve_profile(user, payload=None):
    """Resolve and authorise the profile a request is acting on.

    The profile id is user-controlled, so it is always validated against the
    signed-in account. An account that has created no profiles yet still works:
    the caller falls back to the unprofiled path rather than being locked out.
    """
    store = authdb.get_store()
    # GET and DELETE carry the profile in the query string (there is no body),
    # so both have to be consulted or those requests silently fall back to the
    # first profile and read the wrong watcher's history.
    raw = (payload or {}).get("profile_id") or request.args.get("profile_id")
    if raw in (None, ""):
        # No profile supplied: use the account's first profile if there is one.
        profiles = store.list_profiles(user["id"])
        if not profiles:
            return None
        return profiles[0]
    # Left as a string: ids are UUIDs on postgres and integers on sqlite, so
    # coercing to int raised a ValueError on the uuid deployment and turned every
    # profile-scoped request into a 500. The lookup below is the only
    # authorisation that matters, and it works for either type.
    return store.profile_by_id(raw, user["id"]) or False


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


@app.route("/api/auth/account", methods=["DELETE", "OPTIONS"])
def api_delete_account():
    """Delete the signed-in account and everything attached to it.

    The privacy notice promises a deletion route, and there was no endpoint and
    no client surface behind it -- so the promise was one a viewer could not
    act on.

    Password confirmation is required because this is irreversible and the
    bearer token is long-lived: a token that leaked, or a shared device someone
    was left logged into, would otherwise be enough to destroy someone's
    history without their involvement. Signing in again is the check that costs
    the least and proves the password is known rather than merely that a token
    exists.
    """
    if request.method == "OPTIONS":
        return ("", 204)
    user = _auth_user()
    if not user:
        return _auth_error("Sign in to delete your account.")

    payload = request.get_json(silent=True) or {}
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", str(payload.get("email") or "")):
        return _auth_error("Confirm the email address on the account.", 400)
    if str(payload.get("email") or "").strip().lower() != str(user["email"]).lower():
        # Deliberately the same message as an unknown address: reporting "that
        # is not the address on this account" would let a token holder confirm
        # which email the account is registered to.
        return _auth_error("Confirm the email address on the account.", 400)
    if not str(payload.get("password") or ""):
        return _auth_error("Enter your password to delete the account.", 400)
    if not authdb.get_store().verify_password(
        user, str(payload.get("password"))
    ):
        return _auth_error("That password did not match.", 401)

    try:
        deleted = authdb.get_store().delete_user(user["id"])
    except Exception:
        app.logger.exception("account deletion failed")
        return _auth_error("Could not delete the account. Try again.", 500)
    if not deleted:
        return _auth_error("Could not delete the account. Try again.", 500)
    return jsonify({"success": True})


# ---------------------------------------------------------------------------
# Profiles (a home is the signed-in account; max 4)
# ---------------------------------------------------------------------------

def _serialize_profile(profile: dict) -> dict:
    """Public shape of a profile.

    `pin_hash` and `pin_salt` are deliberately absent: the client only needs to
    know that a lock exists, and shipping the hash to the browser would make the
    PIN brute-forceable offline.
    """
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
        profiles = store.list_profiles(user["id"])
        return jsonify(
            {
                "profiles": [_serialize_profile(p) for p in profiles],
                "max": store.MAX_PROFILES,
            }
        )

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return _auth_error("Enter a name for this profile.", 400)
    if len(name) > 40:
        return _auth_error("That name is too long.", 400)

    pin = str(payload.get("pin") or "")
    if pin and not re.match(r"^\d{4,8}$", pin):
        return _auth_error("A PIN must be 4 to 8 digits.", 400)
    # The account cap is a business rule, so it is enforced here rather than
    # only in the picker UI.
    if store.count_profiles(user["id"]) >= store.MAX_PROFILES:
        return _auth_error(
            f"A home can have up to {store.MAX_PROFILES} profiles.", 409
        )

    pin_hash, pin_salt = (None, None)
    if pin:
        pin_salt = secrets.token_hex(16)
        pin_hash = store.hash_secret(pin, pin_salt)
    try:
        profile = store.create_profile(
            user["id"],
            name,
            avatar=str(payload.get("avatar") or "")[:400],
            avatar_id=(str(payload.get("avatar_id"))[:40] or None),
            is_kids=1 if payload.get("is_kids") else 0,
            pin_hash=pin_hash,
            pin_salt=pin_salt,
        )
    except Exception:
        app.logger.exception("profile create failed")
        return _auth_error("Could not create the profile. Try again.", 500)
    if not profile:
        return _auth_error(
            f"A home can have up to {store.MAX_PROFILES} profiles.", 409
        )
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
    # A PIN is only ever set or replaced, never read back: sending an empty pin
    # clears the lock, which is the documented "remove PIN" path.
    if "pin" in payload:
        pin = str(payload.get("pin") or "")
        if pin and not re.match(r"^\d{4,8}$", pin):
            return _auth_error("A PIN must be 4 to 8 digits.", 400)
        if pin:
            salt = secrets.token_hex(16)
            updates["pin_salt"] = salt
            updates["pin_hash"] = store.hash_secret(pin, salt)
            updates["is_locked"] = 1
        else:
            updates["pin_hash"] = None
            updates["pin_salt"] = None
            updates["is_locked"] = 0
    try:
        updated = store.update_profile(profile_id, user["id"], **updates)
    except Exception:
        app.logger.exception("profile update failed")
        return _auth_error("Could not update the profile. Try again.", 500)
    return jsonify({"profile": _serialize_profile(updated)})


@app.route("/api/profiles/<profile_id>/unlock", methods=["POST", "OPTIONS"])
def api_profile_unlock(profile_id: str):
    """Check a profile PIN.

    The account password is *not* accepted here. A PIN is a child-level lock,
    and accepting the account password here would make it look like the
    account itself is protected by a second factor, which it is not.
    """
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
    ok = store.verify_secret(
        pin, profile.get("pin_hash") or "", profile.get("pin_salt") or ""
    )
    if not ok:
        return _auth_error("Incorrect PIN.", 401)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Daily allowance & referrals
# ---------------------------------------------------------------------------

def _allowance_payload(store, user, profile):
    day = authdb.utc_today()
    data = store.allowance(user["id"], profile["id"], day)
    # The countdown needs an explicit reset instant, not just the day string, so
    # the client does not have to re-derive midnight in its own timezone.
    reset = (
        datetime.strptime(day, "%Y-%m-%d")
        + timedelta(days=1)
    ).replace(tzinfo=timezone.utc)
    data["resets_at"] = reset.isoformat()
    data["timezone"] = "UTC"
    return data


# ---------------------------------------------------------------------------
# Taste signals & recommendations
# ---------------------------------------------------------------------------

def _taste_payload() -> tuple[dict | None, dict | None, object]:
    """Resolve the acting user, profile and parsed body in one place.

    Returns `(user, profile, payload)`. `user` is None when signed out and
    `profile` is False when the requested profile is not theirs, which the
    callers turn into 401 and 403 respectively.

    Unlike `_resolve_profile`, an explicit `profile_id` is required here. These
    endpoints operate on one viewer's taste data, so silently substituting the
    first profile when the id is missing or foreign would read and write the
    wrong watcher's signals -- and would report a 409 ("create a profile") for
    what is really a 403.
    """
    user = _auth_user()
    if not user:
        return None, None, {}
    payload = request.get_json(silent=True) or {}
    raw = payload.get("profile_id") or request.args.get("profile_id")
    if raw in (None, ""):
        profiles = authdb.get_store().list_profiles(user["id"])
        # No id supplied: fall back to the caller's only profile, which is the
        # common single-viewer case, but never to another account's.
        return user, (profiles[0] if len(profiles) == 1 else None), payload
    # Passed through as a string, not coerced to int: profile ids are UUIDs on
    # postgres and autoincrement integers on sqlite, and `int("3f2b-...")`
    # raised on the deployment that matters most.
    return user, authdb.get_store().profile_by_id(raw, user["id"]) or False, payload


def _clamp_int(raw, default: int, low: int, high: int) -> int:
    """Parse a query-string integer, falling back instead of raising.

    `int("abc")` on a public feed parameter turned a stray `?limit=` into a 500
    with a stack trace in the log, so every numeric argument coming off the
    query string goes through here.
    """
    if raw in (None, ""):
        return default
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


@app.route("/api/taste", methods=["POST", "OPTIONS"])
def api_taste():
    """Record one interaction for the active profile.

    Only derived features are accepted. A `query` is tokenised and hashed here
    and the text is dropped on the floor, so a private search leaves a
    fingerprint behind rather than the words.
    """
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
        # Below the repeat threshold this is noise, so it is counted but not
        # folded into the weights.
        if count < taste.SEARCH_TOKEN_MIN_HITS:
            return jsonify({"ok": True, "recorded": True, "applied": False})
        tokens = taste.tokenise_query(query)
        if not tokens:
            # Every word was a stopword or a year: the query says nothing about
            # what this viewer likes, so it is counted but not applied.
            return jsonify({"ok": True, "recorded": True, "applied": False})
        # Search taste is recorded as the *repeat count* of a hashed key and
        # nothing else. The words are deliberately not written anywhere: an
        # earlier version folded the tokens into the weight state, which meant
        # the query text was recoverable from taste_signals -- exactly what the
        # hashing is meant to prevent. What a profile gains from searching is
        # "this viewer searched for something often", not a memory of what.
        repeat_weight = store.search_token_weight(profile_id, key) or float(count)
        state = store.load_taste_state(profile_id)
        state = taste.fold_event_with_director(
            state, "search", [f"q:{key}"], [], weight=repeat_weight
        )
        store.save_taste_state(profile_id, state)
        return jsonify({"ok": True, "recorded": True, "applied": True})

    genres = payload.get("genres") or payload.get("genre") or []
    # `people` is what the client actually sends; `cast` and `director` are also
    # accepted so the older shape keeps working. Only reading `cast` meant a
    # client following the documented `people` field recorded no cast at all,
    # and the director was silently dropped.
    people = payload.get("people") or []
    cast = payload.get("cast") or []
    director = payload.get("director")
    if isinstance(genres, str):
        genres = [genres]
    if not isinstance(genres, list):
        genres = []
    if not isinstance(people, list):
        people = []
    if not isinstance(cast, list):
        cast = []
    # Cast names are personal data about real people; storing the full top-billed
    # list would be both noisy and a needless record. Three is enough to
    # recognise a favourite without profiling a cast.
    named = [str(p).strip() for p in (list(people) + list(cast)) if str(p).strip()]
    named = [p for p in named if p.lower() != str(director or "").strip().lower()][:3]
    if director:
        named.append(str(director).strip())

    store.record_taste_event(
        profile_id,
        kind,
        genres=[str(g).strip() for g in genres][:8],
        people=named,
        media_key=(str(payload.get("media_key"))[:200] or None),
        weight=float(payload.get("weight") or 1.0),
    )
    # Fold into the weights now rather than waiting for a scheduled rebuild.
    # The state table is a cache, but if nothing ever writes it, a profile that
    # has played twenty films still reports no signal and the feed stays
    # unranked -- which is exactly what happened before this call.
    state = taste.fold_event_with_director(
        store.load_taste_state(profile_id),
        kind,
        [str(g).strip() for g in genres][:8],
        named,
        weight=float(payload.get("weight") or 1.0),
    )
    store.save_taste_state(profile_id, state)
    return jsonify({"ok": True, "recorded": True, "applied": True})


@app.route("/api/taste/state", methods=["GET", "POST", "OPTIONS"])
def api_taste_state():
    """Read the profile's weights, or rebuild them from the event log.

    The rebuild is what a scheduled retrain calls: `taste_events` is the source
    of truth and the state table is a cache of it, so a rollup can always be
    recomputed rather than trusted.
    """
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
            state = taste.fold_event_with_director(
                state,
                event.get("kind", "play"),
                [g for g in (event.get("genres") or "").split(",") if g],
                [p for p in (event.get("people") or "").split(",") if p],
                weight=event.get("weight", 1.0),
            )
        # Search taste is folded in from the repeat counters rather than
        # replayed from the log. Searches deliberately write no event -- that
        # is what keeps the query text out of the database -- so a rebuild from
        # events alone would silently erase everything the profile learned
        # from searching.
        for feature, hits in store.search_token_hits(profile_id).items():
            if hits < taste.SEARCH_TOKEN_MIN_HITS:
                continue
            state = taste.fold_event_with_director(
                state, "search", [f"q:{feature}"], [], weight=float(hits)
            )
        store.save_taste_state(profile_id, state)
        # The same payload the GET returns, plus `rebuilt`. It used to return
        # only {ok, rebuilt, state}, so a client that treated the two verbs
        # alike read `event_count` and `has_signal` as undefined after a
        # rebuild and concluded the profile had no signal.
        return jsonify(
            dict(
                _taste_state_payload(store, profile_id, state),
                rebuilt=True,
            )
        )

    return jsonify(
        _taste_state_payload(store, profile_id, store.load_taste_state(profile_id))
    )


def _taste_state_payload(store, profile_id, state):
    return {
        "profile_id": profile_id,
        "state": state,
        "model_version": store.model_version(profile_id) or "linear-v1",
        "has_signal": taste.has_signal(state),
        # How much raw material the weights came from. Useful when diagnosing a
        # profile whose feed is not personalising: a state with features but
        # almost no events means the cache is stale and wants a rebuild.
        "event_count": len(store.taste_events(profile_id)),
    }


@app.route("/api/recommendations", methods=["GET", "OPTIONS"])
def api_recommendations():
    """Rank a catalogue list for the active profile.

    The upstream list still decides what is in the window; this only reorders
    it, so a profile with no history sees the plain catalogue rather than an
    empty page.
    """
    if request.method == "OPTIONS":
        return ("", 204)
    user, profile, _ = _taste_payload()
    # These list helpers take a page, not a count, so the window is a page and
    # the slice bounds how much is actually returned. `?limit=abc` used to
    # raise ValueError and surface a 500 on a public feed endpoint.
    page = _clamp_int(request.args.get("page"), default=1, low=1, high=5)
    limit = _clamp_int(request.args.get("limit"), default=20, low=1, high=40)
    kind = (request.args.get("kind") or "trending").strip().lower()

    if kind == "popular":
        items = tmdb.get_popular("movie", page) or []
    elif kind == "now_playing":
        items = tmdb.get_now_playing(page) or []
    else:
        items = tmdb.get_trending_catalog("week", "all") or []

    # Rank on the same normalised shape the catalogue serves, then return that
    # shape. The raw TMDB rows only carry `poster_path` and `genre_ids`, so
    # returning them directly made the "For You" row render posterless cards
    # with no year or genres -- the client maps `CatalogItem`, and a raw TMDB
    # dict is not one.
    items = [
        tmdb.normalize_tmdb_item(item, item.get("media_type") or "movie")
        for item in items
    ]
    items = [item for item in items if item]

    # Personalisation is an enhancement, not a gate. Requiring auth or a profile
    # here made this a 401/403 for exactly the viewers who most need a working
    # feed -- a signed-out visitor, or someone who has not created a profile yet
    # and cannot fix that from this screen. The unranked list is the correct
    # answer for them, and `personalised: False` is the honest way to say so.
    if not user or profile is False or not profile:
        return jsonify({"results": items[:limit], "personalised": False})

    store = authdb.get_store()
    state = store.load_taste_state(profile["id"])
    if not taste.has_signal(state):
        return jsonify({"results": items[:limit], "personalised": False})
    ranked = taste.rank(state, items)
    # `has_signal` says the profile has *something* to match on; it does not say
    # any of this particular page matches. Reporting `personalised: True` over a
    # list where every score was 0.0 is the claim the client renders as "For
    # You", so the flag follows whether ranking moved the page.
    scores = taste.ranked_scores(state, items)
    if max(scores) <= 0.0:
        return jsonify({"results": items[:limit], "personalised": False})
    return jsonify(
        {
            "results": ranked[:limit],
            "personalised": True,
            "top_score": round(max(scores), 4),
            "model_version": store.model_version(profile["id"]) or "linear-v1",
        }
    )


@app.route("/api/recommendations/eval", methods=["GET", "OPTIONS"])
def api_recommendations_eval():
    """Held-out evaluation of the current model on a profile's own history.

    Exposed rather than buried in a cron log because the claim "this
    recommender works" should be checkable by the person relying on it.
    Returns `verdict: not_better` when the model does not beat a random
    baseline, which is the expected answer at low interaction counts.
    """
    if request.method == "OPTIONS":
        return ("", 204)
    user, profile, _ = _taste_payload()
    if not user:
        return _auth_error("Sign in to see your evaluation.")
    if profile is False:
        return _auth_error("Unknown profile.", 403)
    if not profile:
        return _auth_error("Create a profile first.", 409)
    store = authdb.get_store()
    # Unwrapped: the response is the evaluation itself. Nesting it under
    # `evaluation` meant the client's typed field was one level too deep, so
    # every value read as undefined and the endpoint looked broken.
    return jsonify(taste.evaluate(store.taste_events(profile["id"])))


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
        return jsonify(
            {
                "allowance": {
                    "used": 0, "remaining": 0, "per_profile_cap": 0,
                    "account_cap": 0, "account_used": 0, "unlocked": False,
                    "unlimited": False,
                    "resets_at": (
                        datetime.now(timezone.utc).replace(
                            hour=0, minute=0, second=0, microsecond=0
                        ) + timedelta(days=1)
                    ).isoformat(),
                    "timezone": "UTC",
                },
                "profiles": [],
            }
        )
    # The headline allowance must be the *active* profile's. It used to be
    # `profiles[0]`, so a household with four profiles was metered against
    # whichever account was created first -- the client sends ?profile_id= and
    # the server ignored it. `profiles` still carries every profile's numbers,
    # which is what the switcher renders.
    active = _resolve_profile(user)
    if active is False or not isinstance(active, dict):
        active = profiles[0]
    payload = _allowance_payload(store, user, active)
    payload["profile_id"] = active["id"]
    return jsonify(
        {
            "allowance": payload,
            "profiles": [
                dict(_allowance_payload(store, user, p), profile_id=p["id"])
                for p in profiles
            ],
        }
    )


@app.route("/api/allowance/claim", methods=["POST", "OPTIONS"])
def api_allowance_claim():
    """Claim today's allowance for one title.

    Called when playback starts rather than on page load, so a title the user
    opens and immediately leaves does not burn the daily allowance. The claim is
    idempotent per (profile, day, title), which is what makes a double click or
    a second tab safe.
    """
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
        # An unlocked day means the cap does not apply, but the play is still
        # recorded: the history and the "what did I watch" list depend on it.
        store.record_play(profile["id"], day, movie_key, user["id"], enforce_caps=False)
        return jsonify(
            {
                "ok": True,
                "claimed": True,
                "allowance": _allowance_payload(store, user, profile),
            }
        )

    # No pre-check on `remaining`. It used to run here, which had two problems:
    # the check and the insert were separate statements, so concurrent claims
    # could both see one slot left and both take it; and a viewer who had
    # already used their ten titles got a 429 for re-opening a title they had
    # already watched, which reads as "you were charged twice".
    #
    # The insert is now the decision -- it only writes when both caps have room
    # -- so the only question left afterwards is why it declined.
    claimed = store.record_play(profile["id"], day, movie_key, user["id"])
    if not claimed and not store.claimed_today(profile["id"], day, movie_key):
        return (
            jsonify(
                {
                    "error": (
                        "You have used today's free titles. "
                        "Refer a friend to unlock more."
                    ),
                    "code": "daily_limit",
                    "allowance": _allowance_payload(store, user, profile),
                }
            ),
            429,
        )
    return jsonify(
        {
            "ok": True,
            # False here means "already on today's bill", not "refused".
            "claimed": claimed,
            "allowance": _allowance_payload(store, user, profile),
        }
    )


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
    return jsonify(
        {
            "code": stats["code"],
            "accepted": stats["accepted"],
            "granted_days": stats["granted_days"],
            "unlocked_today": store.has_unlocked_day(user["id"], day),
            "unlocks_per_referral": authdb.REFERRAL_UNLOCKS_PER_ACCEPT,
            "day": day,
        }
    )


@app.route("/api/referrals/apply", methods=["POST", "OPTIONS"])
def api_referrals_apply():
    """Redeem a friend's code.

    Each accepted referral unlocks one day, where a day means "the cap does not
    apply for that UTC date". The grant is keyed to a concrete day rather than a
    counter, because a day-based benefit should not be spendable twice and
    should be visible in the UI as a calendar fact.
    """
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
        return _auth_error(
            "That code has already been used, or it is your own.", 409
        )

    # Both sides get the day, which is what the copy in DailyLimitNotice
    # promises. Previously only the joiner was granted one, so the inviter saw
    # their accepted count rise and nothing else happen.
    inviter_id = store.referrer_of(user["id"])
    for recipient in [user["id"], inviter_id]:
        if recipient is None:
            continue
        # Unlocked days are consumed oldest-first so a grant always lands on a
        # distinct future date rather than stacking on today.
        day = authdb.utc_today()
        for offset in range(0, authdb.REFERRAL_UNLOCKS_PER_ACCEPT):
            target = (
                datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1 + offset)
            ).strftime("%Y-%m-%d")
            if not store.has_unlocked_day(recipient, target):
                store.grant_day(recipient, target)
    stats = store.referral_stats(user["id"])
    return jsonify(
        {
            "success": True,
            "code": stats["code"],
            "accepted": stats["accepted"],
            "granted_days": stats["granted_days"],
        }
    )


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

    history = store.history(user_id, profile_id=profile_id)
    return jsonify({"history": history, "profile_id": profile_id})


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
    authdb.get_store().remove_history(
        user["id"], movie_key, profile["id"] if profile else None
    )
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