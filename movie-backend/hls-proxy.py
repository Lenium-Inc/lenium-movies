"""
hls_proxy.py — same-origin HLS relay for the player.

  GET /api/proxy/manifest?url=...&referer=...   fetch + rewrite + return
  GET /api/proxy/segment?url=...&referer=...    stream bytes (Range aware)
  GET /api/proxy/subtitle?url=...&referer=...   any-host subtitle -> WebVTT

Rewrites segment lines AND URI="..." attributes (EXT-X-KEY / EXT-X-MAP /
EXT-X-MEDIA) so AES keys and fMP4 init maps route back through us too.
"""
from __future__ import annotations

import re
import urllib.parse

import requests
from flask import Blueprint, Response, request, stream_with_context

from proxy_util import playable  # noqa: F401  (re-exported)

hls_bp = Blueprint("hls_proxy", __name__)

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_URI_ATTR = re.compile(r'(URI=")([^"]+)(")')


def _headers(referer: str = "") -> dict:
    h = {"User-Agent": BROWSER_UA, "Accept": "*/*"}
    if referer:
        h["Referer"] = referer
        parsed = urllib.parse.urlparse(referer)
        if parsed.scheme and parsed.netloc:
            h["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
    return h


def _proxify(uri: str, manifest_url: str, referer: str) -> str:
    absolute = urllib.parse.urljoin(manifest_url, uri)
    params = {"url": absolute}
    if referer:
        params["referer"] = referer
    route = (
        "/api/proxy/manifest"
        if urllib.parse.urlparse(absolute).path.lower().endswith(".m3u8")
        else "/api/proxy/segment"
    )
    return f"{route}?{urllib.parse.urlencode(params)}"


def _rewrite(text: str, manifest_url: str, referer: str) -> str:
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
        elif s.startswith("#"):
            out.append(
                _URI_ATTR.sub(
                    lambda m: m.group(1)
                    + _proxify(m.group(2), manifest_url, referer)
                    + m.group(3),
                    line,
                )
            )
        else:
            out.append(_proxify(s, manifest_url, referer))
    return "\n".join(out)


@hls_bp.route("/api/proxy/manifest", methods=["GET"])
def proxy_manifest():
    url = request.args.get("url")
    referer = request.args.get("referer", "")
    if not url:
        return {"error": "missing url"}, 400
    try:
        up = requests.get(url, headers=_headers(referer), timeout=10)
    except requests.exceptions.RequestException as e:
        return {"error": f"manifest fetch failed: {e}"}, 502
    if up.status_code != 200:
        return {"error": f"upstream {up.status_code}"}, 502
    return Response(
        _rewrite(up.text, url, referer),
        content_type="application/vnd.apple.mpegurl",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"},
    )


@hls_bp.route("/api/proxy/segment", methods=["GET"])
def proxy_segment():
    url = request.args.get("url")
    referer = request.args.get("referer", "")
    if not url:
        return {"error": "missing url"}, 400
    fwd = _headers(referer)
    if request.headers.get("Range"):
        fwd["Range"] = request.headers["Range"]
    try:
        up = requests.get(url, headers=fwd, stream=True, timeout=15)
    except requests.exceptions.RequestException as e:
        return {"error": f"segment fetch failed: {e}"}, 502
    headers = {
        "Content-Type": up.headers.get("Content-Type", "video/mp2t"),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    }
    for h in ("Content-Length", "Content-Range"):
        if h in up.headers:
            headers[h] = up.headers[h]
    return Response(
        stream_with_context(up.iter_content(64 * 1024)),
        status=up.status_code,
        headers=headers,
    )


@hls_bp.route("/api/proxy/subtitle", methods=["GET"])
def proxy_subtitle():
    """Any-host subtitle relay, converted to WebVTT. Provider captions live on
    arbitrary CDNs, so this deliberately does NOT use the archive allowlist."""
    from catalog_lib import srt_to_vtt

    url = request.args.get("url")
    referer = request.args.get("referer", "")
    if not url:
        return {"error": "missing url"}, 400
    try:
        up = requests.get(url, headers=_headers(referer), timeout=10)
    except requests.exceptions.RequestException as e:
        return {"error": f"subtitle fetch failed: {e}"}, 502
    if up.status_code != 200:
        return {"error": f"upstream {up.status_code}"}, 502

    text = up.text
    if not text.lstrip("\ufeff").lstrip().upper().startswith("WEBVTT"):
        text = srt_to_vtt(text)
    return Response(
        text,
        content_type="text/vtt; charset=utf-8",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300"},
    )