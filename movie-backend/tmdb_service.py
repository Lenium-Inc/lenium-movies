import os
import json
import urllib.request
import urllib.parse
from typing import Optional, Dict, Any, List

from runtime_config import ssl_context, tmdb_api_key
import stream_providers
# The genre id -> name map is owned by the recommender, which needs it to score
# the list endpoints (those return ids only). Imported rather than duplicated so
# the two copies cannot drift; the values are unchanged from the original literal.
from taste import GENRE_NAMES as GENRE_MAP

TMDB_BASE_URL = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p"


def _tmdb_get(endpoint: str, params: Optional[Dict] = None) -> Optional[Dict]:
    """Generic TMDB API request with error handling."""
    api_key = tmdb_api_key()
    if not api_key:
        return None
    try:
        url = f"{TMDB_BASE_URL}{endpoint}"
        request_params = {"api_key": api_key, "language": "en-US"}
        if params:
            request_params.update(params)

        query_string = urllib.parse.urlencode(request_params)
        full_url = f"{url}?{query_string}"

        req = urllib.request.Request(full_url, headers={"User-Agent": "FreeStream/1.0"})
        with urllib.request.urlopen(req, context=ssl_context(), timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as e:
        print(f"[TMDB Fetch Error]: {e}")
        return None


def extract_director_and_cast(credits: Dict) -> tuple[Optional[str], List[str]]:
    """Extract director name and top cast members from credits."""
    director = None
    cast = []
    
    if credits.get("crew"):
        for person in credits["crew"]:
            if person.get("job") == "Director" and person.get("name"):
                director = person["name"]
                break
    
    if credits.get("cast"):
        cast = [person["name"] for person in credits["cast"][:10] if person.get("name")]
    
    return director, cast


def extract_country_and_language(data: Dict) -> tuple[Optional[str], Optional[str]]:
    """Extract country and language from TMDB details."""
    country = None
    language = None
    
    # Country from production_countries
    production_countries = data.get("production_countries", [])
    if production_countries:
        country_names = [
            c.get("name") for c in production_countries if c.get("name")
        ]
        if country_names:
            country = ", ".join(country_names)
    
    # Language from spoken_languages
    spoken_languages = data.get("spoken_languages", [])
    if spoken_languages:
        language_names = [
            lang.get("english_name") or lang.get("name") 
            for lang in spoken_languages if lang.get("english_name") or lang.get("name")
        ]
        if language_names:
            language = ", ".join(language_names)
    
    return country, language


def fetch_media_details(media_id: int, media_type: str = "movie") -> Optional[Dict]:
    """Fetch complete media details including external IDs, credits, videos, and for TV: seasons/episodes."""
    endpoint = f"/{media_type}/{media_id}"
    params = {
        "append_to_response": "external_ids,credits,videos,images,keywords,recommendations"
    }
    
    data = _tmdb_get(endpoint, params)
    if not data:
        return None

    release_date = data.get("release_date") or data.get("first_air_date", "")
    release_year = release_date.split("-")[0] if release_date else ""

    # Extract YouTube trailer key
    trailer_key = select_trailer_key(data.get("videos", {}).get("results", []))

    # Genres
    genres = [genre["name"] for genre in data.get("genres", [])]

    # Poster/backdrop
    poster_path = data.get("poster_path")
    backdrop_path = data.get("backdrop_path")

    # Extract director and cast
    director, cast = extract_director_and_cast(data.get("credits", {}))

    # Extract country and language
    country, language = extract_country_and_language(data)

    # Extract runtime
    runtime = data.get("runtime")
    if runtime is not None:
        try:
            runtime = int(runtime)
        except (ValueError, TypeError):
            runtime = None

    result = {
        "id": data.get("id"),
        "title": data.get("title") or data.get("name"),
        "overview": data.get("overview") or "",
        "release_year": release_year,
        "release_date": release_date,
        "vote_average": round(data.get("vote_average", 0.0), 1) if data.get("vote_average") else None,
        "imdb_id": data.get("external_ids", {}).get("imdb_id"),
        "genres": genres,
        "poster_path": poster_path,
        "poster_url": f"{TMDB_IMAGE_BASE}/w500{poster_path}" if poster_path else "",
        "backdrop_path": backdrop_path,
        "backdrop_url": f"{TMDB_IMAGE_BASE}/w1280{backdrop_path}" if backdrop_path else "",
        "trailer_key": trailer_key,
        "popularity": data.get("popularity"),
        "runtime": runtime,
        "media_type": media_type,
        "director": director,
        "cast": cast,
        "country": country,
        "language": language,
    }

    # For TV shows, fetch season/episode counts
    if media_type == "tv":
        result["number_of_seasons"] = data.get("number_of_seasons", 1)
        result["number_of_episodes"] = data.get("number_of_episodes", 0)
        result["seasons"] = data.get("seasons", [])

    return result


def fetch_season_details(tv_id: int, season_number: int) -> Optional[Dict]:
    """Fetch detailed episode list for a specific season."""
    return _tmdb_get(f"/tv/{tv_id}/season/{season_number}", {})


def fetch_episode_details(tv_id: int, season_number: int, episode_number: int) -> Optional[Dict]:
    """Fetch detailed metadata for a specific episode."""
    return _tmdb_get(f"/tv/{tv_id}/season/{season_number}/episode/{episode_number}", {})


def get_trending_catalog(time_window: str = "week", media_type: str = "all") -> List[Dict]:
    """Fetch trending movies/TV from TMDB - basic info only, no per-item detail calls."""
    endpoint = f"/trending/{media_type}/{time_window}"
    data = _tmdb_get(endpoint)
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        mt = item.get("media_type", "movie")
        catalog.append({
            "id": item.get("id"),
            "title": item.get("title") or item.get("name"),
            "overview": item.get("overview", ""),
            "release_date": item.get("release_date") or item.get("first_air_date", ""),
            "first_air_date": item.get("first_air_date", ""),
            "vote_average": item.get("vote_average"),
            "poster_path": item.get("poster_path"),
            "backdrop_path": item.get("backdrop_path"),
            "genre_ids": item.get("genre_ids", []),
            "popularity": item.get("popularity"),
            "media_type": mt,
            "number_of_seasons": item.get("number_of_seasons") if mt == "tv" else None,
            "number_of_episodes": item.get("number_of_episodes") if mt == "tv" else None,
        })
    return catalog


def get_popular(media_type: str = "movie", page: int = 1) -> List[Dict]:
    """Fetch popular movies/TV from TMDB - basic info only."""
    endpoint = f"/{media_type}/popular"
    data = _tmdb_get(endpoint, {"page": page})
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        catalog.append({
            "id": item.get("id"),
            "title": item.get("title") or item.get("name"),
            "overview": item.get("overview", ""),
            "release_date": item.get("release_date") or item.get("first_air_date", ""),
            "first_air_date": item.get("first_air_date", ""),
            "vote_average": item.get("vote_average"),
            "poster_path": item.get("poster_path"),
            "backdrop_path": item.get("backdrop_path"),
            "genre_ids": item.get("genre_ids", []),
            "popularity": item.get("popularity"),
            "media_type": media_type,
            "number_of_seasons": item.get("number_of_seasons") if media_type == "tv" else None,
            "number_of_episodes": item.get("number_of_episodes") if media_type == "tv" else None,
        })
    return catalog


def get_now_playing(page: int = 1) -> List[Dict]:
    """Fetch currently playing movies from TMDB - basic info only."""
    endpoint = "/movie/now_playing"
    data = _tmdb_get(endpoint, {"page": page})
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        catalog.append({
            "id": item.get("id"),
            "title": item.get("title"),
            "overview": item.get("overview", ""),
            "release_date": item.get("release_date", ""),
            "vote_average": item.get("vote_average"),
            "poster_path": item.get("poster_path"),
            "backdrop_path": item.get("backdrop_path"),
            "genre_ids": item.get("genre_ids", []),
            "popularity": item.get("popularity"),
            "media_type": "movie",
        })
    return catalog


def get_top_rated(media_type: str = "movie", page: int = 1) -> List[Dict]:
    """Fetch top-rated movies/TV from TMDB - basic info only."""
    return _basic_list(f"/{media_type}/top_rated", media_type, page)


def get_upcoming(page: int = 1) -> List[Dict]:
    """Fetch upcoming films from TMDB - basic info only."""
    return _basic_list("/movie/upcoming", "movie", page)


def get_discover(media_type: str = "movie", genre_id: Optional[int] = None, page: int = 1) -> List[Dict]:
    """Fetch a discover list by genre (or all genres) from TMDB - basic info only."""
    params: Dict[str, Any] = {"page": page, "sort_by": "popularity.desc"}
    if genre_id:
        params["with_genres"] = genre_id
    if media_type not in ("movie", "tv"):
        media_type = "movie"
    return _basic_list(f"/discover/{media_type}", media_type, page, params)


def _basic_list(endpoint: str, media_type: str, page: int, params: Optional[Dict] = None) -> List[Dict]:
    """Shared list fetcher: turns a TMDB list response into catalog entries."""
    data = _tmdb_get(endpoint, {**(params or {}), "page": page})
    if not data:
        return []
    results = data.get("results", [])
    catalog = []
    for item in results:
        catalog.append({
            "id": item.get("id"),
            "title": item.get("title") or item.get("name"),
            "overview": item.get("overview", ""),
            "release_date": item.get("release_date") or item.get("first_air_date", ""),
            "first_air_date": item.get("first_air_date", ""),
            "vote_average": item.get("vote_average"),
            "poster_path": item.get("poster_path"),
            "backdrop_path": item.get("backdrop_path"),
            "genre_ids": item.get("genre_ids", []),
            "popularity": item.get("popularity"),
            "media_type": media_type,
            "number_of_seasons": item.get("number_of_seasons") if media_type == "tv" else None,
            "number_of_episodes": item.get("number_of_episodes") if media_type == "tv" else None,
        })
    return catalog


def get_on_the_air(page: int = 1) -> List[Dict]:
    """Fetch currently airing TV shows from TMDB - basic info only."""
    endpoint = "/tv/on_the_air"
    data = _tmdb_get(endpoint, {"page": page})
    if not data:
        return []
    
    results = data.get("results", [])
    catalog = []
    for item in results:
        catalog.append({
            "id": item.get("id"),
            "title": item.get("name"),
            "overview": item.get("overview", ""),
            "first_air_date": item.get("first_air_date", ""),
            "vote_average": item.get("vote_average"),
            "poster_path": item.get("poster_path"),
            "backdrop_path": item.get("backdrop_path"),
            "genre_ids": item.get("genre_ids", []),
            "popularity": item.get("popularity"),
            "media_type": "tv",
            "number_of_seasons": item.get("number_of_seasons"),
            "number_of_episodes": item.get("number_of_episodes"),
        })
    return catalog


def search_multi(query: str, page: int = 1) -> List[Dict]:
    """Search movies and TV shows via TMDB multi-search - basic info only."""
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
        catalog.append({
            "id": item.get("id"),
            "title": item.get("title") or item.get("name"),
            "overview": item.get("overview", ""),
            "release_date": item.get("release_date") or item.get("first_air_date", ""),
            "first_air_date": item.get("first_air_date", ""),
            "vote_average": item.get("vote_average"),
            "poster_path": item.get("poster_path"),
            "backdrop_path": item.get("backdrop_path"),
            "genre_ids": item.get("genre_ids", []),
            "popularity": item.get("popularity"),
            "media_type": media_type,
            "number_of_seasons": item.get("number_of_seasons") if media_type == "tv" else None,
            "number_of_episodes": item.get("number_of_episodes") if media_type == "tv" else None,
        })
    return catalog


# TMDB types ordered by how well they stand in for a trailer. "Trailer" is the
# real thing; "Teaser" is an acceptable stand-in. The rest (Clip, Featurette,
# Behind the Scenes, Opening Credits) are supplementary material that plays
# wrong under a title card and is far more likely to be embed-blocked, so they
# are only reached when nothing better exists.
_TRAILER_TYPE_RANK = {
    "Trailer": 0,
    "Teaser": 1,
    "Clip": 2,
    "Featurette": 3,
    "Behind the Scenes": 4,
    "Opening Credits": 5,
}
_UNRANKED_TRAILER_TYPE = 6


def _trailer_rank(video: Dict[str, Any]) -> tuple:
    """Sort key for a YouTube video: official uploads first, then type.

    Official is weighted above type on purpose. A non-official Trailer is usually
    a third-party reupload that is more likely to be removed or have embedding
    disabled, while an official Featurette at least comes from the rights
    holder. The previous code ignored `official` entirely and fell back to
    "first YouTube video of any type", which is what made some titles embed a
    Behind the Scenes clip while others played a real trailer.
    """
    is_official = 0 if video.get("official") else 1
    type_rank = _TRAILER_TYPE_RANK.get(video.get("type"), _UNRANKED_TRAILER_TYPE)
    return (is_official, type_rank)


def select_trailer_key(videos: Optional[List[Dict[str, Any]]]) -> Optional[str]:
    """Pick the best YouTube video key from a TMDB `videos.results` list.

    Returns None when there is no usable YouTube video, so the caller keeps the
    backdrop instead of mounting an embed that is likely to fail.
    """
    if not videos:
        return None
    candidates = [v for v in videos if v.get("site") == "YouTube" and v.get("key")]
    if not candidates:
        return None
    best = min(candidates, key=_trailer_rank)
    return best.get("key")


def get_trailer_key(media_id: int, media_type: str) -> Optional[str]:
    """Fetch YouTube trailer key for a media item."""
    data = _tmdb_get(f"/{media_type}/{media_id}/videos", {})
    if not data:
        return None
    return select_trailer_key(data.get("results", []))


# The id -> name map is owned by the recommender, which needs it to score the
# list endpoints (which return ids only). Imported rather than duplicated so the
# two cannot drift; the values are unchanged from the original literal here.


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
        seasons_count = item.get("number_of_seasons") or 1
        episodes_count = item.get("number_of_episodes") or 1
    else:
        seasons_count = 1
        episodes_count = 1

    # The catalogue hands out the first embed in the chain so a card has
    # something to point at before anything is resolved. It used to hardcode
    # `vidsrc.me`, a host that has been gone for months: every card carried a
    # dead URL, which is what made a title look unavailable while the provider
    # chain behind it was perfectly healthy. Built from the manifest instead, so
    # the field cannot name a retired provider again.
    stream_url = ""
    for provider in stream_providers.active_embed_providers():
        candidate = provider.build(tmdb_id, media_type, 1, 1)
        if candidate:
            stream_url = candidate
            break

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
        "runtime": "",
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