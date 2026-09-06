"""
Movie backend for the FreeStream frontend bridge.

Serves the playable catalog (`GET /api/movies`) and resolves playback on
demand (`POST /api/movies/resolve`). When a requested title is not already in
the catalog, the backend scrapes Archive.org for it, verifies the stream is
playable, and adds it to the platform so it appears on the /stream page too.

Refresh the bulk catalog:
    python scrape_movies.py        # rewrites movies.json

Run:
    pip install -r requirements.txt
    python app.py                  # listens on http://localhost:5000

The frontend reads `VITE_MOVIE_API_BASE_URL` (default: same-origin, route
through the dev server / proxy) and expects the `/api/movies` and
`/api/movies/resolve` contracts.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request

from flask import Flask, Response, jsonify, request

import catalog_lib as lib

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(HERE, "movies.json")

TMDB_BASE_URL = "https://api.themoviedb.org/3"
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "")

app = Flask(__name__)

with open(CATALOG_PATH, encoding="utf-8") as handle:
    MOVIES: list[dict] = json.load(handle)

_lock = threading.Lock()
_trailer_cache: dict[tuple[str, int | None], dict | None] = {}


def _persist() -> None:
    with open(CATALOG_PATH, "w", encoding="utf-8") as handle:
        json.dump(MOVIES, handle, ensure_ascii=False, indent=2)


def _local_match(title: str, requested_year=None) -> tuple[dict | None, bool]:
    """Confident match against the current catalog. A movie only matches when
    its title strongly refers to the requested one and its year passes the
    trust check (no contradiction, or nothing to check against). Shared-word
    overlap is never enough — wrong films must not play."""
    best: dict | None = None
    best_score = 0.0
    for movie in MOVIES:
        score = lib.match_title(title, movie.get("title", ""))
        if score < 0.7:
            continue
        if not lib.accept_candidate(requested_year, movie.get("year")):
            continue
        if score > best_score:
            best, best_score = movie, score
    if best is None:
        return None, False
    return best, best_score == 1.0


def _resolve(title: str, requested_year=None) -> tuple[dict | None, bool]:
    movie, exact = _local_match(title, requested_year)
    if movie:
        return movie, exact

    entry = lib.scrape_title(title, requested_year=requested_year)
    if entry is None:
        return None, False

    with _lock:
        for existing in MOVIES:
            if existing.get("id") == entry.get("id"):
                break
        else:
            MOVIES.append(entry)
            _persist()

    entry_exact = lib.normalize_title(entry.get("title", "")) == lib.normalize_title(title)
    return entry, entry_exact


@app.after_request
def add_cors_headers(response):
    """Allow the Vite dev server (3000/5173) to call this API cross-origin."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.route("/api/movies", methods=["GET", "OPTIONS"])
def list_movies():
    if request.method == "OPTIONS":
        return ("", 204)
    return jsonify(MOVIES)


@app.route("/api/movies/resolve", methods=["GET", "POST", "OPTIONS"])
def resolve_movie():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        title = str(payload.get("title", ""))
        year = payload.get("year")
    else:
        title = str(request.args.get("title", ""))
        year_arg = request.args.get("year")
        year = int(year_arg) if str(year_arg).isdigit() else None
    title = title.strip()
    if not title:
        return jsonify({"error": "title is required"}), 400

    movie, exact = _resolve(title, year)
    if movie is None:
        lib.log(f"resolve miss: title={title!r} year={year!r}")
        return jsonify({"error": "No playable title found for this search."}), 404
    return jsonify({"movie": movie, "exact": exact})


def _days_since_epoch() -> int:
    import datetime

    return (datetime.date.today() - datetime.date(1970, 1, 1)).days


def _shelf(sort_key, allowed: set[str] | None = None, limit: int = 18) -> list[dict]:
    picks = MOVIES
    if allowed:
        picks = [m for m in MOVIES if (set(m.get("topics") or []) & allowed)]
    picks = sorted(picks, key=sort_key, reverse=True)
    return picks[:limit]


@app.route("/api/movies/todays-pick", methods=["GET", "OPTIONS"])
def todays_pick():
    """Deterministic 'Movie of the Day' chosen from the featured pool, rotated
    by day so it changes daily while staying stable within a day."""
    if request.method == "OPTIONS":
        return ("", 204)
    pool = [m for m in MOVIES if "featured" in (m.get("topics") or [])] or MOVIES
    pool = sorted(pool, key=lambda m: m.get("id", ""))
    if not pool:
        return jsonify({"movie": None}), 404
    movie = pool[_days_since_epoch() % len(pool)]
    return jsonify({"movie": movie})


@app.route("/api/movies/feeds", methods=["GET", "OPTIONS"])
def feeds():
    """Shelf feeds backed entirely by playable titles.

    featured  -> featured pool (daily-rotation subset)
    recent    -> newest-added feature films
    popular   -> most-downloaded feature films
    """
    if request.method == "OPTIONS":
        return ("", 204)
    return jsonify(
        {
            "featured": _shelf(
                lambda m: m.get("year") or 0, allowed={"featured"}, limit=18
            ),
            "recent": _shelf(
                lambda m: _date_key(m), allowed={"recent"}, limit=24
            ),
            "popular": _shelf(
                lambda m: int(m.get("_downloads") or 0), allowed={"popular"}, limit=24
            ),
        }
    )


def _date_key(movie: dict) -> str:
    return str(movie.get("_addeddate") or "")


def _tmdb_get(path: str, params: dict) -> dict | None:
    """Small TMDB client used only for trailer discovery (hover previews)."""
    if not TMDB_API_KEY:
        return None
    try:
        url = f"{TMDB_BASE_URL}{path}?" + urllib.parse.urlencode(
            {"api_key": TMDB_API_KEY, "language": "en-US", **params}
        )
        with urllib.request.urlopen(url, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, json.JSONDecodeError):
        return None


def _resolve_trailer(title: str, requested_year: int | None) -> dict | None:
    """Find an official preview trailer for `title`. TMDB is the trailer
    registry; the search is year-qualified so a wrong film's preview is never
    attached to a title. The result is cached keyed by normalized title + year."""
    search_year = requested_year if requested_year else None
    cache_key = (lib.normalize_title(title), search_year)
    with _lock:
        if cache_key in _trailer_cache:
            return _trailer_cache[cache_key]

    payload = _tmdb_get(
        "/search/movie",
        {"query": title, "primary_release_year": search_year} if search_year else {"query": title},
    )
    results = (payload or {}).get("results") or []
    if not results:
        with _lock:
            _trailer_cache[cache_key] = None
        return None

    # Prefer an exact year match so the trailer belongs to the same film.
    movie = None
    if search_year:
        movie = next(
            (r for r in results if str(r.get("release_date") or "")[:4] == str(search_year)),
            results[0],
        )
    else:
        movie = results[0]

    videos = (_tmdb_get(f"/movie/{movie['id']}/videos", {}) or {}).get("results") or []
    if not videos:
        with _lock:
            _trailer_cache[cache_key] = None
        return None

    youtube = [v for v in videos if v.get("site") == "YouTube"]
    trailer_pool = [v for v in youtube if v.get("type") == "Trailer"] or youtube
    best = next((v for v in trailer_pool if v.get("official")), trailer_pool[0]) if trailer_pool else None

    result = (
        {"provider": "youtube", "id": best["key"], "title": movie.get("title")}
        if best and best.get("key")
        else None
    )
    with _lock:
        _trailer_cache[cache_key] = result
    return result


@app.route("/api/movies/trailer", methods=["GET", "OPTIONS"])
def trailer():
    """Preview trailer for a title (hover cards). Never the film itself —
    TMDB videos are consulted and the response is a platform key for an embed.
    404 when no trailer exists, so the card falls back to backdrop artwork."""
    if request.method == "OPTIONS":
        return ("", 204)
    title = str(request.args.get("title", "")).strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    year_arg = request.args.get("year")
    year = int(year_arg) if str(year_arg).isdigit() else None

    trailer = _resolve_trailer(title, year)
    if trailer is None:
        return jsonify({"error": "No trailer found for this title."}), 404
    return jsonify({"trailer": trailer})


@app.route("/api/movies/stream", methods=["GET", "OPTIONS"])
def stream():
    """Same-origin relay for Archive.org movie bytes.

    The <video> element can fetch archive.org directly, but `fetch()`-based
    quality prefetching (or any same-origin cookie-less client) can't — Archive
    sends no CORS headers. Routing playback+prefetch through this endpoint gives
    the player a single origin and keeps range requests working."""
    if request.method == "OPTIONS":
        return ("", 204)
    url = str(request.args.get("url", "")).strip()
    if not url:
        return jsonify({"error": "url is required"}), 400
    try:
        status, headers, body = lib.open_archive_stream(url, request.headers.get("Range"))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except urllib.error.HTTPError as error:
        return Response(str(error.reason), status=error.code)
    except Exception as error:  # noqa: BLE001 - relay failure -> upstream hiccup
        lib.log(f"stream relay failed for {url!r}: {error}")
        return jsonify({"error": "stream unavailable"}), 502
    return Response(body, status=status, headers=headers)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)