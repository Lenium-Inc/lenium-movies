"""proxy_util.py — shared URL rewriting helpers (no Flask import)."""
from __future__ import annotations

import urllib.parse


def playable(url: str, referer: str = "") -> str:
    """Route an .m3u8 through the manifest proxy; leave other URLs alone.
    Idempotent: a URL already on /api/proxy/... passes through untouched."""
    if not url:
        return url
    if urllib.parse.urlparse(url).path.lower().endswith(".m3u8"):
        return "/api/proxy/manifest?" + urllib.parse.urlencode(
            {"url": url, "referer": referer}
        )
    return url


def playable_sub(url: str, referer: str = "") -> str:
    """Route a subtitle file through the subtitle proxy (any host)."""
    if not url:
        return url
    return "/api/proxy/subtitle?" + urllib.parse.urlencode(
        {"url": url, "referer": referer}
    )