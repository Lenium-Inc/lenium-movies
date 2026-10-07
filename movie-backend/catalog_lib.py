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


def http_json(
    url: str,
    retries: int = 2,
    timeout: int = 30,
    deadline: float | None = None,
):
    """Fetch JSON, retrying transient failures.

    `deadline` is an absolute `time.monotonic()` value. When supplied it caps
    both the retry count and the per-attempt socket timeout, because
    `urlopen` blocks for the full timeout on a hung connection and there is no
    way to interrupt it. Without this a single scrape could occupy a worker
    for minutes (see scrape_title)."""
    last_error: Exception | None = None
    for attempt in range(retries):
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"deadline exceeded before fetching {url}")
            timeout = max(1, min(timeout, int(remaining)))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - retry any transient failure
            last_error = error
            if deadline is not None and time.monotonic() >= deadline:
                break
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_error}")


def probe_stream(url: str, deadline: float | None = None) -> bool:
    """Verify the browser would get playable bytes (200/206 range response)."""
    timeout = 25
    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        timeout = max(1, min(timeout, int(remaining)))
    try:
        req = urllib.request.Request(
            url,
            method="GET",
            headers={"Range": "bytes=0-0", "User-Agent": UA},
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status in (200, 206)
    except Exception:
        return False


STREAM_HOST_ALLOWLIST = ("archive.org",)

# Ports a relay request may name. `None` is "whatever the scheme implies";
# anything else is either a scanner trying to reach something on the same host or
# a URL that did not come from the resolver, and neither is worth answering.
_STREAM_ALLOWED_PORTS = (None, 80, 443)


class ArchiveUrlRejected(ValueError):
    """A URL the relay is not allowed to fetch.

    A distinct type rather than a plain `ValueError` because callers used to
    tell "you asked for something forbidden" (400) from "upstream went wrong"
    (502) by searching the message text for `archive.org` -- so a rejection
    worded any other way was reported as a server fault, and the tests that
    assert a 400 quietly depended on the wording. Subclasses `ValueError`, so
    every existing `except ValueError` still catches it.
    """


def _is_archive_host(hostname: str | None) -> bool:
    """True for archive.org itself and any host inside its DNS zone.

    The subdomain form is required, not incidental: `/download/...` answers with
    a 302 to a storage node (`ia600803.us.archive.org`) and the redirect is
    followed on every single playback, so rejecting nodes would break streaming
    entirely. What it does not permit is a host *outside* the zone -- the exact
    property a single-host string comparison cannot express.
    """
    if not hostname:
        return False
    host = hostname.lower().rstrip(".")
    return any(
        host == allowed or host.endswith("." + allowed)
        for allowed in STREAM_HOST_ALLOWLIST
    )


# The two shapes a media file is served under: the canonical
# `/download/{identifier}/{name}` and a storage node's `/{shard}/items/{id}/{name}`.
# Anchored on the segment structure rather than a prefix alone, so a query that
# merely *mentions* `/download/` (`/metadata/x?file=/download/y`) is not one.
_ARCHIVE_MEDIA_PATH = re.compile(r"^/(?:download/|\d+/items/)\S")


def validate_archive_url(url: str, *, require_download_path: bool = False) -> str:
    """Return `url` if it may be relayed, else raise `ValueError`.

    Three separate things are checked, because each has a different failure
    mode and only checking the first two leaves the relay a one-string bypass
    away from being open again:

    - **scheme and host.** http/https, no credentials in the authority, and a
      host inside the allow-listed zone. `parsed.netloc == "archive.org"` used to
      stand in for this, which silently rejects legitimate node URLs while
      comparing a string that carries userinfo and port along with the host.
    - **port.** Only the two default ones, so the relay cannot be pointed at an
      unrelated service listening on the same box.
    - **path.** A media-file path when `require_download_path` is set: either
      `/download/...` (what the resolver produces, via `DOWNLOAD_URL`) or a node's
      `/NN/items/...`, which is the shape a storage node serves and which a
      stored URL can already be. Anything else -- Archive's JSON APIs, search
      endpoints, account pages -- is refused, so the relay cannot be used as a
      general fetch service for the whole site.

    `require_download_path` is off for redirect hops rather than on, because a
    node answers from `/NN/items/{id}/{name}` rather than `/download/`, and that
    hop is where the bytes actually come from on every playback.
    """
    try:
        parsed = urllib.parse.urlparse(url)
        port = parsed.port
    except ValueError as error:
        raise ArchiveUrlRejected(f"malformed URL: {error}") from error

    if parsed.scheme not in ("http", "https"):
        raise ArchiveUrlRejected("stream URL must be http or https")
    if parsed.username or parsed.password:
        raise ArchiveUrlRejected("stream URL must not carry credentials")
    if port not in _STREAM_ALLOWED_PORTS:
        raise ArchiveUrlRejected("stream URL must use the default port")
    if not _is_archive_host(parsed.hostname):
        raise ArchiveUrlRejected("stream URL must be an archive.org download")
    if require_download_path and not _is_archive_media_path(parsed.path):
        raise ArchiveUrlRejected("stream URL must be an archive.org download")
    return url


def _is_archive_media_path(path: str) -> bool:
    return bool(_ARCHIVE_MEDIA_PATH.match(path))


class _ArchiveOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-apply the host check to every redirect hop.

    `urllib` follows redirects to *any* host by default, so validating only the
    URL the caller supplied made the allow-list a check on the first hop and
    nothing more: one 302 from a permitted host to anywhere on the internet, and
    the relay is an open proxy again. The check runs here instead of at the call
    site so it applies to hops the caller never sees.
    """

    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_archive_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _archive_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_ArchiveOnlyRedirectHandler())


def open_archive_stream(url: str, range_header: str | None):
    """Open a bounded, host-allowlisted Archive.org stream request.

    Returns (status, headers, iterator-of-bytes). Only Archive.org download URLs
    are permitted -- at the first hop and at every redirect after it -- so this
    cannot be abused as a general-purpose proxy."""
    validate_archive_url(url, require_download_path=True)
    headers = {"User-Agent": UA}
    if range_header:
        headers["Range"] = range_header
    req = urllib.request.Request(url, headers=headers)
    response = _archive_opener().open(req, timeout=60)

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


def fetch_bounded_text(url: str, timeout: float, max_bytes: int) -> str:
    """Fetch a small text file, enforcing the archive.org allowlist and a byte cap.

    Subtitle files are tens of KB, so the cap is a hard ceiling rather than a
    budget: without it this helper would happily pull an arbitrarily large
    object through a route that exists to return a caption track. Rejects a body
    that exceeds the cap instead of truncating it, because a silently clipped
    caption file would fail part-way through playback with no visible cause.

    Kept beside `open_archive_stream` so both routes share one allowlist check
    rather than each restating it.
    """
    validate_archive_url(url, require_download_path=True)
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/vtt, text/plain, */*"},
    )
    with _archive_opener().open(req, timeout=timeout) as response:
        raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError("file exceeds the maximum subtitle size")
    return raw.decode("utf-8", errors="replace")


def clean_title(raw: str | None) -> str:
    title = re.sub(r"\s+", " ", (raw or "").strip())
    title = re.sub(r"\s*[(\[]?(?:19|20)\d{2}[)\]]?$", "", title)
    return title.strip() or "Untitled"


# ---------------------------------------------------------------------------
# HLS master manifests
# ---------------------------------------------------------------------------
#
# Why this lives here rather than in `app.py`
# ------------------------------------------
# Most of the direct catalog is progressive MP4, which `choose_streams` already
# resolves into quality tiers from Archive.org's file metadata. But a direct
# source can also be an HLS master playlist, and a master carries two things a
# file listing cannot: a genuine adaptive bitrate ladder, and alternate audio
# renditions. The renditions are the important half -- an English dub of a
# Korean or Chinese release exists *only* as an `#EXT-X-MEDIA:TYPE=AUDIO` entry
# pointing at a sub-playlist, so a resolver that reads nothing else will
# resolve the video ladder perfectly and never once offer the dub.
#
# Parsing is kept pure (text in, inventory out) so it is testable without a
# socket, and so the route layer can decide what to do about a manifest it
# could not fetch.

#: Ceiling on a master manifest fetch. Masters are kilobytes; anything near this
#: is not a manifest, and an unbounded read here would be an allocation
#: primitive reachable from a client-supplied URL.
MANIFEST_MAX_BYTES = 2 * 1024 * 1024
MANIFEST_TIMEOUT_SECONDS = 12.0

_ATTRIBUTE_PATTERN = re.compile(r'([A-Za-z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)')
#: ISO-639-2 codes a packager may use where the RFC-5646 2-letter form is expected.
_ENGLISH_LANGUAGE_CODES = {"en", "eng", "en-us", "en-gb", "english"}


def parse_manifest_attributes(value: str) -> dict[str, str]:
    """Parse an HLS attribute list into a dict.

    Quoted values may contain commas (`NAME="English, 5.1"`), which is exactly
    why this cannot be a `split(",")`. The leading `#EXT-X-TAG:` is the
    caller's to strip, so the same helper serves every tag type.
    """
    attributes: dict[str, str] = {}
    for match in _ATTRIBUTE_PATTERN.finditer(value):
        attributes[match.group(1).upper()] = match.group(2).strip('"')
    return attributes


def _is_english(language: str) -> bool:
    normalised = (language or "").strip().lower()
    if normalised in _ENGLISH_LANGUAGE_CODES:
        return True
    return normalised.split("-")[0].split("_")[0] in {"en", "eng"}


def _base_language(language: str) -> str:
    return (language or "").strip().lower().split("-")[0].split("_")[0]


def _manifest_line_kind(line: str) -> tuple[str, str]:
    """Return (tag, attribute-list) for a tag line, else ("", "") for a URI."""
    if not line.startswith("#"):
        return "", ""
    tag, _, rest = line.partition(":")
    return tag.strip().upper(), rest.strip()


def parse_hls_master(
    manifest: str, base_url: str = "", original_language: str | None = None
) -> dict:
    """Inventory an HLS master playlist: video rungs, audio dubs, subtitles.

    Returns a dict with `variants`, `audio` and `subtitles`. An empty
    `variants` list means this is a media playlist rather than a master, which
    is not an error -- it just has no ladder to advertise.

    URIs are resolved against `base_url` when one is supplied, so a relative
    `variant/1080.m3u8` becomes absolute. They are returned as parsed; the
    caller is responsible for putting them on an authorized, same-origin route
    before they reach a browser.
    """
    variants: list[dict] = []
    audio: list[dict] = []
    subtitles: list[dict] = []
    pending: dict | None = None

    def absolute(uri: str) -> str:
        if not base_url:
            return uri
        try:
            return urllib.parse.urljoin(base_url, uri)
        except ValueError:
            return uri

    for raw_line in manifest.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if not line.startswith("#"):
            # The URI line that follows `#EXT-X-STREAM-INF` names a variant.
            if pending is not None:
                pending["url"] = absolute(line)
                variants.append(pending)
                pending = None
            continue

        tag, attributes_text = _manifest_line_kind(line)

        if tag == "#EXT-X-STREAM-INF":
            attributes = parse_manifest_attributes(attributes_text)
            match = re.search(r"x(\d+)", attributes.get("RESOLUTION", ""), re.I)
            height = int(match.group(1)) if match else 0
            pending = {
                "height": height,
                # "4K" rather than "2160p": that is the label a viewer reads on
                # the quality badge, and it matches what the TS resolver emits.
                "quality": "4K" if height >= 2000 else (f"{height}p" if height else "Adaptive"),
                "bandwidth": int(
                    attributes.get("AVERAGE-BANDWIDTH") or attributes.get("BANDWIDTH") or 0
                ),
                "url": "",
            }
            continue

        if tag not in ("#EXT-X-MEDIA",):
            continue

        attributes = parse_manifest_attributes(attributes_text)
        kind = attributes.get("TYPE", "").upper()
        uri = attributes.get("URI", "")
        # A rendition with no URI is muxed into the variant rather than shipped
        # separately, so it is not selectable and there is nothing to point at.
        if kind not in ("AUDIO", "SUBTITLES") or not uri:
            continue

        language = attributes.get("LANGUAGE", "und").strip() or "und"
        name = attributes.get("NAME", "").strip() or language
        group_id = attributes.get("GROUP-ID", "").strip()
        descriptor = {
            "id": f"{group_id}:{language}:{name}",
            "label": name,
            "language": language,
            "name": name,
            "group_id": group_id,
            "url": absolute(uri),
        }

        if kind == "SUBTITLES":
            subtitles.append(descriptor)
            continue

        descriptor["is_default"] = attributes.get("DEFAULT", "").upper() == "YES"
        # An English rendition is a *dub* only on a title that was not made in
        # English. Without a declared original language nothing is labelled a
        # dub, because on an English film English audio is the primary track and
        # labelling it otherwise would misreport most of the catalog.
        descriptor["is_dub"] = bool(
            _is_english(language)
            and original_language
            and _base_language(original_language) not in {"en", "eng"}
        )
        channels = attributes.get("CHANNELS", "")
        if channels.isdigit():
            descriptor["channels"] = int(channels)
        audio.append(descriptor)

    variants.sort(key=lambda item: (-item["height"], item["bandwidth"]))
    audio.sort(key=lambda item: (not item["is_default"], item["label"]))
    return {"variants": variants, "audio": audio, "subtitles": subtitles}


def fetch_hls_master(url: str, original_language: str | None = None) -> dict | None:
    """Fetch and inventory an HLS master, or None when it cannot be read.

    Returns None rather than raising for every failure: an unreadable manifest
    is an ordinary outcome on this path (the origin is down, the URL was a media
    playlist rather than a master, the body was not an `#EXTM3U`), and the
    caller's correct response to all of them is the same -- fall back.
    """
    try:
        text = fetch_bounded_text(url, MANIFEST_TIMEOUT_SECONDS, MANIFEST_MAX_BYTES)
    except Exception:  # noqa: BLE001 - any fetch failure degrades to "no manifest"
        return None
    if not text.lstrip("﻿").lstrip().startswith("#EXTM3U"):
        return None
    return parse_hls_master(text, base_url=url, original_language=original_language)


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


# `.srt` is accepted and converted, not just `.vtt`.
#
# A <track> element can only consume WebVTT, and the majority of Archive.org
# caption files are `.srt` (their ASR pipeline emits SRT). Filtering to `.vtt`
# alone therefore threw away nearly every real subtitle track on the site --
# the menu had nothing to offer even once the frontend was fixed. Conversion is
# cheap and lossless for caption text, so `.srt` is now a first-class source.
SUBTITLE_EXTENSIONS = (".vtt", ".srt")

# `00:00:09,000 --> 00:00:15,001` (SRT) uses a comma before milliseconds;
# WebVTT requires a dot. Matched loosely so a malformed cue is passed through
# untouched rather than dropped.
_SRT_CUE_TIMING = re.compile(
    r"(\d{1,2}:)?(\d{1,2}:\d{1,2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}:)?(\d{1,2}:\d{1,2})[,.](\d{1,3})"
)


def _vtt_timestamp(match: re.Match) -> str:
    """Rewrite one SRT timing line into WebVTT form.

    The pattern captures six groups per cue: optional hours, `mm:ss`, then
    milliseconds -- twice.
    """
    h1, clock1, ms1, h2, clock2, ms2 = match.groups()
    # SRT writes exactly three millisecond digits; files in the wild use one or
    # two, so pad rather than trust.
    return (
        f"{h1 or '00:'}{clock1}.{ms1.ljust(3, '0')} --> "
        f"{h2 or '00:'}{clock2}.{ms2.ljust(3, '0')}"
    )


def srt_to_vtt(text: str) -> str:
    """Convert SubRip (`.srt`) text to WebVTT.

    Three differences matter to a browser:
      - the `WEBVTT` signature line must come first
      - timings use `.` not `,` before milliseconds
      - the numeric sequence line before each cue is not part of WebVTT

    Blank lines between cues are preserved because they delimit cues.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    if normalized.lstrip().upper().startswith("WEBVTT"):
        # Already WebVTT (some items ship a .srt extension but VTT content).
        return normalized if normalized.startswith("WEBVTT") else "WEBVTT\n" + normalized

    lines = normalized.split("\n")
    out: list[str] = ["WEBVTT", ""]
    for index, line in enumerate(lines):
        match = _SRT_CUE_TIMING.search(line)
        if match:
            out.append(_vtt_timestamp(match))
            continue
        # Drop SRT's per-cue sequence numbers: a bare integer on its own line.
        #
        # Only when it directly precedes a timing line. Testing `isdigit()` on
        # its own would also delete a caption whose text happens to be a number
        # -- a year, a countdown, a price -- which is real dialogue and would
        # vanish from the file with no error.
        stripped = line.strip()
        if stripped.isdigit():
            following = next(
                (nxt.strip() for nxt in lines[index + 1 :] if nxt.strip()),
                "",
            )
            if _SRT_CUE_TIMING.search(following):
                continue
        out.append(line)
    return "\n".join(out).rstrip() + "\n"


# A standalone ISO 639-2 code inside a filename stem: not adjacent to any other
# letter, so `Movie.spa.vtt` yields `spa` while `Movie.vtt` yields nothing.
LANG_CODE_RE = re.compile(r"(?<![a-z])([a-z]{3})(?![a-z])")


def choose_subtitles(files: list[dict], identifier: str) -> list[dict]:
    """Best-effort subtitles for an item, as WebVTT-track descriptors.

    A language code embedded in the filename (e.g. `.._eng.vtt`) becomes the
    label; otherwise the item defaults to English. `format` records the upstream
    container so the serving route knows whether conversion is required --
    `text/vtt` responses are passed through untouched.
    """
    blocked = ("thumb", "_djvu", "__ia", "sample", "trailer")
    seen: set[str] = set()
    subtitles: list[dict] = []

    # `.vtt` before `.srt`: when an item ships both for one language, the
    # native WebVTT is the better source (no conversion, no re-timing risk), so
    # it has to be seen first or the first-seen dedup keeps the SRT instead.
    ordered = sorted(
        files,
        key=lambda f: next(
            (
                SUBTITLE_EXTENSIONS.index(ext)
                for ext in SUBTITLE_EXTENSIONS
                if str(f.get("name") or "").lower().endswith(ext)
            ),
            len(SUBTITLE_EXTENSIONS),
        ),
    )

    for file in ordered:
        name = str(file.get("name") or "")
        lowered = name.lower()
        if not lowered.endswith(SUBTITLE_EXTENSIONS):
            continue
        if any(token in lowered for token in blocked):
            continue
        ext = next(e for e in SUBTITLE_EXTENSIONS if lowered.endswith(e))
        stem = lowered[: -len(ext)]
        # The language code must be a standalone 3-letter token.
        #
        # A leading `(?:^|[^a-z])*` looks equivalent but is not: the `*` allows
        # zero separators, so the leftmost match inside a plain stem like
        # "movie" was "vie" from the middle of the word. That never appears in
        # LANG_CODES, so every such file silently fell back to English and a
        # Spanish track was labelled "English". Requiring non-letters on both
        # sides is what makes `Movie.spa.vtt` resolve to `spa`.
        code_match = LANG_CODE_RE.search(stem)
        # The token must be a code we can name. `Movie.asr.srt` yields "asr"
        # (automatic speech recognition), which is not a language, and is
        # extremely common on Archive.org -- indexing it blindly raises
        # KeyError below and takes out the whole resolve.
        key = (
            code_match.group(1)
            if code_match and code_match.group(1) in LANG_CODES
            else "eng"
        )
        if key in seen:
            continue
        seen.add(key)
        subtitles.append(
            {
                "label": LANG_CODES[key],
                "lang": key,
                "url": stream_download_url(identifier, name),
                "format": ext.lstrip("."),
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
    deadline: float | None = None,
) -> dict | None:
    """Resolve one Archive.org item into a playable catalog entry or None.

    `deadline` (absolute `time.monotonic()`) bounds the two network calls; see
    http_json. Callers resolving several candidates in sequence should pass a
    single shared deadline so the whole search is capped, not each attempt."""
    metadata = http_json(META_URL.format(id=identifier), deadline=deadline)
    files = metadata.get("files") or []
    resolved = choose_streams(files, identifier)
    if not resolved:
        return None

    streams, default = resolved
    stream_url = default["url"]
    if not probe_stream(stream_url, deadline=deadline):
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
    deadline: float | None = None,
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
    payload = http_json(f"{SEARCH_URL}?{params}", deadline=deadline)
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


def accept_candidate(
    requested_year, candidate_year, title_score: float | None = None
) -> bool:
    """A candidate is trustworthy enough to play when there is no requested
    year to check against, or the years agree.

    A known requested year with an *unknown* candidate year is normally
    rejected, because an unverifiable release must not play in place of the
    requested one. `title_score` carves out the one case where that rule was
    discarding the correct film: most Archive.org items carry no `year` field at
    all, so an exact title match was thrown away and the caller silently fell
    back to a third-party embed, leaving the title with no downloadable file.
    Absence of a year is not evidence of a different film, so an exact
    normalised title match (1.0) is allowed through. A weak title match still
    requires the year, because there a missing year really is unverifiable.
    """
    if not requested_year:
        return True
    if candidate_year and not year_mismatch(requested_year, candidate_year):
        return True
    # No usable candidate year: only an exact title match can carry the weight.
    if candidate_year:
        return False
    return title_score is not None and title_score >= 1.0


# The season and episode numbers must be *marked*, never bare: a candidate
# named "Alien 3" or "1917" must not read as S03E01 or S19E17. So the pattern
# needs an explicit `x`, `e` or the word `episode` between the two numbers.
_EPISODE_TOKEN = re.compile(
    r"(?:\b(?:season|series)\s*)?(?:s\s*)?(?P<season>\d{1,2})"
    r"[\s._-]*(?:x|e(?:pisode)?)[\s._-]*(?P<episode>\d{1,3})\b",
    re.IGNORECASE,
)


def parse_episode_token(title: str) -> tuple[int, int] | None:
    """`(season, episode)` encoded in a candidate title, or None.

    Archive.org carries public-domain series as one item per episode, and the
    naming convention the rips settled on is `Show Name S01E02`, sometimes with
    a dot, a dash or a space between the two numbers. Reading the token out of
    the title is the only way to tell "the file for S01E02" from "the file for
    some other episode of the same show", because the catalog index has no
    season/episode columns of its own.
    """
    match = _EPISODE_TOKEN.search(title or "")
    if not match:
        return None
    season = int(match.group("season"))
    episode = int(match.group("episode"))
    if season < 1 or episode < 1:
        return None
    return season, episode


def episode_query(title: str, season: int, episode: int) -> str:
    """The title to search the catalog with when a specific episode is wanted."""
    return f"{title} S{int(season):02d}E{int(episode):02d}"


def accept_episode(candidate_title: str, season: int, episode: int) -> bool:
    """A candidate title names exactly the episode that was asked for.

    This is the guard that makes it safe to look up a series at all. Searching
    `The Twilight Zone S01E07` returns, among other things, the item for
    S01E01 -- `match_title` scores that a confident 0.7, because every word of
    the shorter title appears in the longer one. Accepting it would serve the
    wrong episode under the right title, which is worse than the embed this
    change is trying to avoid: the viewer cannot see the mistake until the
    episode plays.

    A candidate with no token at all is rejected too. A whole-season file is not
    the episode that was requested, and it cannot be seeked to the right one
    from here.
    """
    token = parse_episode_token(candidate_title)
    return token == (int(season), int(episode))


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
        if not accept_candidate(requested_year, doc.get("year"), score):
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


# Total wall-clock budget for one on-demand scrape.
#
# Worst case before this existed: one search (3 x 30s) plus five candidates,
# each a 3 x 30s metadata fetch and a 25s stream probe -- roughly ten minutes
# on a single worker. The client's fallback loop gave up long before that and
# retried, so a title with no Archive.org copy multiplied the cost. Bounding
# the whole search means "not on Archive.org" is answered in a predictable
# time, and the client can show that answer instead of spinning.
SCRAPE_BUDGET_SECONDS = 45


def scrape_title(
    title: str,
    rows: int = 12,
    attempts: int = 5,
    requested_year=None,
    budget_seconds: float = SCRAPE_BUDGET_SECONDS,
) -> dict | None:
    """Scrape a title on demand: search -> verify playable, trying ranked
    candidates until one resolves to a real, playable film. Only titles that
    confidently match (and agree on year) are accepted — never a look-alike.

    One shared deadline covers the search and every candidate, so the function
    has a hard upper bound rather than a per-call one that multiplies out."""
    query = title_query(title)
    if not query:
        return None
    deadline = time.monotonic() + max(1.0, float(budget_seconds))
    try:
        docs = discover_catalog(query, rows=rows, deadline=deadline)
    except Exception as error:  # noqa: BLE001 - degrade to "not found"
        log(f"on-demand search failed for {title!r}: {error}")
        return None
    if not docs:
        return None

    tried = 0
    for doc in pick_best_docs(docs, title, requested_year)[:attempts]:
        if time.monotonic() >= deadline:
            log(
                f"on-demand scrape for {title!r} hit its {budget_seconds:g}s "
                f"budget after {tried} candidate(s); stopping"
            )
            break
        identifier = str(doc.get("identifier", ""))
        if not identifier:
            continue
        tried += 1
        try:
            entry = build_entry_by_identifier(identifier, deadline=deadline)
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