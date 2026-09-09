import os
import requests
from typing import Optional, Dict, Any, List

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "100868d1fc3966ca832b3a5457e1edb9")
TMDB_BASE_URL = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p"

def _tmdb_get(endpoint: str, params: Optional[Dict] = None) -> Optional[Dict]:
    """Generic TMDB API request with error handling."""
    try:
        url = f"{TMDB_BASE_URL}{endpoint}"
        request_params = {"api_key": TMDB_API_KEY, "language": "en-US"}
        if params:
            request_params.update(params)
        
        response = requests.get(url, params=request_params, timeout=10)
        if response.status_code != 200:
            print(f"[TMDB Error {response.status_code}]: {response.text}")
            return None
        return response.json()
    except Exception as e:
        print(f"[TMDB Fetch Error]: {e}")
        return None


def fetch_media_details(media_id: int, media_type: str = "movie") -> Optional[Dict]:
    """Fetch complete media details including external IDs, credits, videos, and for TV: seasons/episodes."""
    endpoint = f"/{media_type}/{media_id}"
    params = {
        "append_to_response": "external_ids,credits,videos,images,keywords,recommendations"
    }
    if media_type == "tv":
        params["append_to_response"] += ",season/1"  # We'll fetch full seasons separately
    
    data = _tmdb_get(endpoint, params)
    if not data:
        return None

    release_date = data.get("release_date") or data.get("first_air_date", "")
    release_year = release_date.split("-")[0] if release_date else "N/A"

    # Extract YouTube trailer key
    trailer_key = None
    videos = data.get("videos", {}).get("results", [])
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
    genres = [genre["name"] for genre in data.get("genres", [])]

    # Poster/backdrop
    poster_path = data.get("poster_path")
    backdrop_path = data.get("backdrop_path")

    result = {
        "id": data.get("id"),
        "title": data.get("title") or data.get("name"),
        "overview": data.get("overview"),
        "release_year": release_year,
        "release_date": release_date,
        "vote_average": round(data.get("vote_average", 0.0), 1),
        "imdb_id": data.get("external_ids", {}).get("imdb_id"),
        "genres": genres,
        "poster_path": poster_path,
        "poster_url": f"{TMDB_IMAGE_BASE}/w500{poster_path}" if poster_path else None,
        "backdrop_path": backdrop_path,
        "backdrop_url": f"{TMDB_IMAGE_BASE}/w1280{backdrop_path}" if backdrop_path else None,
        "trailer_key": trailer_key,
        "popularity": data.get("popularity"),
        "runtime": data.get("runtime"),
        "media_type": media_type,
    }

    # For TV shows, fetch complete season/episode data
    if media_type == "tv":
        result["number_of_seasons"] = data.get("number_of_seasons", 1)
        result["number_of_episodes"] = data.get("number_of_episodes", 0)
        result["seasons"] = fetch_all_seasons(media_id)
        result["episodes"] = fetch_all_episodes(media_id, result["seasons"])

    return result


def fetch_all_seasons(tv_id: int) -> List[Dict]:
    """Fetch all seasons for a TV show."""
    data = _tmdb_get(f"/tv/{tv_id}", {})
    if not data:
        return []
    seasons = data.get("seasons", [])
    # Filter out season 0 (specials) unless it's the only season
    valid_seasons = [s for s in seasons if s.get("season_number", 0) > 0]
    return valid_seasons if valid_seasons else seasons


def fetch_all_episodes(tv_id: int, seasons: List[Dict]) -> List[Dict]:
    """Fetch all episodes for all seasons."""
    all_episodes = []
    for season in seasons:
        season_num = season.get("season_number")
        if not season_num:
            continue
        season_data = _tmdb_get(f"/tv/{tv_id}/season/{season_num}", {})
        if season_data and "episodes" in season_data:
            for ep in season_data["episodes"]:
                ep["season_number"] = season_num
                all_episodes.append(ep)
    return all_episodes


def fetch_season_details(tv_id: int, season_number: int) -> Optional[Dict]:
    """Fetch detailed episode list for a specific season."""
    return _tmdb_get(f"/tv/{tv_id}/season/{season_number}", {})


def fetch_episode_details(tv_id: int, season_number: int, episode_number: int) -> Optional[Dict]:
    """Fetch detailed metadata for a specific episode."""
    return _tmdb_get(f"/tv/{tv_id}/season/{season_number}/episode/{episode_number}", {})


def get_trending_catalog(time_window: str = "week", media_type: str = "all") -> List[Dict]:
    """Fetch trending movies/TV from TMDB."""
    endpoint = f"/trending/{media_type}/{time_window}"
    data = _tmdb_get(endpoint)
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        mt = item.get("media_type", "movie")
        details = fetch_media_details(item.get("id"), mt)
        if details:
            details["media_type"] = mt
            catalog.append(details)
    return catalog


def get_popular(media_type: str = "movie", page: int = 1) -> List[Dict]:
    """Fetch popular movies/TV from TMDB."""
    endpoint = f"/{media_type}/popular"
    data = _tmdb_get(endpoint, {"page": page})
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        details = fetch_media_details(item.get("id"), media_type)
        if details:
            details["media_type"] = media_type
            catalog.append(details)
    return catalog


def get_now_playing(page: int = 1) -> List[Dict]:
    """Fetch currently playing movies from TMDB."""
    endpoint = "/movie/now_playing"
    data = _tmdb_get(endpoint, {"page": page})
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        details = fetch_media_details(item.get("id"), "movie")
        if details:
            details["media_type"] = "movie"
            catalog.append(details)
    return catalog


def get_on_the_air(page: int = 1) -> List[Dict]:
    """Fetch currently airing TV shows from TMDB."""
    endpoint = "/tv/on_the_air"
    data = _tmdb_get(endpoint, {"page": page})
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        details = fetch_media_details(item.get("id"), "tv")
        if details:
            details["media_type"] = "tv"
            catalog.append(details)
    return catalog


def search_multi(query: str, page: int = 1) -> List[Dict]:
    """Search movies and TV shows via TMDB multi-search."""
    endpoint = "/search/multi"
    data = _tmdb_get(endpoint, {"query": query, "page": page})
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        media_type = item.get("media_type")
        if media_type not in ("movie", "tv"):
            continue
        details = fetch_media_details(item.get("id"), media_type)
        if details:
            details["media_type"] = media_type
            catalog.append(details)
    return catalog


def get_trailer_key(media_id: int, media_type: str) -> Optional[str]:
    """Fetch YouTube trailer key for a media item."""
    data = _tmdb_get(f"/{media_type}/{media_id}/videos", {})
    if not data:
        return None
    videos = data.get("results", [])
    for v in videos:
        if v.get("type") == "Trailer" and v.get("site") == "YouTube":
            return v.get("key")
    for v in videos:
        if v.get("site") == "YouTube":
            return v.get("key")
    return None


GENRE_MAP = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
    99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
    27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi",
    10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western", 10762: "Kids",
    10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap",
    10767: "Talk", 10768: "War & Politics"
}


def get_genre_names(genre_ids: List[int]) -> List[str]:
    """Map TMDB genre IDs to names."""
    return [GENRE_MAP[gid] for gid in genre_ids if gid in GENRE_MAP]


def normalize_tmdb_item(item: Dict, media_type: str) -> Optional[Dict]:
    """Normalize a TMDB search/feed result into our StreamMovie format."""
    tmdb_id = item.get("id")
    title = item.get("title") or item.get("name") or "Untitled"
    poster_path = item.get("poster_path")
    backdrop_path = item.get("backdrop_path")
    
    release_date = item.get("release_date") or item.get("first_air_date") or ""
    year = release_date.split("-")[0] if release_date else ""

    if media_type == "tv":
        # For TV, we'll get full season data on demand
        seasons_count = item.get("number_of_seasons") or 1
        episodes_count = item.get("number_of_episodes") or 1
        stream_url = f"https://vidsrc.me/embed/tv?tmdb={tmdb_id}&season=1&episode=1"
    else:
        seasons_count = 1
        episodes_count = 1
        stream_url = f"https://vidsrc.me/embed/movie?tmdb={tmdb_id}"

    genre_ids = item.get("genre_ids") or []
    genres = get_genre_names(genre_ids)
    if item.get("genres"):
        genres = [g.get("name") for g in item.get("genres") if g.get("name")]

    return {
        "id": str(tmdb_id),
        "title": title,
        "poster_url": f"{TMDB_IMAGE_BASE}/w500{poster_path}" if poster_path else "",
        "backdrop_url": f"{TMDB_IMAGE_BASE}/w1280{backdrop_path}" if backdrop_path else "",
        "stream_url": stream_url,
        "year": year,
        "runtime": f"{item.get('runtime')}m" if item.get("runtime") else "",
        "media_type": media_type,
        "seasons": seasons_count,
        "episodes_per_season": episodes_count,
        "is_embed": True,
        "available": True,
        "overview": item.get("overview", ""),
        "vote_average": item.get("vote_average"),
        "popularity": item.get("popularity"),
        "genres": genres,
    }