"""Tests for the TMDB artwork relay (`GET /api/image`).

Run with:  python3 test_image_relay.py

The hero samples its accent colour from the featured backdrop's own pixels, and
the browser can only do that if the artwork is same-origin *and* CORS-readable --
`image.tmdb.org` is neither, so the relay exists to make the canvas readable. Two
properties matter and are pinned here:

  1. It is not an open proxy. Only `image.tmdb.org`, over https, on a
     `/t/p/<size>/<file>` path may be relayed; anything else is refused, so this
     route can never be pointed at an arbitrary host through a victim's browser.
  2. The CORS answer is the shared allow-list hook's, not a wildcard.

Same approach as test_hardening.py: Flask's test client, no framework, and the
one upstream call is stubbed so nothing touches the network.
"""

import os
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="image-relay-tests-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "image-relay.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False

import app as application  # noqa: E402

ART_URL = "https://image.tmdb.org/t/p/original/abc123.jpg"


class _FakeResponse:
    """Enough of `requests.Response` for the relay: status, headers, body, and
    the context-manager protocol the handler closes it with."""

    def __init__(self, status_code=200, body=b"jpeg-bytes", content_type="image/jpeg"):
        self.status_code = status_code
        self.content = body
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _client():
    return application.app.test_client()


def _patch_get(fake):
    original = application.requests.get
    application.requests.get = fake
    return original


def test_image_relay_rejects_missing_url():
    client = _client()
    assert client.get("/api/image").status_code == 400
    assert client.get("/api/image", query_string={"url": "  "}).status_code == 400


def test_image_relay_rejects_non_tmdb_host():
    client = _client()
    for bad in (
        "https://evil.example/t/p/original/x.jpg",
        # A look-alike host must not pass: the check is exact-match on the
        # hostname, not a substring.
        "https://image.tmdb.org.evil.example/t/p/original/x.jpg",
        "https://notimage.tmdb.org/t/p/original/x.jpg",
    ):
        res = client.get("/api/image", query_string={"url": bad})
        assert res.status_code == 400, (bad, res.status_code)
        assert res.get_json().get("code") == "URL_NOT_ALLOWED", res.get_json()


def test_image_relay_rejects_non_https():
    client = _client()
    res = client.get(
        "/api/image", query_string={"url": "http://image.tmdb.org/t/p/original/x.jpg"}
    )
    assert res.status_code == 400, res.get_json()


def test_image_relay_rejects_non_artwork_paths():
    client = _client()
    for bad in (
        "https://image.tmdb.org/t/p/x.jpg",  # missing the size segment
        "https://image.tmdb.org/whatever/x.jpg",
        "https://image.tmdb.org/t/p/original/",  # no filename
    ):
        res = client.get("/api/image", query_string={"url": bad})
        assert res.status_code == 400, (bad, res.status_code)


def test_image_relay_answers_options():
    client = _client()
    assert client.options("/api/image").status_code == 204


def test_image_relay_relays_artwork_and_cors():
    client = _client()
    seen = {}

    def fake_get(url, timeout=None, stream=False):
        seen["url"] = url
        seen["timeout"] = timeout
        seen["stream"] = stream
        return _FakeResponse(body=b"image-bytes", content_type="image/jpeg")

    original = _patch_get(fake_get)
    try:
        res = client.get("/api/image", query_string={"url": ART_URL})
        assert res.status_code == 200, res.get_json()
        assert res.data == b"image-bytes"
        assert res.headers["Content-Type"] == "image/jpeg"
        assert "max-age" in res.headers.get("Cache-Control", "")
        # The upstream URL is passed through untouched, and it is streamed with
        # a bounded timeout rather than buffered open-endedly.
        assert seen["url"] == ART_URL
        assert seen["stream"] is True
        assert seen["timeout"] == application.TMDB_IMAGE_TIMEOUT_SECONDS

        # CORS comes from the shared allow-list hook: an allowlisted origin is
        # reflected (the canvas read needs it), a hostile one gets nothing.
        allowed = client.get(
            "/api/image",
            query_string={"url": ART_URL},
            headers={"Origin": "https://streamvy.me"},
        )
        assert allowed.headers.get("Access-Control-Allow-Origin") == "https://streamvy.me"

        hostile = client.get(
            "/api/image",
            query_string={"url": ART_URL},
            headers={"Origin": "https://evil.example"},
        )
        assert "Access-Control-Allow-Origin" not in hostile.headers, dict(hostile.headers)
    finally:
        application.requests.get = original


def test_image_relay_maps_upstream_failure_to_502():
    client = _client()
    original = _patch_get(lambda url, timeout=None, stream=False: _FakeResponse(status_code=404))
    try:
        res = client.get("/api/image", query_string={"url": ART_URL})
        assert res.status_code == 502, res.get_json()
    finally:
        application.requests.get = original


def test_image_relay_rejects_oversized_artwork():
    client = _client()
    too_big = b"x" * (application.TMDB_IMAGE_MAX_BYTES + 1)
    original = _patch_get(lambda url, timeout=None, stream=False: _FakeResponse(body=too_big))
    try:
        res = client.get("/api/image", query_string={"url": ART_URL})
        assert res.status_code == 502, res.get_json()
    finally:
        application.requests.get = original


def main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
        except Exception as error:  # noqa: BLE001
            failures += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}")
            traceback.print_exc()
        else:
            print(f"ok   {test.__name__}")
    print()
    print(f"{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
