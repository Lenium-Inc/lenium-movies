"""
hls_proxy.py — same-origin media relay for the player, keyed on playback handles.

  GET /api/proxy/manifest?token=...   fetch + rewrite an HLS entry playlist
  GET /api/proxy/dash?token=...       fetch + rewrite a DASH MPD
  GET /api/proxy/segment?token=&u=... stream one segment / nested playlist
  GET /api/proxy/subtitle?track=...   any-host caption -> WebVTT

Every route is a thin handle reader: the upstream URL, the Referer and any
signed headers live inside a `playback_tokens` entry minted by the resolver,
never in the query string. A caller who does not hold a handle minted by this
process cannot aim any of these routes at anything.

HLS: segment lines AND URI="..." attributes (EXT-X-KEY / EXT-X-MAP /
EXT-X-MEDIA) are rewritten onto /api/proxy/segment, so AES keys and fMP4
init maps route back through us too. DASH: SegmentTemplate / SegmentURL /
BaseURL locations are rewritten the same way, with $Number%05d$-style
substitution tokens preserved verbatim for the player to expand.
"""
from __future__ import annotations

import re
import urllib.parse

import requests
from flask import Blueprint, Response, request, stream_with_context

import catalog_lib
import playback_tokens
import proxy_util
import telemetry

hls_bp = Blueprint("hls_proxy", __name__)

HLS_PROXY_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
#: `(connect, read)` socket timeouts. The read half is the one that matters:
#: without it a stalled segment pins a worker thread open for as long as the
#: default -- which is forever.
HLS_PROXY_TIMEOUT = (5.0, 20.0)
#: Manifests are kilobytes. Anything past this is not a manifest, and reading
#: an unbounded body here would be an allocation primitive reachable from a URL
#: the client supplies.
HLS_PROXY_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
#: Caption files are tens of kilobytes. Anything past this is not a caption
#: file, and the subtitle relay reads its body whole in order to convert it --
#: so the cap is what keeps that read bounded.
CAPTION_PROXY_MAX_BYTES = 4 * 1024 * 1024
#: Read size for the segment relay, so a worker holds one bounded buffer rather
#: than a whole segment (commonly 2-10 MB) for the length of its transfer.
HLS_PROXY_CHUNK_BYTES = 256 * 1024
#: Longest `u=` the segment route will read. Playlists carry paths, not
#: sentences; anything past this is a forged request or a pathological one and
#: is refused before the string is joined, resolved or looked up.
PROXY_URI_MAX_LENGTH = 4096


def _json_error(message: str, status: int, **extra):
    return (
        {"error": message, "status": status, "success": False, **extra},
        status,
    )


def _error_response(message: str, status: int, **extra):
    from flask import jsonify

    return jsonify({"error": message, "status": status, "success": False, **extra}), status


def _hls_proxy_request_headers(referer: str, entry: dict | None = None) -> dict[str, str]:
    headers = {
        "User-Agent": HLS_PROXY_USER_AGENT,
        "Accept": "*/*",
        # Segments are not compressed upstream. Asking for identity also keeps
        # the bytes this relay forwards identical to the bytes received.
        "Accept-Encoding": "identity",
    }
    if referer:
        headers["Referer"] = referer
    # Headers the CDN insisted on at resolve time. A signed CloudFront `Cookie`
    # and an `Origin` cannot cross the wire from the player -- a browser drops a
    # cross-origin Cookie before it is sent, and the player is never told the
    # value -- so they ride inside the handle and are reapplied here. Only the
    # fixed key set survives `normalize_upstream_headers`, so this cannot be
    # turned into a header-injection primitive by a malformed resolve.
    headers.update(proxy_util.upstream_headers_of(entry))
    return headers


def _proxy_entry(token: str | None) -> dict | None:
    """Resolve a proxy handle, or None when it is absent, foreign or expired.

    The kind argument is the check: a media or download handle that guessed
    this route answers None, so one token cannot be replayed across legs just
    because both legs read `token=`.
    """
    return playback_tokens.resolve(token or "", playback_tokens.KIND_PROXY)


#: `URI=` inside a tag line: the AES key, the fMP4 init segment, an alternate
#: audio or subtitle rendition. Quoted or bare, and the quoted form may carry a
#: comma, which is why the quoted alternative comes first.
_HLS_URI_ATTRIBUTE = re.compile(r'URI=(?:"([^"]*)"|([^,\s]+))')


def _rewrite_hls_manifest(manifest: str, manifest_url: str, token: str) -> str:
    """Point every URI in `manifest` at `/api/proxy/segment?token=...&u=...`.

    Two kinds of reference exist and both have to move, or the playlist parses
    and playback still stops part-way through:

    - a bare URI line -- a `.ts` chunk, or in a master a nested `.m3u8`;
    - a `URI=` attribute inside a tag -- the decryption key, the init segment,
      an alternate audio rendition. These are left alone by a rewriter that
      only looks at bare lines, and the cost is a master whose video ladder
      works while its English dub never loads.

    Each reference is resolved against the URL the manifest itself was fetched
    from first, because playlists routinely carry relative paths and a relative
    path in the answer would resolve against this origin instead of upstream's.
    The absolute form is then registered against the handle's host set -- that
    registration is what permits the later segment fetch -- and only the `u=`
    form crosses the wire, so the upstream origin itself never becomes data the
    client holds.
    """

    def proxied(uri: str) -> str:
        absolute = urllib.parse.urljoin(manifest_url, uri)
        # Registration, not a permission check: an unregistrable host would
        # still be refused at the segment route by the same host set, so a
        # ceiling hit stops playback rather than leaking the raw URL here.
        playback_tokens.amend_host(token, absolute)
        return "/api/proxy/segment?" + urllib.parse.urlencode(
            {"token": token, "u": absolute}
        )

    rewritten: list[str] = []
    for line in manifest.splitlines():
        stripped = line.strip()
        if not stripped:
            rewritten.append(line)
            continue
        if stripped.startswith("#"):
            if "URI=" in stripped:
                def replace(match: "re.Match", _proxied=proxied) -> str:
                    uri = match.group(1) if match.group(1) is not None else match.group(2)
                    if not uri:
                        return match.group(0)
                    return f'URI="{_proxied(uri)}"'

                line = _HLS_URI_ATTRIBUTE.sub(replace, line)
            rewritten.append(line)
            continue
        rewritten.append(proxied(stripped))
    return "\n".join(rewritten)


#: DASH locations that name a retrievable file. `SegmentTemplate` carries an
#: init segment and a numbered chunk pattern; `SegmentURL` carries a plain list;
#: `<BaseURL>` prefixes both. All three resolve against the MPD's own URL, and
#: all three have to move, or the MPD parses and playback dies on the first
#: chunk with nothing on screen to explain why.
_DASH_ATTR = re.compile(
    r'\b(initialization|media|sourceURL|media)="([^"]+)"'
)
_DASH_BASEURL = re.compile(r"<BaseURL>([^<]+)</BaseURL>")
#: A `$RepresentationID$` / `$Number%05d$` / `$Time$` substitution token.
_DASH_TOKEN = re.compile(r"\$[^$]*\$")


def _encode_dash_uri(uri: str) -> str:
    """Percent-encode a template-bearing URI for a `u=` query value.

    A DASH `SegmentTemplate` location is not a URI yet: it contains
    `$RepresentationID$` and `$Number%05d$`, and the *player* is what fills
    them in. Those tokens have to reach the player verbatim -- the `%` inside
    `%05d` is a printf spec, not a percent-encoding, and a player that never
    sees a literal `$Number%05d$` silently requests the unexpanded path and
    dies on the first chunk with a 404 and nothing on screen to say why.

    So the encoding walks around the tokens. Everything between them is encoded
    normally, which is what keeps an upstream `&` or `=` from being read as
    this route's own query structure.
    """
    out: list[str] = []
    last = 0
    for match in _DASH_TOKEN.finditer(uri):
        out.append(urllib.parse.quote(uri[last:match.start()], safe=""))
        out.append(match.group(0))
        last = match.end()
    out.append(urllib.parse.quote(uri[last:], safe=""))
    return "".join(out)


def _rewrite_dash_manifest(manifest: str, manifest_url: str, token: str) -> str:
    """Point every location in `MPD` at `/api/proxy/segment?token=...&u=...`.

    The DASH equivalent of `_rewrite_hls_manifest`. Same registration contract:
    each reference is resolved against the MPD's URL, registered against the
    handle's host set (which is what later permits the chunk fetch), and only
    the `u=` form crosses the wire.
    """
    safe_token = urllib.parse.quote(token, safe="")

    def proxied(uri: str) -> str:
        absolute = urllib.parse.urljoin(manifest_url, uri)
        playback_tokens.amend_host(token, absolute)
        return f"/api/proxy/segment?token={safe_token}&u={_encode_dash_uri(absolute)}"

    def swap(match: "re.Match") -> str:
        uri = match.group(2)
        if not uri:
            return match.group(0)
        return f'{match.group(1)}="{proxied(uri)}"'

    def swap_base(match: "re.Match") -> str:
        uri = match.group(1).strip()
        if not uri or "$" in uri:
            return match.group(0)
        return f"<BaseURL>{proxied(uri)}</BaseURL>"

    return _DASH_ATTR.sub(swap, _DASH_BASEURL.sub(swap_base, manifest))


def _read_bounded(upstream, max_bytes: int) -> bytes:
    """Read an upstream body in chunks, refusing anything over `max_bytes`.

    Raised rather than truncated: a clipped manifest parses part-way and then
    fails with no visible cause, which is worse than a clean refusal.
    """
    chunks: list[bytes] = []
    size = 0
    for chunk in upstream.iter_content(64 * 1024):
        if not chunk:
            continue
        size += len(chunk)
        if size > max_bytes:
            raise ValueError("upstream body exceeds the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _hls_manifest_response(manifest_url: str, token: str, raw: bytes) -> Response:
    manifest = raw.decode("utf-8", errors="replace")
    response = Response(
        _rewrite_hls_manifest(manifest, manifest_url, token), status=200
    )
    # Set directly rather than through `mimetype`, which would append a charset
    # hls.js has no use for and which some CDN validators treat as a mismatch.
    response.headers["Content-Type"] = "application/vnd.apple.mpegurl"
    # No `Access-Control-Allow-Origin: *` here: the shared CORS hook answers
    # allowlisted origins exactly and nobody else, the same rule every other
    # route follows. A wildcard on a relay would let any site on the internet
    # read bytes through this server.
    response.headers["Cache-Control"] = "no-store"
    return response


def _hls_is_playlist(url: str, content_type: str | None) -> bool:
    """True when a request routed through the segment relay targets a playlist.

    The manifest rewriter sends *every* URI line to `/api/proxy/segment`, so a
    master's variant and rendition lines arrive here as playlists. Detecting
    them is what keeps a master -> variant -> chunk chain on this origin:
    handing the bytes back raw would leave the variant's own relative chunk
    paths resolving against this server, where nothing serves them.
    """
    path = urllib.parse.urlparse(url).path.lower()
    if path.endswith(".m3u8") or path.endswith(".m3u"):
        return True
    return "mpegurl" in (content_type or "").lower()


@hls_bp.route("/api/proxy/manifest", methods=["GET", "OPTIONS"])
def proxy_hls_manifest():
    """Fetch the handle's entry playlist and rewrite it onto the segment relay.

    The upstream URL and Referer both come from the handle, so this route
    fetches exactly one host per token and the caller can influence neither.
    Returns the rewritten playlist: every URI inside it is made absolute
    against the manifest's own URL, registered against the handle, and pointed
    at `/api/proxy/segment` with the same token -- so the segments that follow
    go out with the headers hls.js is not allowed to send, from hosts this
    handle was built to reach.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = _proxy_entry(token)
    if entry is None:
        return _error_response(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )
    url = entry["url"]
    referer = entry.get("referer") or ""

    try:
        with requests.get(
            url,
            headers=_hls_proxy_request_headers(referer, entry),
            timeout=HLS_PROXY_TIMEOUT,
            stream=True,
        ) as upstream:
            if upstream.status_code != 200:
                return _error_response(
                    f"Manifest upstream returned {upstream.status_code}", 502
                )
            raw = _read_bounded(upstream, HLS_PROXY_MANIFEST_MAX_BYTES)
    except requests.Timeout:
        return _error_response("Manifest upstream timed out", 504)
    except requests.RequestException:
        return _error_response("Manifest upstream unavailable", 502)
    except ValueError:
        return _error_response("Manifest is too large", 502)

    region = entry.get("meta", {}).get("region") or None
    telemetry.record_event("manifest")
    telemetry.record_bytes(len(raw), region)
    telemetry.touch_stream(token, count=len(raw))
    return _hls_manifest_response(url, token, raw)


@hls_bp.route("/api/proxy/dash", methods=["GET", "OPTIONS"])
def proxy_dash_manifest():
    """Fetch the handle's MPD and rewrite it onto the segment relay.

    The DASH twin of `/api/proxy/manifest`. Most provider-sourced films are DASH
    rather than HLS -- the resolver sees roughly eleven MPDs for every one
    playlist -- and an MPD whose `SegmentTemplate` paths stayed absolute would
    send the player straight to the CDN with no Cookie, which the CDN then
    refuses. Rewriting those paths onto `/api/proxy/segment` is what lets the
    signed request be made from here, where the Cookie lives.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = _proxy_entry(token)
    if entry is None:
        return _error_response(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )
    url = entry["url"]
    referer = entry.get("referer") or ""

    try:
        with requests.get(
            url,
            headers=_hls_proxy_request_headers(referer, entry),
            timeout=HLS_PROXY_TIMEOUT,
            stream=True,
        ) as upstream:
            if upstream.status_code != 200:
                return _error_response(
                    f"MPD upstream returned {upstream.status_code}", 502
                )
            raw = _read_bounded(upstream, HLS_PROXY_MANIFEST_MAX_BYTES)
    except requests.Timeout:
        return _error_response("MPD upstream timed out", 504)
    except requests.RequestException:
        return _error_response("MPD upstream unavailable", 502)
    except ValueError:
        return _error_response("MPD is too large", 502)

    region = entry.get("meta", {}).get("region") or None
    telemetry.record_event("manifest")
    telemetry.record_bytes(len(raw), region)
    telemetry.touch_stream(token, count=len(raw))

    response = Response(
        _rewrite_dash_manifest(raw.decode("utf-8", errors="replace"), url, token),
        status=200,
    )
    response.headers["Content-Type"] = "application/dash+xml"
    response.headers["Cache-Control"] = "no-store"
    return response


@hls_bp.route("/api/proxy/segment", methods=["GET", "OPTIONS"])
def proxy_hls_segment():
    """Relay one media segment (or nested playlist), on the handle's terms.

    `u` is resolved against the handle's entry URL and then checked against the
    handle's host set -- the set the rewrite built while serving the playlist.
    A `u` naming a host that was never part of that playlist's own references
    is refused, so this route cannot be aimed elsewhere even with a valid
    token. Bytes stream straight through rather than buffering: a segment is
    megabytes, several viewers pull several at once, and holding them whole is
    how a relay turns into an OOM on a box with a fixed memory budget.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("token") or ""
    entry = _proxy_entry(token)
    if entry is None:
        return _error_response(
            "Unknown or expired stream token", 400, code="TOKEN_INVALID"
        )

    raw_uri = (request.args.get("u") or "").strip()
    if not raw_uri or len(raw_uri) > PROXY_URI_MAX_LENGTH:
        return _error_response("Missing or invalid u parameter", 400)
    url = urllib.parse.urljoin(entry["url"], raw_uri)
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return _error_response("Invalid u parameter", 400)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return _error_response("Invalid u parameter", 400)
    host = (parsed.hostname or "").lower()
    if not host or host not in entry.get("hosts", set()):
        return _error_response(
            "Host is not part of this stream", 403, code="HOST_NOT_ALLOWED"
        )

    referer = entry.get("referer") or ""
    region = entry.get("meta", {}).get("region") or None

    try:
        upstream = requests.get(
            url,
            headers=_hls_proxy_request_headers(referer, entry),
            timeout=HLS_PROXY_TIMEOUT,
            stream=True,
        )
    except requests.Timeout:
        return _error_response("Segment upstream timed out", 504)
    except requests.RequestException:
        return _error_response("Segment upstream unavailable", 502)

    if upstream.status_code not in (200, 206):
        upstream.close()
        return _error_response(f"Segment upstream returned {upstream.status_code}", 502)

    if _hls_is_playlist(url, upstream.headers.get("Content-Type")):
        try:
            with upstream:
                raw = _read_bounded(upstream, HLS_PROXY_MANIFEST_MAX_BYTES)
        except requests.Timeout:
            return _error_response("Segment upstream timed out", 504)
        except requests.RequestException:
            return _error_response("Segment upstream unavailable", 502)
        except ValueError:
            return _error_response("Manifest is too large", 502)
        telemetry.record_event("manifest")
        telemetry.record_bytes(len(raw), region)
        telemetry.touch_stream(token, count=len(raw))
        return _hls_manifest_response(url, token, raw)

    def generate():
        sent = 0
        try:
            for chunk in upstream.iter_content(HLS_PROXY_CHUNK_BYTES):
                if chunk:
                    sent += len(chunk)
                    yield chunk
        except requests.RequestException:
            # The status line is already on the wire, so a mid-stream failure
            # cannot become an error response. Stopping is the honest signal:
            # the client sees a short read and retries, which is what hls.js
            # does for a failed segment anyway.
            print(f"[HLS] segment relay cut short for {url}")
        finally:
            upstream.close()
            # After the last byte: the bytes counted per-stream (and the view's
            # last-seen clock) move together with the bytes counted globally.
            if sent:
                telemetry.record_bytes(sent, region)
                telemetry.touch_stream(token, count=sent)

    telemetry.record_event("segment")
    response = Response(
        stream_with_context(generate()),
        status=upstream.status_code,
    )
    # DASH chunks are fMP4 (`.m4s`) and HLS segments are MPEG-TS (`.ts`). Label
    # each by its own extension: the upstream CDN answers `application/octet-
    # stream` for both, and a player given the wrong type either refuses the
    # segment or guesses a container that does not match the bytes.
    seg_path = urllib.parse.urlparse(url).path.lower()
    if seg_path.endswith((".m4s", ".mp4", ".m4v", ".cmfv", ".cmfa")):
        response.headers["Content-Type"] = "video/mp4"
    else:
        response.headers["Content-Type"] = "video/mp2t"
    # Allowlist-exact CORS via the shared hook; no wildcard on a relay.
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


@hls_bp.route("/api/proxy/subtitle", methods=["GET", "OPTIONS"])
def proxy_subtitle():
    """Relay one caption file, any host, converted to WebVTT.

    Provider captions live on CDNs that are deliberately *not* on the archive
    allowlist -- the archive leg of this server has no reason to reach them and
    should not start. So this route does the opposite of every other relay
    here: it admits a host the allowlist would refuse, and its scoping is the
    handle alone. That is safe for the same reason the manifest relay is: only
    server code can mint a handle, and a handle names exactly one URL, so a
    caller cannot aim this route anywhere the resolver did not already choose.

    The upstream URL never crosses the wire. Range is not forwarded either: a
    caption file is tens of kilobytes and is read whole so it can be converted,
    which is also why the body is size-capped rather than streamed.
    """
    if request.method == "OPTIONS":
        return ("", 204)

    token = request.args.get("track") or request.args.get("token") or ""
    entry = playback_tokens.resolve(token, playback_tokens.KIND_CAPTION)
    if entry is None:
        return _error_response(
            "Unknown or expired caption token", 400, code="TOKEN_INVALID"
        )

    referer = entry.get("referer") or ""
    try:
        upstream = requests.get(
            entry["url"],
            headers=_hls_proxy_request_headers(referer, entry),
            timeout=(5.0, 12.0),
        )
    except requests.Timeout:
        return _error_response("Caption upstream timed out", 504)
    except requests.RequestException:
        return _error_response("Caption upstream unavailable", 502)
    if upstream.status_code != 200:
        return _error_response(f"Caption upstream returned {upstream.status_code}", 502)
    # Captions are tens of KB; anything past this is not a caption file, and
    # reading an unbounded body would make this route a file-fetching primitive.
    raw = upstream.content[:CAPTION_PROXY_MAX_BYTES]

    text = raw.decode("utf-8", errors="replace")
    if not text.lstrip("\ufeff").lstrip().upper().startswith("WEBVTT"):
        text = catalog_lib.srt_to_vtt(text)

    telemetry.record_event("caption")
    return Response(
        text,
        status=200,
        content_type="text/vtt; charset=utf-8",
        headers={
            # `charset=utf-8` is not decoration: a `text/vtt` response decoded as
            # Latin-1 mangles every non-ASCII cue into mojebake, and caption text
            # is exactly where non-ASCII lives.
            "Cache-Control": "public, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )
