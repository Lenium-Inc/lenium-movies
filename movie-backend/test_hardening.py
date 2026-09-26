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
