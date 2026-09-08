"""
Movie backend for the FreeStream frontend bridge.

Serves the playable catalog (`GET /api/movies`), live TMDB search (`GET /api/search`),
and playback resolution (`POST /api/movies/resolve`).

Run:
    pip install -r requirements.txt
    python app.py                  # listens on http://localhost:5000
"""

from __future__ import annotations

import json
import os
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request

import certifi
from flask import Flask, jsonify, request

import catalog_lib as lib

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG_PATH = os.path.join(HERE, "movies.json")

TMDB_BASE_URL = "https://api.themoviedb.org/3"
TMDB_API_KEY = os.environ.get("TMDB_API_KEY") or "15d20e15d05b70a3111b18f95c120818"

app = Flask(__name__)

MOVIES: list[dict] = []
if os.path.exists(CATALOG_PATH):
    try:
        with open(CATALOG_PATH, encoding="utf-8") as handle:
            MOVIES = json.load(handle)
    except Exception:
        MOVIES = []


def _tmdb_get(path: str, params: dict) -> dict | None:
    """TMDB client wrapper supporting search & metadata lookup with macOS SSL fix."""
    try:
        url = f"{TMDB_BASE_URL}{path}?" + urllib.parse.urlencode(
            {"api_key": TMDB_API_KEY, "language": "en-US", **params}
        )
        
        try:
            ctx = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            ctx = ssl._create_unverified_context()

        req = urllib.request.Request(url, headers={"User-Agent": lib.UA})
        with urllib.request.urlopen(req, context=ctx, timeout=10) as response:
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


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


@app.route("/api/movies", methods=["GET", "OPTIONS"])
def list_movies():
    if request.method == "OPTIONS":
        return ("", 204)
    return jsonify(MOVIES)


@app.route("/api/search", methods=["GET", "OPTIONS"])
def search_catalog():
    if request.method == "OPTIONS":
        return ("", 204)

    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

    q_lower = query.lower()
    local_matches = [
        m for m in MOVIES 
        if q_lower in m.get("title", "").lower()
    ]

    tmdb_results = []
    res = _tmdb_get("/search/multi", {"query": query})
    if res and "results" in res:
        for item in res["results"]:
            media_type = item.get("media_type")
            if media_type not in ("movie", "tv"):
                continue

            norm = _normalize_tmdb_item(item, media_type)
            if norm:
                tmdb_results.append(norm)

    seen_titles = {m.get("title", "").lower() for m in local_matches}
    combined = list(local_matches)
    for item in tmdb_results:
        if item["title"].lower() not in seen_titles:
            combined.append(item)
            seen_titles.add(item["title"].lower())

    return jsonify(combined)


@app.route("/api/search/suggest", methods=["GET", "OPTIONS"])
def search_suggest():
    """Live autocomplete suggestions for search input."""
    if request.method == "OPTIONS":
        return ("", 204)

    query = request.args.get("q", "").strip()
    if not query or len(query) < 2:
        return jsonify([])

    res = _tmdb_get("/search/multi", {"query": query})
    results = (res or {}).get("results", [])
    
    suggestions = []
    for item in results[:8]:  # Limit to 8 suggestions
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

    if not tmdb_id and title:
        res = _tmdb_get("/search/multi", {"query": title})
        results = (res or {}).get("results", [])
        
        valid_results = [r for r in results if r.get("media_type") in ("movie", "tv")]
        if valid_results:
            top = valid_results[0]
            tmdb_id = top["id"]
            media_type = top.get("media_type", "movie")
            title = top.get("title") or top.get("name") or title

    if not tmdb_id and title:
        res_tv = _tmdb_get("/search/tv", {"query": title})
        tv_results = (res_tv or {}).get("results", [])
        if tv_results:
            tmdb_id = tv_results[0]["id"]
            media_type = "tv"
            title = tv_results[0].get("name") or title

    if not tmdb_id and title:
        res_movie = _tmdb_get("/search/movie", {"query": title})
        movie_results = (res_movie or {}).get("results", [])
        if movie_results:
            tmdb_id = movie_results[0]["id"]
            media_type = "movie"
            title = movie_results[0].get("title") or title

    if not tmdb_id:
        return jsonify({"error": f"Could not find metadata for '{title}'"}), 404

    if not media_type:
        media_type = "movie"

    if media_type == "tv":
        seasons_count, ep_count, tv_year = _get_tv_metadata(tmdb_id, current_season=season)
        if tv_year:
            year = tv_year
        stream_url = f"https://vidsrc.me/embed/tv?tmdb={tmdb_id}&season={season}&episode={episode}"
    else:
        seasons_count = 1
        ep_count = 1
        stream_url = f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}"

    movie_data = {
        "id": str(tmdb_id),
        "title": title,
        "stream_url": stream_url,
        "is_available": True,
        "available": True,
        "is_embed": True,
        "year": str(year) if year else "",
        "media_type": media_type,
        "season": season if media_type == "tv" else 1,
        "episode": episode if media_type == "tv" else 1,
        "seasons": seasons_count,
        "episodes_per_season": ep_count,
    }

    return jsonify({"movie": movie_data, "exact": True, "available": True})


@app.route("/api/get-stream", methods=["GET", "OPTIONS"])
def get_stream_direct():
    if request.method == "OPTIONS":
        return ("", 204)
        
    tmdb_id = request.args.get("tmdb_id") or request.args.get("id")
    media_type = request.args.get("media_type", "movie")
    season = request.args.get("season", 1)
    episode = request.args.get("episode", 1)

    if not tmdb_id:
        return jsonify({"success": False, "error": "Invalid ID"}), 400

    if media_type in ("tv", "series"):
        stream_url = f"https://vidsrc.me/embed/tv?tmdb={tmdb_id}&season={season}&episode={episode}"
        fallback = f"https://vidsrc.cc/v2/embed/tv/{tmdb_id}/{season}/{episode}"
        goojara = f"https://goojara.to/embed/tv?tmdb={tmdb_id}&season={season}&episode={episode}"
    else:
        stream_url = f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}"
        fallback = f"https://vidsrc.cc/v2/embed/movie/{tmdb_id}"
        goojara = f"https://goojara.to/embed/movie?tmdb={tmdb_id}"

    return jsonify({
        "success": True,
        "activeSource": stream_url,
        "mirrors": [
            {"name": "Server Alpha (VidSrc Me)", "url": stream_url},
            {"name": "Server Beta (VidSrc CC)", "url": fallback},
            {"name": "Server Gamma (Goojara)", "url": goojara}
        ]
    })


@app.route("/api/movies/todays-pick", methods=["GET", "OPTIONS"])
def todays_pick():
    if request.method == "OPTIONS":
        return ("", 204)
    pool = [m for m in MOVIES if "featured" in (m.get("topics") or [])] or MOVIES
    if not pool:
        return jsonify({"movie": None}), 404
    import datetime
    day_idx = (datetime.date.today() - datetime.date(1970, 1, 1)).days
    movie = pool[day_idx % len(pool)]
    return jsonify({"movie": movie})


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
        episode_data = _tmdb_get(f"/tv/{tmdb_id}/season/{season}/episode/{episode}", {})
    except Exception as e:
        print(f"[Episode Fetch Error]: {e}")
        episode_data = None

    if not episode_data:
        return jsonify({"success": False, "error": "Episode not found"}), 404

    # Fetch season details for poster/still path
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


@app.route("/api/movies/feeds", methods=["GET", "OPTIONS"])
def feeds():
    if request.method == "OPTIONS":
        return ("", 204)

    def _shelf(sort_key, allowed: set[str] | None = None, limit: int = 18):
        picks = MOVIES
        if allowed:
            picks = [m for m in MOVIES if (set(m.get("topics") or []) & allowed)]
        return sorted(picks, key=sort_key, reverse=True)[:limit]

    return jsonify({
        "featured": _shelf(lambda m: m.get("year") or 0, allowed={"featured"}, limit=18),
        "recent": _shelf(lambda m: str(m.get("_addeddate") or ""), allowed={"recent"}, limit=24),
        "popular": _shelf(lambda m: int(m.get("_downloads") or 0), allowed={"popular"}, limit=24),
    })


import re

def extract_year(date_str: str | None) -> str:
    """Extract 4-digit year from various date formats (YYYY-MM-DD, YYYY, etc.)."""
    if not date_str:
        return ""
    # Try to find a 4-digit year (1900-2099)
    match = re.search(r'\b(19\d{2}|20\d{2})\b', str(date_str))
    return match.group(1) if match else ""


def _normalize_tmdb_item(item: dict, media_type: str) -> dict | None:
    """Normalize a TMDB search result into our stream format."""
    tmdb_id = item.get("id")
    title = item.get("title") or item.get("name") or "Untitled"
    poster_path = item.get("poster_path")
    poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else ""
    backdrop_path = item.get("backdrop_path")
    backdrop_url = f"https://image.tmdb.org/t/p/w1280{backdrop_path}" if backdrop_path else ""
    
    if media_type == "tv":
        seasons_count, ep_count, year = _get_tv_metadata(tmdb_id, current_season=1)
        stream_url = f"https://vidsrc.me/embed/tv?tmdb={tmdb_id}&season=1&episode=1"
        release = item.get("first_air_date") or ""
    else:
        release = item.get("release_date") or ""
        year = extract_year(release)
        seasons_count = 1
        ep_count = 1
        stream_url = f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}"

    # Also extract runtime if available
    runtime = item.get("runtime")
    runtime_str = f"{runtime}m" if runtime and isinstance(runtime, (int, float)) else ""
    
    # Extract genres
    genre_names_map = {
        12: "Adventure", 14: "Fantasy", 16: "Animation", 18: "Drama", 27: "Horror",
        28: "Action", 35: "Comedy", 36: "History", 37: "Western", 53: "Thriller",
        80: "Crime", 99: "Documentary", 878: "Sci-Fi", 9648: "Mystery",
        10402: "Music", 10749: "Romance", 10751: "Family", 10752: "War", 10770: "TV",
    }
    genre_ids = item.get("genre_ids") or []
    genres = [genre_names_map[gid] for gid in genre_ids if gid in genre_names_map]
    if item.get("genres"):
        genres = [g.get("name") for g in item.get("genres") if g.get("name")]

    return {
        "id": str(tmdb_id),
        "title": title,
        "poster_url": poster_url,
        "backdrop_url": backdrop_url,
        "stream_url": stream_url,
        "year": year,
        "runtime": runtime_str,
        "media_type": media_type,
        "seasons": seasons_count,
        "episodes_per_season": ep_count,
        "is_embed": True,
        "available": True,
        "overview": item.get("overview", ""),
        "vote_average": item.get("vote_average"),
        "popularity": item.get("popularity"),
        "genres": genres,
    }


@app.route("/api/movies/trending", methods=["GET", "OPTIONS"])
def get_trending():
    """Fetch trending movies/TV from TMDB (day/week). Falls back to local catalog."""
    if request.method == "OPTIONS":
        return ("", 204)

    time_window = request.args.get("time_window", "day")
    media_type = request.args.get("media_type", "all")

    valid_windows = {"day", "week"}
    valid_media = {"all", "movie", "tv"}

    if time_window not in valid_windows:
        time_window = "day"
    if media_type not in valid_media:
        media_type = "all"

    endpoint = f"/trending/{media_type}/{time_window}"
    res = _tmdb_get(endpoint, {})
    results = (res or {}).get("results", [])

    normalized = []
    for item in results:
        mt = item.get("media_type")
        if mt not in ("movie", "tv"):
            continue
        norm = _normalize_tmdb_item(item, mt)
        if norm:
            normalized.append(norm)

    # Fallback to local catalog if TMDB fails
    if not normalized:
        return jsonify(MOVIES[:40])

    return jsonify(normalized)


@app.route("/api/movies/popular", methods=["GET", "OPTIONS"])
def get_popular():
    """Fetch popular movies/TV from TMDB. Falls back to local catalog."""
    if request.method == "OPTIONS":
        return ("", 204)

    media_type = request.args.get("media_type", "movie")
    page = request.args.get("page", 1, type=int)

    if media_type not in ("movie", "tv"):
        media_type = "movie"

    endpoint = f"/{media_type}/popular"
    res = _tmdb_get(endpoint, {"page": page})
    results = (res or {}).get("results", [])

    normalized = []
    for item in results:
        norm = _normalize_tmdb_item(item, media_type)
        if norm:
            normalized.append(norm)

    # Fallback to local catalog if TMDB fails
    if not normalized:
        return jsonify(MOVIES[:40])

    return jsonify(normalized)


@app.route("/api/movies/trailer", methods=["GET", "OPTIONS"])
def get_trailer():
    if request.method == "OPTIONS":
        return ("", 204)

    title = request.args.get("title", "").strip()
    year = request.args.get("year")

    if not title:
        return jsonify({"trailer": None}), 400

    # Search TMDB for the movie/TV show
    res = _tmdb_get("/search/multi", {"query": title})
    results = (res or {}).get("results", [])
    valid_results = [r for r in results if r.get("media_type") in ("movie", "tv")]
    
    if not valid_results:
        return jsonify({"trailer": None}), 404

    # If year is provided, try to find a matching result
    target = valid_results[0]
    if year:
        for r in valid_results:
            release = r.get("release_date") or r.get("first_air_date") or ""
            if release.startswith(str(year)):
                target = r
                break

    tmdb_id = target.get("id")
    media_type = target.get("media_type", "movie")

    # Fetch videos for this title
    video_endpoint = f"/{media_type}/{tmdb_id}/videos"
    videos_res = _tmdb_get(video_endpoint, {})
    videos = (videos_res or {}).get("results", [])

    # Find official trailer (YouTube preferred)
    trailer = None
    for v in videos:
        if v.get("type") == "Trailer" and v.get("site") == "YouTube":
            trailer = {"provider": "youtube", "id": v.get("key")}
            break
    
    # Fallback to any YouTube video
    if not trailer:
        for v in videos:
            if v.get("site") == "YouTube":
                trailer = {"provider": "youtube", "id": v.get("key")}
                break

    return jsonify({"trailer": trailer})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)