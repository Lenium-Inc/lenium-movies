"""Tests for `/api/season`, the endpoint behind the episode-level shelves.

Run with:  python3 test_season_shelf.py

Why these exist
---------------
`/api/episodes` answers one episode at a time, which is all the watch page ever
needed. The "New episodes" shelf is a different shape: it asks for several shows
at once and needs a whole season back from each, so it needed a route that
`tmdb_service.fetch_season_details` had been sitting unused behind. Two things
about it are easy to get wrong and invisible when they are:

* `season` is optional, and when it is omitted the resolver must pick the newest
  *aired* season. TMDB pre-announces upcoming seasons with no episodes in them,
  and picking one of those produces a shelf of empty seasons that looks broken
  rather than absent.
* A cached season must not be able to mask a malformed request, and a malformed
  request must not be cached. Both directions were live bugs in the
  `/api/episodes` path, which is why `int()` parsing there is validated outside
  the try/except.

No network: `tmdb_service` is stubbed, and the Flask test client exercises the
real routing, validation and cache.
"""

import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app as application  # noqa: E402


SHOW = {
    "id": 1396,
    "name": "Breaking Bad",
    "overview": "A chemistry teacher turns to manufacturing.",
    "poster_path": "/poster.jpg",
    "backdrop_path": "/backdrop.jpg",
    "seasons": [
        {"season_number": 0, "air_date": "2008-01-20"},  # specials: never resolved
        {"season_number": 1, "air_date": "2008-01-20"},
        {"season_number": 2, "air_date": "2009-03-08"},
        {"season_number": 6, "air_date": "2099-01-01"},  # announced, unaired
    ],
}

SEASON_2 = {
    "season_number": 2,
    "name": "Season 2",
    "poster_path": "/season2.jpg",
    "episodes": [
        {
            "season_number": 2,
            "episode_number": 1,
            "name": "Seven Thirty-Seven",
            "overview": "Walt and Jesse clean up.",
            "still_path": "/still1.jpg",
            "air_date": "2009-03-08",
            "runtime": 47,
            "vote_average": 8.5,
        },
        {
            "season_number": 2,
            "episode_number": 2,
            "name": "Cat's in the Bag...",
            "overview": "",
            "still_path": None,
            "air_date": "2009-03-15",
            "runtime": 48,
            "vote_average": 8.7,
        },
    ],
}

# The two TMDB entry points this route reaches, patched on the module the Flask
# code actually calls them through (`tmdb_service`, imported as `tmdb`).
_PATCH_PATHS = ("fetch_media_details", "fetch_season_details")


def _stubbed():
    """Patch the two TMDB calls this route makes, and clear the season cache."""
    saved = [(name, getattr(application.tmdb, name)) for name in _PATCH_PATHS]
    application.tmdb.fetch_media_details = lambda tmdb_id, media_type="movie": (
        SHOW if tmdb_id == SHOW["id"] else None
    )
    application.tmdb.fetch_season_details = lambda tmdb_id, season: (
        SEASON_2 if (tmdb_id, season) == (SHOW["id"], 2) else None
    )
    application._season_cache.clear()
    return saved


def _restore(saved):
    for name, original in saved:
        setattr(application.tmdb, name, original)


def test_the_newest_aired_season_is_resolved_when_season_is_omitted():
    saved = _stubbed()
    try:
        response = application.app.test_client().get("/api/season?tmdb_id=1396")
        body = response.get_json()
        assert response.status_code == 200, body
        # Season 6 is listed by TMDB with a 2099 air date and no episodes. It must
        # not win, and the specials row (season 0) must never be considered.
        assert body["season"]["number"] == 2, body["season"]
        assert len(body["episodes"]) == 2, body["episodes"]
        assert body["show"]["name"] == "Breaking Bad"
    finally:
        _restore(saved)


def test_an_explicit_season_is_honoured():
    saved = _stubbed()
    try:
        application.tmdb.fetch_season_details = lambda tmdb_id, season: SEASON_2
        response = application.app.test_client().get("/api/season?tmdb_id=1396&season=2")
        body = response.get_json()
        assert response.status_code == 200, body
        assert body["season"]["number"] == 2
    finally:
        _restore(saved)


def test_a_missing_season_is_a_404_not_an_empty_shelf():
    saved = _stubbed()
    try:
        # Season 1 exists on the show but the stub has no payload for it, which is
        # the shape a genuinely missing season takes.
        response = application.app.test_client().get("/api/season?tmdb_id=1396&season=1")
        assert response.status_code == 404, response.get_json()
        assert "error" in response.get_json()
    finally:
        _restore(saved)


def test_an_unknown_show_is_a_404():
    saved = _stubbed()
    try:
        response = application.app.test_client().get("/api/season?tmdb_id=999")
        assert response.status_code == 404, response.get_json()
    finally:
        _restore(saved)


def test_a_missing_still_does_not_become_a_broken_image_url():
    saved = _stubbed()
    try:
        body = application.app.test_client().get("/api/season?tmdb_id=1396").get_json()
        # An empty string is what the client renders as "no still"; a URL ending
        # in "None" would render as a broken image on every episode card.
        assert body["episodes"][1]["still_url"] == "", body["episodes"][1]
        assert body["episodes"][0]["still_url"].endswith("w500/still1.jpg")
    finally:
        _restore(saved)


def test_a_non_numeric_id_is_rejected_before_any_lookup():
    saved = _stubbed()
    calls = []
    try:
        application.tmdb.fetch_media_details = lambda *a, **k: calls.append(a) or SHOW
        response = application.app.test_client().get("/api/season?tmdb_id=breaking-bad")
        assert response.status_code == 400, response.get_json()
        assert calls == [], "a malformed id must not reach TMDB"
    finally:
        _restore(saved)


def test_a_zero_or_negative_season_is_rejected():
    saved = _stubbed()
    try:
        client = application.app.test_client()
        assert client.get("/api/season?tmdb_id=1396&season=0").status_code == 400
        assert client.get("/api/season?tmdb_id=1396&season=-2").status_code == 400
        assert client.get("/api/season?tmdb_id=1396&season=abc").status_code == 400
    finally:
        _restore(saved)


def test_a_resolved_season_is_cached_and_a_miss_is_not():
    saved = _stubbed()
    try:
        lookups = []

        def _counting(tmdb_id, media_type="movie"):
            lookups.append(tmdb_id)
            return SHOW

        application.tmdb.fetch_media_details = _counting
        client = application.app.test_client()

        assert client.get("/api/season?tmdb_id=1396").status_code == 200
        assert client.get("/api/season?tmdb_id=1396").status_code == 200
        assert lookups == [1396], f"second request should be cached, got {lookups}"

        # A miss must not be pinned for the TTL: a show that has not aired yet
        # should be picked up the moment it does. Both stubs have to start
        # returning data, or the second call would 404 again for a reason that
        # has nothing to do with caching.
        assert client.get("/api/season?tmdb_id=4242").status_code == 404
        application.tmdb.fetch_media_details = lambda tmdb_id, media_type="movie": SHOW
        application.tmdb.fetch_season_details = lambda tmdb_id, season: SEASON_2
        assert client.get("/api/season?tmdb_id=4242").status_code == 200
    finally:
        _restore(saved)


def test_the_two_cache_keys_do_not_collide():
    # "latest" and an explicit season number are different requests. Collapsing
    # them would serve season 1's payload for a request that meant the newest.
    saved = _stubbed()
    try:
        application.tmdb.fetch_season_details = lambda tmdb_id, season: {
            **SEASON_2,
            "season_number": season,
        }
        client = application.app.test_client()
        client.get("/api/season?tmdb_id=1396")
        body = client.get("/api/season?tmdb_id=1396&season=1").get_json()
        assert body["season"]["number"] == 1, body["season"]
    finally:
        _restore(saved)


def _run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for fn in tests:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except Exception:
            failures += 1
            print(f"  FAIL  {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run() else 0)