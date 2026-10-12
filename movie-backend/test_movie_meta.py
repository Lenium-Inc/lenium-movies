"""Tests for `/api/movies/meta`, the details window's metadata route.

Why this exists
---------------
`/api/movies/resolve` answers metadata *and* a resolved stream -- which means
a headless-browser render measured in tens of seconds. The details window needs
the record and a "More Like This" shelf the moment it opens and resolves
nothing; the watch page likewise fetches its metadata long before anyone
presses Play. Those callers used to queue a render for a synopsis. This route
answers from one TMDB details call (recommendations already appended), cached
for the worker's life.

No network: `tmdb.fetch_media_details` and the `_tmdb_get` fallback are
stubbed, and the Flask test client exercises real routing, validation, the
identity rule and the cache.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app as application  # noqa: E402


def _client():
    return application.app.test_client()


def _clear_meta_cache():
    with application._meta_cache_lock:
        application._meta_cache.clear()


def _details(**overrides):
    """A canned `fetch_media_details` answer for a 2008 series."""
    base = {
        "id": 1396,
        "title": "Breaking Bad",
        "overview": "A chemistry teacher turns to manufacturing.",
        "release_year": "2008",
        "release_date": "2008-01-20",
        "vote_average": 8.9,
        "imdb_id": "tt0903747",
        "genres": ["Drama", "Crime"],
        "poster_path": "/poster.jpg",
        "poster_url": "https://image.tmdb.org/t/p/w500/poster.jpg",
        "backdrop_path": "/backdrop.jpg",
        "backdrop_url": "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
        "trailer_key": "abc",
        "popularity": 100.0,
        "runtime": 45,
        "media_type": "tv",
        "director": "Vince Gilligan",
        "cast": ["Bryan Cranston", "Aaron Paul"],
        "country": "United States",
        "language": "English",
        "number_of_seasons": 5,
        "number_of_episodes": 62,
        "seasons": [],
        "credits": {
            "cast": [
                {
                    "id": 17416,
                    "name": "Bryan Cranston",
                    "character": "Walter White",
                    "profile_path": "/bc.jpg",
                },
                {
                    "id": 3894,
                    "name": "Aaron Paul",
                    "character": "Jesse Pinkman",
                    "profile_path": None,
                },
                # No id: there is no link to build for this person.
                {"name": "Unlinkable", "character": "Nobody"},
                # No name: nothing to read, either.
                {"id": 5, "character": "Unnamed"},
            ],
        },
        "recommendations": {
            "results": [
                {
                    "id": 60059,
                    "title": "Better Call Saul",
                    "release_date": "2015-02-08",
                    "poster_path": "/saul.jpg",
                    "backdrop_path": "/saul-bg.jpg",
                    "vote_average": 8.7,
                    "overview": "Before Saul, Jimmy McGill.",
                },
                {
                    # No poster: the wall's bar for a recognisable neighbour.
                    "id": 1,
                    "title": "Unpostered Neighbour",
                    "release_date": "2001-01-01",
                    "poster_path": None,
                    "backdrop_path": None,
                    "vote_average": 5.0,
                    "overview": "",
                },
                # No id / no title: not a neighbour at all.
                "garbage-entry",
            ]
        },
    }
    base.update(overrides)
    return base


def _patch_details(fn):
    original = application.tmdb.fetch_media_details
    application.tmdb.fetch_media_details = fn
    return original


def test_meta_route_returns_movie_record_and_similar_wall():
    _clear_meta_cache()
    calls = []

    def fake(media_id, media_type="movie"):
        calls.append((media_id, media_type))
        return _details()

    original = _patch_details(fake)
    try:
        res = _client().get(
            "/api/movies/meta", query_string={"id": "1396", "media_type": "tv"}
        )
        assert res.status_code == 200, res.get_json()
        payload = res.get_json()
        movie = payload["movie"]

        # The shape `fetchMovieDetails` on the client maps: every metadata key
        # resolution would have built, none of the stream keys.
        assert movie["id"] == "1396"
        assert movie["media_type"] == "tv"
        assert movie["year"] == "2008"
        assert movie["title"] == "Breaking Bad"
        assert movie["runtime"] == 45
        assert movie["genres"] == ["Drama", "Crime"]
        assert movie["director"] == "Vince Gilligan"
        assert movie["cast"] == ["Bryan Cranston", "Aaron Paul"]
        assert movie["seasons"] == 5
        assert movie["poster_url"].endswith("/w500/poster.jpg")
        assert movie["overview"].startswith("A chemistry teacher")
        # The cast row carries people, not names: id for the link, character
        # for the billing, photo for the tile. The unidentifiable entries are
        # barred the way the wall bars its own.
        assert movie["cast_members"] == [
            {
                "id": "17416",
                "name": "Bryan Cranston",
                "character": "Walter White",
                "profile_path": "/bc.jpg",
            },
            {
                "id": "3894",
                "name": "Aaron Paul",
                "character": "Jesse Pinkman",
                "profile_path": None,
            },
        ]
        for stream_key in ("stream_url", "sources", "streams", "mirrors"):
            assert stream_key not in movie

        similar = payload["similar"]
        # The posterless entry and the malformed entry are both barred; the
        # shelf shows what a viewer can recognise.
        assert [s["id"] for s in similar] == ["60059"]
        assert similar[0]["title"] == "Better Call Saul"
        assert similar[0]["year"] == 2015
        assert similar[0]["media_type"] == "tv"
        assert isinstance(similar[0]["year"], int)

        assert calls == [(1396, "tv")]
    finally:
        application.tmdb.fetch_media_details = original


def test_meta_route_accepts_the_post_body_the_client_already_sends():
    """`fetchMovieDetails` posts `{id, media_type}` -- same alias as resolve."""
    _clear_meta_cache()
    original = _patch_details(lambda *a, **k: _details())
    try:
        res = _client().post(
            "/api/movies/meta", json={"id": "1396", "media_type": "tv"}
        )
        assert res.status_code == 200, res.get_json()
        assert res.get_json()["movie"]["media_type"] == "tv"
    finally:
        application.tmdb.fetch_media_details = original


def test_meta_route_validates_and_coerces_like_the_trailer_route():
    _clear_meta_cache()
    original = _patch_details(lambda *a, **k: _details())
    client = _client()
    try:
        assert client.get("/api/movies/meta").status_code == 400
        assert client.get(
            "/api/movies/meta", query_string={"id": "abc"}
        ).status_code == 400

        # An unrecognised media type falls back to movie rather than erroring,
        # exactly as `/api/catalog/movieTrailer` does: a viewer's malformed
        # query still deserves the record, in its default kind.
        calls = []

        def typed(media_id, media_type="movie"):
            calls.append(media_type)
            return _details(media_type=media_type)

        application.tmdb.fetch_media_details = typed
        res = client.get(
            "/api/movies/meta", query_string={"id": "1396", "media_type": "audiobook"}
        )
        assert res.status_code == 200
        assert calls == ["movie"]
        assert res.get_json()["movie"]["media_type"] == "movie"

        assert client.options("/api/movies/meta").status_code == 204
    finally:
        application.tmdb.fetch_media_details = original


def test_meta_route_404s_when_tmdb_misses_or_redirects_the_id():
    _clear_meta_cache()
    client = _client()
    original = _patch_details(lambda *a, **k: None)
    try:
        res = client.get("/api/movies/meta", query_string={"id": "999999"})
        assert res.status_code == 404
        assert res.get_json().get("code") == "TITLE_NOT_FOUND"

        # A merged id answered with a different record is not the title that
        # was asked for -- playback_init's identity rule, enforced identically.
        application.tmdb.fetch_media_details = (
            lambda *a, **k: _details(id=4242, title="Some Other Show")
        )
        res = client.get("/api/movies/meta", query_string={"id": "1396"})
        assert res.status_code == 404
        assert res.get_json().get("code") == "TITLE_NOT_FOUND"
    finally:
        application.tmdb.fetch_media_details = original


def test_meta_route_falls_back_to_similar_when_there_are_no_recommendations():
    _clear_meta_cache()
    fallbacks = []

    def fake_tmdb_get(path, params):
        fallbacks.append(path)
        return {
            "results": [
                {
                    "id": 7,
                    "name": "Neighbour Show",  # TV titles name themselves
                    "first_air_date": "2010-03-07",
                    "poster_path": "/n.jpg",
                    "backdrop_path": None,
                    "vote_average": 7.7,
                    "overview": "",
                }
            ]
        }

    details = _details(recommendations={"results": []})
    original_get = application._tmdb_get
    application._tmdb_get = fake_tmdb_get
    original = _patch_details(lambda *a, **k: details)
    try:
        res = _client().get(
            "/api/movies/meta", query_string={"id": "1396", "media_type": "tv"}
        )
        assert res.status_code == 200
        similar = res.get_json()["similar"]
        assert [s["title"] for s in similar] == ["Neighbour Show"]
        assert fallbacks == ["/tv/1396/similar"]
    finally:
        application._tmdb_get = original_get
        application.tmdb.fetch_media_details = original


def test_meta_route_serves_cached_answers_without_a_second_tmdb_call():
    _clear_meta_cache()
    calls = []

    def counting(media_id, media_type="movie"):
        calls.append(media_id)
        return _details(id=media_id)

    original = _patch_details(counting)
    try:
        client = _client()
        first = client.get("/api/movies/meta", query_string={"id": "767"})
        second = client.get("/api/movies/meta", query_string={"id": "767"})
        assert first.status_code == 200
        assert second.status_code == 200
        assert second.get_json() == first.get_json()
        assert calls == [767]
    finally:
        application.tmdb.fetch_media_details = original
        _clear_meta_cache()


def test_fetch_media_details_keeps_recommendations_attached():
    """The route's one-call premise: `fetch_media_details` must not drop them.

    Every other key in that dict is flattened out of the raw TMDB payload;
    `recommendations` used to be flattened with them, which made the wall
    cost a second round trip that the appending details call had already paid.
    """
    import tmdb_service  # noqa: E402

    captured = {}

    def fake_get(endpoint, params=None):
        captured["endpoint"] = endpoint
        captured["params"] = params
        return {
            "id": 60059,
            "title": "Better Call Saul",
            "release_date": "2015-02-08",
            "recommendations": {"results": [{"id": 1396, "name": "Breaking Bad"}]},
            "credits": {"cast": [{"id": 1, "name": "Bob Odenkirk"}]},
        }

    original = tmdb_service._tmdb_get
    tmdb_service._tmdb_get = fake_get
    try:
        details = tmdb_service.fetch_media_details(60059, "movie")
        assert details["recommendations"]["results"][0]["id"] == 1396
        assert details["credits"]["cast"][0]["name"] == "Bob Odenkirk"
        appended = captured["params"]["append_to_response"]
        assert "recommendations" in appended
        assert "credits" in appended
    finally:
        tmdb_service._tmdb_get = original
