"""
Shared catalog utilities for the movie backend.

Used by `scrape_movies.py` (bulk catalog build) and `app.py` (on-demand
resolution: when a requested title is not in the catalog, it is scraped from
Archive.org right then, verified playable, and added to the platform).

Catalog feeds: every playable entry is tagged with one or more `topics`
(`featured` from Archive's curated home selection, `recent` newest-added, and
`popular` most-downloaded) so the frontend can render "Movie of the day",
"New this week", "Most watched", and similar shelves entirely from playable
titles.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = "Mozilla/5.0 (FreeStream-movie-backend; +http://localhost:5000)"
SEARCH_URL = "https://archive.org/advancedsearch.php"
META_URL = "https://archive.org/metadata/{id}"
DOWNLOAD_URL = "https://archive.org/download/{id}/{name}"

# Archive.org collections that back the discovery feeds. All are public-domain
# / openly licensed full-film collections; `build_entry_by_identifier` re-verifies
# playability before anything enters the catalog.
CATALOG_COLLECTIONS = (
    "feature_films",  # public-domain features
    "silent_films",  # public-domain silents
    "animationandcartoons",  # archival animation (PD shorts + features)
)
FEATURE_FILMS_COLLECTION = "feature_films"

_print_lock = threading.Lock()


def log(message: str) -> None:
    with _print_lock:
        print(message, flush=True)


def http_json(url: str, retries: int = 2, timeout: int = 30):
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - retry any transient failure
            last_error = error
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def probe_stream(url: str) -> bool:
    """Verify the browser would get playable bytes (200/206 range response)."""
    try:
        req = urllib.request.Request(
            url,
            method="GET",
            headers={"Range": "bytes=0-0", "User-Agent": UA},
        )
        with urllib.request.urlopen(req, timeout=25) as response:
            return response.status in (200, 206)
    except Exception:
        return False


STREAM_HOST_ALLOWLIST = ("archive.org",)


def open_archive_stream(url: str, range_header: str | None):
    """Open a bounded, host-allowlisted Archive.org stream request.

    Returns (status, headers, iterator-of-bytes). Only archive.org hosts are
    permitted so this cannot be abused as a general-purpose proxy."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.netloc not in STREAM_HOST_ALLOWLIST:
        raise ValueError("stream URL must be an archive.org download")
    headers = {"User-Agent": UA}
    if range_header:
        headers["Range"] = range_header
    req = urllib.request.Request(url, headers=headers)
    response = urllib.request.urlopen(req, timeout=60)

    def chunks(read_size: int = 256 * 1024):
        try:
            while True:
                block = response.read(read_size)
                if not block:
                    break
                yield block
        finally:
            response.close()

    headers_out = {}
    # Content-Range is what lets the browser compute total size and seek within
    # a 206; dropping it turns every range request into an unseekable clip.
    for header in ("Content-Length", "Content-Type", "Accept-Ranges", "Content-Range"):
        value = response.headers.get(header)
        if value:
            headers_out[header] = value
    return response.status, headers_out, chunks()


def clean_title(raw: str | None) -> str:
    title = re.sub(r"\s+", " ", (raw or "").strip())
    title = re.sub(r"\s*[(\[]?(?:19|20)\d{2}[)\]]?$", "", title)
    return title.strip() or "Untitled"


STOPWORDS = {"the", "a", "an", "and", "of", "for"}


def normalize_title(raw: str) -> str:
    """Comparable form: lowercase, alnum only, years/stopwords dropped."""
    value = re.sub(r"[^a-z0-9]+", " ", (raw or "").lower()).strip()
    value = re.sub(r"\b(?:19|20)\d{2}\b", " ", value)
    return " ".join(word for word in value.split() if word not in STOPWORDS)


def choose_video(files: list[dict]) -> tuple[str, int] | None:
    blocked = (
        "thumb",
        "_djvu",
        "_text",
        ".xml",
        ".sqlite",
        ".txt",
        "_archive",
        "__ia",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        "sample",
        "trailer",
        "clip",
    )
    candidates = []
    for file in files:
        name = file.get("name", "")
        fmt = (file.get("format") or "").lower()
        size = int(file.get("size") or 0)
        lowered = name.lower()
        if any(token in lowered for token in blocked):
            continue
        if name.endswith(".mp4") or name.endswith(".m4v") or fmt in (
            "h.264",
            "mpeg4",
        ):
            candidates.append((name, size))
    candidates = [c for c in candidates if 40_000_000 <= c[1] <= 2_500_000_000]
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[1], reverse=True)
    return candidates[0]


QUALITY_TIERS = (
    (2160, "4K"),
    (1080, "1080p"),
    (700, "720p"),
    (450, "480p"),
    (0, "320p"),
)
QUALITY_ORDER = [label for _, label in QUALITY_TIERS]


def quality_for_height(height: int) -> str:
    for threshold, label in QUALITY_TIERS:
        if height >= threshold:
            return label
    return "320p"


def stream_download_url(identifier: str, name: str) -> str:
    return DOWNLOAD_URL.format(id=identifier, name=urllib.parse.quote(name, safe="/"))


# ISO 639-2 -> human label for subtitle files that embed a language code.
LANG_CODES = {
    "ara": "Arabic",
    "deu": "German",
    "eng": "English",
    "fra": "French",
    "ita": "Italian",
    "spa": "Spanish",
    "por": "Portuguese",
    "nld": "Dutch",
    "pol": "Polish",
    "swe": "Swedish",
    "nor": "Norwegian",
    "dan": "Danish",
    "fin": "Finnish",
    "rus": "Russian",
    "hin": "Hindi",
    "zho": "Chinese",
    "jpn": "Japanese",
    "kor": "Korean",
    "ukr": "Ukrainian",
    "ces": "Czech",
}


def choose_subtitles(files: list[dict], identifier: str) -> list[dict]:
    """Best-effort WebVTT subtitles for an item.

    Only `.vtt` files can drive a native <video> <track> element (SRT is not
    supported by browsers). A language code embedded in the filename (e.g.
    `.._eng.vtt`) becomes the label; otherwise the item defaults to English.
    """
    blocked = ("thumb", "_djvu", "__ia", "sample", "trailer")
    seen: set[str] = set()
    subtitles: list[dict] = []
    for file in files:
        name = str(file.get("name") or "")
        lowered = name.lower()
        if not lowered.endswith(".vtt"):
            continue
        if any(token in lowered for token in blocked):
            continue
        stem = lowered[:-4]
        code_match = re.search(r"(?:^|[\W_])*([a-z]{3})(?:[\W_]|$)", stem)
        key = code_match.group(1) if code_match and code_match.group(1) in LANG_CODES else "eng"
        if key in seen:
            continue
        seen.add(key)
        subtitles.append(
            {
                "label": LANG_CODES[key],
                "lang": key,
                "url": stream_download_url(identifier, name),
            }
        )
    return subtitles


def choose_streams(
    files: list[dict], identifier: str
) -> tuple[list[dict], dict] | None:
    """Return (quality variants best -> worst, default stream).

    Only real h.264 MP4/M4V files are kept — .mkv/.ogv/.m2ts can't play in a
    <video> element and are ignored. One variant per quality tier, picking the
    tallest (then largest) file within that tier."""

    def better(height: int, size: int, current: dict) -> bool:
        if height > current["height"]:
            return True
        return height == current["height"] and size > current.get("size", 0)

    blocked = (
        "thumb",
        "_djvu",
        "_text",
        ".xml",
        ".sqlite",
        ".txt",
        "_archive",
        "__ia",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        "sample",
        "trailer",
        "clip",
    )
    by_tier: dict[str, dict] = {}
    for file in files:
        name = str(file.get("name") or "")
        lowered = name.lower()
        if any(token in lowered for token in blocked):
            continue
        if not (lowered.endswith(".mp4") or lowered.endswith(".m4v")):
            continue
        size = int(file.get("size") or 0)
        if not 40_000_000 <= size <= 4_000_000_000:
            continue
        height = 0
        width = 0
        try:
            height = int(file.get("height") or 0)
            width = int(file.get("width") or 0)
        except (TypeError, ValueError):
            pass
        if height <= 0:
            match = re.search(r"(\d{3,4})[pP]", name)
            height = int(match.group(1)) if match else 480
        label = quality_for_height(height)
        current = by_tier.get(label)
        if current is None or better(height, size, current):
            by_tier[label] = {
                "quality": label,
                "url": stream_download_url(identifier, name),
                "height": height,
                "width": width,
                "size": size,
            }
    if not by_tier:
        return None

    streams = [by_tier[label] for label in QUALITY_ORDER if label in by_tier]
    default = next((s for s in streams if s["quality"] == "720p"), None)
    if default is None:
        default = next(
            (s for s in streams if s["quality"] in ("1080p", "4K")), streams[0]
        )
    return streams, default


def build_entry_by_identifier(
    identifier: str,
    topics: list[str] | None = None,
    extra: dict | None = None,
) -> dict | None:
    """Resolve one Archive.org item into a playable catalog entry or None."""
    metadata = http_json(META_URL.format(id=identifier))
    files = metadata.get("files") or []
    resolved = choose_streams(files, identifier)
    if not resolved:
        return None

    streams, default = resolved
    stream_url = default["url"]
    if not probe_stream(stream_url):
        return None

    subtitles = choose_subtitles(files, identifier)

    meta = metadata.get("metadata") or {}
    year = meta.get("year")
    year = int(year) if str(year).isdigit() else None

    entry = {
        "id": identifier,
        "title": clean_title(meta.get("title")),
        "poster_url": f"https://archive.org/download/{identifier}/__ia_thumb.jpg",
        "stream_url": stream_url,
        "streams": streams,
        "year": year,
        "media_type": "movie",
        "seasons": 1,
        "episodes_per_season": 1,
        "topics": topics or [],
    }
    if subtitles:
        entry["subtitles"] = subtitles
    if extra:
        entry.update(extra)
    return entry


def discover_catalog(
    query: str,
    rows: int = 60,
    sort: str = "downloads desc",
    extra_fields: list[str] | None = None,
) -> list[dict]:
    fields = ["identifier", "title", "year", "downloads", "addeddate"]
    if extra_fields:
        fields.extend(extra_fields)
    params = urllib.parse.urlencode(
        [
            ("q", query),
            *[(("fl[]", f)) for f in fields],
            ("sort[]", sort),
            ("rows", rows),
            ("output", "json"),
        ]
    )
    payload = http_json(f"{SEARCH_URL}?{params}")
    return payload.get("response", {}).get("docs", [])


def title_query(title: str) -> str:
    """Archive.org field search for a title (mediatype-filtered)."""
    words = normalize_title(title).split()
    if not words:
        return ""
    return f"title:({' '.join(words)}) AND mediatype:movies"


def year_mismatch(requested_year, candidate_year) -> bool:
    """Two known, different years means it is a different film. Unknown years
    never veto (we cannot prove they differ)."""
    if not requested_year or not candidate_year:
        return False
    try:
        return int(requested_year) != int(candidate_year)
    except (TypeError, ValueError):
        return False


def accept_candidate(requested_year, candidate_year) -> bool:
    """A candidate is trustworthy enough to play when there is no requested
    year to check against, or the years agree. A known requested year with an
    unknown candidate year is rejected — an unverifiable release must not play
    in place of the requested one."""
    if not requested_year:
        return True
    return bool(candidate_year) and not year_mismatch(requested_year, candidate_year)


def match_title(requested: str, candidate_title: str) -> float:
    """Confidence the requested title refers to the candidate film.

    1.0  identical normalized titles
    0.7  one title is a shortened/expanded variant of the other (every word of
         the shorter title appears in the longer, and the shared words form at
         least half of the longer title)
    0.0  anything else — never guess on a lone shared word
    """
    requested_words = normalize_title(requested).split()
    candidate_words = normalize_title(candidate_title).split()
    if not requested_words or not candidate_words:
        return 0.0
    if requested_words == candidate_words:
        return 1.0
    requested_set = set(requested_words)
    candidate_set = set(candidate_words)
    if requested_set <= candidate_set:
        overlap_ratio = len(requested_set) / len(candidate_set)
    elif candidate_set <= requested_set:
        overlap_ratio = len(candidate_set) / len(requested_set)
    else:
        return 0.0
    return 0.7 if overlap_ratio >= 0.5 else 0.0


def pick_best_docs(
    docs: list[dict], requested: str, requested_year=None
) -> list[dict]:
    """Keep only docs that confidently match the requested title (and pass the
    year trust check); order exact matches first, then downloads."""
    candidates = []
    for doc in docs:
        score = match_title(requested, doc.get("title") or "")
        if score < 0.7:
            continue
        if not accept_candidate(requested_year, doc.get("year")):
            continue
        candidates.append((doc, score))
    candidates.sort(
        key=lambda item: (
            item[1],
            int(item[0].get("downloads") or 0),
        ),
        reverse=True,
    )
    return [item[0] for item in candidates]


def scrape_title(
    title: str,
    rows: int = 12,
    attempts: int = 5,
    requested_year=None,
) -> dict | None:
    """Scrape a title on demand: search -> verify playable, trying ranked
    candidates until one resolves to a real, playable film. Only titles that
    confidently match (and agree on year) are accepted — never a look-alike."""
    query = title_query(title)
    if not query:
        return None
    try:
        docs = discover_catalog(query, rows=rows)
    except Exception as error:  # noqa: BLE001 - degrade to "not found"
        log(f"on-demand search failed for {title!r}: {error}")
        return None
    if not docs:
        return None

    for doc in pick_best_docs(docs, title, requested_year)[:attempts]:
        identifier = str(doc.get("identifier", ""))
        if not identifier:
            continue
        try:
            entry = build_entry_by_identifier(identifier)
        except Exception as error:  # noqa: BLE001
            log(f"on-demand resolution failed for {title!r} ({identifier}): {error}")
            continue
        if entry:
            return entry
    return None


def bulk_build(
    query: str,
    rows: int,
    workers: int = 8,
    topics: list[str] | None = None,
) -> list[dict]:
    """Resolve N candidates concurrently, keeping only verified-playable ones."""
    docs = discover_catalog(query, rows=rows)
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                build_entry_by_identifier,
                str(doc.get("identifier", "")),
                topics,
            ): doc
            for doc in docs
            if doc.get("identifier")
        }
        for future in as_completed(futures):
            try:
                entry = future.result()
            except Exception as error:  # noqa: BLE001 - a bad item must not abort the run
                log(f"- {futures[future].get('identifier')}: {error}")
                continue
            if entry:
                results.append(entry)
    return results


# ---------------------------------------------------------------------------
# Watch-page / embed resolution – media_type aware payloads
# ---------------------------------------------------------------------------

VIDSRC_BASE = "https://vidsrc.xyz"


def vidsrc_movie_url(tmdb_id) -> str:
    return f"{VIDSRC_BASE}/embed/movie?tmdb={tmdb_id}"


def vidsrc_tv_url(tmdb_id, season: int = 1, episode: int = 1) -> str:
    return f"{VIDSRC_BASE}/embed/tv?tmdb={tmdb_id}&season={season}&episode={episode}"


def parse_watch_url(url: str) -> dict:
    """Parse a watch-page URL into `{media_type, media_id, season, episode}`.

    Handles both `/watch-movie/{id}` and `/watch-series/{id}` path patterns.
    Season/episode are pulled from the `season`/`episode` query parameters when
    a series path is matched (defaulting to 1/1).
    """
    parsed = urllib.parse.urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    media_type = "movie"
    media_id = None
    if parts:
        slug = parts[0].lower()
        if slug in ("watch-series", "watch-tv", "series", "tv", "show"):
            media_type = "tv"
        elif slug in ("watch-movie", "watch-film", "movie", "film"):
            media_type = "movie"
        if len(parts) >= 2:
            media_id = parts[1] or None

    query = urllib.parse.parse_qs(parsed.query)
    try:
        season = int(query.get("season", ["1"])[0])
    except (TypeError, ValueError):
        season = 1
    try:
        episode = int(query.get("episode", ["1"])[0])
    except (TypeError, ValueError):
        episode = 1

    return {
        "media_type": media_type,
        "media_id": media_id,
        "season": max(1, season),
        "episode": max(1, episode),
    }


def build_watch_entry(
    media_id,
    media_type: str = "movie",
    season: int = 1,
    episode: int = 1,
    title: str = "Untitled",
    total_seasons: int = 1,
    episodes_per_season: int = 12,
) -> dict:
    """Build the playable payload for a watch-page id.

    Movies resolve to a VidSrc movie embed; series resolve to a season- and
    episode-aware TV embed (the requested `season`/`episode` are encoded into
    the stream URL). `seasons`/`episodes` describe how many rows the client's
    episode matrix should offer and are used when the source does not publish a
    full episode manifest.

    The payload shape — `media_type`, `seasons`, `episodes`, `stream_url` — is
    shared by both media types so the frontend can branch on `media_type`.
    """
    normalized_type = media_type if media_type in ("movie", "tv") else "movie"
    is_tv = normalized_type == "tv"
    stream_url = (
        vidsrc_tv_url(media_id, season, episode)
        if is_tv
        else vidsrc_movie_url(media_id)
    )
    return {
        "id": str(media_id),
        "title": title,
        "stream_url": stream_url,
        "media_type": normalized_type,
        "seasons": max(1, int(total_seasons) if is_tv else 1),
        "episodes_per_season": max(1, int(episodes_per_season) if is_tv else 1),
    }


# ---------------------------------------------------------------------------
# Feed helpers – supply "featured", "recent", "popular" shelves
# ---------------------------------------------------------------------------

def _feed_query(sort: str, rows: int) -> list[dict]:
    """Search the curated collections + sort, returning raw docs."""
    collections = " OR ".join(
        f"collection:{name}" for name in CATALOG_COLLECTIONS
    )
    params = urllib.parse.urlencode(
        [
            (
                "q",
                f"({collections}) AND mediatype:movies AND format:(mp4 OR ogg)",
            ),
            ("fl[]", "identifier"),
            ("fl[]", "title"),
            ("fl[]", "year"),
            ("fl[]", "downloads"),
            ("fl[]", "addeddate"),
            ("sort[]", sort),
            ("rows", rows),
            ("output", "json"),
        ]
    )
    payload = http_json(f"{SEARCH_URL}?{params}")
    return payload.get("response", {}).get("docs", [])


def _resolve_feed_docs(
    docs: list[dict], topic: str, workers: int = 8
) -> list[dict]:
    """Resolve a list of search docs into playable entries, tagging with `topic`."""
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                build_entry_by_identifier,
                str(doc.get("identifier", "")),
                [topic],
                {
                    "_downloads": int(doc.get("downloads") or 0),
                    "_addeddate": str(doc.get("addeddate") or ""),
                },
            ): doc
            for doc in docs
            if doc.get("identifier")
        }
        for future in as_completed(futures):
            try:
                entry = future.result()
            except Exception as error:
                log(f"- feed {topic}: {futures[future].get('identifier')}: {error}")
                continue
            if entry:
                results.append(entry)
    return results


def discover_recent(rows: int = 20) -> list[dict]:
    """Most recently added films from the curated collections."""
    docs = _feed_query("addeddate desc", rows)
    return _resolve_feed_docs(docs, "recent")


def discover_popular(rows: int = 20) -> list[dict]:
    """Most-downloaded films from the curated collections (all time)."""
    docs = _feed_query("downloads desc", rows)
    return _resolve_feed_docs(docs, "popular")