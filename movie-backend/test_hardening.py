"""Tests for request validation and CORS policy.

Run with:  python3 test_hardening.py

Same approach as test_shares.py: a throwaway SQLite database, Flask's test
client, no framework and no network.
"""

import os
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="hardening-tests-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "hardening.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False


def _fresh_client():
    store = authdb.Store(dsn="")
    store.pg = False
    store.sqlite_path = os.path.join(_TMP, "hardening.db")
    store.init()
    authdb._store = store

    import app as application

    application.authdb._store = store
    return store, application.app.test_client()


def _account(client, email):
    res = client.post(
        "/api/auth/signup",
        json={"email": email, "name": "Tester", "password": "pw123456"},
    )
    assert res.status_code in (200, 201), (res.status_code, res.get_json())
    return res.get_json()["token"]


def test_history_requires_authentication():
    _store, client = _fresh_client()
    # No token at all.
    assert client.post("/api/auth/history", json={"movie_key": "m1"}).status_code == 401
    assert client.get("/api/auth/history").status_code == 401
    # A token that was never issued.
    res = client.post(
        "/api/auth/history",
        json={"movie_key": "m1"},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert res.status_code == 401
    # Right shape, wrong scheme.
    res = client.post(
        "/api/auth/history",
        json={"movie_key": "m1"},
        headers={"Authorization": "Basic YWJjOmRlZg=="},
    )
    assert res.status_code == 401


def test_history_rejects_junk_instead_of_crashing():
    """Every one of these was an unhandled 500 before validation."""
    _store, client = _fresh_client()
    token = _account(client, "junk@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    hostile = [
        {"movie_key": "m1"},                                  # no title -> NOT NULL
        {"movie_key": "m2", "title": "T", "progress_seconds": "abc"},
        {"movie_key": "m3", "title": "T", "duration_seconds": {"a": 1}},
        {"movie_key": "m4", "title": "T", "watched_at": "soon"},
        {"movie_key": "m5", "title": "T", "year": "not-a-year"},
        {"movie_key": "m6", "title": ["a", "list"]},
        {"movie_key": "m7", "title": "T", "progress_seconds": -99999},
        {"movie_key": "m8", "title": "T", "progress_seconds": 10**12},
        {"movie_key": 12, "title": "T", "media_type": "audiobook"},
        {"movie_key": "m9", "title": "T", "completed": {"truthy": True}},
        {"movie_key": {"nested": "dict"}, "title": "T"},
        {"movie_key": True, "title": "T"},
        {},
        {"movie_key": "   ", "title": "T"},
    ]
    for payload in hostile:
        res = client.post("/api/auth/history", json=payload, headers=auth)
        assert res.status_code in (200, 400), (
            payload,
            res.status_code,
            res.get_json(),
        )
        assert res.status_code != 500, f"500 for {payload}"


def test_history_stores_sanitised_values():
    store, client = _fresh_client()
    token = _account(client, "clean@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    res = client.post(
        "/api/auth/history",
        json={
            "movie_key": "movie-1",
            "title": "Arrival",
            "year": 2016,
            "media_type": "movie",
            "progress_seconds": 120,
            "duration_seconds": 7200,
            "completed": True,
        },
        headers=auth,
    )
    assert res.status_code == 200, res.get_json()

    rows = client.get("/api/auth/history", headers=auth).get_json()["history"]
    assert len(rows) == 1
    row = rows[0]
    assert row["movie_key"] == "movie-1" and row["title"] == "Arrival"
    assert row["progress_seconds"] == 120 and row["completed"] in (1, True, "1")

    # A missing title falls back to the key rather than violating NOT NULL.
    client.post("/api/auth/history", json={"movie_key": "movie-2"}, headers=auth)
    rows = client.get("/api/auth/history", headers=auth).get_json()["history"]
    titles = {r["movie_key"]: r["title"] for r in rows}
    assert titles["movie-2"] == "movie-2", titles

    # Long strings are capped, and absurd offsets are clamped.
    client.post(
        "/api/auth/history",
        json={"movie_key": "movie-3", "title": "A" * 5000, "progress_seconds": 10**9},
        headers=auth,
    )
    rows = client.get("/api/auth/history", headers=auth).get_json()["history"]
    capped = next(r for r in rows if r["movie_key"] == "movie-3")
    assert len(capped["title"]) <= 300, len(capped["title"])
    assert capped["progress_seconds"] <= 60 * 60 * 12

    # One account cannot write into another's history.
    other = _account(client, "other@example.com")
    client.post(
        "/api/auth/history",
        json={"movie_key": "movie-1", "title": "Poisoned"},
        headers={"Authorization": f"Bearer {other}"},
    )
    rows = client.get("/api/auth/history", headers=auth).get_json()["history"]
    mine = {r["movie_key"]: r["title"] for r in rows}
    assert mine["movie-1"] == "Arrival", mine


def test_cors_is_not_a_wildcard():
    _store, client = _fresh_client()

    # A hostile origin gets no CORS headers at all, so the browser blocks it.
    res = client.get("/api/auth/me", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in res.headers, dict(res.headers)

    # Reflecting an arbitrary origin is the classic CORS bug.
    res = client.get(
        "/api/auth/me", headers={"Origin": "https://vy-virid.vercel.app.evil.example"}
    )
    assert "Access-Control-Allow-Origin" not in res.headers

    # The production frontend is allowed, and credentials ride along with it.
    res = client.get(
        "/api/auth/me", headers={"Origin": "https://vy-virid.vercel.app"}
    )
    assert res.headers.get("Access-Control-Allow-Origin") == "https://vy-virid.vercel.app"
    assert res.headers.get("Access-Control-Allow-Credentials") == "true"

    # A same-origin request (no Origin header) needs no CORS headers.
    res = client.get("/api/auth/me")
    assert "Access-Control-Allow-Origin" not in res.headers

    # Vary is what stops a cache serving one origin's response to another.
    assert "Origin" in res.headers.get("Vary", "")

    # Preflight is answered for allowed origins and denied for others.
    ok = client.options(
        "/api/auth/shares",
        headers={
            "Origin": "https://vy-virid.vercel.app",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert ok.headers.get("Access-Control-Allow-Origin") == "https://vy-virid.vercel.app"
    assert "POST" in ok.headers.get("Access-Control-Allow-Methods", "")
    assert "Authorization" in ok.headers.get("Access-Control-Allow-Headers", "")

    denied = client.options(
        "/api/auth/shares",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "Access-Control-Allow-Origin" not in denied.headers


def test_every_share_route_answers_the_preflight():
    """A share POST cannot be blocked by a failed preflight.

    `POST /api/auth/shares` carries `Content-Type: application/json` and
    `Authorization`, neither of which is CORS-safelisted, so the browser sends
    `OPTIONS` first and only sends the real request if that preflight succeeds.
    A preflight that 404s -- which is what a deploy predating the share routes
    returns -- makes the browser drop the request before it is ever sent, and the
    page sees a bare `TypeError: Failed to fetch` with no HTTP status, no body,
    and no hint that the endpoint is fine.

    The header assertions elsewhere in this file cannot catch that, because a 404
    can still carry CORS headers. So the status is what gets pinned here, for
    every route the share UI touches rather than just the collection endpoint.
    """
    _store, client = _fresh_client()

    import app as application

    # (path, method the browser will actually follow up with)
    routes = [
        ("/api/auth/shares", "POST"),
        ("/api/auth/shares/some-token", "GET"),
        ("/api/auth/shares/some-token/accept", "POST"),
        ("/api/auth/shares/some-token/members", "GET"),
        ("/api/auth/shares/some-token/members/some-user", "DELETE"),
        ("/api/auth/shares/some-token/revoke", "POST"),
        ("/api/auth/shared/some-owner/my-list", "GET"),
    ]

    for path, method in routes:
        res = client.options(
            path,
            headers={
                "Origin": "https://vy-virid.vercel.app",
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        # A non-2xx preflight is what breaks the flow, so assert it first and
        # most directly -- the message names the route, which the header-only
        # checks below could not.
        assert 200 <= res.status_code < 300, (
            f"preflight for {path} ({method}) returned {res.status_code}; the "
            "browser would block the real request and the client would only see "
            "'Failed to fetch'"
        )
        assert (
            res.headers.get("Access-Control-Allow-Origin")
            == "https://vy-virid.vercel.app"
        ), f"{path} did not reflect the allowed origin"
        for header in ("Authorization", "Content-Type"):
            assert header in res.headers.get(
                "Access-Control-Allow-Headers", ""
            ), f"{path} preflight does not allow {header}"

        # The advertised methods come from one global constant, so they are the
        # same on every route and prove nothing about this one. What matters is
        # that the rule really accepts the verb: a route that only declares GET
        # still answers the preflight happily and then returns 405 to the actual
        # request, which reaches the app as a real error rather than a blocked
        # one, so it needs its own check.
        adapter = application.app.url_map.bind("localhost")
        try:
            # `match(..., method=...)` raises rather than returning a rule that
            # cannot serve the verb, so simply not raising is the check.
            rule, _args = adapter.match(path, method=method, return_rule=True)
        except Exception as error:  # noqa: BLE001
            raise AssertionError(
                f"{path} is not served for {method} by any registered rule "
                f"({type(error).__name__}: {error})"
            ) from error
        assert method in rule.methods, f"{path} matched {rule} without {method}"


def test_fingerprint_headers_are_scrubbed():
    _store, client = _fresh_client()
    res = client.get("/")
    for header in (
        "X-Powered-By",
        "X-Render-Origin-Server",
        "rndr-id",
        "X-AspNet-Version",
    ):
        assert header not in res.headers, f"{header} leaked: {dict(res.headers)}"


def test_trailer_route_validates_and_looks_up_by_media_type():
    """`/api/catalog/movieTrailer` is what the home hero calls.

    It was dropped in 33bd5c7 as collateral from a client-only change, so every
    hero trailer 404ed and the client reported "no trailer" for every title.
    These pin the validation, the media-type hand-off and the payload shape --
    the client parses `{trailer: {provider, id}}` and nothing else.
    """
    _store, client = _fresh_client()
    import app as application

    calls = []

    def fake_key(media_id, media_type):
        calls.append((media_id, media_type))
        return "L2NAh3CIdig" if media_type == "movie" else None

    original = application.tmdb.get_trailer_key
    application.tmdb.get_trailer_key = fake_key
    try:
        assert client.get("/api/catalog/movieTrailer").status_code == 400
        assert client.get("/api/catalog/movieTrailer?id=abc").status_code == 400

        res = client.get("/api/catalog/movieTrailer?id=299534&media_type=movie")
        assert res.status_code == 200, res.get_json()
        assert res.get_json() == {
            "trailer": {"provider": "youtube", "id": "L2NAh3CIdig"}
        }
        assert calls[-1] == (299534, "movie")

        # A TMDB id is only meaningful against its own type: the same number can
        # name a film and a series, and asking for the wrong one returns a real
        # but incorrect trailer rather than an error.
        res = client.get("/api/catalog/movieTrailer?id=66732&media_type=tv")
        assert res.status_code == 200
        assert res.get_json() == {"trailer": None}
        assert calls[-1] == (66732, "tv")

        # An unrecognised media type falls back to movie instead of erroring.
        res = client.get("/api/catalog/movieTrailer?id=1&media_type=audiobook")
        assert res.status_code == 200
        assert calls[-1] == (1, "movie")

        assert client.options("/api/catalog/movieTrailer").status_code == 204
    finally:
        application.tmdb.get_trailer_key = original


def test_select_trailer_key_prefers_official_trailer():
    """The selector must rank on `official`, not just on the word "Trailer".

    TMDB marks third-party reuploads as official=false. Those are the ones that
    tend to be taken down or have embedding disabled, so an unofficial Trailer
    has to lose to an official Teaser. A real trailer from the rights holder
    still wins outright, and the order of the input list must not matter.
    """
    import tmdb_service

    assert (
        tmdb_service.select_trailer_key(
            [
                {"site": "YouTube", "key": "clip1", "type": "Clip", "official": True},
                {"site": "YouTube", "key": "unofficial", "type": "Trailer", "official": False},
                {"site": "YouTube", "key": "teaser1", "type": "Teaser", "official": True},
            ]
        )
        == "teaser1"
    )

    assert (
        tmdb_service.select_trailer_key(
            [
                {"site": "YouTube", "key": "teaser1", "type": "Teaser", "official": True},
                {"site": "YouTube", "key": "real1", "type": "Trailer", "official": True},
            ]
        )
        == "real1"
    )

    # Input order is not a ranking signal.
    assert (
        tmdb_service.select_trailer_key(
            [
                {"site": "YouTube", "key": "real1", "type": "Trailer", "official": True},
                {"site": "YouTube", "key": "teaser1", "type": "Teaser", "official": True},
            ]
        )
        == "real1"
    )


def test_select_trailer_key_never_returns_missing_or_wrong_site():
    """A title with no usable YouTube video must report None, not a broken key.

    Returning a key with no video behind it is what mounts an embed that can
    only fail, so the caller needs to be able to fall back to the backdrop.
    """
    import tmdb_service

    assert tmdb_service.select_trailer_key([]) is None
    assert tmdb_service.select_trailer_key(None) is None
    # Vimeo-only entries are not embeddable by the client.
    assert (
        tmdb_service.select_trailer_key(
            [{"site": "Vimeo", "key": "abc123", "type": "Trailer", "official": True}]
        )
        is None
    )
    # A YouTube entry with no key is not usable.
    assert (
        tmdb_service.select_trailer_key(
            [{"site": "YouTube", "key": None, "type": "Trailer", "official": True}]
        )
        is None
    )


def test_select_trailer_key_keeps_a_trailer_when_that_is_all_there_is():
    """Long-tail titles have no official upload at all; do not blank them.

    Audited against TMDB: NCIS, The Office, Doraemon and others carry only a
    non-official Trailer. Returning None there would remove a trailer that
    currently plays, so an unofficial Trailer has to remain the last resort --
    but only after every official candidate has been rejected.
    """
    import tmdb_service

    assert (
        tmdb_service.select_trailer_key(
            [{"site": "YouTube", "key": "onlyone", "type": "Trailer", "official": False}]
        )
        == "onlyone"
    )

    # An official Behind the Scenes still beats a non-official Trailer: the
    # rights holder published it, and non-official uploads are what break.
    assert (
        tmdb_service.select_trailer_key(
            [
                {"site": "YouTube", "key": "bs1", "type": "Behind the Scenes", "official": True},
                {"site": "YouTube", "key": "unofficial", "type": "Trailer", "official": False},
            ]
        )
        == "bs1"
    )


def test_get_trailer_key_delegates_to_the_shared_selector():
    """`get_trailer_key` had its own copy of the ranking, which drifted.

    Both copies ranked on `type == "Trailer"` and then fell back to the first
    YouTube video of any type, so a title whose only upload is a Featurette
    played a behind-the-scenes clip under the title card. This pins the
    single-source-of-truth wiring so a third copy cannot appear silently.
    """
    import tmdb_service

    captured = {}

    def fake_get(endpoint, params=None):
        captured["endpoint"] = endpoint
        return {
            "results": [
                {"site": "YouTube", "key": "bts1", "type": "Behind the Scenes", "official": True},
                {"site": "YouTube", "key": "real1", "type": "Trailer", "official": True},
            ]
        }

    original = tmdb_service._tmdb_get
    tmdb_service._tmdb_get = fake_get
    try:
        assert tmdb_service.get_trailer_key(299534, "movie") == "real1"
        assert captured["endpoint"] == "/movie/299534/videos"
    finally:
        tmdb_service._tmdb_get = original


def test_details_route_uses_shared_trailer_selection():
    """`/api/media/<id>` had a third inline copy of the buggy ranking."""
    _store, client = _fresh_client()
    import app as application

    def fake_tmdb_get(endpoint, params=None):
        if endpoint.startswith("/movie/"):
            return {
                "id": 42,
                "title": "Test Movie",
                "release_date": "2024-01-02",
                "videos": {
                    "results": [
                        {
                            "site": "YouTube",
                            "key": "behind1",
                            "type": "Behind the Scenes",
                            "official": True,
                        },
                        {
                            "site": "YouTube",
                            "key": "trailer1",
                            "type": "Trailer",
                            "official": True,
                        },
                    ]
                },
                "genres": [],
            }
        return None

    original = application._tmdb_get
    application._tmdb_get = fake_tmdb_get
    try:
        res = client.get("/api/media/42")
        assert res.status_code == 200, res.get_json()
        assert res.get_json().get("trailer_key") == "trailer1"
    finally:
        application._tmdb_get = original


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
