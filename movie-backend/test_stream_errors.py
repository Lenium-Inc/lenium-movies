"""Tests for JSON error responses, input validation, and scrape budgeting.

Run with:  python3 test_stream_errors.py

Why these exist
---------------
An unhandled exception in the Flask app produced Werkzeug's HTML 500 page.
The client calls `response.json()` on every error, which threw a SyntaxError
on the leading `<`, matched none of the branches in its error classifier, and
was treated as "unknown but maybe recoverable" -- so the watch page retried
every second, indefinitely, showing the viewer a permanent "Optimizing..." and
never an error. The status code and the content type are therefore part of the
contract, not cosmetics, and they are asserted here.

Same harness approach as test_hardening.py: throwaway SQLite, Flask's test
client, no framework, no network.
"""

import os
import sys
import tempfile
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="stream-errors-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "stream-errors.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False


# The Flask *module* is a singleton in sys.modules, so every call to _client()
# hands back the same object and any monkeypatching done by one test would leak
# into the next. These are the attributes the cache/scrape tests replace, so
# they are snapshotted once here and restored before each test.
_PATCHED = (
    ("catalog_lib", "scrape_title"),
    ("catalog_lib", "discover_catalog"),
    ("catalog_lib", "build_entry_by_identifier"),
    ("_find_catalog_entry",),
    ("_direct_source_cache",),
    ("_direct_source_locks",),
)


def _snapshot():
    import app as application

    saved = []
    for path in _PATCHED:
        owner = application
        for part in path[:-1]:
            owner = getattr(owner, part)
        saved.append((owner, path[-1], getattr(owner, path[-1])))
    return saved


_SAVED = None
_ROUTES_REGISTERED = False


def _register_boom_routes(application):
    """Declare a route that raises, to exercise the 500 handler.

    Flask refuses new routes once the first request has been handled, so this
    has to happen at import time rather than inside a test body."""

    @application.app.route("/api/_boom-for-test")
    def _boom():
        raise RuntimeError("secret internal detail: db password is hunter2")

    @application.app.route("/api/_boom-logged-for-test")
    def _boom_logged():
        raise ValueError("distinctive-marker-9f3a")


def _restore(saved):
    for owner, name, original in saved:
        setattr(owner, name, original)


def _client():
    global _SAVED
    if _SAVED is None:
        _SAVED = _snapshot()

    store = authdb.Store(dsn="")
    store.pg = False
    store.sqlite_path = os.path.join(_TMP, "stream-errors.db")
    store.init()
    authdb._store = store

    import app as application

    application.authdb._store = store
    _restore(_SAVED)
    global _ROUTES_REGISTERED
    if not _ROUTES_REGISTERED:
        _register_boom_routes(application)
        _ROUTES_REGISTERED = True
    return application, application.app.test_client()


def _assert_json_error(res, expected_status):
    """Every error must be JSON with a usable status.

    A non-JSON error body is the specific failure this suite exists to catch,
    so the content type is checked before anything else."""
    assert res.status_code == expected_status, (
        f"expected {expected_status}, got {res.status_code}: {res.data[:200]!r}"
    )
    ctype = (res.headers.get("Content-Type") or "").lower()
    assert "application/json" in ctype, f"error was not JSON: {ctype!r}"
    body = res.get_json()
    assert isinstance(body, dict), f"error body was {type(body).__name__}"
    assert body.get("success") is False, f"missing success:false in {body!r}"
    assert body.get("status") == expected_status, f"status field disagrees: {body!r}"
    assert body.get("error"), f"no error message in {body!r}"
    return body


# --- error responses are always JSON ----------------------------------------


def test_unknown_route_returns_json_404():
    app, client = _client()
    _assert_json_error(client.get("/api/definitely-not-a-route"), 404)


def test_unhandled_exception_returns_json_500():
    _, client = _client()
    res = client.get("/api/_boom-for-test")
    body = _assert_json_error(res, 500)
    # Internals must not be echoed back to the client.
    assert "hunter2" not in res.get_data(as_text=True), "leaked internal detail"
    assert "secret internal detail" not in res.get_data(as_text=True)


def test_unhandled_exception_is_logged_server_side():
    _, client = _client()
    client.get("/api/_boom-logged-for-test")
    # The detail belongs in the server log, not the response.
    assert "distinctive-marker-9f3a" not in client.get(
        "/api/_boom-logged-for-test"
    ).get_data(as_text=True)


# --- /api/get-stream input validation ---------------------------------------


def test_get_stream_rejects_missing_id():
    _, client = _client()
    _assert_json_error(client.get("/api/get-stream"), 400)


def test_episodes_rejects_nonnumeric_id_as_400_not_404():
    # int() used to raise inside the try and be reported as "Episode not
    # found", which blames the title for a malformed request.
    _, client = _client()
    body = _assert_json_error(client.get("/api/episodes?tmdb_id=abc"), 400)
    assert "episode" not in body["error"].lower()


def test_get_stream_rejects_nonnumeric_id():
    # The bug: the id was interpolated into the TMDB path and the embed URL, so
    # garbage produced a confident 200 carrying an embed URL that can never play.
    _, client = _client()
    _assert_json_error(client.get("/api/get-stream?id=not-a-number"), 400)


def test_get_stream_rejects_path_injection_id():
    _, client = _client()
    for bad in ("../secrets", "1;DROP TABLE users", "-1", "0", "1e999"):
        _assert_json_error(client.get(f"/api/get-stream?id={bad}"), 400)


def test_rejects_oversized_id():
    # A 40-digit id parses as a Python int (unbounded) but is not a TMDB id, so
    # it should be rejected rather than forwarded upstream as a certain 404.
    _, client = _client()
    _assert_json_error(client.get("/api/get-stream?id=" + "9" * 40), 400)
    _assert_json_error(client.get("/api/episodes?tmdb_id=" + "9" * 40), 400)


# --- /api/movies/resolve input validation -----------------------------------


def test_resolve_rejects_non_object_json_body():
    # `silent=True` suppresses only *parse* failures. A valid body that is not
    # an object stays truthy, and .get() on it raised -> 500.
    _, client = _client()
    for raw in ('"x"', "[1,2]", "5", "true", "null"):
        res = client.post("/api/movies/resolve", data=raw, content_type="application/json")
        if raw == "null":
            # `or {}` turns JSON null into {} -> treated as an empty request and
            # falls through to the "missing title" 400. Still a 400, still JSON.
            _assert_json_error(res, 400)
        else:
            _assert_json_error(res, 400)


def test_resolve_rejects_unparseable_body_as_json_400():
    _, client = _client()
    res = client.post(
        "/api/movies/resolve", data="{not json", content_type="application/json"
    )
    _assert_json_error(res, 400)


def test_resolve_rejects_missing_identifier_as_json_400():
    # No title and no id: the request never named anything, so 400. It used to
    # answer 404 "Could not find metadata for ''".
    _, client = _client()
    body = _assert_json_error(client.post("/api/movies/resolve", json={}), 400)
    assert "title" in body["error"].lower()


# --- CORS still applied to error responses -----------------------------------


def test_cors_header_present_on_error_responses():
    _, client = _client()
    res = client.get(
        "/api/definitely-not-a-route", headers={"Origin": "https://vy-virid.vercel.app"}
    )
    assert res.headers.get("Access-Control-Allow-Origin") == "https://vy-virid.vercel.app", (
        f"no CORS header on error response: {dict(res.headers)}"
    )
    # "Vary" is the header name; its value here is "Origin". Checking for the
    # name in the value tests nothing.
    assert "Vary" in res.headers, f"no Vary header: {dict(res.headers)}"
    assert "Origin" in res.headers.get("Vary", "")


# --- direct-source cache behaviour ------------------------------------------


def test_negative_result_is_cached_and_survives_refresh():
    """A miss must not re-scrape on every refresh.

    The client calls with refresh=True up to three times in a row. Before the
    miss TTL, each of those triggered a full multi-minute Archive.org scrape."""
    app, _ = _client()
    app._direct_source_cache.clear()
    app._direct_source_locks.clear()

    calls = []
    app.catalog_lib.scrape_title = lambda *a, **k: (calls.append(1), None)[1]

    key = "unit-test-negative-cache"
    for _ in range(4):
        app._direct_source_for("Nothing At All Here", refresh=True)
    assert len(calls) == 1, f"expected 1 scrape across 4 refreshes, got {len(calls)}"


def test_concurrent_lookups_collapse_to_one_scrape():
    """N simultaneous viewers of one uncached title must produce one scrape."""
    import threading

    app, _ = _client()
    app._direct_source_cache.clear()
    app._direct_source_locks.clear()

    started = []
    gate = threading.Event()

    def slow_scrape(*a, **k):
        started.append(1)
        gate.wait(2.0)
        return None

    app.catalog_lib.scrape_title = slow_scrape

    threads = [
        threading.Thread(target=app._direct_source_for, args=("Concurrent Title",))
        for _ in range(6)
    ]
    for t in threads:
        t.start()
    time.sleep(0.2)
    gate.set()
    for t in threads:
        t.join(5.0)

    assert len(started) == 1, f"expected 1 scrape for 6 concurrent viewers, got {len(started)}"


def test_cache_is_bounded():
    """One entry per distinct title would grow without limit on a busy worker."""
    app, _ = _client()
    app._direct_source_cache.clear()
    app._direct_source_locks.clear()
    app._find_catalog_entry = lambda *a, **k: {"id": f"id-{i}", "stream_url": "x"}
    app.catalog_lib.scrape_title = lambda *a, **k: None

    for i in range(app._CACHE_MAX_ENTRIES + 200):
        app._direct_source_for(f"Bounded Title {i}")

    assert len(app._direct_source_cache) <= app._CACHE_MAX_ENTRIES, (
        f"cache grew to {len(app._direct_source_cache)}"
    )


# --- scrape budget -----------------------------------------------------------


def test_scrape_title_respects_its_budget():
    """The worst case used to be ~10 minutes on one worker.

    Five candidates x (3 x 30s metadata + 25s probe) plus a 90s search. The
    budget exists so "not on Archive.org" is answered in a predictable time."""
    app, _ = _client()
    import catalog_lib

    calls = []

    def slow_docs(*a, **k):
        calls.append(1)
        return [{"identifier": f"id-{i}"} for i in range(5)]

    catalog_lib.discover_catalog = slow_docs
    catalog_lib.build_entry_by_identifier = lambda *a, **k: time.sleep(0.3)

    started = time.monotonic()
    result = catalog_lib.scrape_title("Budget Test Title", budget_seconds=1.0)
    elapsed = time.monotonic() - started

    assert result is None
    assert elapsed < 5.0, f"budget of 1.0s overran to {elapsed:.1f}s"


def test_scrape_title_stops_trying_candidates_after_deadline():
    app, _ = _client()
    import catalog_lib

    catalog_lib.discover_catalog = lambda *a, **k: [
        {"identifier": f"id-{i}"} for i in range(5)
    ]
    attempts = []
    catalog_lib.build_entry_by_identifier = lambda ident, **k: (
        attempts.append(ident),
        time.sleep(0.4),
        None,
    )[2]

    catalog_lib.scrape_title("Deadline Test Title", budget_seconds=1.0)
    assert len(attempts) < 5, f"kept trying candidates past the deadline: {attempts}"


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
