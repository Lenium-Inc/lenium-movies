"""Tests for per-profile taste signals and the linear recommender.

Run with:  python3 test_taste.py

The point of these is not that the arithmetic is right -- it is that the
privacy and correctness properties hold: no raw query text is ever persisted,
profiles cannot read each other's signals, and the model reports honestly when
it has too little data to claim it works.
"""

import os
import random
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="taste-tests-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "taste.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False

import taste  # noqa: E402
import app as app_module  # noqa: E402


# One store instance for the whole suite, pointed at a throwaway file. The app
# reaches the database through `authdb.get_store()`, a process-wide singleton
# created on first call from `SQLITE_PATH` -- an env var every suite in this
# directory overwrites at import time, so whichever module imported last owned
# the database and the others ran against it. Each suite therefore installs its
# own store on the app immediately before exercising it (see `_client`), and
# direct assertions share the same instance.
_THEIR_STORE = authdb.Store(dsn="")
_THEIR_STORE.pg = False
_THEIR_STORE.sqlite_path = os.path.join(_TMP, "taste.db")
_THEIR_STORE.init()


def _store() -> authdb.Store:
    return _THEIR_STORE


_SEQ = [0]


def _unique(prefix: str) -> str:
    _SEQ[0] += 1
    return f"{prefix}-{_SEQ[0]}@example.com"


def _client():
    app_module.app.config["TESTING"] = True
    # Point the app at this suite's store for the duration of the test, so a
    # request handler and a direct `_store()` assertion always see the same data.
    authdb.set_store(_THEIR_STORE)
    return app_module.app.test_client()


def _account(client, prefix="taste") -> tuple[dict, str]:
    email = _unique(prefix)
    client.post(
        "/api/auth/signup",
        json={"email": email, "name": "T", "password": "pw123456"},
    )
    token = client.post(
        "/api/auth/login", json={"email": email, "password": "pw123456"}
    ).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}, email


def _profile(client, headers, name="Viewer") -> int:
    return client.post(
        "/api/profiles", headers=headers, json={"name": name}
    ).get_json()["profile"]["id"]


# ---------------------------------------------------------------------------
# tokenising
# ---------------------------------------------------------------------------


def test_stopwords_and_years_are_not_taste():
    # A release year is metadata, not an interest. Left in, "horror 2019" and
    # "horror films" look like two different one-off searches and neither ever
    # clears the repeat threshold.
    assert taste.tokenise_query("horror movies 2019") == ["horror"]
    assert taste.tokenise_query("horror films") == ["horror"]
    assert taste.tokenise_query("the best free full HD movie of 2024") == []
    assert taste.query_feature_key("horror movies 2019") == taste.query_feature_key(
        "horror films"
    )
    # Case and filler must not fragment one interest into several.
    assert taste.query_feature_key("Horror") == taste.query_feature_key("horror movie")
    assert taste.query_feature_key("") == ""


def test_query_key_is_not_reversible():
    key = taste.query_feature_key("private medical drama about grief")
    assert key and len(key) == 16
    # The words themselves must not appear anywhere in the stored key.
    for word in ("private", "medical", "drama", "grief"):
        assert word not in key
    # Order-insensitive: the same interest phrased differently is one feature,
    # not two, which is what lets a repeated search clear the threshold.
    assert key == taste.query_feature_key("private drama medical grief")
    # A genuinely different interest must not collide into the same feature.
    assert key != taste.query_feature_key("obscure private diagnosis drama")


# ---------------------------------------------------------------------------
# weights
# ---------------------------------------------------------------------------


def test_recency_decay_dominates():
    state = taste.empty_weights()
    for _ in range(30):
        state = taste.fold_event_with_director(state, "play", ["horror"], [])
    # w <- 0.6w + 1 converges on 1/(1-0.6) = 2.5, so rewatching the same
    # genre is bounded rather than accumulating without limit. A reviewer who
    # only ever watches horror must not end up with an infinitely dominant
    # feature that swamps every other signal.
    assert state["genre"]["horror"] < 2.5 + 1e-6, state
    # A different interest still registers, which is the point of the ceiling.
    state = taste.fold_event_with_director(state, "play", ["documentary"], [])
    assert state["genre"]["documentary"] > 0
    assert state["genre"]["horror"] > state["genre"]["documentary"]


def test_stronger_actions_weigh_more():
    light = taste.empty_weights()
    heavy = taste.empty_weights()
    for _ in range(3):
        light = taste.fold_event_with_director(light, "open", ["horror"], [])
        heavy = taste.fold_event_with_director(heavy, "play", ["horror"], [])
    assert heavy["genre"]["horror"] > light["genre"]["horror"]


def test_director_outranks_cast():
    state = taste.empty_weights()
    state = taste.fold_event_with_director(state, "play", [], ["someone"], "the director")
    assert state["people"]["the director"] > state["people"]["someone"]


def test_state_is_trimmed_and_noise_dropped():
    state = taste.empty_weights()
    for i in range(30):
        state = taste.fold_event_with_director(state, "play", [f"g{i}"], [])
    assert len(state["genre"]) <= taste.MAX_GENRES
    assert len(state["people"]) <= taste.MAX_PEOPLE
    assert all(w >= taste.MIN_WEIGHT for w in state["genre"].values())


def test_ranking_promotes_matches_and_is_stable():
    weights = {"genre": {"horror": 1.0}, "people": {}}
    items = [
        {"id": "a", "genres": ["comedy"], "cast": []},
        {"id": "b", "genres": ["horror"], "cast": []},
        {"id": "c", "genres": ["drama"], "cast": []},
        {"id": "d", "genres": ["comedy"], "cast": []},
    ]
    ranked = taste.rank(weights, items)
    assert [i["id"] for i in ranked][0] == "b"
    # Everything else keeps its upstream relative order, so paging is stable.
    assert [i["id"] for i in ranked][1:] == ["a", "c", "d"]
    # Deterministic: identical input must never reshuffle what was already seen.
    assert taste.rank(weights, items) == ranked


def test_empty_state_leaves_order_untouched():
    items = [{"id": str(i), "genres": ["horror"], "cast": []} for i in range(5)]
    assert taste.rank(taste.empty_weights(), items) == items
    assert not taste.has_signal(taste.empty_weights())


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------


def test_evaluation_refuses_to_claim_with_little_data():
    events = [{"kind": "play", "genres": ["horror"], "people": [], "created_at": i, "weight": 1.0}
              for i in range(3)]
    result = taste.evaluate(events)
    assert result["verdict"] == "insufficient_data"
    assert result["hit_rate_at_5"] is None


def test_evaluation_reports_not_better_when_it_is_not():
    # Two interleaved interests the model cannot tell apart, so the ordering
    # carries no information. Two features is also below the bar for any
    # ranking to be measurable, so no verdict is claimed.
    events = []
    for i in range(20):
        events.append({
            "kind": "play", "genres": ["horror"], "people": [],
            "created_at": i * 2, "weight": 1.0,
        })
        events.append({
            "kind": "play", "genres": ["comedy"], "people": [],
            "created_at": i * 2 + 1, "weight": 1.0,
        })
    result = taste.evaluate(events)
    # Only two distinct features exist, so there is no ordering to get right
    # and the honest answer is "not enough data" rather than a score.
    assert result["verdict"] == "insufficient_data", result
    assert result["hit_rate_at_5"] is not None
    assert 0.0 <= result["hit_rate_at_5"] <= 1.0
    # A score is only meaningful next to its baseline and its ceiling.
    assert result["random_hit_rate"] is not None
    assert result["best_possible"] is not None


def test_evaluation_discriminates_a_real_signal_from_noise():
    """The metric has to separate a learnable profile from random data.

    It previously could not. Candidates were built from the *held-out*
    features, so anything made of a held-out feature counted as a hit by
    construction and the score was ~1.0 on every profile -- the eval "passed"
    regardless of the model. The baseline was then `5 / len(candidates)`, which
    saturates at 1.0 for any small pool, so even a correct model could never be
    reported as better than random.
    """
    pool = [
        "horror", "scifi", "romance", "thriller", "drama", "western",
        "noir", "anime", "documentary", "musical", "classic", "war",
    ]

    def events(choose):
        return [
            {"kind": "play", "genres": choose(i), "people": "",
             "weight": 1.0, "created_at": 1000 + i}
            for i in range(120)
        ]

    # A viewer who mostly watches horror: a real model should find it.
    concentrated = taste.evaluate(
        events(lambda i: "horror" if i % 10 < 7 else pool[i % 12])
    )
    assert concentrated["verdict"] == "better", concentrated
    assert concentrated["hit_rate_at_5"] > concentrated["random_hit_rate"]

    # The same volume of events with no pattern must not win.
    rng = random.Random(11)
    noise = taste.evaluate(events(lambda i: rng.choice(pool)))
    assert noise["verdict"] == "not_better", noise
    assert noise["hit_rate_at_5"] <= noise["random_hit_rate"] + 0.05


def test_evaluation_reports_insufficient_data_instead_of_a_false_verdict():
    # Two distinct features: the top 5 covers the entire pool, so no ordering
    # could have been wrong. A score here would be a number with nothing behind
    # it, and reporting one would dress "no data" up as a measurement.
    result = taste.evaluate([
        {"kind": "play", "genres": "horror" if i % 2 else "scifi",
         "people": "", "weight": 1.0, "created_at": 1000 + i}
        for i in range(40)
    ])
    assert result["verdict"] == "insufficient_data", result


def test_evaluation_states_its_own_limits():
    # The candidate pool is the viewer's own features, not the real catalogue,
    # so the result must say so rather than reading as a live A/B measurement.
    result = taste.evaluate([
        {"kind": "play", "genres": ["horror", "scifi", "romance", "drama"][i % 4],
         "people": "", "weight": 1.0, "created_at": 1000 + i}
        for i in range(60)
    ])
    assert result["scope"] == "self_contained"


# ---------------------------------------------------------------------------
# API: privacy and isolation
# ---------------------------------------------------------------------------


def test_search_is_counted_but_only_applied_once_recurring():
    client = _client()
    headers, _ = _account(client, "search")
    pid = _profile(client, headers)
    # One search is noise (a typo, a passing curiosity).
    first = client.post(
        "/api/taste", headers=headers,
        json={"profile_id": pid, "kind": "search", "query": "horror films"},
    ).get_json()
    assert first["recorded"] is True and first["applied"] is False
    second = client.post(
        "/api/taste", headers=headers,
        json={"profile_id": pid, "kind": "search", "query": "horror movies 2019"},
    ).get_json()
    assert second["applied"] is True

    state = client.post(
        "/api/taste/state", headers=headers, json={"profile_id": pid}
    ).get_json()["state"]
    # The search is remembered as a repeated hashed interest, never as its
    # words, so what appears is the fingerprint rather than "horror".
    key = taste.query_feature_key("horror films")
    assert f"q:{key}" in state["genre"], state
    assert "horror" not in state["genre"]


def test_raw_query_text_is_never_persisted():
    client = _client()
    headers, _ = _account(client, "raw")
    pid = _profile(client, headers)
    secret = "obscure private diagnosis drama"
    for _ in range(3):
        client.post(
            "/api/taste", headers=headers,
            json={"profile_id": pid, "kind": "search", "query": secret},
        )
    store = _store()
    for table in ("taste_events", "taste_signals"):
        rows = store._query(f"SELECT * FROM {table}", (), fetch_all=True) or []
        blob = " ".join(str(row) for row in rows).lower()
        for word in secret.split():
            assert word not in blob, f"{word!r} leaked into {table}"
    # The hashed fingerprint is what persists.
    assert store.search_token_hits(pid)


def test_profile_ids_are_not_coerced_to_integers():
    """Postgres hands back UUID profile ids; sqlite hands back integers.

    Every profile route and resolver used to do `int(profile_id)`, which is
    harmless on sqlite and a hard 500 on the deployment that actually runs. This
    drives the string form through the same paths an opaque id takes.
    """
    client = _client()
    headers, _ = _account(client, "opaque")
    pid = _profile(client, headers)
    # A uuid-shaped id: valid on postgres, impossible on sqlite.
    opaque = "3f2b9c14-0a5e-4c7d-9b1f-2d6e8a4c0f31"

    assert client.post(
        "/api/taste", headers=headers,
        json={"profile_id": opaque, "kind": "play", "genres": ["horror"]},
    ).status_code == 403
    assert client.get(
        "/api/taste/state", headers=headers, query_string={"profile_id": opaque}
    ).status_code == 403
    # Not even a number-looking id may be trusted to belong to the caller.
    assert client.patch(
        f"/api/profiles/{opaque}", headers=headers, json={"name": "Nope"}
    ).status_code == 404
    assert client.delete(f"/api/profiles/{opaque}", headers=headers).status_code == 404
    assert client.post(
        f"/api/profiles/{opaque}/unlock", headers=headers, json={"pin": "1234"}
    ).status_code == 404
    # A non-numeric id on an allowance claim is a 404, not a traceback.
    assert client.post(
        "/api/allowance/claim", headers=headers,
        json={"profile_id": opaque, "movie_key": "x"},
    ).status_code in (403, 404)
    # The real id still works, as a string and as a number.
    assert client.get(
        "/api/taste/state", headers=headers, query_string={"profile_id": str(pid)}
    ).status_code == 200


def test_malformed_feed_parameters_do_not_error():
    """A stray `?limit=` on a public feed endpoint used to be a 500."""
    client = _client()
    for params in [
        {"limit": "abc"}, {"page": ""}, {"page": "-9"}, {"page": "1e9"},
        {"limit": "0"}, {"kind": ";drop table"}, {"limit": "999999"},
    ]:
        resp = client.get("/api/recommendations", query_string=params)
        assert resp.status_code == 200, (params, resp.status_code)
        assert isinstance(resp.get_json()["results"], list)


def test_unknown_interaction_kind_is_rejected():
    client = _client()
    headers, _ = _account(client, "kind")
    pid = _profile(client, headers)
    for bad in ["", "   ", "hack", "delete", "drop table", "play; drop"]:
        resp = client.post(
            "/api/taste", headers=headers,
            json={"profile_id": pid, "kind": bad, "genres": ["horror"]},
        )
        assert resp.status_code == 400, (bad, resp.status_code)
    # Case and surrounding whitespace are normalised, not refused.
    assert client.post(
        "/api/taste", headers=headers,
        json={"profile_id": pid, "kind": " PLAY ", "genres": ["horror"]},
    ).status_code == 200


def test_taste_requires_auth_and_a_profile():
    client = _client()
    assert client.post("/api/taste", json={"kind": "play"}).status_code == 401
    headers, _ = _account(client, "noprofile")
    assert client.post("/api/taste", headers=headers, json={"kind": "play"}).status_code == 409


def test_profiles_cannot_read_or_write_each_others_signals():
    client = _client()
    owner, _ = _account(client, "owner")
    stranger, _ = _account(client, "stranger")
    pid = _profile(client, owner)
    client.post(
        "/api/taste", headers=owner,
        json={"profile_id": pid, "kind": "play", "genres": ["horror"]},
    )
    # Reading another profile's state, writing to it, and reading their
    # evaluation must all be refused. A GET has no body, so the profile
    # travels in the query string -- and that path must be authorised too.
    for path, method, body, query in [
        ("/api/taste/state", "GET", None, {"profile_id": pid}),
        ("/api/taste/state", "POST", {"profile_id": pid}, None),
        ("/api/taste", "POST", {"profile_id": pid, "kind": "play", "genres": ["comedy"]}, None),
        ("/api/recommendations/eval", "GET", None, {"profile_id": pid}),
    ]:
        resp = getattr(client, method.lower())(
            path, headers=stranger, json=body, query_string=query
        )
        assert resp.status_code == 403, (path, method, resp.status_code)

    # The recommendations list is different on purpose: it is a public feed, so
    # another account's profile id falls back to the unranked list rather than
    # an error. What must never happen is the stranger getting a ranking built
    # from someone else's taste.
    resp = client.get(
        "/api/recommendations", headers=stranger, query_string={"profile_id": pid}
    )
    assert resp.status_code == 200
    assert resp.get_json()["personalised"] is False


def test_state_is_a_rebuildable_cache_not_the_source_of_truth():
    client = _client()
    headers, _ = _account(client, "cache")
    pid = _profile(client, headers)
    for _ in range(4):
        client.post(
            "/api/taste", headers=headers,
            json={"profile_id": pid, "kind": "play", "genres": ["horror"]},
        )
    store = _store()
    first = client.post(
        "/api/taste/state", headers=headers, json={"profile_id": pid}
    ).get_json()["state"]
    # Corrupting the cache must be recoverable by replaying the event log.
    store.save_taste_state(pid, {"genre": {"comedy": 99.0}, "people": {}})
    assert client.get(
        "/api/taste/state", headers=headers, query_string={"profile_id": pid}
    ).get_json()["state"]["genre"]["comedy"] == 99.0
    rebuilt = client.post(
        "/api/taste/state", headers=headers, json={"profile_id": pid}
    ).get_json()["state"]
    assert rebuilt == first
    assert "comedy" not in rebuilt["genre"]


def test_recommendations_fall_back_when_there_is_no_signal():
    client = _client()
    headers, _ = _account(client, "nosignal")
    pid = _profile(client, headers)
    # A fresh profile must see the plain catalogue, never an empty page.
    resp = client.get(
        "/api/recommendations", headers=headers,
        query_string={"profile_id": pid, "limit": 5},
    )
    assert resp.status_code == 200
    assert resp.get_json()["personalised"] is False


def test_recommendations_are_capped_and_bounded():
    client = _client()
    headers, _ = _account(client, "bounds")
    pid = _profile(client, headers)
    for bad in ["0", "-5", "9999"]:
        resp = client.get(
            "/api/recommendations", headers=headers,
            query_string={"profile_id": pid, "limit": bad},
        )
        assert resp.status_code == 200
    # A page param outside the sane range is clamped, not passed upstream.
    resp = client.get(
        "/api/recommendations", headers=headers,
        query_string={"profile_id": pid, "page": "99"},
    )
    assert resp.status_code == 200


def test_ranking_promotes_a_matching_tmdb_list_row():
    """A TMDB list row carries `genre_ids`, not genre names.

    This is the shape the feed actually gets: `get_trending_catalog` returns
    `genre_ids` only. If the model scores on names alone, every row scores 0.0
    against a profile that has learned affinities, so ranking is a no-op while
    the endpoint still reports `personalised: True`. Score genre_ids as a
    fallback so the flag and the ordering can both be true.
    """
    state = taste.empty_weights()
    state = taste.fold_event_with_director(
        state, "play", ["Horror"], [], weight=1.0
    )
    # A trending row: names absent, ids present (27 = Horror).
    items = [
        {"id": 1, "title": "Comedy", "genre_ids": [35]},
        {"id": 2, "title": "Horror film", "genre_ids": [27]},
    ]
    scores = taste.ranked_scores(state, items)
    # The horror row must actually score above the comedy row.
    assert scores[1] > scores[0], scores
    assert max(scores) > 0
    ranked = taste.rank(state, items)
    assert ranked[0]["id"] == 2


def test_personalised_is_false_when_nothing_on_the_page_matches():
    """`personalised: True` over an all-zero ranking is a claim that did not happen.

    A profile can have real signal but the current page may contain none of it.
    Reporting True there is exactly the dishonest case the client renders as a
    "For You" row.
    """
    client = _client()
    headers, _ = _account(client, "nomatch")
    pid = _profile(client, headers)
    # Give the profile a strong, specific affinity...
    client.post(
        "/api/taste", headers=headers,
        json={"profile_id": pid, "kind": "play", "genres": ["Horror"]},
    )
    # ...but feed the endpoint a page of nothing matching.
    import tmdb_service as tmdb

    original = tmdb.get_trending_catalog
    tmdb.get_trending_catalog = lambda *a, **k: [
        {"id": 1, "title": "Romcom", "genre_ids": [10749]},
    ]
    try:
        resp = client.get(
            "/api/recommendations", headers=headers,
            query_string={"profile_id": pid},
        )
        assert resp.status_code == 200
        assert resp.get_json()["personalised"] is False
    finally:
        tmdb.get_trending_catalog = original


def test_cast_list_is_bounded():
    client = _client()
    headers, _ = _account(client, "cast")
    pid = _profile(client, headers)
    client.post(
        "/api/taste", headers=headers,
        json={
            "profile_id": pid, "kind": "play",
            "cast": [f"actor-{i}" for i in range(50)],
        },
    )
    state = client.post(
        "/api/taste/state", headers=headers, json={"profile_id": pid}
    ).get_json()["state"]
    # Storing a full top-billed cast would be a needless record about real
    # people; three is enough to recognise a favourite.
    assert len(state["people"]) <= 3


def test_delete_profile_removes_its_taste_data():
    client = _client()
    headers, _ = _account(client, "del")
    pid = _profile(client, headers)
    client.post(
        "/api/taste", headers=headers,
        json={"profile_id": pid, "kind": "play", "genres": ["horror"]},
    )
    store = _store()
    assert store.taste_events(pid)
    client.delete(f"/api/profiles/{pid}", headers=headers)
    # Taste data follows the profile it belonged to.
    assert not store.taste_events(pid)
    assert store.load_taste_state(pid) == {"genre": {}, "people": {}}


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
