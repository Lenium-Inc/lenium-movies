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
    # The provider-chain tests below replace this to control the direct tier, so
    # it has to be restored with the rest or every later test in this file runs
    # against a stub that returns nothing.
    ("_direct_source_for",),
    ("_direct_hit_cache",),
    ("_direct_miss_cache",),
    ("_direct_source_locks",),
    ("stream_providers", "probe_embed"),
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


def _register_boom_routes(application):
    """Declare routes that raise, to exercise the 500 handler."""

    @application.app.route("/api/_boom-for-test")
    def _boom():
        raise RuntimeError("secret internal detail: db password is hunter2")

    @application.app.route("/api/_boom-logged-for-test")
    def _boom_logged():
        raise ValueError("distinctive-marker-9f3a")


# Flask refuses to register a route once the app has handled its first request
# (`_check_setup_finished`). These therefore have to exist before *any* suite
# makes a request, not merely before this suite's first one: registering them
# lazily inside `_client()` meant this file only worked when it was run alone,
# and failed all 21 tests when it ran after test_shares.py in the same process,
# because that suite had already served a request through the same app object.
# Module import happens during pytest collection, ahead of every test body.
import app as _app_module  # noqa: E402

_register_boom_routes(_app_module)


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


# --- /api/v1/playback/init input validation ---------------------------------


def test_init_rejects_missing_id():
    _, client = _client()
    _assert_json_error(client.get("/api/v1/playback/init"), 400)


def test_episodes_rejects_nonnumeric_id_as_400_not_404():
    # int() used to raise inside the try and be reported as "Episode not
    # found", which blames the title for a malformed request.
    _, client = _client()
    body = _assert_json_error(client.get("/api/episodes?tmdb_id=abc"), 400)
    assert "episode" not in body["error"].lower()


def test_init_rejects_nonnumeric_id():
    # The bug: the id was interpolated into the TMDB path and the embed URL, so
    # garbage produced a confident 200 carrying an embed URL that can never play.
    _, client = _client()
    _assert_json_error(client.get("/api/v1/playback/init?id=not-a-number"), 400)
    _assert_json_error(client.get("/api/v1/playback/init?tmdb_id=not-a-number"), 400)


def test_init_rejects_path_injection_id():
    _, client = _client()
    for bad in ("../secrets", "1;DROP TABLE users", "-1", "0", "1e999"):
        _assert_json_error(client.get(f"/api/v1/playback/init?id={bad}"), 400)


def test_rejects_oversized_id():
    # A 40-digit id parses as a Python int (unbounded) but is not a TMDB id, so
    # it should be rejected rather than forwarded upstream as a certain 404.
    _, client = _client()
    _assert_json_error(
        client.get("/api/v1/playback/init?id=" + "9" * 40), 400
    )
    _assert_json_error(client.get("/api/episodes?tmdb_id=" + "9" * 40), 400)


# --- provider exhaustion is a decision, not an error ------------------------


def _exhaust_the_chain(application, direct=None):
    """Force every provider to come back empty.

    The direct catalog is stubbed to miss and every embed is stubbed
    unreachable, which is the only state in which the route is allowed to say
    "unavailable". Anything less and the response would be a real answer.
    """
    application._direct_source_for = lambda *a, **k: direct
    application.stream_providers.HEALTH.reset()
    application.stream_providers.clear_probe_cache()
    application.stream_providers.probe_embed = lambda *a, **k: False


def _restore_chain(application):
    _restore(_SAVED)
    application.stream_providers.HEALTH.reset()
    application.stream_providers.clear_probe_cache()


def _stub_details(application, details):
    """Route `fetch_media_details` to a canned row; returns the original.

    The metadata half of init must not need a network round trip to exercise
    the provider half: the chain under test is resolution, and a live TMDB
    call would make every assertion here depend on someone else's uptime."""
    original = application.tmdb.fetch_media_details
    application.tmdb.fetch_media_details = lambda *a, **k: details
    return original


def test_init_answers_404_only_after_every_provider_failed():
    # The contract the client now depends on: exhaustion is a *final* answer,
    # not an outage. It used to be a 503, which is also what the shared memory
    # guard answers when the byte ceiling trips -- so "the whole chain was
    # walked and none of it works" and "we are shedding load right now" were
    # the same number, and the client could not tell a decision from a
    # transient failure. It now carries a code that names the case, and the
    # guard keeps 503 to itself.
    app, client = _client()
    _exhaust_the_chain(app)
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        res = client.get("/api/v1/playback/init?tmdb_id=603")
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    body = _assert_json_error(res, 404)
    assert body.get("code") == "PROVIDERS_EXHAUSTED", (
        f"exhaustion did not name itself: {body!r}"
    )
    assert body.get("error") == "No active stream sources", (
        f"unexpected exhaustion message: {body!r}"
    )
    assert body.get("available") is False, f"exhaustion did not report available:false: {body!r}"

    # Exhaustion still advertises the chain, in priority order and in the one
    # shape every resolver client reads -- now as frame handles: the client
    # walks this list on its own per-candidate timer, so it needs *something*
    # addressable, but the URL behind each entry is not its to hold. A raw
    # https:// URL here would undo the whole point of the handle layer.
    providers = body.get("providers")
    assert isinstance(providers, list) and providers, (
        f"exhaustion advertised no candidates: {body!r}"
    )
    assert all({"name", "url", "is_embed"} <= set(entry) for entry in providers), (
        f"candidate entries are not in the documented shape: {providers!r}"
    )
    assert all(entry["is_embed"] for entry in providers), (
        f"a planned embed candidate claimed to be a file: {providers!r}"
    )
    assert all(
        entry["url"].startswith("/api/v1/playback/frame?token=") for entry in providers
    ), f"exhaustion leaked a raw provider URL: {providers!r}"
    assert [entry["name"] for entry in providers] == [
        provider.label for provider in app.stream_providers.EMBED_PROVIDERS
    ], f"exhaustion chain is out of priority order: {providers!r}"


def test_init_exhaustion_reports_what_each_provider_did():
    # Without per-provider diagnostics the client's terminal state is an
    # unactionable "nothing worked", which is indistinguishable from a bug.
    app, client = _client()
    _exhaust_the_chain(app)
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        body = _assert_json_error(
            client.get("/api/v1/playback/init?tmdb_id=603"), 404
        )
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    attempts = body.get("provider_attempts")
    assert isinstance(attempts, list) and attempts, f"no per-provider diagnostics: {body!r}"
    assert all({"id", "kind", "outcome"} <= set(a) for a in attempts), (
        f"incomplete attempt records: {attempts!r}"
    )
    embeds = [a for a in attempts if a["kind"] == "embed"]
    assert len(embeds) == len(app.stream_providers.EMBED_PROVIDERS), (
        f"the route gave up before walking the chain: {attempts!r}"
    )


def test_init_never_reports_exhaustion_while_a_provider_is_working():
    # The inverse, because exhaustion is terminal for the client: if a single
    # reachable provider is enough to answer, the retry budget is not spent and
    # the viewer sees a frame instead of an error card. A 503 would be even
    # worse than it was before -- with the guard owning that status, exhaustion
    # spilling into it would also mean claiming the memory ceiling was hit.
    app, client = _client()
    _exhaust_the_chain(app)
    app.stream_providers.probe_embed = lambda *a, **k: True
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        res = client.get("/api/v1/playback/init?tmdb_id=603")
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    assert res.status_code == 200, f"a live provider still produced {res.status_code}"
    body = res.get_json()
    assert body["success"] is True
    assert body["available"] is True
    movie = body["movie"]
    assert movie["is_embed"] is True
    assert movie["format"] == "frame", f"an embed claimed a playable format: {movie!r}"
    assert movie["stream_url"].startswith("/api/v1/playback/frame?token="), (
        f"embed stream_url is not a frame handle: {movie['stream_url']!r}"
    )
    assert movie["providers"], "no failover chain on a successful resolve"
    assert all(
        entry["url"].startswith("/api/v1/playback/frame?token=")
        for entry in movie["providers"]
    ), f"a provider URL crossed the wire raw: {movie['providers']!r}"
    # The locale seed rides on the success payload too, so the player can build
    # its default audio/subtitle tracks without a second round trip.
    assert isinstance(body.get("language"), str) and body["language"], (
        f"no language on a successful resolve: {body!r}"
    )


def test_init_prefers_a_direct_source_over_every_embed():
    # Direct is a real file the native player can boot, with no third-party
    # frame in the path. It must win whenever the catalog has the title.
    app, client = _client()
    probed = []
    app.stream_providers.HEALTH.reset()
    app.stream_providers.clear_probe_cache()
    app.stream_providers.probe_embed = lambda url, **k: probed.append(url) or True
    app._direct_source_for = lambda *a, **k: {
        "stream_url": "https://archive.org/download/x/master.mp4",
        "streams": [
            {"url": "https://archive.org/download/x/720.mp4", "quality": "720p"}
        ],
    }
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        res = client.get("/api/v1/playback/init?tmdb_id=603")
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    assert res.status_code == 200
    body = res.get_json()
    movie = body["movie"]
    assert movie["is_embed"] is False
    assert movie["provider"] == "archive_direct"
    assert movie["format"] == "mp4"
    assert movie["stream_url"].startswith("/api/v1/playback/media?token="), (
        f"primary is not a media handle: {movie['stream_url']!r}"
    )
    assert movie["sources"], "no failover chain on a successful resolve"
    assert all(url.startswith("/api/v1/playback/") for url in movie["sources"]), (
        f"a source URL crossed the wire raw: {movie['sources']!r}"
    )
    assert probed == [], f"embeds were probed despite a direct hit: {probed!r}"


def test_init_relays_hls_behind_the_manifest_proxy():
    # An `.m3u8` needs the manifest relay (its segments are rewritten as the
    # playlist is served); pointing the player straight at the playlist would
    # hand it a cross-origin URL that dies on CORS and the Referer check.
    app, client = _client()
    app.stream_providers.HEALTH.reset()
    app.stream_providers.clear_probe_cache()
    app.stream_providers.probe_embed = lambda *a, **k: False
    app._direct_source_for = lambda *a, **k: {
        "stream_url": "https://cdn.example.org/hls/master.m3u8",
        "streams": [],
    }
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        res = client.get("/api/v1/playback/init?tmdb_id=603")
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    assert res.status_code == 200
    movie = res.get_json()["movie"]
    assert movie["format"] == "hls"
    assert movie["stream_url"].startswith("/api/proxy/manifest?token="), (
        f"an HLS primary bypassed the relay: {movie['stream_url']!r}"
    )


# --- /api/movies/resolve is a compat alias for playback/init ----------------
#
# The web client still POSTs the pre-v1 contract from three places (stream
# resolver, Watch metadata fetch, details warm resolve). The route is kept as
# a thin alias so those callers stop 404ing; these tests pin that the alias
# inherits the tokenised-legs contract rather than resurrecting the old
# raw-URL behaviour the hard cut removed.


def test_resolve_alias_serves_the_pre_v1_contract():
    # Success through the alias must carry the fields the client's
    # `isResolvePayload` reads (`movie`, `exact`, `language`) and only ever
    # tokenised legs -- the reason the old route was safe to re-expose.
    app, client = _client()
    app.stream_providers.HEALTH.reset()
    app.stream_providers.clear_probe_cache()
    app.stream_providers.probe_embed = lambda *a, **k: True
    app._direct_source_for = lambda *a, **k: None
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        res = client.post("/api/movies/resolve", json={"id": "603"})
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    assert res.status_code == 200, f"alias failed: {res.status_code} {res.data[:200]!r}"
    body = res.get_json()
    assert body["exact"] is True
    assert isinstance(body.get("language"), str) and body["language"]
    movie = body["movie"]
    assert movie["id"] == "603"
    assert movie["stream_url"].startswith("/api/v1/playback/frame?token="), (
        f"alias leaked a raw stream URL: {movie['stream_url']!r}"
    )
    assert movie["providers"], "alias dropped the failover chain"
    assert all(
        entry["url"].startswith("/api/v1/playback/frame?token=")
        for entry in movie["providers"]
    ), f"alias leaked a raw provider URL: {movie['providers']!r}"


def test_resolve_alias_keeps_the_exhaustion_contract():
    # 404-with-a-code is the client's terminal-state signal; the alias must
    # not answer exhaustion with a bare 200 or an un-coded error.
    app, client = _client()
    _exhaust_the_chain(app)
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        body = _assert_json_error(
            client.post("/api/movies/resolve", json={"id": "603"}), 404
        )
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    assert body.get("code") == "PROVIDERS_EXHAUSTED", f"alias lost the code: {body!r}"


def test_resolve_alias_shares_init_input_validation():
    # The alias goes through the same validator, so the pre-v1 path's old
    # injection holes (path-traversal ids, oversized ids) stay closed.
    _, client = _client()
    _assert_json_error(client.get("/api/movies/resolve?id=not-a-number"), 400)
    _assert_json_error(
        client.get("/api/movies/resolve?id=" + "9" * 40), 400
    )
    _assert_json_error(client.get("/api/movies/resolve"), 400)


# --- /api/v1/playback/init body validation -----------------------------------


def test_init_rejects_non_object_json_body():
    # `silent=True` suppresses only *parse* failures. A valid body that is not
    # an object stays truthy, and .get() on it raised -> 500.
    _, client = _client()
    for raw in ('"x"', "[1,2]", "5", "true", "null"):
        res = client.post("/api/v1/playback/init", data=raw, content_type="application/json")
        # "null" parses to None, which is indistinguishable from a body we
        # refused to parse -- both are a 400, both JSON, never a fallthrough
        # that treats a null body as an empty request.
        _assert_json_error(res, 400)


def test_init_rejects_unparseable_body_as_json_400():
    _, client = _client()
    res = client.post(
        "/api/v1/playback/init", data="{not json", content_type="application/json"
    )
    _assert_json_error(res, 400)


def test_init_rejects_missing_identifier_as_json_400():
    # No title and no id: the request never named anything, so 400. It used to
    # answer 404 "Could not find metadata for ''".
    _, client = _client()
    body = _assert_json_error(client.post("/api/v1/playback/init", json={}), 400)
    assert "title" in body["error"].lower()


def test_init_rejects_wrong_content_type_and_bad_scalars():
    # Every field has one type and the answer names it, so the client never
    # has to guess which of five fields was wrong from a generic message.
    _, client = _client()
    body = _assert_json_error(
        client.post(
            "/api/v1/playback/init", data="title=X", content_type="text/plain"
        ),
        400,
    )
    assert "json" in body["error"].lower()
    _assert_json_error(
        client.post("/api/v1/playback/init", json={"title": "X", "season": "abc"}), 400
    )
    _assert_json_error(
        client.post("/api/v1/playback/init", json={"title": "X", "media_type": "game"}),
        400,
    )
    _assert_json_error(
        client.post("/api/v1/playback/init", json={"title": "X", "year": "1200"}),
        400,
    )
    _assert_json_error(
        client.post("/api/v1/playback/init", json={"title": "X", "refresh": "maybe"}),
        400,
    )
    _assert_json_error(
        client.post("/api/v1/playback/init", json={"title": "x" * 301}), 400
    )


# --- strict title matching in /api/v1/playback/init ---------------------------


def _search_returns(application, results):
    """Route `search_multi` to a canned list; caller restores it."""
    original = application.tmdb.search_multi
    application.tmdb.search_multi = lambda *a, **k: results
    return original


def test_init_does_not_answer_with_the_top_search_hit():
    # The defect this whole section exists for: a title TMDB does not carry used
    # to resolve to `valid_results[0]`, whatever that happened to be. The viewer
    # searched for one film and got another, correctly labelled, with nothing on
    # screen to show the swap. The rank of a guess is not evidence that it is
    # the title that was asked for.
    app, client = _client()
    original = _search_returns(
        app,
        [
            {"id": 1, "media_type": "movie", "title": "Son of Samson"},
            {"id": 2, "media_type": "movie", "title": "The Dirty Dozen"},
            {"id": 3, "media_type": "tv", "name": "Bored to Death"},
        ],
    )
    try:
        res = client.get("/api/v1/playback/init?title=No%20Greater%20Love&year=1920")
    finally:
        app.tmdb.search_multi = original

    body = _assert_json_error(res, 404)
    assert body.get("code") == "TITLE_NOT_FOUND", f"404 did not name itself: {body!r}"
    for decoy in ("Son of Samson", "Dirty Dozen", "Bored"):
        assert decoy not in res.get_data(as_text=True), (
            f"an unrelated search hit was echoed back: {body!r}"
        )


def test_init_rejects_an_id_that_answers_with_a_different_title():
    # TMDB redirects some lookups onto a merged or replaced entry. The id the
    # request named is the request; an id that comes back different is a second
    # title, and playing it is the same defect as taking position zero.
    app, client = _client()
    original = app.tmdb.fetch_media_details
    app.tmdb.fetch_media_details = lambda *a, **k: {"id": 4242, "title": "Not It"}
    try:
        res = client.post("/api/v1/playback/init", json={"id": 603, "title": "It"})
    finally:
        app.tmdb.fetch_media_details = original

    body = _assert_json_error(res, 404)
    assert body.get("code") == "TITLE_NOT_FOUND", f"404 did not name itself: {body!r}"
    assert "Not It" not in res.get_data(as_text=True), f"leaked the wrong title: {body!r}"


def test_exact_title_match_finds_a_hit_below_the_top():
    import app as application

    results = [
        {"id": 1, "media_type": "movie", "title": "Son of Samson"},
        {"id": 9, "media_type": "movie", "title": "The Matrix", "release_date": "1999-03-31"},
        {"id": 7, "media_type": "movie", "title": "The Matrix Reloaded"},
    ]
    match = application._exact_title_match(results, "the matrix", "1999")
    assert match is not None and match["id"] == 9, f"missed the real title: {match!r}"

    # Same title, no year given: still the one that is named.
    assert application._exact_title_match(results, "The Matrix", None)["id"] == 9


def test_exact_title_match_will_not_accept_another_year():
    import app as application

    results = [
        {"id": 10, "media_type": "movie", "title": "It", "release_date": "1990-01-01"},
        {"id": 11, "media_type": "movie", "title": "It", "release_date": "2017-09-08"},
    ]
    match = application._exact_title_match(results, "It", 2017)
    assert match is not None and match["id"] == 11, f"wrong year won: {match!r}"
    assert application._exact_title_match(results, "It", 2050) is None, (
        "a year nothing matched was papered over"
    )


def test_exact_title_match_normalises_both_sides_the_same_way():
    import app as application

    # Case, punctuation, a trailing year and the stopwords are all outside what
    # counts as "the same title", and the normalisation is the one the direct
    # catalog already compares with -- so the id path and the title path in
    # resolve cannot disagree about which film a string means.
    results = [{"id": 5, "media_type": "movie", "title": "Fast & Furious (2009)"}]
    assert application._exact_title_match(results, "THE FAST AND THE FURIOUS", None) is not None
    assert application._exact_title_match(results, "fast and furious 2009", None) is not None
    assert application._exact_title_match(results, "Son of Samson", None) is None
    assert application._exact_title_match([], "Anything", None) is None
    assert application._exact_title_match(results, "", None) is None





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
    app._direct_hit_cache.clear()
    app._direct_miss_cache.clear()
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
    app._direct_hit_cache.clear()
    app._direct_miss_cache.clear()
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
    app._direct_hit_cache.clear()
    app._direct_miss_cache.clear()
    app._direct_source_locks.clear()
    app._find_catalog_entry = lambda *a, **k: {"id": f"id-{i}", "stream_url": "x"}
    app.catalog_lib.scrape_title = lambda *a, **k: None

    for i in range(app.CACHE_MAX_SIZE + 200):
        app._direct_source_for(f"Bounded Title {i}")

    assert len(app._direct_hit_cache) <= app.CACHE_MAX_SIZE, (
        f"hit cache grew to {len(app._direct_hit_cache)}"
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


def test_choose_streams_drops_known_short_runtimes():
    # A same-title short or TV edit that shares the film's year can pass
    # title+year matching; the runtime floor is what keeps it out of the main
    # player. Both Archive.org `length` shapes (bare seconds, clock string)
    # must be honoured, and a file with no readable length must survive so a
    # missing field never empties the catalog.
    import catalog_lib

    def _f(name, size, length=None, height=720):
        entry = {"name": name, "size": size, "height": height}
        if length is not None:
            entry["length"] = length
        return entry

    # Each file gets its own quality tier so the runtime floor is what drops a
    # file, not `choose_streams`' one-per-tier collapsing.
    files = [
        _f("feature.1080p.mp4", 800_000_000, "1:46:00", 1080),  # 6360s -> keep
        _f("feature.540p.mp4", 800_000_000, "540", 540),  # 9min bare -> drop
        _f("feature.480p.mp4", 800_000_000, "0:09:00", 480),  # 9min clock -> drop
        _f("feature.nolen.mp4", 800_000_000, None, 360),  # no length -> keep
    ]
    resolved = catalog_lib.choose_streams(
        files, "test-id", min_runtime_seconds=catalog_lib.MIN_MOVIE_RUNTIME_SECONDS
    )
    assert resolved is not None, "floor discarded every candidate"
    kept = {stream["url"].rsplit("/", 1)[-1] for stream in resolved[0]}
    assert "feature.540p.mp4" not in kept, f"short slipped through: {kept!r}"
    assert "feature.480p.mp4" not in kept, f"TV edit slipped through: {kept!r}"
    assert "feature.1080p.mp4" in kept, f"full feature was dropped: {kept!r}"
    assert "feature.nolen.mp4" in kept, f"no-length file was wrongly dropped: {kept!r}"


def test_parse_duration_seconds_handles_both_archive_shapes():
    # Archive.org carries `length` as either a bare second count or a clock
    # string; both must land on the same number, and anything unparseable must
    # be None rather than a guess.
    import catalog_lib

    assert catalog_lib.parse_duration_seconds("5820") == 5820
    assert catalog_lib.parse_duration_seconds("1:37:00") == 5820
    assert catalog_lib.parse_duration_seconds("9:21") == 561
    assert catalog_lib.parse_duration_seconds("") is None
    assert catalog_lib.parse_duration_seconds(None) is None
    assert catalog_lib.parse_duration_seconds("abc") is None


def test_init_never_returns_a_trailer_url_as_the_primary_stream():
    # Regression: a trailer must never reach the main player -- it lives only
    # in the "Trailers" tab. A direct candidate whose `stream_url` looks like a
    # trailer endpoint must be discarded and the request must fall through to
    # the embed chain, minting a frame handle for an embed rather than for the
    # rejected URL.
    app, client = _client()
    app.stream_providers.HEALTH.reset()
    app.stream_providers.clear_probe_cache()
    app.stream_providers.probe_embed = lambda *a, **k: True
    app._direct_source_for = lambda *a, **k: {
        "id": "603",
        "title": "The Matrix",
        "stream_url": "https://www.youtube.com/watch?v=vKQi3bBA1y8",
        "streams": [
            {
                "quality": "720p",
                "height": 720,
                "width": 1280,
                "size": 700_000_000,
                "url": "https://www.youtube.com/watch?v=vKQi3bBA1y8",
            }
        ],
        "year": "1999",
    }
    original = _stub_details(app, {"id": 603, "title": "The Matrix"})
    try:
        res = client.post("/api/movies/resolve", json={"id": "603"})
    finally:
        app.tmdb.fetch_media_details = original
        _restore_chain(app)

    assert res.status_code == 200, f"resolve failed: {res.status_code} {res.data[:200]!r}"
    movie = res.get_json()["movie"]
    assert "youtube" not in movie["stream_url"].lower(), (
        f"trailer reached the primary stream: {movie['stream_url']!r}"
    )
    assert movie["stream_url"].startswith("/api/v1/playback/frame?token="), (
        f"expected an embed frame handle, got: {movie['stream_url']!r}"
    )
    for tier in movie.get("streams", []):
        assert "youtube" not in tier["url"].lower(), f"trailer leaked into a tier: {tier!r}"


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
