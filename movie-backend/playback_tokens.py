"""Opaque playback handles: the only way a third-party origin leaves this process.

Every URL the client is allowed to fetch -- a manifest, a chunk, a progressive
file, an embed frame, a caption asset -- is minted here first. The client is
handed a random handle; the handle maps to its target inside this process. The
consequences are the whole point:

- The API payload never carries a third-party domain, so nothing in a response
  names a host the platform does not control. A handle is meaningless without
  this process's memory, which is also why it is not a signed token: a signed
  token has to *contain* the URL to be useful, and base64 is not encryption.
- A handle can only be minted by server code that already resolved the target,
  so a client cannot turn the playback routes into a general-purpose fetcher.
- The map is bounded and time-living (a `TTLCache` with a hard `maxsize` and a
  two-hour TTL). A flood of init calls evicts the oldest handles instead of
  growing the table, and an abandoned handle expires rather than pinning a
  target -- which matters on a box with a fixed memory budget.

Handles are validated on both ends: issuance refuses unknown kinds, and
resolution refuses anything that is not shaped like one of ours before it ever
touches the cache, so a malformed `?token=` costs a regex match and nothing
else.
"""

from __future__ import annotations

import re
import secrets
import threading
import time
from urllib.parse import urlparse

from cachetools import TTLCache

#: How long a handle stays valid. Long enough to cover a film plus a reseek
#: session; short enough that a leaked handle stops working within an evening.
HANDLE_TTL_SECONDS = 2 * 60 * 60

#: Hard ceiling on live handles. `TTLCache` evicts least-recently-used on
#: overflow, so the worst case is a fixed table regardless of traffic.
HANDLE_MAX_SIZE = 4096

#: Shape of a handle as issued: URL-safe base64 from `token_urlsafe(24)`.
#: Checked before lookup so garbage input never reaches the cache, and bounded
#: so a huge query string cannot be turned into a huge lookup key.
HANDLE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")

#: What a handle may point at. The kind is stored on the entry and re-checked
#: on resolution, so a proxy handle cannot be replayed against the media route
#: (or any other pairing) even if the target URL would happen to fit.
KIND_PROXY = "proxy"
KIND_MEDIA = "media"
KIND_FRAME = "frame"
KIND_CAPTION = "caption"
KIND_DOWNLOAD = "download"
KINDS = frozenset({KIND_PROXY, KIND_MEDIA, KIND_FRAME, KIND_CAPTION, KIND_DOWNLOAD})

#: Hosts a single proxy handle may reach. A proxy handle carries a referer and
#: a browser User-Agent upstream, so an unscoped one is a general-purpose
#: fetcher wearing our headers. The set starts with the manifest's own host and
#: grows only with hosts the *upstream manifests we fetched* actually reference
#: (CDN hosts differ from the manifest host routinely). Bounded so a hostile
#: playlist cannot grow the table without limit.
MAX_PROXY_HOSTS = 64

_store: TTLCache = TTLCache(maxsize=HANDLE_MAX_SIZE, ttl=HANDLE_TTL_SECONDS)
_lock = threading.Lock()
#: Reissue counter: `TTLCache` is not internally synchronised and gunicorn runs
#: this app multi-threaded, so every read-modify-write runs under `_lock`.
_issued = 0


class HandleError(ValueError):
    """A handle that could not have come from `issue`."""


def _host_of(url: str) -> str:
    """Lowercased hostname for `url`, or "" when it has none."""
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def issue(
    kind: str,
    url: str,
    *,
    referer: str = "",
    meta: dict | None = None,
    hosts: tuple[str, ...] = (),
) -> str:
    """Mint a handle that resolves `url` as `kind`.

    `meta` is caller context kept server-side only -- the filename a download
    should save as, the quality tier a segment belongs to. It is never returned
    to the client, because the client has no use for it and it would otherwise
    become the side channel that re-exports internals.

    `hosts` seeds the reach of a proxy handle (see `MAX_PROXY_HOSTS`); it is
    ignored for other kinds, which reach exactly one fixed URL.
    """
    if kind not in KINDS:
        raise HandleError(f"unknown handle kind: {kind!r}")
    if not isinstance(url, str) or not url:
        raise HandleError("a handle needs a target url")
    global _issued
    token = secrets.token_urlsafe(24)
    host_set: set[str] = set()
    if kind == KIND_PROXY:
        for host in hosts:
            if host:
                host_set.add(host.lower())
        own = _host_of(url)
        if own:
            host_set.add(own)
    entry = {
        "kind": kind,
        "url": url,
        "referer": referer or "",
        "meta": dict(meta or {}),
        "hosts": host_set,
        "issued_at": time.time(),
    }
    with _lock:
        _issued += 1
        _store[token] = entry
    return token


def amend_host(token: str | None, url: str) -> bool:
    """Allow one more host on a proxy handle, because a manifest listed it.

    The host comes from a playlist body we fetched ourselves, never from a
    client parameter: the client can only name the handle, and the handle only
    admits hosts that appeared in upstream content already trusted as this
    stream's own. Returns False when the handle is not a proxy handle, is
    unknown, or is already at the ceiling -- callers treat False as "do not
    rewrite this URI", which keeps a runaway playlist from opening more of the
    web while playback continues on the hosts already allowed.
    """
    host = _host_of(url)
    if not token or not host or not HANDLE_PATTERN.match(token):
        return False
    with _lock:
        entry = _store.get(token)
        if entry is None or entry["kind"] != KIND_PROXY:
            return False
        hosts = entry["hosts"]
        if host in hosts:
            return True
        if len(hosts) >= MAX_PROXY_HOSTS:
            return False
        hosts.add(host)
        return True


def resolve(token: str | None, kind: str | None = None) -> dict | None:
    """Return a fresh copy of the entry behind `token`, or None.

    Always a copy: callers routinely annotate the entry (a byte counter, a
    country), and sharing the cached dict would let one request's bookkeeping
    leak into the next. Expired entries are already gone -- `TTLCache` drops
    them on access -- so a stale handle is simply a miss.
    """
    if not token or not HANDLE_PATTERN.match(token):
        return None
    with _lock:
        entry = _store.get(token)
        if entry is None:
            return None
        if kind is not None and entry["kind"] != kind:
            return None
        return {
            "kind": entry["kind"],
            "url": entry["url"],
            "referer": entry["referer"],
            "meta": dict(entry["meta"]),
            "hosts": frozenset(entry["hosts"]),
            "issued_at": entry["issued_at"],
        }


def revoke(token: str | None) -> bool:
    """Drop one handle (logout, finished download). Unknown handles are a no-op."""
    if not token or not HANDLE_PATTERN.match(token):
        return False
    with _lock:
        return _store.pop(token, None) is not None


def stats() -> dict:
    """Live table size and issuance count, for the operator metrics surface."""
    with _lock:
        return {
            "live_handles": len(_store),
            "issued_total": _issued,
            "max_handles": HANDLE_MAX_SIZE,
            "ttl_seconds": HANDLE_TTL_SECONDS,
        }
