import os
import requests

TMDB_API_KEY = os.getenv("TMDB_API_KEY", "100868d1fc3966ca832b3a5457e1edb9")

def fetch_media_details(media_id, media_type="movie"):
    url = f"https://api.themoviedb.org/3/{media_type}/{media_id}?api_key={100868d1fc3966ca832b3a5457e1edb9}&append_to_response=external_ids,credits"
    response = requests.get(url)
    if response.status_code != 200:
        return None
    
    data = response.json()
    release_date = data.get("release_date") or data.get("first_air_date", "")
    release_year = release_date.split("-")[0] if release_date else "N/A"
    
    return {
        "id": data.get("id"),
        "title": data.get("title") or data.get("name"),
        "overview": data.get("overview"),
        "release_year": release_year,
        "vote_average": round(data.get("vote_average", 0.0), 1),
        "imdb_id": data.get("external_ids", {}).get("imdb_id"),
        "genres": [genre["name"] for genre in data.get("genres", [])],
        "poster_path": f"https://image.tmdb.org/t/p/w500{data.get('poster_path')}" if data.get('poster_path') else None,
        "backdrop_path": f"https://image.tmdb.org/t/p/original{data.get('backdrop_path')}" if data.get('backdrop_path') else None
    }

def get_trending_catalog():
    url = f"https://api.themoviedb.org/3/trending/all/week?api_key={TMDB_API_KEY}"
    response = requests.get(url)
    if response.status_code != 200:
        return []
    
    results = response.json().get("results", [])
    catalog = []
    for item in results:
        media_type = item.get("media_type", "movie")
        details = fetch_media_details(item.get("id"), media_type)
        if details:
            details["media_type"] = media_type
            catalog.append(details)
    return catalog