"""
extractors.py — server-side stream extraction (the "real source" tier).

Turns a TMDB id into a directly-playable HLS/MP4 URL with real quality levels
and subtitle tracks, so the custom player owns quality / subs / speed.

Hard rule: the whole chain is bounded by EXTRACTOR_BUDGET_SECONDS. A slow
provider can never hang a resolve -- when the budget is spent the chain stops
and the caller falls back to embeds.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass, field

import requests

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
TIMEOUT = float(os.getenv("EXTRACTOR_TIMEOUT", "7"))
#: One render needs room to load a page, run a wasm module and receive the
#: playlist document. Nine seconds -- the old chain budget -- is not enough for
#: that, and cutting a render off mid-flight wastes the whole attempt rather
#: than half of it.
BUDGET = float(os.getenv("EXTRACTOR_BUDGET_SECONDS", "25"))
#: Hard ceiling on a single page render, independent of the chain budget.
BROWSER_RENDER_TIMEOUT = float(os.getenv("BROWSER_RENDER_TIMEOUT_SECONDS", "16"))
#: An embed page is kilobytes. Past this the fetch is not a page and reading
#: it whole would be an allocation primitive reachable from a third party.
MAX_BODY_BYTES = 2 * 1024 * 1024
CACHE_TTL = 1800
MISS_TTL = 300
MAX_DEPTH = 2

_M3U8 = re.compile(r'https?://[^\s"\'<>\\]+?\.m3u8[^\s"\'<>\\]*')
_MP4 = re.compile(r'https?://[^\s"\'<>\\]+?\.mp4[^\s"\'<>\\]*')
_JSON_URL = re.compile(
    r'["\'](?:file|source|url|playlist|src|link)["\']\s*:\s*["\']([^"\']+\.(?:m3u8|mp4)[^"\']*)["\']'
)
_IFRAME = re.compile(r'<iframe[^>]+src=["\']([^"\']+)["\']')
_TXT = re.compile(r'https?://[^\s"\']+?\.txt[^\s"\']*')
_PACKER = re.compile(
    r"eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)",
    re.S,
)


@dataclass
class Extraction:
    provider: str
    streams: list[dict] = field(default_factory=list)
    subtitles: list[dict] = field(default_factory=list)
    referer: str = ""


class BudgetSpent(Exception):
    """Raised when a chain's wall-clock budget is gone.

    Carried out of `_get` so an extractor that is mid-flight abandons the rest
    of its work instead of finishing a page full of requests nobody will read.
    """


_local = threading.local()


def _remaining() -> float:
    """Seconds left in this chain's budget, or `TIMEOUT` outside one.

    Thread-local because gunicorn runs the app multi-threaded and two
    concurrent resolves must not share a deadline.
    """
    deadline = getattr(_local, "deadline", None)
    if deadline is None:
        return TIMEOUT
    return deadline - time.time()


class _Fetched:
    """A response whose body is already in memory.

    Returned instead of the live `requests.Response`: the body is read in a
    worker thread under a wall clock, and a live response would be a socket
    still attached to a deadline that has already passed.
    """

    __slots__ = ("status_code", "content", "text")

    def __init__(self, status_code: int, content: bytes):
        self.status_code = status_code
        self.content = content
        self.text = content.decode("utf-8", errors="replace")

    def json(self):
        return json.loads(self.text)


def _fetch(url: str, headers: dict, cap: float, deadline: float):
    """Do one HTTP fetch. Runs in a worker thread.

    `cap` bounds each socket operation and `deadline` bounds the body read.
    Neither can stop a hung DNS lookup -- `requests` does not apply its
    timeout to `getaddrinfo`, and nothing in the stdlib does either -- which is
    why the caller abandons this thread rather than joining it forever.
    """
    with requests.get(
        url, headers=headers, timeout=(min(5.0, cap), cap), stream=True
    ) as upstream:
        if upstream.status_code != 200:
            return None
        chunks: list[bytes] = []
        size = 0
        for chunk in upstream.iter_content(64 * 1024):
            if not chunk:
                continue
            if time.time() >= deadline:
                break
            size += len(chunk)
            if size > MAX_BODY_BYTES:
                break
            chunks.append(chunk)
    return _Fetched(200, b"".join(chunks))


#: Abandoned threads still sitting in a DNS lookup or a dead socket. Bounded
#: so a provider that hangs on purpose cannot turn the backend into a source
#: of unbounded threads.
_MAX_ABANDONED = 8
_abandoned = 0
_abandoned_lock = threading.Lock()


def _spare_thread() -> bool:
    global _abandoned
    with _abandoned_lock:
        if _abandoned >= _MAX_ABANDONED:
            return False
        _abandoned += 1
    return True


def _reclaim() -> None:
    global _abandoned
    with _abandoned_lock:
        _abandoned = max(0, _abandoned - 1)


def _get(url: str, referer: str = "", timeout: float | None = None):
    """One bounded fetch. Returns the response, or None.

    Four ceilings apply and the tightest one wins:

    - the caller's `timeout`;
    - whatever is left of the chain budget;
    - `MAX_BODY_BYTES`, because an embed page is kilobytes and anything much
      larger is not one;
    - `_MAX_ABANDONED`, because a hung lookup has to cost *something*.

    The real work happens in a worker thread that is joined for at most the
    budget and then abandoned. `requests`' own `timeout` is per socket
    operation and does not cover DNS, so a provider that resolves nothing --
    or dribbles a byte a second -- can hold a worker open far past any timeout
    it was given. Abandoning the thread is the only way to make the budget a
    wall clock rather than a suggestion.
    """
    left = _remaining()
    if left <= 0:
        raise BudgetSpent
    cap = min(timeout if timeout is not None else TIMEOUT, left)
    if not _spare_thread():
        raise BudgetSpent

    h = {"User-Agent": UA, "Accept": "*/*"}
    if referer:
        h["Referer"] = referer
    deadline = min(time.time() + cap, _local.deadline) if getattr(_local, "deadline", None) else time.time() + cap
    box: dict = {}

    def run():
        try:
            box["res"] = _fetch(url, h, cap, deadline)
        except requests.exceptions.RequestException:
            box["res"] = None
        except Exception as err:  # noqa: BLE001
            box["err"] = err

    worker = threading.Thread(target=run, daemon=True, name="extractor-fetch")
    worker.start()
    worker.join(cap + 0.25)
    if worker.is_alive():
        # Abandoned: the thread keeps its socket and its daemon flag, so it
        # dies with the process and holds nothing open on our side.
        raise BudgetSpent
    _reclaim()
    if "err" in box:
        return None
    return box.get("res")


def _abs(base: str, u: str) -> str:
    return "https:" + u if u.startswith("//") else urllib.parse.urljoin(base, u)


def _label(height) -> str:
    if not height:
        return "Auto"
    try:
        n = int(height)
    except (TypeError, ValueError):
        return str(height)
    for floor, name in ((4000, "8K"), (2000, "4K"), (1080, "1080p"), (720, "720p"),
                        (480, "480p"), (360, "360p")):
        if n >= floor:
            return name
    return f"{n}p"


def _order(label: str) -> int:
    return {"8K": 0, "4K": 1, "1080p": 2, "720p": 3, "480p": 4, "360p": 5}.get(label, 9)


def _sort_streams(streams: list[dict]) -> list[dict]:
    seen, out = set(), []
    for s in sorted(streams, key=lambda s: _order(s.get("label", "Auto"))):
        if s["url"] not in seen:
            seen.add(s["url"])
            out.append(s)
    return out


def _unpack(script: str) -> str:
    m = _PACKER.search(script)
    if not m:
        return script
    payload, _, _, keys = m.groups()
    keys = keys.split("|")

    def repl(mo):
        w = mo.group(0)
        if w.isdigit() and int(w) < len(keys) and keys[int(w)]:
            return keys[int(w)]
        return w

    return re.sub(r"\b\w+\b", repl, payload)


def _scrape(text: str) -> list[str]:
    urls = _M3U8.findall(text) + _MP4.findall(text)
    urls += [m.group(1) for m in _JSON_URL.finditer(text)]
    seen, out = set(), []
    for u in urls:
        u = u.replace("\\/", "/")
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _variants(master_text: str, master_url: str) -> list[dict]:
    out, lines = [], master_text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF:"):
            continue
        m = re.search(r"RESOLUTION=\d+x(\d+)", line)
        label = _label(m.group(1) if m else None)
        for nxt in lines[i + 1:]:
            if nxt and not nxt.startswith("#"):
                out.append({"url": urllib.parse.urljoin(master_url, nxt.strip()), "label": label})
                break
    return out


def _streams_from(url: str, referer: str) -> list[dict]:
    if ".m3u8" not in url.lower():
        return [{"url": url, "label": "Auto", "referer": referer}]
    r = _get(url, referer=referer)
    if r and "#EXT-X-STREAM-INF" in r.text:
        v = _variants(r.text, url)
        if v:
            # The master playlist itself goes first, carrying the best rung's
            # label so it wins the sort and becomes the default stream. Handing
            # the client the master (rather than only its children) is what
            # gives hls.js the whole ladder -- every rung, including 4K/8K --
            # plus the EXT-X-MEDIA audio groups a dubbed film needs. The split
            # children stay behind it as failover candidates for source
            # cycling: they cost nothing and still work if the master route
            # ever fails for a host.
            best = min(v, key=lambda s: _order(s.get("label", "Auto")))
            master = {"url": url, "label": best.get("label") or "Auto", "referer": referer}
            return [master] + [dict(x, referer=referer) for x in v]
    return [{"url": url, "label": "Auto", "referer": referer}]


def _json_streams(data) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if isinstance(v, str) and (".m3u8" in v or ".mp4" in v):
                    found.append((str(k), v))
                else:
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return found


def _json_subs(data, base: str) -> list[dict]:
    out = []

    def walk(node):
        if isinstance(node, dict):
            u = node.get("url") or node.get("file") or node.get("src")
            if isinstance(u, str) and any(x in u for x in (".vtt", ".srt", ".ass")):
                lang = (node.get("lang") or node.get("language")
                        or node.get("label") or node.get("id") or "sub")
                out.append({"url": _abs(base, u), "label": str(lang)})
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return out


def _json_extract(name: str, api_url: str, referer: str):
    r = _get(api_url, referer=referer)
    if not r:
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    pairs = _json_streams(data)
    if not pairs:
        return None
    streams = [{"url": _abs(api_url, u), "label": _label(k), "referer": referer}
               for k, u in pairs]
    return Extraction(name, _sort_streams(streams), _json_subs(data, api_url), referer)


def _deep_scrape(page_url: str, referer: str, depth: int = MAX_DEPTH) -> list[str]:
    if _remaining() <= 0:
        raise BudgetSpent
    r = _get(page_url, referer=referer)
    if not r:
        return []
    found = _scrape(r.text)
    if found:
        return found
    unpacked = _unpack(r.text)
    if unpacked != r.text:
        found = _scrape(unpacked)
        if found:
            return found
    if depth <= 0:
        return []
    for txt in _TXT.findall(r.text)[:2]:
        if _remaining() <= 0:
            raise BudgetSpent
        j = _get(txt, referer=page_url)
        if j:
            found = _scrape(j.text) or _scrape(_unpack(j.text))
            if found:
                return found
    for src in _IFRAME.findall(r.text)[:3]:
        found = _deep_scrape(_abs(page_url, src), page_url, depth - 1)
        if found:
            return found
    return []


def _generic(name: str, page_url: str, referer: str):
    found = _deep_scrape(page_url, referer)
    if not found:
        return None
    streams: list[dict] = []
    for u in found:
        streams += _streams_from(u, referer)
    return Extraction(name, _sort_streams(streams), [], referer)


# --------------------------------------------------------------------------- #
#  Per-provider extractors                                                     #
# --------------------------------------------------------------------------- #
def extract_vidlink(tmdb_id, media_type, season, episode, title=""):
    base, ref = "https://vidlink.pro", "https://vidlink.pro/"
    api = (f"{base}/api/b/tv/{tmdb_id}/{season}/{episode}" if media_type == "tv"
           else f"{base}/api/b/movie/{tmdb_id}")
    r = _get(api, referer=ref)
    if not r:
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    # A 200 with a `null` body is a real answer ("this title has nothing"), not
    # a transport failure -- and it is the shape this endpoint actually sends
    # when it has no source, so it has to be checked before anything is read
    # off the payload.
    if not isinstance(data, dict):
        return None
    stream = data.get("stream") or {}
    if not isinstance(stream, dict):
        return None
    streams: list[dict] = []
    if stream.get("playlist"):
        streams += _streams_from(stream["playlist"], ref)
    for q, u in (stream.get("qualities") or {}).items():
        if u and u not in [s["url"] for s in streams]:
            streams.append({"url": u, "label": _label(q), "referer": ref})
    subs = [{"url": c["url"], "label": c.get("language") or c.get("id") or "sub"}
            for c in (stream.get("captions") or []) if c.get("url")]
    return Extraction("vidlink", _sort_streams(streams), subs, ref) if streams else None


def extract_vidsrc_wtf(tmdb_id, media_type, season, episode, title=""):
    ref = "https://vidsrc.wtf/"
    api = (f"https://vidsrc.wtf/api/1/tv/?id={tmdb_id}&s={season}&e={episode}" if media_type == "tv"
           else f"https://vidsrc.wtf/api/1/movie/?id={tmdb_id}")
    return _json_extract("vidsrc-wtf", api, ref)


def extract_multiembed(tmdb_id, media_type, season, episode, title=""):
    base, ref = "https://multiembed.mov", "https://multiembed.mov/"
    q = f"video_id={tmdb_id}&tmdb=1" + (f"&s={season}&e={episode}" if media_type == "tv" else "")
    r = _get(f"{base}/directstream.php?{q}", referer=ref)
    if not r:
        return None
    url = None
    try:
        data = r.json()
        url = data.get("file") or data.get("source") or data.get("url")
    except ValueError:
        pass
    if not url:
        m = _M3U8.search(r.text) or _MP4.search(r.text)
        url = m.group(0) if m else None
    return Extraction("multiembed", _streams_from(url, ref), [], ref) if url else None


def extract_111movies(tmdb_id, media_type, season, episode, title=""):
    page = (f"https://111movies.com/tv/{tmdb_id}/{season}/{episode}" if media_type == "tv"
            else f"https://111movies.com/movie/{tmdb_id}")
    return _generic("111movies", page, "https://111movies.com/")


def extract_vidlink(tmdb_id, media_type, season, episode, title=""):
    """Render the provider page and read the playlist it names.

    Every hand-written extractor in this file fails against the same wall, and
    it is worth being precise about why: the provider derives an opaque id with
    a `.wasm` module, asks its own API for the stream URL, and only then plays
    it. There is no plain-HTTP path to that id, so a regex over a fetched page
    finds nothing -- which is why this chain returned no source for every modern
    film and why the app shipped iframes instead.

    Rendering the page is the only way to get the URL out, and getting the URL
    out is the whole difference: the player then owns quality, seeking and
    subtitles on a real media element rather than handing the tab to a frame.
    """
    import browser_resolver

    page = (
        f"https://vidlink.pro/tv/{tmdb_id}/{season}/{episode}"
        if media_type == "tv"
        else f"https://vidlink.pro/movie/{tmdb_id}"
    )
    budget = min(BROWSER_RENDER_TIMEOUT, max(1.0, _remaining()))
    rendered = browser_resolver.render(page, budget=budget)
    url = rendered.playlist or (rendered.observed[0] if rendered.observed else "")
    if not url:
        return None
    streams = [{
        "url": url,
        "label": "Auto",
        "referer": rendered.referer,
        # The CDN answers only for a signed Cookie/Origin pair the player is
        # never allowed to hold. Carried on the stream so the handle can
        # reapply it at relay time.
        "headers": rendered.headers,
    }]
    subs = [
        {"url": c["url"], "label": c.get("label") or "sub", "headers": rendered.headers}
        for c in rendered.captions
        if c.get("url")
    ]
    return Extraction("vidlink", streams, subs, rendered.referer)


def extract_vidsrc_cc(tmdb_id, media_type, season, episode, title=""):
    page = (f"https://vidsrc.cc/v2/embed/tv/{tmdb_id}/{season}/{episode}" if media_type == "tv"
            else f"https://vidsrc.cc/v2/embed/movie/{tmdb_id}")
    return _generic("vidsrc-cc", page, "https://vidsrc.cc/")


def extract_vidsrc_xyz(tmdb_id, media_type, season, episode, title=""):
    page = (f"https://vidsrc.xyz/embed/tv?tmdb={tmdb_id}&season={season}&episode={episode}"
            if media_type == "tv" else f"https://vidsrc.xyz/embed/movie?tmdb={tmdb_id}")
    return _generic("vidsrc-xyz", page, "https://vidsrc.xyz/")


def extract_2embed(tmdb_id, media_type, season, episode, title=""):
    page = (f"https://www.2embed.cc/embedtv/{tmdb_id}&s={season}&e={episode}" if media_type == "tv"
            else f"https://www.2embed.cc/embed/{tmdb_id}")
    return _generic("2embed", page, "https://www.2embed.cc/")


def extract_smashy(tmdb_id, media_type, season, episode, title=""):
    page = (f"https://smashy.stream/tv/{tmdb_id}?s={season}&e={episode}" if media_type == "tv"
            else f"https://smashy.stream/movie/{tmdb_id}")
    return _generic("smashy", page, "https://smashy.stream/")


def extract_vidora(tmdb_id, media_type, season, episode, title=""):
    page = (f"https://vidora.su/tv/{tmdb_id}/{season}/{episode}" if media_type == "tv"
            else f"https://vidora.su/movie/{tmdb_id}")
    return _generic("vidora", page, "https://vidora.su/")


def extract_autoembed(tmdb_id, media_type, season, episode, title=""):
    page = (f"https://player.autoembed.cc/embed/tv/{tmdb_id}/{season}/{episode}" if media_type == "tv"
            else f"https://player.autoembed.cc/embed/movie/{tmdb_id}")
    return _generic("autoembed", page, "https://player.autoembed.cc/")


#: Default chain. Only `vidlink` is listed, and that is a measurement rather
#: than a preference: every other provider here was probed by hand *and*
#: rendered in a real browser, and none of them produced a stream URL.
#: vidsrc.pro and embed.su no longer resolve; 2embed, vidsrc.cc, vidsrc.xyz,
#: smashy, vidora, autoembed and multiembed load a player that names no media;
#: 111movies no longer resolves at all and used to hang the chain on DNS.
#: Leaving them in would spend the whole budget rediscovering that, so they
#: stay defined (and reachable through EXTRACTOR_ORDER) but out of the path.
_DEFAULT_CHAIN = [
    ("vidlink", extract_vidlink),
    ("vidsrc-wtf", extract_vidsrc_wtf),
    ("multiembed", extract_multiembed),
    ("111movies", extract_111movies),
    ("vidsrc-cc", extract_vidsrc_cc),
    ("2embed", extract_2embed),
    ("vidsrc-xyz", extract_vidsrc_xyz),
    ("smashy", extract_smashy),
    ("vidora", extract_vidora),
    ("autoembed", extract_autoembed),
]
_DEFAULT_CHAIN = _DEFAULT_CHAIN[:1]


def _chain():
    order = [x.strip() for x in os.getenv("EXTRACTOR_ORDER", "").split(",") if x.strip()]
    disabled = {x.strip() for x in os.getenv("EXTRACTOR_DISABLED", "").split(",") if x.strip()}
    by_name = dict(_DEFAULT_CHAIN)
    seq = ([(n, by_name[n]) for n in order if n in by_name]
           + [(n, f) for n, f in _DEFAULT_CHAIN if n not in order]) if order else list(_DEFAULT_CHAIN)
    return [(n, f) for n, f in seq if n not in disabled]


_cache: dict[str, tuple[float, float, "Extraction | None"]] = {}
_lock = threading.Lock()


def extract_chain(tmdb_id, media_type="movie", season=1, episode=1, title="", budget=None):
    """First extractor to yield a stream wins, hard-bounded by `budget` seconds.

    The budget is a wall clock, not a hint. It is installed on the thread
    before the first extractor runs and every fetch inside the chain reads it,
    so a provider that dribbles bytes, follows five iframes, or simply never
    answers still costs the chain at most `budget` -- and the caller gets its
    answer back in that time rather than in whatever the slowest provider
    felt like.
    """
    key = f"{media_type}:{tmdb_id}:{season}:{episode}"
    with _lock:
        rec = _cache.get(key)
    if rec and (time.time() - rec[0]) < rec[1]:
        return rec[2]

    _local.deadline = time.time() + (budget or BUDGET)
    try:
        for name, fn in _chain():
            if _remaining() <= 0:
                break
            try:
                res = fn(tmdb_id, media_type, season, episode, title)
            except BudgetSpent:
                break
            except Exception as err:  # noqa: BLE001
                print(f"[extractors] {name}: {err}")
                res = None
            if res and res.streams:
                with _lock:
                    _cache[key] = (time.time(), CACHE_TTL, res)
                print(f"[extractors] {key} -> {name} ({len(res.streams)} qualities)")
                return res
    finally:
        _local.deadline = None

    with _lock:
        _cache[key] = (time.time(), MISS_TTL, None)
    print(f"[extractors] {key} -> no source")
    return None