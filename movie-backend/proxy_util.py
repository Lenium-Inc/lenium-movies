"""proxy_util.py — same-origin playback handles for resolved media.

`stream_providers` resolves a title to raw upstream URLs. Those URLs never
reach the client: each one is exchanged here for a handle minted by
`playback_tokens`, and the client is handed only the matching same-origin
route. The Referer an upstream origin requires rides along inside the handle,
so the relay can present it while the wire never carries it -- which is the
whole reason the exchange happens server-side.

Two shapes exist and container decides which:

- HLS goes behind `/api/proxy/manifest`, whose rewrite points every URI inside
  the playlist at `/api/proxy/segment` on the same handle -- so the ladder, its
  decryption keys and its alternate renditions all stay on our origin.
- Anything progressive goes behind `/api/v1/playback/media`, which passes
  `Range` through so seeking is a real seek rather than a full re-download.

Captions are the third case and the reason this module exists separately from
app.py: provider caption files live on CDNs that are deliberately not on the
archive allowlist, so they need their own relay (`/api/proxy/subtitle`).
"""
from __future__ import annotations

import urllib.parse

import playback_tokens

#: The handle route for a progressive file. Read back off a handle to recover
#: `format`, because a handle is an opaque path and its suffix carries nothing.
MEDIA_ROUTE = "/api/v1/playback/media"
#: The handle route for an HLS entry playlist.
MANIFEST_ROUTE = "/api/proxy/manifest"
#: The handle route for a DASH MPD.
DASH_MANIFEST_ROUTE = "/api/proxy/dash"
#: The handle route for a caption file.
SUBTITLE_ROUTE = "/api/proxy/subtitle"

#: Upstream origins that answer a playlist request only when a particular
#: `Cookie`/`Origin`/`Referer` set accompanies it. The player cannot send these
#: (they are not its to know, and a browser refuses a cross-origin Cookie), so
#: they ride inside the handle and are applied by the relay. Bounded to a fixed
#: key set: a handle is minted by our own resolver, but a header name that
#: reached this map from anywhere else would turn the relay into a request
#: forger.
_ALLOWED_UPSTREAM_HEADERS = frozenset({
    "cookie", "origin", "referer", "accept", "accept-language", "authorization",
})


def normalize_upstream_headers(raw) -> dict[str, str]:
    """Keep only relay-safe upstream headers, as a plain str->str map."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in list(raw.items())[:8]:
        name = str(key).strip()
        if name.lower() not in _ALLOWED_UPSTREAM_HEADERS:
            continue
        if not isinstance(value, str) or len(value) > 4096:
            continue
        out[name] = value
    return out


def upstream_headers_of(entry: dict | None) -> dict[str, str]:
    """Recover the upstream headers a handle was minted with, or {}."""
    if not entry:
        return {}
    meta = entry.get("meta")
    if not isinstance(meta, dict):
        return {}
    return normalize_upstream_headers(meta.get("headers"))


def stream_format(url: str) -> str:
    """`"hls"`, `"dash"` or `"mp4"` -- what the player must load, by container.

    Only the path is trustworthy: an `.m3u8` needs hls.js, an `.mpd` needs a
    DASH player, anything else is progressive. Query strings are ignored on
    purpose -- a cache-buster or a signed token in the query must not be able to
    change the answer.
    """
    path = urllib.parse.urlparse(url or "").path.lower()
    if path.endswith((".m3u8", ".m3u")):
        return "hls"
    if path.endswith(".mpd"):
        return "dash"
    return "mp4"


def format_of_handle(play_url: str) -> str:
    """`format` for a handle this module (or `_play_url`) just minted.

    Handles are opaque paths, so the container is read off the route the handle
    names rather than the URL's suffix -- which carries none. Any path this
    module does not recognise is progressive, the safe default: a mislabelled
    HLS or DASH playlist fails loudly in the player, a mislabelled MP4 would be
    silently unseekable.
    """
    path = urllib.parse.urlparse(play_url or "").path
    if path == MANIFEST_ROUTE:
        return "hls"
    if path == DASH_MANIFEST_ROUTE:
        return "dash"
    return "mp4"


def _is_archive_url(url: str) -> bool:
    """Whether `url` is one the archive allowlist would already admit.

    Decides only whether a media handle needs the `any_host` escape hatch. The
    check is imported lazily because `catalog_lib` is heavy and this module is
    imported on every resolution path.
    """
    try:
        import catalog_lib
    except Exception:  # noqa: BLE001 - no allowlist available == assume off-list
        return False
    try:
        catalog_lib.validate_archive_url(url, require_download_path=True)
    except Exception:  # noqa: BLE001 - rejected by the allowlist == off-list
        return False
    return True


def playable(url: str, referer: str = "", headers: dict | None = None) -> str:
    """A same-origin handle for `url`, or "" when there is nothing to handle.

    Never returns `url` itself. A caller that hands this an empty string gets
    an empty string back, so a resolution with a blank stream entry degrades to
    "no source" rather than to a raw third-party URL in the payload.

    `headers` are the extras the upstream CDN insists on (a signed CloudFront
    `Cookie`, an `Origin`). They cannot ride on the wire -- the browser would
    strip a cross-origin Cookie before it left -- so they are stored on the
    handle and reapplied by the relay.
    """
    if not url:
        return ""
    extra = normalize_upstream_headers(headers)
    container = stream_format(url)
    if container == "hls":
        token = playback_tokens.issue(
            playback_tokens.KIND_PROXY, url, referer=referer or "",
            meta={"headers": extra} if extra else None,
        )
        return f"{MANIFEST_ROUTE}?token={token}"
    if container == "dash":
        token = playback_tokens.issue(
            playback_tokens.KIND_PROXY, url, referer=referer or "",
            meta={"headers": extra} if extra else None,
        )
        return f"{DASH_MANIFEST_ROUTE}?token={token}"
    # A progressive file off the archive allowlist is served by the existing
    # archive relay unchanged. Anything else needs the media route to know it
    # is stepping outside that allowlist, which the route would otherwise
    # refuse -- and the handle being unforgeable is what makes that safe.
    meta: dict = {} if _is_archive_url(url) else {"any_host": True}
    if extra:
        meta["headers"] = extra
    token = playback_tokens.issue(
        playback_tokens.KIND_MEDIA, url, referer=referer or "", meta=meta
    )
    return f"{MEDIA_ROUTE}?token={token}"


def playable_sub(url: str, referer: str = "", headers: dict | None = None) -> str:
    """A same-origin caption handle for `url`, or "" when `url` is empty.

    Always `any_host`: a caption file's CDN is never on the archive allowlist,
    and a caption route that only reached archive.org would return every
    provider-sourced track as a 400 with no way for the player to tell why.
    """
    if not url:
        return ""
    extra = normalize_upstream_headers(headers)
    token = playback_tokens.issue(
        playback_tokens.KIND_CAPTION,
        url,
        referer=referer or "",
        meta={"any_host": True, **({"headers": extra} if extra else {})},
    )
    return f"{SUBTITLE_ROUTE}?track={token}"


def raw_url_of(play_url: str) -> str | None:
    """Recover the upstream URL a handle was minted for, or None.

    Only for handles this process just minted in the same request: the handle
    store is the authority, and a handle the caller did not mint may name a
    URL this process has no business relaying. Used to apply server-side
    decisions (the trailer guard, the download allowlist) that need the URL
    after it has already left the response.
    """
    if not play_url:
        return None
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(play_url).query)
    except ValueError:
        return None
    for key in ("token", "track"):
        values = query.get(key)
        if not values or not values[0]:
            continue
        entry = playback_tokens.resolve(values[0])
        if entry is not None:
            return entry["url"]
    return None
