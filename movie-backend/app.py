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
import ssl
import urllib.error
import urllib.parse
import urllib.request

import certifi
from flask import Flask, jsonify, request

import tmdb_service as tmdb

HERE = os.path.dirname(os.path.abspath(__file__))

TMDB_BASE_URL = "https://api.themoviedb.org/3"
TMDB_API_KEY = os.environ.get("TMDB_API_KEY") or "100868d1fc3966ca832b3a5457e1edb9"

app = Flask(__name__)


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

        req = urllib.request.Request(url, headers={"User-Agent": "FreeStream/1.0"})
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


@app.route("/api/search", methods=["GET", "OPTIONS"])
def search_catalog():
    if request.method == "OPTIONS":
        return ("", 204)

    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

    results = tmdb.search_multi(query)
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
    else:
        seasons_count = 1
        episodes_count = 1
        if not year and details.get("release_date"):
            year = details["release_date"][:4]
        stream_url = f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}"

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
        "is_embed": True,
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
        "genres": genres,
        "runtime": runtime,
        "director": director,
        "cast": cast,
        "country": country,
        "language": language,
        "release_date": details.get("release_date"),
    }

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


@app.route("/api/movies/feeds", methods=["GET", "OPTIONS"])
def feeds():
    if request.method == "OPTIONS":
        return ("", 204)

    trending = tmdb.get_trending_catalog("week", "all")
    popular_movies = tmdb.get_popular("movie", 1)
    popular_tv = tmdb.get_popular("tv", 1)

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
    normalized = [tmdb.normalize_tmdb_item(item, "tv") for item in results]
    normalized = [n for n in normalized if n]
    normalized.sort(key=lambda x: x.get("popularity", 0), reverse=True)

    return jsonify(normalized)


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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)