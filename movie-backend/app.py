"""
FreeStream Backend - TMDB-First Metadata & Streaming API

Serves live TMDB search (GET /api/search), trending/popular/now_playing/on_the_air feeds,
the unified playback contract (POST/GET /api/v1/playback/init), tokenised playback legs
(GET /api/v1/playback/media, /frame, /captions, /download), locale configuration
(GET/POST /api/v1/locale/config), operator metrics (GET /api/admin/system/metrics),
trailer lookup (GET /api/movies/trailer), and episode details (GET /api/episodes).
Third-party HLS is relayed through GET /api/proxy/manifest and GET /api/proxy/segment,
which carry a Referer and a browser User-Agent upstream so hls.js can play what the
origin would otherwise refuse cross-origin.

No response carries a third-party URL: every playable, embeddable or downloadable
target crosses the wire as an opaque handle minted by playback_tokens, so the set of
hosts this process will fetch for a client is decided entirely by server-side
resolution (see docs/api.md).

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

from flask import Flask, Response, jsonify, redirect, request, stream_with_context
from werkzeug.exceptions import HTTPException

import requests
from cachetools import TTLCache

# Imported first so the dotenv file is loaded before any module reads a secret.
from runtime_config import load_env_file, ssl_context, tmdb_api_key

load_env_file()

import authdb
import caption_engine
import catalog_lib
import catalog_service
import geo_locale
import locale_settings
import playback_tokens
import stream_providers
import taste
import telemetry
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


# Season payloads, keyed by "id:season" (or "id:latest"). A season's episode list
# is fixed once it has aired, so this is the one TMDB response on this path that
# can be held for hours rather than seconds -- and the episode shelf asks for
# several shows on every page load, so without it every viewer would pay for the
# same handful of lookups. Misses are never cached, which matters most for the
# "latest" key: a show with no aired season yet has to start resolving the
# moment its season drops rather than at the end of a TTL.
_season_cache: TTLCache = TTLCache(maxsize=CACHE_MAX_SIZE, ttl=CACHE_TTL_SECONDS)
#: `TTLCache` is not internally synchronised, and gunicorn runs this app with
#: more than one worker thread. A read-modify-write on the underlying dict can
#: interleave two writers into a lost entry, so every access to the season cache
#: is made under this. (The direct-source caches have their own lock, below.)
_season_cache_lock = threading.Lock()


def _image_url(path, size: str) -> str:
    return f"https://image.tmdb.org/t/p/{size}{path}" if path else ""


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

# NOTE: moving the frontend to a new domain requires adding it HERE as well, and
# redeploying the backend. A domain change is not frontend-only: until this list
# contains the new origin, the browser refuses every cross-origin call with
# "No 'Access-Control-Allow-Origin' header", which looks like an outage and is
# only a stale allowlist. Set ALLOWED_ORIGINS in the environment to override.
_DEFAULT_ALLOWED_ORIGINS = (
    "https://streamvy.me,https://www.streamvy.me,https://streamvy.vercel.app,"
    "https://vy-virid.vercel.app,"
    "http://localhost:5173,http://127.0.0.1:5173,"
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

    Shared by /api/v1/playback/init and /api/episodes so both classify a bad id
    the same way instead of one 400-ing and the other 404-ing with a message
    that blames the title.
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


# Cap the upstream caption fetch so a slow Archive.org node cannot pin a
# worker thread. Caption files are small (tens of KB), so a hard byte ceiling
# also prevents the caption route being used to pull an arbitrary large file.
SUBTITLE_TIMEOUT_SECONDS = 15
SUBTITLE_MAX_BYTES = 4 * 1024 * 1024


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


# ---------------------------------------------------------------------------
# Telemetry & the memory guard
#
# Every request is counted and every error class recorded, so the operator
# metrics route reports the process that served it rather than a guess. The
# guard runs *before* the bulk-memory routes only: those are the ones that
# fetch a manifest, relay a file, or walk a provider chain -- the work whose
# allocations actually threaten the worker. Answering them 503 with an
# explicit code when RSS is at the ceiling sheds load honestly (retryable,
# distinguishable from "no source exists"), while metadata routes keep
# answering because they allocate kilobytes.
# ---------------------------------------------------------------------------

#: Paths that pull bulk bodies upstream or buffer them in process. Kept as
#: explicit paths rather than a prefix so a future metadata route added under
#: /api/v1 is not silently made sheddable.
_MEMORY_GUARDED_PATHS = frozenset(
    {
        "/api/v1/playback/init",
        "/api/v1/playback/media",
        "/api/v1/playback/download",
        "/api/proxy/manifest",
        "/api/proxy/segment",
    }
)


@app.before_request
def _telemetry_before_request():
    telemetry.begin_request()
    if request.method == "OPTIONS":
        return None
    if request.path in _MEMORY_GUARDED_PATHS and telemetry.over_budget():
        return _json_error(
            "The server is at its memory limit. Try again shortly.",
            503,
            code="RESOURCE_LIMIT_EXCEEDED",
        )
    return None


@app.after_request
def _telemetry_after_request(response):
    telemetry.end_request(response.status_code or 500)
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

# ---------------------------------------------------------------------------
# Playback: one init call; every downstream leg is an opaque handle
#
# `/api/v1/playback/init` is the only route that resolves a title. It answers
# with metadata and with same-origin URLs -- a manifest relay, a media relay,
# a frame redirect, caption tracks, download legs -- each carrying an opaque
# handle minted by `playback_tokens`. Nothing hereafter hands a client a
# third-party URL, so the set of hosts this process will ever fetch is decided
# by server-side resolution alone, and a client cannot turn any playback leg
# into a general-purpose fetcher.
#
# The metadata half is deliberately the same answer `/api/movies/resolve`
# used to give (exact-title matching, redirect refusal, season/episode
# counts), because those rules exist to stop an unrelated title playing under
# the right heading -- they belong to resolution wherever it is exposed.
# ---------------------------------------------------------------------------


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

    Downloadability is decided here by the same allowlist the relay enforces,
    because the client can no longer classify a URL it never sees: `null` is
    the honest answer for a tier the download route would refuse, rather than
    a handle that 400s when clicked.
    """
    try:
        catalog_lib.validate_archive_url(url, require_download_path=True)
    except Exception:  # noqa: BLE001 - not downloadable == no handle, not an error
        return None
    token = playback_tokens.issue(
        playback_tokens.KIND_DOWNLOAD, url, meta={"filename": filename, "region": region or ""}
    )
    return f"/api/v1/playback/download?token={token}"


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

    resolution = stream_providers.resolve_direct(
        _direct_source_for,
        tmdb_id=tmdb_id,
        media_type=media_type,
        title=title_for_direct,
        year=year_for_direct,
        season=season,
        episode=episode,
        refresh=refresh,
    )

    if not resolution.ok:
        # 404 with an explicit code, not 503: every provider was walked and
        # none could serve the title, so re-asking only re-walks what just
        # failed. The planned chain is still handed back -- as frame handles,
        # never raw URLs -- so a client walking it on its own timer has
        # something to walk.
        planned = [
            {
                "name": entry["name"],
                "url": _frame_url(entry["url"], region),
                "is_embed": True,
            }
            for entry in stream_providers.planned_candidate_entries(
                tmdb_id, media_type, season, episode
            )
            if entry.get("url")
        ]
        return _json_error(
            "No active stream sources",
            404,
            code="PROVIDERS_EXHAUSTED",
            available=False,
            providers=planned,
            provider_attempts=resolution.attempts,
        )

    winner = resolution.winner
    direct = winner.payload if winner.kind == "direct" else None
    is_embed = resolution.is_embed

    streams: list[dict] = []
    mirrors: list[dict] = []
    sources: list[str] = []
    subtitles: list[dict] = []

    # A direct source is expected to be a progressive file off archive.org.
    # Anything that looks like a trailer host or a short-clip endpoint is a
    # regression -- a trailer must never reach the main player (it belongs only
    # in the "Trailers" tab, which fetches separately via the trailer routes).
    # This is a cheap final guard behind `choose_streams`' own filename/size
    # filters, not a substitute for them.
    def _is_trailer_endpoint(raw: str) -> bool:
        lowered = raw.lower()
        if any(
            host in lowered
            for host in ("youtube.com", "youtu.be", "youtube-nocookie.com")
        ):
            return True
        path = urllib.parse.urlparse(raw).path.lower()
        return any(token in path for token in ("/trailer", "trailer.", "/clip", "featurette"))

    if direct:
        # One handle per raw URL, not per call: the same file named by the
        # default stream and by its own quality tier must produce one token,
        # or the client's URL Set sees two distinct strings and offers the
        # viewer the identical source twice under different labels.
        play_cache: dict[str, tuple[str, str]] = {}

        def cached_play(raw: str) -> tuple[str, str]:
            if raw not in play_cache:
                play_cache[raw] = _play_url(raw, region)
            return play_cache[raw]

        primary_raw = direct.get("stream_url") or ""
        if primary_raw and _is_trailer_endpoint(primary_raw):
            # A trailer leaked into the direct candidate. Treat the whole
            # direct hit as unusable and fall through to the embed chain below
            # rather than boot the player on a nine-minute clip.
            print(f"[Catalog] discarded trailer-like direct stream for {title!r}: {primary_raw}")
            direct = None
        else:
            primary_url, primary_format = cached_play(primary_raw)
            if primary_url:
                sources.append(primary_url)
            seen_sources = {primary_url}
            for index, tier in enumerate(direct.get("streams") or []):
                tier_url = str(tier.get("url") or "")
                if not tier_url or _is_trailer_endpoint(tier_url):
                    continue
                play, fmt = cached_play(tier_url)
                if not play:
                    continue
                quality = str(tier.get("quality") or "")
                try:
                    height = int(tier.get("height") or 0)
                except (TypeError, ValueError):
                    height = 0
                try:
                    size = int(tier.get("size") or 0)
                except (TypeError, ValueError):
                    size = 0
                streams.append(
                    {
                        "quality": quality,
                        "height": height,
                        "width": tier.get("width") or 0,
                        "size": size,
                        "url": play,
                        "format": fmt,
                        "download_url": _download_url(
                            tier_url, _download_filename(title, quality, tier_url), region
                        ),
                    }
                )
                if play not in seen_sources:
                    seen_sources.add(play)
                    sources.append(play)
                if tier_url != (direct.get("stream_url") or ""):
                    mirrors.append(
                        {"name": f"Server {index + 1}", "url": play}
                    )
            subtitles = _caption_tracks(direct.get("subtitles"), region)

    if not direct:
        # Prefer the first embed candidate over `resolution.url`: when the
        # discarded winner was the direct hit, `resolution.url` still points at
        # that same rejected URL, and minting a frame handle for it would put
        # the trailer right back into the player.
        embed_url = next(
            (
                entry["url"]
                for entry in resolution.candidate_entries()
                if entry.get("is_embed") and entry.get("url")
            ),
            resolution.url,
        )
        primary_url, primary_format = _frame_url(embed_url, region), "frame"

    # The embed failover chain, as frame handles. Direct entries a resolution
    # may include are dropped on purpose: every direct candidate is already in
    # `sources`/`mirrors`, and this array is what the embed player walks --
    # a progressive file here would end up in an <iframe>.
    providers = [
        {
            "name": entry["name"],
            "url": _frame_url(entry["url"], region),
            "is_embed": True,
        }
        for entry in resolution.candidate_entries()
        if entry.get("is_embed") and entry.get("url")
    ]
    if not providers:
        providers = [
            {
                "name": entry["name"],
                "url": _frame_url(entry["url"], region),
                "is_embed": True,
            }
            for entry in stream_providers.planned_candidate_entries(
                tmdb_id, media_type, season, episode
            )
            if entry.get("url")
        ]

    runtime = details.get("runtime")
    if runtime is not None:
        try:
            runtime = int(runtime)
        except (ValueError, TypeError):
            runtime = None

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
        "provider": winner.id,
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

    return jsonify(
        {
            "success": True,
            "exact": True,
            "available": True,
            "format": primary_format,
            "provider": winner.id,
            "language": language,
            "country": region,
            "movie": movie,
        }
    )


@app.route("/api/movies/resolve", methods=["GET", "POST", "OPTIONS"])
def resolve_movie():
    """Compatibility alias for /api/v1/playback/init.

    The web client still calls this path from three places -- the stream
    resolver (`api.ts resolveStream`), the Watch page's metadata fetch, and
    the details sheet's warm resolve -- with the pre-v1 field names
    (`id`/`title`/`year`/`season`/`episode`), which `_init_inputs` already
    accepts as aliases. The v1 response is a strict superset of the old
    contract (`movie` + `exact` + `language` are all present), so the same
    handler answers both paths and nothing on the client needs to change to
    stop the 404 this route's removal caused on every cold open.
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
            url, SUBTITLE_TIMEOUT_SECONDS, SUBTITLE_MAX_BYTES
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


@app.route("/api/v1/playback/media", methods=["GET", "OPTIONS"])
def playback_media():
    """Relay the handle's progressive bytes: same-origin, range-safe.

    The bytes come through this origin so the player gets `Access-Control-
    Allow-Origin` and a `Range` that the archive node actually honours --
    seeking a cross-origin file without both is a full re-download or a dead
    scrubber. Range is passed through exactly as the browser sent it, and the
    upstream's status (200 or 206) and Content-Range come back unchanged, so
    the media element sees one honest, seekable resource.

    Only `open_archive_stream`'s allowlisted hosts are reachable here, checked
    per request -- the handle says which file, the allowlist says whether this
    server may serve it at all.
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
        status, headers, body = catalog_lib.open_archive_stream(
            url, request.headers.get("Range")
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


# ---------------------------------------------------------------------------
# Locale: what language to play in, what language to caption in, which region
# the viewer is in. Read (GET) without a session -- a signed-out visitor still
# starts somewhere; written (POST) only to a profile, because a choice with
# nowhere to live is a setting that silently vanishes on reload.
# ---------------------------------------------------------------------------

#: Config key -> profile column. The API contract is the config vocabulary
#: (`language`, not `preferred_language`); the profile vocabulary is storage.
LOCALE_CONFIG_COLUMNS = {
    "language": "preferred_language",
    "subtitle_language": "preferred_subtitle",
    "region": "locale_region",
}


@app.route("/api/v1/locale/config", methods=["GET", "POST", "OPTIONS"])
def locale_config():
    """Read (GET) or set (POST) the playback locale.

    GET answers without a session: seed values only (geo IP + Accept-Language
    + English), with `sources` reported per field so a wrong answer can be
    told apart from a wrong *saved preference*. POST requires a session and
    validates strictly -- an unknown language, a three-letter region or a
    missing value is a 400 naming the field, never a silent ignore, because a
    setting that half-applies is a setting the viewer cannot trust.

    `subtitle_language` may be `"off"`: turning captions off is a choice with
    the same standing as picking one, and it is stored the same way.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    if request.method == "GET":
        user = _auth_user()
        profile = _resolve_profile(user) if user else None
        if profile is False:
            return _auth_error("Unknown profile.", 404)
        config = locale_settings.effective_config(
            request, profile if isinstance(profile, dict) else None
        )
        return jsonify({"success": True, "config": config})

    user = _auth_user()
    if not user:
        return _auth_error("Sign in to save locale preferences.")
    if request.data and not request.is_json:
        return _json_error("Content-Type must be application/json.", 400)
    payload = request.get_json(silent=True)
    if payload is None:
        return _json_error("Request body must be a JSON object.", 400)
    if not isinstance(payload, dict):
        return _json_error("Request body must be a JSON object.", 400)

    unknown = [key for key in payload if key not in LOCALE_CONFIG_COLUMNS]
    if unknown:
        return _json_error(
            f"Unknown config field: {unknown[0]}. "
            "Expected language, subtitle_language or region.",
            400,
        )
    try:
        validated = locale_settings.validate_config(payload, field_prefix="config")
    except ValueError as error:
        return _json_error(str(error), 400)
    if not validated:
        return _json_error(
            "Provide at least one of language, subtitle_language, region.", 400
        )

    profile = _resolve_profile(user)
    if profile is False:
        return _auth_error("Unknown profile.", 404)
    if not isinstance(profile, dict):
        return _auth_error("Create a profile before saving locale preferences.", 400)

    updates = {
        LOCALE_CONFIG_COLUMNS[key]: value
        for key, value in validated.items()
        if key in LOCALE_CONFIG_COLUMNS
    }
    store = authdb.get_store()
    try:
        updated = store.update_profile(profile["id"], user["id"], **updates)
    except Exception:
        app.logger.exception("locale config update failed")
        return _auth_error("Could not save locale preferences. Try again.", 500)

    config = locale_settings.effective_config(request, updated or profile)
    return jsonify({"success": True, "config": config})


# ---------------------------------------------------------------------------
# HLS relay: manifests and segments
#
# hls.js cannot read a third-party playlist in the browser. The `.m3u8` and the
# `.ts` chunks behind it are cross-origin, and the origin serving them answers
# neither CORS nor the Referer check its CDN performs -- so the request dies
# before a byte reaches the decoder, and no amount of player-side configuration
# fixes it. Both hops are relayed from here instead: the manifest is fetched
# with browser-looking headers and every URI line inside it rewritten onto
# `/api/proxy/segment?token=...&u=...`, and the segments are streamed back
# through with the same headers attached upstream.
#
# Both routes take a proxy handle minted by `/api/v1/playback/init`, never a
# URL. The handle names one entry playlist; each URI the rewrite walks out to
# is registered against that handle's host set (`amend_host`, seeded with the
# entry's host, capped) before it is handed to the client, and the segment
# route refuses any `u` whose host was not registered that way -- so a handle
# cannot be pointed at an arbitrary origin even if the token leaks, and no raw
# upstream URL crosses the wire in either direction. The Referer and User-Agent
# upstream come from the handle, so the client cannot set them either.
# ---------------------------------------------------------------------------

#: A stock browser UA. An origin that gates playback on Referer gates it on a
#: browser-looking User-Agent too, and `python-requests/...` is refused long
#: before the Referer header is ever read.
HLS_PROXY_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
#: `(connect, read)` socket timeouts. The read half is the one that matters:
#: without it a stalled segment pins a worker thread open for as long as the
#: default -- which is forever.
HLS_PROXY_TIMEOUT = (5.0, 20.0)
#: Manifests are kilobytes. Anything past this is not a manifest, and reading
#: an unbounded body here would be an allocation primitive reachable from a URL
#: the client supplies.
HLS_PROXY_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
#: Read size for the segment relay, so a worker holds one bounded buffer rather
#: than a whole segment (commonly 2-10 MB) for the length of its transfer.
HLS_PROXY_CHUNK_BYTES = 256 * 1024
#: Longest `u=` the segment route will read. Playlists carry paths, not
#: sentences; anything past this is a forged request or a pathological one and
#: is refused before the string is joined, resolved or looked up.
PROXY_URI_MAX_LENGTH = 4096


def _hls_proxy_request_headers(referer: str) -> dict[str, str]:
    headers = {
        "User-Agent": HLS_PROXY_USER_AGENT,
        "Accept": "*/*",
        # Segments are not compressed upstream. Asking for identity also keeps
        # the bytes this relay forwards identical to the bytes received.
        "Accept-Encoding": "identity",
    }
    if referer:
        headers["Referer"] = referer
    return headers


def _proxy_entry(token: str | None) -> dict | None:
    """Resolve a proxy handle, or None when it is absent, foreign or expired.

    The kind argument is the check: a media or download handle that guessed
    this route answers None, so one token cannot be replayed across legs just
    because both legs read `token=`.
    """
    return playback_tokens.resolve(token or "", playback_tokens.KIND_PROXY)


#: `URI=` inside a tag line: the AES key, the fMP4 init segment, an alternate
#: audio or subtitle rendition. Quoted or bare, and the quoted form may carry a
#: comma, which is why the quoted alternative comes first.
_HLS_URI_ATTRIBUTE = re.compile(r'URI=(?:"([^"]*)"|([^,\s]+))')


def _rewrite_hls_manifest(manifest: str, manifest_url: str, token: str) -> str:
    """Point every URI in `manifest` at `/api/proxy/segment?token=...&u=...`.

    Two kinds of reference exist and both have to move, or the playlist parses
    and playback still stops part-way through:

    - a bare URI line -- a `.ts` chunk, or in a master a nested `.m3u8`;
    - a `URI=` attribute inside a tag -- the decryption key, the init segment,
      an alternate audio rendition. These are left alone by a rewriter that
      only looks at bare lines, and the cost is a master whose video ladder
      works while its English dub never loads.

    Each reference is resolved against the URL the manifest itself was fetched
    from first, because playlists routinely carry relative paths and a relative
    path in the answer would resolve against this origin instead of upstream's.
    The absolute form is then registered against the handle's host set -- that
    registration is what permits the later segment fetch -- and only the `u=`
    form crosses the wire, so the upstream origin itself never becomes data the
    client holds.
    """
    def proxied(uri: str) -> str:
        absolute = urllib.parse.urljoin(manifest_url, uri)
        # Registration, not a permission check: an unregistrable host would
        # still be refused at the segment route by the same host set, so a
        # ceiling hit stops playback rather than leaking the raw URL here.
        playback_tokens.amend_host(token, absolute)
        return "/api/proxy/segment?" + urllib.parse.urlencode(
            {"token": token, "u": absolute}
        )

    rewritten: list[str] = []
    for line in manifest.splitlines():
        stripped = line.strip()
        if not stripped:
            rewritten.append(line)
            continue
        if stripped.startswith("#"):
            if "URI=" in stripped:
                def replace(match: re.Match, _proxied=proxied) -> str:
                    uri = match.group(1) if match.group(1) is not None else match.group(2)
                    if not uri:
                        return match.group(0)
                    return f'URI="{_proxied(uri)}"'

                line = _HLS_URI_ATTRIBUTE.sub(replace, line)
            rewritten.append(line)
            continue
        rewritten.append(proxied(stripped))
    return "\n".join(rewritten)


def _read_bounded(upstream, max_bytes: int) -> bytes:
    """Read an upstream body in chunks, refusing anything over `max_bytes`.

    Raised rather than truncated: a clipped manifest parses part-way and then
    fails with no visible cause, which is worse than a clean refusal.
    """
    chunks: list[bytes] = []
    size = 0
    for chunk in upstream.iter_content(64 * 1024):
        if not chunk:
            continue
        size += len(chunk)
        if size > max_bytes:
            raise ValueError("upstream body exceeds the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _hls_manifest_response(manifest_url: str, token: str, raw: bytes) -> Response:
    manifest = raw.decode("utf-8", errors="replace")
    response = Response(
        _rewrite_hls_manifest(manifest, manifest_url, token), status=200
    )
    # Set directly rather than through `mimetype`, which would append a charset
    # hls.js has no use for and which some CDN validators treat as a mismatch.
    response.headers["Content-Type"] = "application/vnd.apple.mpegurl"
    # No `Access-Control-Allow-Origin: *` here: the shared CORS hook answers
    # allowlisted origins exactly and nobody else, the same rule every other
    # route follows. A wildcard on a relay would let any site on the internet
    # read bytes through this server.
    response.headers["Cache-Control"] = "no-store"
    return response


def _hls_is_playlist(url: str, content_type: str | None) -> bool:
    """True when a request routed through the segment relay targets a playlist.

    The manifest rewriter sends *every* URI line to `/api/proxy/segment`, so a
    master's variant and rendition lines arrive here as playlists. Detecting
    them is what keeps a master -> variant -> chunk chain on this origin:
    handing the bytes back raw would leave the variant's own relative chunk
    paths resolving against this server, where nothing serves them.
    """
    path = urllib.parse.urlparse(url).path.lower()
    if path.endswith(".m3u8") or path.endswith(".m3u"):
        return True
    return "mpegurl" in (content_type or "").lower()


@app.route("/api/proxy/manifest", methods=["GET", "OPTIONS"])
def proxy_hls_manifest():
    """Fetch the handle's entry playlist and rewrite it onto the segment relay.

    The upstream URL and Referer both come from the handle, so this route
    fetches exactly one host per token and the caller can influence neither.
    Returns the rewritten playlist: every URI inside it is made absolute
    against the manifest's own URL, registered against the handle, and pointed
    at `/api/proxy/segment` with the same token -- so the segments that follow
    go out with the headers hls.js is not allowed to send, from hosts this
    handle was built to reach.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = _proxy_entry(token)
    if entry is None:
        return _json_error(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )
    url = entry["url"]
    referer = entry.get("referer") or ""

    try:
        with requests.get(
            url,
            headers=_hls_proxy_request_headers(referer),
            timeout=HLS_PROXY_TIMEOUT,
            stream=True,
        ) as upstream:
            if upstream.status_code != 200:
                return _json_error(
                    f"Manifest upstream returned {upstream.status_code}", 502
                )
            raw = _read_bounded(upstream, HLS_PROXY_MANIFEST_MAX_BYTES)
    except requests.Timeout:
        return _json_error("Manifest upstream timed out", 504)
    except requests.RequestException:
        return _json_error("Manifest upstream unavailable", 502)
    except ValueError:
        return _json_error("Manifest is too large", 502)

    region = entry.get("meta", {}).get("region") or None
    telemetry.record_event("manifest")
    telemetry.record_bytes(len(raw), region)
    telemetry.touch_stream(token, count=len(raw))
    return _hls_manifest_response(url, token, raw)


@app.route("/api/proxy/segment", methods=["GET", "OPTIONS"])
def proxy_hls_segment():
    """Relay one media segment (or nested playlist), on the handle's terms.

    `u` is resolved against the handle's entry URL and then checked against the
    handle's host set -- the set the rewrite built while serving the playlist.
    A `u` naming a host that was never part of that playlist's own references
    is refused, so this route cannot be aimed elsewhere even with a valid
    token. Bytes stream straight through rather than buffering: a segment is
    megabytes, several viewers pull several at once, and holding them whole is
    how a relay turns into an OOM on a box with a fixed memory budget.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = _proxy_entry(token)
    if entry is None:
        return _json_error(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )

    raw_uri = (request.args.get("u") or "").strip()
    if not raw_uri or len(raw_uri) > PROXY_URI_MAX_LENGTH:
        return _json_error("Missing or invalid u parameter", 400)
    url = urllib.parse.urljoin(entry["url"], raw_uri)
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return _json_error("Invalid u parameter", 400)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return _json_error("Invalid u parameter", 400)
    host = (parsed.hostname or "").lower()
    if not host or host not in entry.get("hosts", set()):
        return _json_error(
            "Host is not part of this stream", 403, code="HOST_NOT_ALLOWED"
        )

    referer = entry.get("referer") or ""
    region = entry.get("meta", {}).get("region") or None

    try:
        upstream = requests.get(
            url,
            headers=_hls_proxy_request_headers(referer),
            timeout=HLS_PROXY_TIMEOUT,
            stream=True,
        )
    except requests.Timeout:
        return _json_error("Segment upstream timed out", 504)
    except requests.RequestException:
        return _json_error("Segment upstream unavailable", 502)

    if upstream.status_code not in (200, 206):
        upstream.close()
        return _json_error(f"Segment upstream returned {upstream.status_code}", 502)

    if _hls_is_playlist(url, upstream.headers.get("Content-Type")):
        try:
            with upstream:
                raw = _read_bounded(upstream, HLS_PROXY_MANIFEST_MAX_BYTES)
        except requests.Timeout:
            return _json_error("Segment upstream timed out", 504)
        except requests.RequestException:
            return _json_error("Segment upstream unavailable", 502)
        except ValueError:
            return _json_error("Manifest is too large", 502)
        telemetry.record_event("manifest")
        telemetry.record_bytes(len(raw), region)
        telemetry.touch_stream(token, count=len(raw))
        return _hls_manifest_response(url, token, raw)

    def generate():
        sent = 0
        try:
            for chunk in upstream.iter_content(HLS_PROXY_CHUNK_BYTES):
                if chunk:
                    sent += len(chunk)
                    yield chunk
        except requests.RequestException:
            # The status line is already on the wire, so a mid-stream failure
            # cannot become an error response. Stopping is the honest signal:
            # the client sees a short read and retries, which is what hls.js
            # does for a failed segment anyway.
            app.logger.warning("HLS segment relay cut short for %s", url)
        finally:
            upstream.close()
            # After the last byte: the bytes counted per-stream (and the view's
            # last-seen clock) move together with the bytes counted globally.
            if sent:
                telemetry.record_bytes(sent, region)
                telemetry.touch_stream(token, count=sent)

    telemetry.record_event("segment")
    response = Response(
        stream_with_context(generate()),
        status=upstream.status_code,
    )
    response.headers["Content-Type"] = "video/mp2t"
    # Allowlist-exact CORS via the shared hook; no wildcard on a relay.
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
        status, headers, body = catalog_lib.open_archive_stream(url, None)
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
    with _season_cache_lock:
        payload = _season_cache.get(cache_key)
        hit = payload is not None
    if not hit:
        payload = _build_season_payload(parsed, season)
        # Only a resolved season is pinned. A cached miss would freeze the
        # "newest aired season" answer for the whole TTL, so a show that airs a
        # new season keeps serving the old one for hours after it does -- which
        # is the one thing this route is asked for.
        if payload and not payload.get("error"):
            with _season_cache_lock:
                _season_cache[cache_key] = payload

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

    # Embed targets used to be emitted here (`embed_urls`, `default_embed`) --
    # the one place a raw third-party URL still crossed the wire. The embed
    # chain now travels only from /api/v1/playback/init, as frame handles.

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
# Admin: account roster
#
# Read-only, and deliberately so. `docs/prd.md` records the product decision
# that there is no catalogue-correction surface, and this endpoint does not
# reopen it: it answers "who has an account", which is the one operational
# question that cannot be answered by the product itself, and it writes nothing.
#
# The gate is the `ADMIN_EMAILS` allowlist, evaluated here on every request from
# the token's own user row. Not from a query parameter, not from a role column,
# and not from anything the client sent.
# ---------------------------------------------------------------------------


@app.route("/api/admin/users", methods=["GET", "OPTIONS"])
def api_admin_users():
    """One page of accounts, with per-account counts and database totals."""
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


@app.route("/api/admin/system/metrics", methods=["GET", "OPTIONS"])
def admin_system_metrics():
    """Live system metrics for an operator: traffic, streams, memory, handles.

    Admin-only, and the guard order mirrors `/api/admin/users`: no session is
    401, a session that is not on the allowlist is 403 (never 401 -- the
    client clears its stored token on a 401, which would sign the operator out
    of their own account for opening the wrong page).

    The numbers are per worker process -- telemetry is deliberately in-memory
    and honest about its scope (`scope.pid` says which process answered) --
    and include the memory guard's own verdict, because "why did playback
    503" is the question this endpoint exists to answer.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    user = _auth_user()
    if not user:
        return _auth_error("Not signed in.")
    if not authdb.is_admin_email(user.get("email")):
        return _auth_error("You do not have access to this page.", 403)

    return jsonify(
        {
            "success": True,
            "metrics": telemetry.snapshot(),
            "handles": playback_tokens.stats(),
        }
    )


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
        # Empty strings, never null: the client distinguishes "no preference,
        # use the geo seed" from "I chose this" by emptiness, and a key that
        # sometimes vanishes forces a null check into every reader.
        "preferred_language": profile.get("preferred_language") or "",
        "preferred_subtitle": profile.get("preferred_subtitle") or "",
        "locale_region": profile.get("locale_region") or "",
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
    # Locale choices ride the profile PATCH because that is the object they
    # belong to; validation is shared with the /api/v1/locale/config surface
    # so the two paths cannot drift on what counts as a valid language.
    locale_fields = {
        "language": "preferred_language",
        "subtitle_language": "preferred_subtitle",
        "region": "locale_region",
    }
    locale_payload = {
        key: payload[name]
        for key, name in (
            ("language", "preferred_language"),
            ("subtitle_language", "preferred_subtitle"),
            ("region", "locale_region"),
        )
        if name in payload
    }
    if locale_payload:
        try:
            validated = locale_settings.validate_config(locale_payload, field_prefix="profile")
        except ValueError as error:
            return _auth_error(str(error), 400)
        for key, column in locale_fields.items():
            if key in validated:
                updates[column] = validated[key]
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
        # Serve each request on its own thread. Werkzeug's dev server defaults
        # to a single-threaded socket, so one slow request (a provider probe, a
        # cold season resolve) blocks every other one behind it and the proxy
        # in front sees a stalled backend it can only answer 502 for. This is
        # the development server; production still runs gunicorn, whose worker
        # count the deployment owns.
        threaded=True,
        request_handler=_QuietRequestHandler,
    )