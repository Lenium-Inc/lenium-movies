"""Tests for watch profiles, the daily allowance, and referrals.

Run with:  python3 test_profiles_limits.py

Covers the three policy decisions that are easy to regress silently:
  * a home is capped at 4 profiles, enforced server-side;
  * 10 titles/day per profile with an account-wide ceiling of 20, resetting at
    00:00 UTC;
  * a referral unlocks one uncapped day, and cannot be claimed twice, by
    yourself, or by two accounts at once.

Uses a throwaway SQLite database and Flask's test client, matching
test_shares.py.
"""

import os
import sys
import tempfile
import traceback
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="profile-tests-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "profiles.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False

import app as app_module  # noqa: E402


_EMAIL_SEQ = [0]


def _fresh_client():
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def _unique(prefix: str) -> str:
    """A per-call unique address.

    The store is shared across tests in this module, so a hardcoded address
    would 409 on the second signup and the helper would then read a token that
    is not there.
    """
    _EMAIL_SEQ[0] += 1
    return f"{prefix}-{_EMAIL_SEQ[0]}@example.com"


def _account(client, email: str) -> dict:
    client.post(
        "/api/auth/signup",
        json={"email": email, "name": "Test", "password": "pw123456"},
    )
    token = client.post(
        "/api/auth/login", json={"email": email, "password": "pw123456"}
    ).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# profiles
# ---------------------------------------------------------------------------


def test_home_is_capped_at_four_profiles():
    client = _fresh_client()
    headers = _account(client, _unique("cap"))
    created = []
    for i in range(authdb.Store.MAX_PROFILES):
        resp = client.post(
            "/api/profiles", headers=headers, json={"name": f"P{i}"}
        )
        assert resp.status_code == 201, resp.get_json()
        created.append(resp.get_json()["profile"]["id"])
    overflow = client.post("/api/profiles", headers=headers, json={"name": "P4"})
    assert overflow.status_code == 409, overflow.status_code
    assert "up to" in overflow.get_json()["error"]
    assert len(client.get("/api/profiles", headers=headers).get_json()["profiles"]) == 4


def test_profile_names_are_bounded():
    client = _fresh_client()
    headers = _account(client, _unique("names"))
    assert client.post("/api/profiles", headers=headers, json={"name": "  "}).status_code == 400
    assert client.post("/api/profiles", headers=headers, json={"name": "x" * 41}).status_code == 400


def test_profile_pin_lock_round_trip():
    client = _fresh_client()
    headers = _account(client, _unique("pin"))
    pid = client.post("/api/profiles", headers=headers, json={"name": "Kid"}).get_json()["profile"]["id"]
    assert client.patch(f"/api/profiles/{pid}", headers=headers, json={"pin": "12ab"}).status_code == 400
    assert client.patch(f"/api/profiles/{pid}", headers=headers, json={"pin": "4821"}).status_code == 200
    wrong = client.post(f"/api/profiles/{pid}/unlock", headers=headers, json={"pin": "1111"})
    assert wrong.status_code == 401, wrong.status_code
    assert client.post(f"/api/profiles/{pid}/unlock", headers=headers, json={"pin": "4821"}).status_code == 200
    # Clearing the pin removes the lock.
    assert client.patch(f"/api/profiles/{pid}", headers=headers, json={"pin": ""}).status_code == 200
    assert client.get("/api/profiles", headers=headers).get_json()["profiles"][0]["is_locked"] is False


def test_pin_hash_is_never_sent_to_the_client():
    client = _fresh_client()
    headers = _account(client, _unique("leak"))
    pid = client.post("/api/profiles", headers=headers, json={"name": "Kid"}).get_json()["profile"]["id"]
    client.patch(f"/api/profiles/{pid}", headers=headers, json={"pin": "1234"})
    profile = client.get("/api/profiles", headers=headers).get_json()["profiles"][0]
    # A hash in the response would make the PIN brute-forceable offline.
    assert "pin_hash" not in profile
    assert "pin_salt" not in profile
    assert profile["is_locked"] is True


def test_one_account_cannot_touch_another_profiles_profile():
    client = _fresh_client()
    owner = _account(client, _unique("owner"))
    stranger = _account(client, _unique("stranger"))
    pid = client.post("/api/profiles", headers=owner, json={"name": "P"}).get_json()["profile"]["id"]
    assert client.patch(f"/api/profiles/{pid}", headers=stranger, json={"name": "hax"}).status_code == 404
    assert client.delete(f"/api/profiles/{pid}", headers=stranger).status_code == 404
    assert client.post(f"/api/profiles/{pid}/unlock", headers=stranger, json={"pin": "1234"}).status_code == 404
    assert client.get("/api/profiles", headers=owner).get_json()["profiles"][0]["name"] == "P"


def test_deleting_a_profile_removes_its_history_and_allowance():
    client = _fresh_client()
    headers = _account(client, _unique("del"))
    a = client.post("/api/profiles", headers=headers, json={"name": "A"}).get_json()["profile"]["id"]
    b = client.post("/api/profiles", headers=headers, json={"name": "B"}).get_json()["profile"]["id"]
    client.post("/api/auth/history", headers=headers, json={"profile_id": a, "movie_key": "m1", "title": "A1"})
    client.post("/api/auth/history", headers=headers, json={"profile_id": b, "movie_key": "m1", "title": "B1"})
    client.post("/api/allowance/claim", headers=headers, json={"profile_id": a, "movie_key": "m1"})
    assert client.delete(f"/api/profiles/{a}", headers=headers).status_code == 200
    # B's row survives, and B's own history is untouched by A's deletion.
    assert client.get("/api/auth/history", headers=headers, json=None, query_string={"profile_id": b}).get_json()["history"]
    store = authdb.get_store()
    assert store.plays_on(a, authdb.utc_today()) == 0


# ---------------------------------------------------------------------------
# history scoping
# ---------------------------------------------------------------------------


def test_history_is_isolated_per_profile():
    client = _fresh_client()
    headers = _account(client, _unique("hist"))
    a = client.post("/api/profiles", headers=headers, json={"name": "A"}).get_json()["profile"]["id"]
    b = client.post("/api/profiles", headers=headers, json={"name": "B"}).get_json()["profile"]["id"]
    # Same title watched by two profiles: independent progress, not a merge.
    client.post("/api/auth/history", headers=headers, json={"profile_id": a, "movie_key": "shared", "title": "Shared", "progress_seconds": 100, "duration_seconds": 200})
    client.post("/api/auth/history", headers=headers, json={"profile_id": b, "movie_key": "shared", "title": "Shared", "progress_seconds": 900, "duration_seconds": 1000})
    ha = client.get("/api/auth/history", headers=headers, query_string={"profile_id": a}).get_json()["history"]
    hb = client.get("/api/auth/history", headers=headers, query_string={"profile_id": b}).get_json()["history"]
    assert len(ha) == 1 and ha[0]["progress_seconds"] == 100, ha
    assert len(hb) == 1 and hb[0]["progress_seconds"] == 900, hb
    # Clearing one profile must not wipe the other.
    client.delete("/api/auth/history", headers=headers, query_string={"profile_id": a})
    assert client.get("/api/auth/history", headers=headers, query_string={"profile_id": a}).get_json()["history"] == []
    assert len(client.get("/api/auth/history", headers=headers, query_string={"profile_id": b}).get_json()["history"]) == 1


def test_history_rejects_a_profile_from_another_account():
    client = _fresh_client()
    owner = _account(client, _unique("howner"))
    stranger = _account(client, _unique("hstranger"))
    pid = client.post("/api/profiles", headers=owner, json={"name": "P"}).get_json()["profile"]["id"]
    resp = client.post(
        "/api/auth/history",
        headers=stranger,
        json={"profile_id": pid, "movie_key": "m", "title": "M"},
    )
    assert resp.status_code == 403, resp.status_code


# ---------------------------------------------------------------------------
# daily allowance
# ---------------------------------------------------------------------------


def test_ten_titles_then_a_refusal():
    client = _fresh_client()
    headers = _account(client, _unique("cap10"))
    pid = client.post("/api/profiles", headers=headers, json={"name": "P"}).get_json()["profile"]["id"]
    for i in range(authdb.DAILY_TITLE_CAP):
        assert client.post(
            "/api/allowance/claim", headers=headers,
            json={"profile_id": pid, "movie_key": f"m{i}"},
        ).status_code == 200
    blocked = client.post(
        "/api/allowance/claim", headers=headers, json={"profile_id": pid, "movie_key": "extra"}
    )
    assert blocked.status_code == 429, blocked.status_code
    body = blocked.get_json()
    assert body["code"] == "daily_limit"
    # The message has to tell the user what to do next, not just refuse.
    assert "refer" in body["error"].lower()
    assert body["allowance"]["remaining"] == 0
    assert body["allowance"]["resets_at"].endswith("+00:00")


def test_replaying_a_title_does_not_burn_allowance():
    client = _fresh_client()
    headers = _account(client, _unique("replay"))
    pid = client.post("/api/profiles", headers=headers, json={"name": "P"}).get_json()["profile"]["id"]
    first = client.post(
        "/api/allowance/claim", headers=headers,
        json={"profile_id": pid, "movie_key": "same"},
    )
    assert first.status_code == 200
    assert first.get_json()["claimed"] is True
    # The second and third attempts are recognised as replays and must not
    # count again, even though the request still succeeds.
    for _ in range(2):
        resp = client.post(
            "/api/allowance/claim", headers=headers,
            json={"profile_id": pid, "movie_key": "same"},
        )
        assert resp.status_code == 200
        assert resp.get_json()["claimed"] is False
    store = authdb.get_store()
    assert store.plays_on(pid, authdb.utc_today()) == 1


def test_account_ceiling_applies_across_profiles():
    client = _fresh_client()
    headers = _account(client, _unique("ceiling"))
    a = client.post("/api/profiles", headers=headers, json={"name": "A"}).get_json()["profile"]["id"]
    b = client.post("/api/profiles", headers=headers, json={"name": "B"}).get_json()["profile"]["id"]
    for i in range(authdb.DAILY_TITLE_CAP):
        client.post("/api/allowance/claim", headers=headers, json={"profile_id": a, "movie_key": f"a{i}"})
    # Profile A used 10, so B can use the other 10 of the 20 account budget.
    for i in range(authdb.DAILY_TITLE_CAP):
        assert client.post(
            "/api/allowance/claim", headers=headers, json={"profile_id": b, "movie_key": f"b{i}"}
        ).status_code == 200
    third = client.post("/api/profiles", headers=headers, json={"name": "C"}).get_json()["profile"]["id"]
    blocked = client.post(
        "/api/allowance/claim", headers=headers, json={"profile_id": third, "movie_key": "c0"}
    )
    assert blocked.status_code == 429, blocked.status_code
    assert blocked.get_json()["allowance"]["account_used"] == authdb.DAILY_ACCOUNT_CAP


def test_allowance_requires_auth_and_a_profile():
    client = _fresh_client()
    assert client.post("/api/allowance/claim", json={"profile_key": "m"}).status_code == 401
    headers = _account(client, _unique("noprofile"))
    resp = client.post("/api/allowance/claim", headers=headers, json={"movie_key": "m"})
    assert resp.status_code == 409, resp.status_code
    # A blank title is rejected once a profile exists.
    pid = client.post("/api/profiles", headers=headers, json={"name": "P"}).get_json()["profile"]["id"]
    assert client.post("/api/allowance/claim", headers=headers, json={"profile_id": pid, "movie_key": ""}).status_code == 400


def test_reset_is_midnight_utc_not_server_local():
    day = authdb.utc_today()
    assert len(day) == 10 and day[4] == "-" and day[7] == "-"
    # The next reset is always the following 00:00 UTC, whatever the host zone.
    reset = (
        datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)
    ).replace(tzinfo=timezone.utc)
    assert (reset.hour, reset.minute, reset.second) == (0, 0, 0)
    assert reset > datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# referrals
# ---------------------------------------------------------------------------


def test_referral_unlocks_a_day_and_raises_the_cap():
    client = _fresh_client()
    email_inviter = _unique("inviter")
    email_joiner = _unique("joiner")
    inviter = _account(client, email_inviter)
    joiner = _account(client, email_joiner)
    code = client.get("/api/referrals", headers=inviter).get_json()["code"]
    assert code.startswith("LM") and len(code) == 10
    # Stable across devices because it is derived from the account id.
    assert client.get("/api/referrals", headers=inviter).get_json()["code"] == code

    applied = client.post("/api/referrals/apply", headers=joiner, json={"code": code})
    assert applied.status_code == 200, applied.get_json()
    # `accepted` counts the people *you* referred, so it is the inviter's
    # number. The unlocked day goes to both sides, which is what the notice
    # promises the viewer -- it used to go only to the joiner, so the inviter
    # watched their accepted count rise and nothing else happened.
    joiner_stats = client.get("/api/referrals", headers=joiner).get_json()
    assert joiner_stats["accepted"] == 0
    assert joiner_stats["granted_days"] == authdb.REFERRAL_UNLOCKS_PER_ACCEPT
    inviter_stats = client.get("/api/referrals", headers=inviter).get_json()
    assert inviter_stats["accepted"] == 1
    assert inviter_stats["granted_days"] == authdb.REFERRAL_UNLOCKS_PER_ACCEPT

    store = authdb.get_store()
    uid = store.user_by_email(email_joiner)["id"]
    today = authdb.utc_today()
    assert not store.has_unlocked_day(uid, today)
    # The grant lands on a future date, so today's cap is unchanged.
    tomorrow = (datetime.strptime(today, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    assert store.has_unlocked_day(uid, tomorrow)

    # On the unlocked day the cap stops applying.
    store.grant_day(uid, today)
    pid = client.post("/api/profiles", headers=joiner, json={"name": "P"}).get_json()["profile"]["id"]
    statuses = set()
    for i in range(authdb.DAILY_TITLE_CAP + 5):
        statuses.add(
            client.post(
                "/api/allowance/claim", headers=joiner,
                json={"profile_id": pid, "movie_key": f"u{i}"},
            ).status_code
        )
    assert statuses == {200}, statuses
    assert client.get("/api/allowance", headers=joiner).get_json()["allowance"]["unlimited"] is True


def test_referral_cannot_be_self_claimed_or_reused():
    client = _fresh_client()
    solo = _account(client, _unique("solo"))
    code = client.get("/api/referrals", headers=solo).get_json()["code"]
    assert client.post("/api/referrals/apply", headers=solo, json={"code": code}).status_code == 409

    friend = _account(client, _unique("friend"))
    assert client.post("/api/referrals/apply", headers=friend, json={"code": code}).status_code == 200
    # The same account cannot redeem a second code to stack grants.
    other = _account(client, _unique("other"))
    other_code = client.get("/api/referrals", headers=other).get_json()["code"]
    assert client.post("/api/referrals/apply", headers=friend, json={"code": other_code}).status_code == 409
    # Two accounts cannot claim the same code.
    second = _account(client, _unique("second"))
    assert client.post("/api/referrals/apply", headers=second, json={"code": code}).status_code == 409


def test_malformed_referral_codes_are_rejected():
    client = _fresh_client()
    headers = _account(client, _unique("malformed"))
    for bad in ["", "nope", "lm-lowercase", "LM123", "LMTOOLONGCODE"]:
        assert client.post("/api/referrals/apply", headers=headers, json={"code": bad}).status_code == 400, bad
    assert client.get("/api/referrals").status_code == 401


def test_concurrent_claims_cannot_exceed_the_cap():
    """The last slot goes to exactly one requester.

    The cap used to be checked in the route and the row inserted afterwards, in
    two separate statements. Four simultaneous claims for the final slot all saw
    `remaining == 1` and all four inserted, so the day finished at 11 of 10.
    The insert now carries the cap check, so the database decides.
    """
    import threading

    client = _fresh_client()
    email = _unique("race")
    headers = _account(client, email)
    pid = client.post(
        "/api/profiles", headers=headers, json={"name": "P"}
    ).get_json()["profile"]["id"]

    for i in range(authdb.DAILY_TITLE_CAP - 1):
        assert client.post(
            "/api/allowance/claim", headers=headers,
            json={"profile_id": pid, "movie_key": f"filler{i}"},
        ).status_code == 200

    statuses, lock = [], threading.Lock()

    def claim(i: int):
        cl = app_module.app.test_client()
        resp = cl.post(
            "/api/allowance/claim", headers=headers,
            json={"profile_id": pid, "movie_key": f"race{i}"},
        )
        with lock:
            statuses.append(resp.status_code)

    threads = [threading.Thread(target=claim, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert statuses.count(200) == 1, statuses
    assert statuses.count(429) == 3, statuses

    store = authdb.get_store()
    allowance = store.allowance(
        store.user_by_email(email)["id"], pid, authdb.utc_today()
    )
    assert allowance["used"] == authdb.DAILY_TITLE_CAP, allowance
    assert allowance["remaining"] == 0, allowance


def test_replaying_a_watched_title_is_not_charged_again_at_the_cap():
    client = _fresh_client()
    headers = _account(client, _unique("replay-cap"))
    pid = client.post(
        "/api/profiles", headers=headers, json={"name": "P"}
    ).get_json()["profile"]["id"]
    for i in range(authdb.DAILY_TITLE_CAP):
        assert client.post(
            "/api/allowance/claim", headers=headers,
            json={"profile_id": pid, "movie_key": f"seen{i}"},
        ).status_code == 200

    # Re-opening something already watched today: allowed, and it costs nothing.
    replay = client.post(
        "/api/allowance/claim", headers=headers,
        json={"profile_id": pid, "movie_key": "seen0"},
    )
    assert replay.status_code == 200, replay.get_json()
    assert replay.get_json()["claimed"] is False
    assert replay.get_json()["allowance"]["used"] == authdb.DAILY_TITLE_CAP

    # A title that has not been watched is still refused.
    fresh = client.post(
        "/api/allowance/claim", headers=headers,
        json={"profile_id": pid, "movie_key": "unseen"},
    )
    assert fresh.status_code == 429, fresh.status_code
    assert fresh.get_json()["code"] == "daily_limit"


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
