"""
browser_resolver.py -- resolve a stream URL by rendering the provider page.

Every mainstream free-movie provider resolves its stream in the browser. Their
pages fetch a small JSON document that names the real m3u8, but the request
needs an id their `.wasm` module derives, so the URL cannot be reproduced with
plain HTTP -- which is why every hand-written extractor in `extractors.py`
returns nothing and why the app used iframes instead.

This module does what the browser does, headlessly, and returns the URL rather
than a frame. It runs one Chrome instance on a dedicated thread (Playwright's
sync API is not safe off the thread that created it) and answers over a queue,
so the Flask workers never touch Playwright directly.

The expensive part is only the id. Once `/api/b/movie/...` has been answered,
the rest is JSON we can read: `stream.playlist` is the m3u8, `stream.playlist
Headers` is what the CDN requires, and `stream.captions` is the subtitle list.
"""
from __future__ import annotations

import os
import queue
import re
import threading
import time
from dataclasses import dataclass, field

#: Cap on one render. The id and the playlist normally arrive inside a few
#: seconds; past this the page is an ad wrapper or a dead host.
RENDER_TIMEOUT = float(os.getenv("BROWSER_RENDER_TIMEOUT", "18"))
#: Playwright's sync API raises if used off the thread that started it, so the
#: browser lives on one thread for the life of the process.
_MAX_PENDING = 4

_MEDIA_RE = re.compile(r"https?://[^\s\"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s\"'<>\\]*)?", re.I)
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
#: Headless Chrome refuses to play media with sound unless told otherwise, and
#: a player that never starts never asks the CDN for anything -- so the resolver
#: would sit on a page that has the film loaded and report "no source".
#:
#: The autoplay policy is only there to get the element to start; the resolver
#: reads the provider's JSON off the wire and never watches or listens to the
#: page. Without `--mute-audio` that means every render plays the title out of
#: the machine's speakers, which is a surprising thing for a background lookup
#: to do. Muting costs nothing here: the segment requests are the same either
#: way, and detection does not depend on audible output.
_ARGS = [
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio",
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
]


@dataclass
class Rendered:
    playlist: str = ""
    headers: dict = field(default_factory=dict)
    captions: list[dict] = field(default_factory=list)
    referer: str = ""
    #: Direct `.mp4`/`.m3u8` seen on the wire, used when the JSON route is absent.
    observed: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.playlist or self.observed)


def _header_map(raw) -> dict:
    """Normalise `playlistHeaders`, which arrives as an object or a JSON string."""
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items() if isinstance(v, str)}
    if isinstance(raw, str) and raw.strip().startswith("{"):
        import json

        try:
            return _header_map(json.loads(raw))
        except ValueError:
            return {}
    return {}


class _Worker(threading.Thread):
    """Owns the browser and the queue. One Chrome, many callers."""

    def __init__(self):
        super().__init__(name="browser-resolver", daemon=True)
        self.jobs: queue.Queue = queue.Queue(maxsize=_MAX_PENDING)
        self._pw = None
        self._browser = None
        self._lock = threading.Lock()

    def run(self):
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            self._pw = pw
            try:
                self._browser = pw.chromium.launch(channel="chrome", headless=True, args=_ARGS)
            except Exception:
                # A system Chrome install is preferred (no 150 MB download), but
                # fall back to Playwright's own build so the resolver still works.
                self._browser = pw.chromium.launch(headless=True, args=_ARGS)
            while True:
                job = self.jobs.get()
                if job is None:
                    return
                url, result_queue, budget = job
                try:
                    result_queue.put(self._render(url, budget))
                except Exception as err:  # noqa: BLE001 - one bad page must not kill the thread
                    result_queue.put(Rendered())
                    print(f"[browser] {url[:70]}: {err}")

    def _render(self, url: str, budget: float) -> Rendered:
        ctx = self._browser.new_context(user_agent=_UA, viewport={"width": 1280, "height": 720})
        page = ctx.new_page()
        out = Rendered(referer=url)
        found = threading.Event()

        def on_response(response):
            try:
                target = response.url
            except Exception:  # noqa: BLE001 - a discarded response has no url
                return
            # Both kinds of title share this route. Matching only `/movie/`
            # made every series resolve to nothing -- the page fetched its
            # episode's JSON and the handler ignored it, so the caller saw a
            # clean miss for a title that was loaded and playable.
            if "/api/b/movie/" in target or "/api/b/tv/" in target:
                self._read_playlist(response, out, found)
            elif _MEDIA_RE.search(target):
                out.observed.append(target)
                found.set()

        page.on("response", on_response)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=budget * 1000)
            deadline = time.time() + budget
            while not found.is_set() and time.time() < deadline:
                page.wait_for_timeout(200)
        finally:
            ctx.close()
        return out

    @staticmethod
    def _read_playlist(response, out: Rendered, found) -> None:
        """Pull `stream.playlist` (and friends) out of the provider's JSON."""
        try:
            if response.status != 200:
                return
            data = response.json()
        except Exception:  # noqa: BLE001 - an ad tag answering the same path is not our problem
            return
        stream = (data or {}).get("stream")
        if not isinstance(stream, dict):
            return
        playlist = stream.get("playlist") or stream.get("file") or stream.get("url")
        if isinstance(playlist, str) and playlist.startswith("http"):
            out.playlist = playlist
            out.headers = _header_map(
                stream.get("playlistHeaders") or stream.get("headers")
            )
            captions = stream.get("captions")
            if isinstance(captions, list):
                out.captions = [
                    {"url": c.get("url"), "label": c.get("language") or c.get("label") or "sub"}
                    for c in captions
                    if isinstance(c, dict) and isinstance(c.get("url"), str)
                ]
            found.set()


_worker: _Worker | None = None
_worker_lock = threading.Lock()


def _ensure_worker() -> _Worker:
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = _Worker()
            _worker.start()
        return _worker


def render(url: str, budget: float = RENDER_TIMEOUT) -> Rendered:
    """Render `url` and return the stream it names, or an empty `Rendered`.

    Bounded on both sides: the queue only accepts `_MAX_PENDING` jobs, so a
    burst of resolves cannot pile up browsers behind one slow page, and the
    render itself stops at `budget`.
    """
    worker = _ensure_worker()
    results: queue.Queue = queue.Queue(maxsize=1)
    try:
        worker.jobs.put((url, results, budget), timeout=budget)
    except queue.Full:
        return Rendered()
    try:
        return results.get(timeout=budget + 5)
    except queue.Empty:
        return Rendered()
