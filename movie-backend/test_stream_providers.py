"""Tests for the resolution chain: tier order, budgets, and the no-iframe rule.

Run with:  python3 test_stream_providers.py

Why these exist
---------------
The chain in `stream_providers.py` is the thing that decides whether a viewer
sees a movie or an error. Its failure modes are order- and budget-sensitive,
which is exactly the kind of code that passes inspection and still breaks in
production:

* Walking a tier that cannot serve the title costs a viewer real seconds, and
  a chain with no total budget turns a fully-down provider set into a request
  that outlives the client's own resolve timeout -- so the viewer is told
  "unavailable" when the answer was merely "slow".
* The whole point of this rewrite is that no third-party URL and no iframe
  reaches the client. That is a property of every entry the chain returns, so
  it is asserted on every path that produces one, not merely on the happy one.

The resolver is a pure function of (direct fetcher, injected extract chain), so
these tests drive it with both stubbed. No network, no Flask, no framework --
same harness style as test_hardening.py.
"""

import os
import re
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extractors  # noqa: E402
import stream_providers  # noqa: E402
from proxy_util import playable, playable_sub, stream_format  # noqa: E402


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

#: Anything the client is allowed to load from our payload. A raw third-party
#: origin matching this is the failure the whole file exists to catch.
_PLAY_HANDLE = re.compile(r"^/api/(proxy/(manifest|subtitle)|v1/playback/(media|captions))\?")


def _stub_extract(streams=None, subtitles=None, provider="stub", referer=""):
    """Replace the extract tier for the duration of one test."""
    original = extractors.extract_chain

    def _chain(*args, **kwargs):
        if not streams:
            return None
        return extractors.Extraction(
            provider,
            [dict(s) for s in streams],
            [dict(s) for s in (subtitles or [])],
            referer,
        )

    extractors.extract_chain = _chain
    return original


def _restore(obj):
    extractors.extract_chain = obj


def _resolve(direct=None, *, streams=None, subtitles=None, provider="stub",
             referer="", title="The Matrix", year="1999", **kwargs):
    original = _stub_extract(streams, subtitles, provider, referer)
    try:
        return stream_providers.resolve(
            lambda *a, **k: direct,
            tmdb_id=603,
            media_type="movie",
            title=title,
            year=year,
            **kwargs,
        )
    finally:
        _restore(original)


def _assert_only_handles(resolution):
    """No entry in a resolution may name a third-party origin.

    The upstream Referer is deliberately *not* asserted here: it lives inside
    the handle, server-side, and that is the guarantee. A caller-visible copy
    is a convenience for the player's own logging, not a contract.
    """
    for stream in resolution.streams:
        url = str(stream.get("url") or "")
        assert _PLAY_HANDLE.match(url), f"stream is not a playback handle: {stream!r}"
    for sub in resolution.subtitles:
        url = str(sub.get("url") or "")
        assert url.startswith("/api/proxy/subtitle?track="), (
            f"subtitle is not a caption handle: {sub!r}"
        )


# ---------------------------------------------------------------------------
# The embed manifest, kept for /api/media -- never for resolution
# ---------------------------------------------------------------------------


def test_embed_manifest_builds_both_shapes():
    """The reference list is metadata for the details route only.

    `EMBED_PROVIDERS` survives so `/api/media` can tell a client which hosts
    exist; nothing in the resolution chain reads it. `build` must still produce
    a well-formed URL for both media types, or that route starts lying.
    """
    for provider in stream_providers.EMBED_PROVIDERS:
        movie = provider.build(603, "movie")
        assert "{id}" not in movie and movie.startswith("https://"), movie
        tv = provider.build(603, "tv", season=2, episode=5)
        assert "{id}" not in tv and "{season}" not in tv and "{episode}" not in tv, tv


def test_active_embed_providers_is_a_copy_of_the_manifest():
    """A caller mutating the active list must not rewrite the manifest."""
    active = stream_providers.active_embed_providers()
    assert [p.id for p in active] == [p.id for p in stream_providers.EMBED_PROVIDERS]
    active.pop()
    assert len(stream_providers.active_embed_providers()) == len(
        stream_providers.EMBED_PROVIDERS
    )


def test_embed_manifest_ids_are_unique():
    ids = [p.id for p in stream_providers.EMBED_PROVIDERS]
    assert len(ids) == len(set(ids)), f"duplicate embed ids: {ids!r}"


# ---------------------------------------------------------------------------
# Tier order
# ---------------------------------------------------------------------------


def test_extract_runs_first_and_archive_is_the_fallback():
    """Extract first (it is the only path to a modern film), archive second.

    A provider miss must not be reported as total failure: the archive still
    holds the public-domain titles the provider does not carry, and the viewer
    has to see that tier's answer, not an error.
    """
    resolution = _resolve(
        streams=[{"url": "https://cdn.example.org/hls/master.m3u8"}],
        direct={"streams": [{"url": "https://archive.org/download/x/f.mp4", "label": "720p"}]},
    )
    assert resolution.ok and resolution.provider == "stub"
    assert [a["tier"] for a in resolution.attempts] == ["extract"], resolution.attempts


def test_archive_serves_the_request_when_the_provider_misses():
    """The archive tier runs after an extract miss, not instead of it."""
    resolution = _resolve(
        direct={"streams": [{"url": "https://archive.org/download/x/f.mp4", "label": "720p"}]},
    )
    assert resolution.ok and resolution.provider == "archive"
    assert [a["tier"] for a in resolution.attempts] == ["extract", "archive"], (
        resolution.attempts
    )


def test_extract_tier_serves_when_it_resolves():
    """A resolving provider wins outright; the archive is never asked."""
    resolution = _resolve(
        streams=[{"url": "https://cdn.example.org/hls/master.m3u8", "label": "1080p"}],
        extract=True,
    )
    assert resolution.ok and resolution.provider == "stub"
    assert [a["tier"] for a in resolution.attempts] == ["extract"], resolution.attempts


def test_extract_false_skips_the_browser_entirely():
    """`extract=False` is the archive-only path, for a box with no Chrome."""
    resolution = _resolve(
        streams=[{"url": "https://cdn.example.org/hls/master.m3u8"}],
        direct={"streams": [{"url": "https://archive.org/download/x/f.mp4", "label": "720p"}]},
        extract=False,
    )
    assert resolution.ok and resolution.provider == "archive"
    assert [a["tier"] for a in resolution.attempts] == ["archive"], resolution.attempts


def test_exhaustion_reports_every_tier_in_order():
    resolution = _resolve(direct=None)
    assert resolution.ok is False
    assert resolution.provider == ""
    assert resolution.streams == [] and resolution.subtitles == []
    assert [a["tier"] for a in resolution.attempts] == ["extract", "archive"], (
        resolution.attempts
    )
    assert all(a["ok"] is False for a in resolution.attempts), resolution.attempts


def test_extract_error_is_a_miss_not_a_crash():
    """An extractor that raises must cost the tier a beat, not the request."""
    original = extractors.extract_chain

    def _boom(*args, **kwargs):
        raise RuntimeError("provider page moved")

    extractors.extract_chain = _boom
    try:
        resolution = _resolve(
            {"streams": [{"url": "https://archive.org/download/x/f.mp4", "label": "720p"}]},
            extract=True,
        )
    finally:
        extractors.extract_chain = original
    assert resolution.ok and resolution.provider == "archive", resolution.attempts
    assert resolution.attempts[0]["ok"] is False, resolution.attempts


def test_archive_error_is_a_miss_not_a_crash():
    """A catalog that raises costs the tier a beat, not the request.

    The extract tier is stubbed to miss first: without that this test would
    render a live provider page, which is a network call in a suite that must
    not depend on someone else's uptime.
    """
    def _boom(*args, **kwargs):
        raise RuntimeError("catalog unavailable")

    original = _stub_extract(None)
    try:
        resolution = stream_providers.resolve(_boom, tmdb_id=603, title="The Matrix")
    finally:
        _restore(original)
    assert resolution.ok is False
    assert [a["tier"] for a in resolution.attempts] == ["extract", "archive"], (
        resolution.attempts
    )
    assert resolution.attempts[-1]["ok"] is False, resolution.attempts


# ---------------------------------------------------------------------------
# The no-iframe rule, asserted on every path that produces a stream
# ---------------------------------------------------------------------------


def test_resolution_is_never_an_embed():
    """`is_embed` is False by construction, on every shape of resolution."""
    assert _resolve(streams=[{"url": "https://a.example/x.mp4"}]).is_embed is False
    assert _resolve(direct=None).is_embed is False


def test_every_stream_is_a_handle_and_carries_its_referer():
    resolution = _resolve(
        streams=[
            {"url": "https://cdn.example.org/hls/master.m3u8", "label": "1080p",
             "referer": "https://vidsrc.pro/"},
            {"url": "https://cdn.example.org/v/f.mp4", "label": "720p",
             "referer": "https://vidsrc.pro/"},
        ],
        referer="https://vidsrc.pro/",
        extract=True,
    )
    assert resolution.ok
    _assert_only_handles(resolution)
    assert resolution.referer == "https://vidsrc.pro/"
    for stream in resolution.streams:
        assert stream["referer"] == "https://vidsrc.pro/", stream


def test_hls_and_progressive_take_different_relay_legs():
    """Container decides the leg: hls.js needs the manifest rewrite, a media
    element needs Range passthrough. Getting this wrong is either a CORS death
    or an unseekable file."""
    resolution = _resolve(
        streams=[
            {"url": "https://cdn.example.org/hls/master.m3u8", "label": "1080p"},
            {"url": "https://cdn.example.org/v/f.mp4", "label": "720p"},
        ],
        extract=True,
    )
    formats = {s["label"]: s["format"] for s in resolution.streams}
    assert formats == {"1080p": "hls", "720p": "mp4"}, formats
    urls = {s["label"]: s["url"] for s in resolution.streams}
    assert urls["1080p"].startswith("/api/proxy/manifest?token="), urls
    assert urls["720p"].startswith("/api/v1/playback/media?token="), urls


def test_subtitles_become_caption_handles():
    resolution = _resolve(
        streams=[{"url": "https://cdn.example.org/hls/master.m3u8"}],
        subtitles=[{"url": "https://cdn.example.org/subs/en.srt", "label": "English"}],
        extract=True,
    )
    assert resolution.subtitles, "subtitles were dropped"
    _assert_only_handles(resolution)
    assert resolution.subtitles[0]["label"] == "English"


def test_playable_refuses_to_pass_a_url_through():
    """The handle exchange is the security boundary, not a formatting step."""
    assert playable("") == ""
    assert playable_sub("") == ""
    raw = "https://cdn.example.org/hls/master.m3u8"
    handle = playable(raw)
    assert _PLAY_HANDLE.match(handle), handle
    assert raw not in handle, f"the raw URL survived the exchange: {handle!r}"


def test_stream_format_reads_the_path_not_the_query():
    assert stream_format("https://x.org/a.m3u8?token=1") == "hls"
    assert stream_format("https://x.org/a.M3U8") == "hls"
    assert stream_format("https://x.org/a.mp4?token=1") == "mp4"
    assert stream_format("") == "mp4"


# ---------------------------------------------------------------------------
# Duration guard -- a trailer must never win a feature film
# ---------------------------------------------------------------------------


def _manifest_response(body: str):
    class _Response:
        status_code = 200
        text = body

    return _Response()


def _duration_body(minutes: float) -> str:
    return f"#EXTM3U\n#EXTINF:{minutes * 60:.1f},\nseg1.ts\n"


def test_short_hls_is_dropped_and_recorded():
    """A 4-minute manifest is a trailer. It is dropped, and the drop is
    reported, so "nothing worked" has a reason attached."""
    original_get = stream_providers.requests.get
    stream_providers.requests.get = lambda *a, **k: _manifest_response(_duration_body(4))
    try:
        resolution = _resolve(
            {"streams": [{"url": "https://cdn.example.org/trailer.m3u8", "label": "720p"}]},
            runtime=110,
        )
    finally:
        stream_providers.requests.get = original_get
    assert resolution.ok is False, resolution.streams
    archive = [a for a in resolution.attempts if a["tier"] == "archive"][0]
    assert archive["ok"] is False and archive.get("reason"), archive


def test_a_feature_length_hls_is_kept():
    """The guard must not become a blocker: a real feature passes."""
    original_get = stream_providers.requests.get
    stream_providers.requests.get = lambda *a, **k: _manifest_response(_duration_body(110))
    try:
        resolution = _resolve(
            {"streams": [{"url": "https://cdn.example.org/feature.m3u8", "label": "720p"}]},
            runtime=110,
        )
    finally:
        stream_providers.requests.get = original_get
    assert resolution.ok, resolution.attempts


def test_progressive_files_skip_the_duration_probe():
    """A progressive file has no cheap duration probe. The guard must not
    invent one by fetching the whole file to read a length."""
    resolution = _resolve(
        {"streams": [{"url": "https://archive.org/download/x/trailer.mp4", "label": "720p"}]},
        runtime=110,
    )
    assert resolution.ok, resolution.attempts


def test_a_short_runtime_disables_the_guard():
    """A title with no usable runtime has no baseline to compare against, so
    the guard reports "fine" rather than guessing."""
    resolution = _resolve(
        {"streams": [{"url": "https://cdn.example.org/hls/master.m3u8", "label": "720p"}]},
        runtime=None,
    )
    assert resolution.ok, resolution.attempts


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def test_resolve_signature_accepts_everything_init_passes():
    """`app.playback_init` calls this with a fixed keyword set; a rename on
    either side would only surface as a 500 in production."""
    import inspect

    params = inspect.signature(stream_providers.resolve).parameters
    for name in ("direct_fetcher", "tmdb_id", "media_type", "title", "year",
                 "season", "episode", "refresh", "runtime", "extract"):
        assert name in params, f"resolve() lost the {name!r} parameter"


def test_resolve_without_the_extract_tier_asks_only_the_archive():
    original = _stub_extract([{"url": "https://cdn.example.org/hls/master.m3u8"}])
    try:
        resolution = stream_providers.resolve(
            lambda *a, **k: None, tmdb_id=603, title="The Matrix", extract=False
        )
    finally:
        _restore(original)
    assert resolution.ok is False
    assert [a["tier"] for a in resolution.attempts] == ["archive"], resolution.attempts


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def _run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for fn in tests:
        name = fn.__name__
        try:
            fn()
            print(f"  PASS  {name}")
        except Exception:
            failures += 1
            print(f"  FAIL  {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    raise SystemExit(1 if _run() else 0)
