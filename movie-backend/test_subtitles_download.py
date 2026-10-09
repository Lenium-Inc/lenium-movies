"""Tests for the subtitle proxy and the offline download endpoint.

Run with:  python3 test_subtitles_download.py

Why these exist
---------------
Subtitles looked implemented and were not. The player offered a hardcoded
`Off / English / Spanish / French` menu, the resolver never received a subtitle
list because the normalizer dropped the field, and the archive.org `.vtt` files
that did exist were unreachable from a `<track>` element: a track is fetched
with CORS, and the archive download nodes return no `Access-Control-Allow-Origin`
and no WebVTT content type. Every one of those layers fails silently -- the menu
shows a language, nothing is spoken, and no error is ever logged. So the
conversion, the proxy, and the CORS-critical response shape are asserted here
rather than trusted.

Downloads have a matching trap: a browser ignores an `<a download>` attribute on
a cross-origin href, so saving the file only works if the backend sends
`Content-Disposition: attachment`. That header is also where a caller-supplied
filename becomes an injection vector, so the sanitizer is covered too.

Same harness approach as test_stream_errors.py: throwaway SQLite, Flask's test
client, no framework, no network. The upstream fetch is monkeypatched, so these
tests never touch archive.org.
"""

import os
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="subtitles-download-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "subtitles-download.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False

import catalog_lib  # noqa: E402

VTT_BODY = (
    "WEBVTT Kind: captions; Language: en\n"
    "\n"
    "00:00:09.000 --> 00:00:15.001\n"
    "This, our country, and all its people,\n"
)

SRT_BODY = (
    "1\n"
    "00:00:09,000 --> 00:00:15,001\n"
    "This, our country, and all its people,\n"
    "\n"
    "2\n"
    "00:01:02,500 --> 00:01:05,000\n"
    "Second cue\n"
)

# `open_archive_stream` is shared with the stream relay, which has its own
# tests, so it is snapshotted and restored to keep monkeypatching from leaking
# into them. The Flask module is a singleton, so the original has to be
# captured once and reinstated before every test.
_PATCH_PATHS = (
    ("catalog_lib", "open_archive_stream"),
    ("catalog_lib", "fetch_bounded_text"),
)
_SAVED = None


def _resolve(application, path):
    owner = application
    for part in path[:-1]:
        owner = getattr(owner, part)
    return owner


def _snapshot():
    import app as application

    return [
        (_resolve(application, path), path[-1], getattr(_resolve(application, path), path[-1]))
        for path in _PATCH_PATHS
    ]


def _restore(saved):
    for owner, name, original in saved:
        setattr(owner, name, original)


def _client():
    global _SAVED
    if _SAVED is None:
        _SAVED = _snapshot()

    store = authdb.Store(dsn="")
    store.pg = False
    store.sqlite_path = os.path.join(_TMP, "subtitles-download.db")
    store.init()
    authdb._store = store

    import app as application

    application.authdb._store = store
    _restore(_SAVED)
    return application, application.app.test_client()


def _fake_archive(body, content_type="text/plain;charset=UTF-8"):
    """Serve `body` from both network-facing helpers, without any network."""

    def _open(url, range_header=None):
        headers = {"Content-Length": str(len(body))}
        if content_type:
            headers["Content-Type"] = content_type
        return 200, headers, iter([body])

    def _text(url, timeout, max_bytes):
        if len(body) > max_bytes:
            raise ValueError("file exceeds the maximum subtitle size")
        return body

    import app as application

    application.catalog_lib.open_archive_stream = _open
    application.catalog_lib.fetch_bounded_text = _text


def _fake_archive_failing():
    def _open(url, range_header=None):
        raise OSError("upstream node refused the connection")

    def _text(url, timeout, max_bytes):
        raise OSError("upstream node refused the connection")

    import app as application

    application.catalog_lib.open_archive_stream = _open
    application.catalog_lib.fetch_bounded_text = _text


# --- SRT -> WebVTT conversion ------------------------------------------------


def test_srt_conversion_produces_webvtt():
    out = catalog_lib.srt_to_vtt(SRT_BODY)
    assert out.startswith("WEBVTT"), out[:40]
    assert "00:00:09.000 --> 00:00:15.001" in out, out
    assert "00:01:02.500 --> 00:01:05.000" in out, out


def test_srt_conversion_drops_sequence_numbers():
    out = catalog_lib.srt_to_vtt(SRT_BODY)
    # A bare integer line is SubRip bookkeeping and is not valid WebVTT.
    assert "\n1\n" not in out, out
    assert "\n2\n" not in out, out


def test_srt_conversion_preserves_cue_text():
    out = catalog_lib.srt_to_vtt(SRT_BODY)
    assert "This, our country, and all its people," in out
    assert "Second cue" in out


def test_srt_conversion_is_idempotent_on_real_vtt():
    # Archive.org ships files that are already WebVTT; a second pass must not
    # prepend a second WEBVTT signature.
    assert catalog_lib.srt_to_vtt(VTT_BODY) == VTT_BODY


def test_srt_conversion_handles_short_millisecond_fields():
    out = catalog_lib.srt_to_vtt("1\n00:00:01,5 --> 00:00:02,25\nx\n")
    assert "00:00:01.500 --> 00:00:02.250" in out, out


def test_srt_conversion_keeps_a_numeric_caption_line():
    # A caption whose text is only digits is dialogue, not a cue index. Testing
    # `isdigit()` alone would delete "1984" and similar lines from the file.
    out = catalog_lib.srt_to_vtt(
        "1\n00:00:01,000 --> 00:00:02,000\n1984\n\n2\n00:00:03,000 --> 00:00:04,000\nok\n"
    )
    assert "\n1984\n" in out, out
    # The genuine sequence numbers must still be gone.
    assert "\n1\n" not in out, out
    assert "\n2\n" not in out, out


def test_srt_conversion_keeps_a_trailing_numeric_caption():
    out = catalog_lib.srt_to_vtt("1\n00:00:01,000 --> 00:00:02,000\n42\n")
    assert out.rstrip().endswith("42"), out


def test_srt_conversion_keeps_cue_order_and_blank_separators():
    out = catalog_lib.srt_to_vtt(SRT_BODY)
    assert out.index("00:00:09.000") < out.index("00:01:02.500")
    assert "\n\n" in out, "cues must stay separated by a blank line"


def test_srt_conversion_normalizes_crlf_and_bom():
    out = catalog_lib.srt_to_vtt("\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nx\r\n")
    assert out.startswith("WEBVTT"), out[:40]
    assert "\r" not in out, "carriage returns must be normalized"


# --- subtitle discovery ------------------------------------------------------


def test_choose_subtitles_includes_srt_files():
    files = [
        {"name": "Movie_512kb.mp4"},
        {"name": "Movie.asr.srt"},
        {"name": "Movie_512kb.mp4"},
    ]
    tracks = catalog_lib.choose_subtitles(files, "some-identifier")
    assert len(tracks) == 1, tracks
    assert tracks[0]["format"] == "srt", tracks
    assert tracks[0]["lang"] == "eng", tracks
    assert tracks[0]["url"].endswith("Movie.asr.srt"), tracks


def test_choose_subtitles_prefers_vtt_over_srt_for_same_language():
    files = [{"name": "Movie.srt"}, {"name": "Movie.vtt"}]
    tracks = catalog_lib.choose_subtitles(files, "some-identifier")
    assert len(tracks) == 1, tracks
    assert tracks[0]["format"] == "vtt", tracks


def test_choose_subtitles_labels_language_from_filename():
    files = [{"name": "Movie.spa.vtt"}, {"name": "Movie.fra.vtt"}]
    labels = {t["lang"]: t["label"] for t in catalog_lib.choose_subtitles(files, "ident")}
    assert labels == {"spa": "Spanish", "fra": "French"}, labels


def test_choose_subtitles_ignores_thumbnails_and_artifacts():
    files = [
        {"name": "Movie_thumb.vtt"},
        {"name": "Movie_sample.vtt"},
        {"name": "Movie_trailer.vtt"},
        {"name": "Movie_djvu.txt"},
    ]
    assert catalog_lib.choose_subtitles(files, "ident") == []


def test_choose_subtitles_deduplicates_by_language():
    files = [{"name": "Movie_eng.vtt"}, {"name": "Movie.en.vtt"}]
    assert len(catalog_lib.choose_subtitles(files, "ident")) == 1


# --- /api/v1/playback/captions ------------------------------------------------


def _caption_track(url, **meta):
    """Mint the caption handle the route now requires, and build its URL."""
    import playback_tokens

    token = playback_tokens.issue(playback_tokens.KIND_CAPTION, url, meta=meta or None)
    return f"/api/v1/playback/captions?track={token}"


def test_captions_route_serves_vtt_content_type():
    _, client = _client()
    _fake_archive(VTT_BODY)
    res = client.get(_caption_track("https://archive.org/download/x/a.vtt"))
    ctype = (res.headers.get("Content-Type") or "").lower()
    # A <track> is rejected outright if this is not WebVTT.
    assert "text/vtt" in ctype, ctype
    assert res.data.decode().startswith("WEBVTT")


def test_captions_route_converts_srt_upstream():
    _, client = _client()
    _fake_archive(SRT_BODY)
    res = client.get(_caption_track("https://archive.org/download/x/a.srt"))
    body = res.data.decode()
    assert res.status_code == 200
    assert body.startswith("WEBVTT"), body[:60]
    assert "00:00:09.000 --> 00:00:15.001" in body, body


def test_captions_route_converts_when_upstream_lies_about_type():
    # The node serves `text/plain` even for `.vtt`; the body is the truth.
    _, client = _client()
    _fake_archive(SRT_BODY, content_type="text/vtt")
    res = client.get(_caption_track("https://archive.org/download/x/a.vtt"))
    assert res.data.decode().startswith("WEBVTT"), res.data[:60]


def test_captions_route_rejects_non_archive_host():
    _, client = _client()
    res = client.get(_caption_track("https://evil.example.com/a.vtt"))
    assert res.status_code == 400, res.status_code
    assert res.get_json()["success"] is False


def test_captions_route_rejects_missing_handle():
    _, client = _client()
    assert client.get("/api/v1/playback/captions").status_code == 400
    assert client.get("/api/v1/playback/captions?track=not-a-token").status_code == 400


def test_captions_route_rejects_non_http_scheme():
    _, client = _client()
    res = client.get(_caption_track("file:///etc/passwd"))
    assert res.status_code == 400, res.status_code


def test_captions_route_reports_upstream_failure_as_json_502():
    _, client = _client()
    _fake_archive_failing()
    res = client.get(_caption_track("https://archive.org/download/x/a.vtt"))
    assert res.status_code == 502, res.status_code
    assert res.get_json()["success"] is False


def test_captions_route_rejects_oversized_payload():
    _, client = _client()
    import app as application

    original = application.SUBTITLE_MAX_BYTES
    application.SUBTITLE_MAX_BYTES = 32
    _fake_archive("WEBVTT\n\n" + ("x" * 500))
    try:
        res = client.get(_caption_track("https://archive.org/download/x/a.vtt"))
        assert res.status_code == 502, res.status_code
    finally:
        application.SUBTITLE_MAX_BYTES = original


def test_captions_route_rejects_truncated_caption_file():
    # A clipped caption file would fail mid-playback with no visible cause, so
    # the helper rejects rather than truncates.
    _, client = _client()

    def _truncating(url, timeout, max_bytes):
        raise ValueError("file exceeds the maximum subtitle size")

    import app as application

    application.catalog_lib.fetch_bounded_text = _truncating
    res = client.get(_caption_track("https://archive.org/download/x/a.vtt"))
    assert res.status_code == 502, res.status_code


def test_captions_route_honours_allowlist_inside_helper():
    # The helper is the single place the host allowlist is enforced; the route
    # must surface that as a 400 rather than a 502.
    #
    # It keys off the exception type, not its wording. The route used to decide
    # with `"archive.org" in str(error)`, so a rejection worded differently (a
    # scheme, a port, a credential in the authority) came back as a 502, which
    # reads as archive.org being down rather than as a refused request.
    _, client = _client()
    import app as application

    def _rejecting(url, timeout, max_bytes):
        raise application.catalog_lib.ArchiveUrlRejected(
            "stream URL must be http or https"
        )

    application.catalog_lib.fetch_bounded_text = _rejecting
    res = client.get(_caption_track("https://evil.example.com/a.vtt"))
    assert res.status_code == 400, res.status_code

    # A plain ValueError is the byte cap, which is an upstream refusal and stays
    # a 502 -- the two cases are no longer told apart by message text.
    def _oversized(url, timeout, max_bytes):
        raise ValueError("file exceeds the maximum subtitle size")

    application.catalog_lib.fetch_bounded_text = _oversized
    res = client.get(_caption_track("https://archive.org/download/x/a.vtt"))
    assert res.status_code == 502, res.status_code


def test_captions_body_is_sanitised_not_passed_through():
    # The upstream body is untrusted like any other relayed content: cue
    # payload overrides and unknown tags are stripped before the text reaches
    # the player, while the cue itself survives.
    _, client = _client()
    _fake_archive(
        "WEBVTT\n\n"
        "00:00:09.000 --> 00:00:15.000 line:0 position:20%\n"
        "<c.yellow>vivid</c> text\n"
    )
    res = client.get(_caption_track("https://archive.org/download/x/a.vtt"))
    body = res.data.decode()
    assert res.status_code == 200, body
    assert "vivid" in body, body
    assert "<c.yellow>" not in body, f"tag survived sanitising: {body}"
    assert "position:20%" not in body, f"cue override survived: {body}"


# --- /api/v1/playback/download ------------------------------------------------


def _download_leg(url, filename=None):
    """Mint the download handle the route now requires, and build its URL."""
    import playback_tokens

    meta = {"filename": filename} if filename else {}
    token = playback_tokens.issue(playback_tokens.KIND_DOWNLOAD, url, meta=meta or None)
    return f"/api/v1/playback/download?token={token}"


def test_download_sends_attachment_disposition():
    _, client = _client()
    _fake_archive(b"movie-bytes")
    res = client.get(
        _download_leg("https://archive.org/download/x/a.mp4", filename="Movie.mp4")
    )
    disposition = res.headers.get("Content-Disposition") or ""
    # Without `attachment` the browser navigates instead of saving.
    assert disposition.startswith("attachment;"), disposition
    assert "Movie.mp4" in disposition, disposition


def test_download_requires_a_handle():
    # The caller no longer supplies the URL at all: without a handle there is
    # nothing to serve, and the old URL-carrying aliases are gone rather than
    # left open as the un-tokenised door they were.
    _, client = _client()
    assert client.get("/api/v1/playback/download").status_code == 400
    assert client.get("/api/v1/playback/download?token=not-a-token").status_code == 400


def test_download_includes_utf8_filename_star():
    _, client = _client()
    _fake_archive(b"movie-bytes")
    res = client.get(
        _download_leg(
            "https://archive.org/download/x/a.mp4", filename="Amélie 2001.mp4"
        )
    )
    disposition = res.headers.get("Content-Disposition") or ""
    # Non-ASCII titles survive via the RFC 6266 UTF-8 form.
    assert "filename*=UTF-8''" in disposition, disposition
    assert "Am%C3%A9lie" in disposition, disposition


def test_download_falls_back_to_archive_filename():
    _, client = _client()
    _fake_archive(b"movie-bytes")
    res = client.get(
        _download_leg("https://archive.org/download/x/NightOfLivingDead.mp4")
    )
    assert "NightOfLivingDead.mp4" in (res.headers.get("Content-Disposition") or "")


def test_download_strips_header_injection_from_filename():
    _, client = _client()
    _fake_archive(b"movie-bytes")
    res = client.get(
        _download_leg(
            "https://archive.org/download/x/a.mp4",
            filename='bad"name\r\nX-Injected: yes',
        )
    )
    disposition = res.headers.get("Content-Disposition") or ""
    # CR/LF must never survive into the header value.
    assert "\r" not in disposition and "\n" not in disposition, repr(disposition)
    # The attempt is flattened into the quoted filename value; the CR/LF that
    # would have ended the header and started a new one are gone, and no
    # `:` survives that could be mistaken for a header separator.
    assert "X-Injected" in disposition, "the test payload should survive as text"
    assert ":" not in disposition.split("filename=")[1].split(";")[0], disposition


def test_download_strips_path_separators_from_filename():
    _, client = _client()
    _fake_archive(b"movie-bytes")
    res = client.get(
        _download_leg(
            "https://archive.org/download/x/a.mp4",
            filename="../../etc/passwd",
        )
    )
    disposition = res.headers.get("Content-Disposition") or ""
    assert "/" not in disposition.split(";")[1], disposition
    assert ".." not in disposition, disposition


def test_download_rejects_non_archive_host():
    # No fake: the real helper must refuse before any socket is opened, and the
    # refusal (ArchiveUrlRejected) is a 400, not an upstream failure.
    _, client = _client()
    res = client.get(_download_leg("https://evil.example.com/a.mp4"))
    assert res.status_code == 400, res.status_code
    assert res.get_json()["success"] is False


def test_download_reports_upstream_failure_as_json_502():
    _, client = _client()
    _fake_archive_failing()
    res = client.get(_download_leg("https://archive.org/download/x/a.mp4"))
    assert res.status_code == 502, res.status_code
    assert res.get_json()["success"] is False


def test_retired_playback_paths_are_gone():
    # The hard cut left no aliases behind. A 404 from each is the proof that
    # the un-tokenised doors -- which took a raw URL from the caller -- are not
    # quietly still serving.
    #
    # `/api/movies/resolve` is the one exception: it is back as a thin alias
    # for `/api/v1/playback/init` (same handler, same tokenised legs) because
    # the web client still calls it from three places. It is absent from this
    # list on purpose; test_stream_errors.py's resolve-alias tests pin why it
    # is safe to keep.
    _, client = _client()
    for path in (
        "/api/subtitles",
        "/api/movies/download",
        "/api/v1/stream/download",
        "/api/get-stream",
        "/api/movies/stream",
        "/api/movies/manifest",
        "/api/v1/stream/manifest",
    ):
        res = client.get(path)
        assert res.status_code == 404, f"{path} is still registered: {res.status_code}"


def test_safe_download_name_helper():
    import app as application

    assert application._safe_download_name("The Matrix (1999).mp4", "x") == "The Matrix (1999).mp4"
    assert application._safe_download_name("  ...  ", "fallback.mp4") == "fallback.mp4"
    assert "\r" not in application._safe_download_name("a\r\nb", "x")
    assert "/" not in application._safe_download_name("a/b", "x")
    # Unicode is preserved: the `filename*` form exists to carry it.
    assert "é" in application._safe_download_name("Amélie.mp4", "x")


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
    sys.exit(1 if _run() else 0)
