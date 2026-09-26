"""Tests for profile/list sharing.

Run with:  python3 test_shares.py

Uses a throwaway SQLite database and Flask's test client, so it needs no
Postgres, no network and no test framework. The same suite is exercised
against Postgres separately -- the drivers differ in ways that matter here
(UUID columns come back as `uuid.UUID`, and TIMESTAMPTZ as `datetime`, while
SQLite hands back plain `int` and `str`), and bugs have slipped through on
one driver before. See `_is_expired` in authdb.py.
"""

import os
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="share-tests-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "shares.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False


def _fresh_store() -> authdb.Store:
    store = authdb.Store(dsn="")
    store.pg = False
    store.sqlite_path = os.path.join(_TMP, "shares.db")
    store.init()
    return store


# ---------------------------------------------------------------------------
# store layer
# ---------------------------------------------------------------------------


def test_invite_lifecycle():
    store = _fresh_store()
    owner = store.create_user("owner@example.com", "Owner", "pw123456")
    friend = store.create_user("friend@example.com", "Friend", "pw123456")
    other = store.create_user("other@example.com", "Other", "pw123456")
    oid, fid, sid = owner["id"], friend["id"], other["id"]

    invite = store.create_share_invite(oid, role="viewer")
    token = invite["token"]
    assert len(token) >= 20, "invite token is too short to be unguessable"
    assert store.count_pending_invites(oid) == 1
    assert store.share_invite_by_token(token)

    # Nobody may accept their own invite.
    assert store.accept_share_invite(token, oid, "owner@example.com") == (None, "own")
    # An unknown token is rejected without touching anything.
    assert store.accept_share_invite("nope", fid, "friend@example.com") == (
        None,
        "invalid",
    )

    accepted, reason = store.accept_share_invite(token, fid, "friend@example.com")
    assert reason == "" and accepted
    assert store.is_share_member(oid, fid)
    assert not store.is_share_member(oid, sid)
    assert len(store.shared_profiles_for_user(fid)) == 1

    # Re-opening a link you already redeemed keeps working.
    assert store.accept_share_invite(token, fid, "friend@example.com")[1] == ""
    # ...but a third party cannot ride on a used invite.
    assert store.accept_share_invite(token, sid, "other@example.com")[1] == "used"

    members = store.share_members_of(oid)
    assert len(members) == 1 and str(members[0]["user_id"]) == str(fid)

    assert store.remove_share_member(oid, fid)
    assert not store.is_share_member(oid, fid)
    assert not store.remove_share_member(oid, fid), "remove should be idempotent"


def test_invite_rejections():
    store = _fresh_store()
    owner = store.create_user("owner2@example.com", "Owner", "pw123456")
    friend = store.create_user("friend2@example.com", "Friend", "pw123456")
    oid, fid = owner["id"], friend["id"]

    def reason_for(invite, user_id, email):
        return store.accept_share_invite(invite["token"], user_id, email)[1]

    def expect(invite, user_id, email, expected):
        actual = reason_for(invite, user_id, email)
        assert actual == expected, f"expected {expected!r}, got {actual!r}"

    # Email-locked invites only work for that address.
    locked = store.create_share_invite(oid, email="friend2@example.com")
    expect(locked, fid, "wrong@example.com", "mismatch")
    expect(locked, fid, "friend2@example.com", "")

    # Revocation is owner-scoped, so a leaked token cannot cancel somebody
    # else's invite.
    fresh = store.create_share_invite(oid)
    assert not store.revoke_share_invite(fresh["token"], fid), "non-owner revoked"
    assert store.revoke_share_invite(fresh["token"], oid), "owner could not revoke"
    assert not store.revoke_share_invite(fresh["token"], oid), "revoke is idempotent"
    expect(fresh, fid, "friend2@example.com", "revoked")

    # Expiry.
    stale = store.create_share_invite(oid)
    store._execute(
        "UPDATE share_invites SET expires_at = ? WHERE token = ?",
        ("2000-01-01T00:00:00+00:00", stale["token"]),
    )
    expect(stale, fid, "friend2@example.com", "expired")

    # An unknown role falls back to the least privileged one.
    assert store.create_share_invite(oid, role="root")["role"] == "viewer"
    # Tokens are unique per invite.
    assert store.create_share_invite(oid)["token"] != store.create_share_invite(oid)["token"]


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def test_share_routes():
    import app as application

    store = _fresh_store()
    authdb._store = store
    application.authdb._store = store
    client = application.app.test_client()

    def signup(email, name):
        res = client.post(
            "/api/auth/signup",
            json={"email": email, "name": name, "password": "pw123456"},
        )
        assert res.status_code in (200, 201), (res.status_code, res.get_json())
        return res.get_json()["token"]

    def auth(token):
        return {"Authorization": f"Bearer {token}"}

    owner_t = signup("r-owner@example.com", "Owner")
    friend_t = signup("r-friend@example.com", "Friend")
    other_t = signup("r-other@example.com", "Other")
    owner_id = store.user_by_email("r-owner@example.com")["id"]
    friend_id = store.user_by_email("r-friend@example.com")["id"]

    for media_id, title in ((11, "Arrival"), (22, "Dune")):
        res = client.post(
            "/api/auth/my-list",
            json={"media_id": media_id, "media_type": "movie", "title": title},
            headers=auth(owner_t),
        )
        assert res.status_code == 200, (res.status_code, res.get_json())

    # Everything is behind a session.
    assert client.get("/api/auth/shares").status_code == 401
    assert client.post("/api/auth/shares", json={}).status_code == 401

    res = client.post("/api/auth/shares", json={"role": "viewer"}, headers=auth(owner_t))
    assert res.status_code == 200, (res.status_code, res.get_json())
    token = res.get_json()["share"]["token"]

    # Asking for the same invite twice reuses the token instead of minting more.
    again = client.post("/api/auth/shares", json={"role": "viewer"}, headers=auth(owner_t))
    assert again.get_json()["reused"] is True
    assert again.get_json()["share"]["token"] == token

    assert (
        client.post(
            "/api/auth/shares", json={"role": "superuser"}, headers=auth(owner_t)
        ).status_code
        == 400
    )

    # The preview works signed out and shows a count, not the list.
    res = client.get(f"/api/auth/shares/{token}")
    assert res.status_code == 200, (res.status_code, res.get_json())
    preview = res.get_json()
    assert preview["inviter_name"] == "Owner" and preview["item_count"] == 2
    assert "items" not in preview and "token" not in preview
    assert client.get("/api/auth/shares/does-not-exist").status_code == 404

    # A stranger cannot read the list.
    assert (
        client.get(f"/api/auth/shared/{owner_id}/my-list", headers=auth(other_t)).status_code
        == 403
    )

    assert client.post(f"/api/auth/shares/{token}/accept", headers=auth(friend_t)).status_code == 200

    res = client.get(f"/api/auth/shared/{owner_id}/my-list", headers=auth(friend_t))
    assert res.status_code == 200, (res.status_code, res.get_json())
    assert res.get_json()["owner"] == "Owner"
    assert len(res.get_json()["items"]) == 2
    # The owner still sees their own list as their own.
    assert client.get(
        f"/api/auth/shared/{owner_id}/my-list", headers=auth(owner_t)
    ).get_json()["owner"] == "you"

    # Email addresses are the owner's business, not every member's.
    owner_view = client.get(f"/api/auth/shares/{token}/members", headers=auth(owner_t))
    assert owner_view.status_code == 200, owner_view.status_code
    assert owner_view.get_json()["members"][0]["email"] == "r-friend@example.com"
    member_view = client.get(f"/api/auth/shares/{token}/members", headers=auth(friend_t))
    assert member_view.get_json()["members"][0]["email"] is None
    assert (
        client.get(f"/api/auth/shares/{token}/members", headers=auth(other_t)).status_code
        == 403
    )

    shared = client.get("/api/auth/shares", headers=auth(friend_t)).get_json()
    assert shared["shared_with_me"][0]["owner_name"] == "Owner"

    # Only the owner removes people, and doing so cuts access immediately.
    assert (
        client.delete(
            f"/api/auth/shares/{token}/members/{friend_id}", headers=auth(friend_t)
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"/api/auth/shares/{token}/members/{friend_id}", headers=auth(owner_t)
        ).status_code
        == 200
    )
    assert (
        client.get(f"/api/auth/shared/{owner_id}/my-list", headers=auth(friend_t)).status_code
        == 403
    )

    # Revoking stops future redemptions.
    res = client.post(
        "/api/auth/shares", json={"email": "r-other@example.com"}, headers=auth(owner_t)
    )
    revoked = res.get_json()["share"]["token"]
    assert client.post(f"/api/auth/shares/{revoked}/revoke", headers=auth(owner_t)).status_code == 200
    assert client.get(f"/api/auth/shares/{revoked}").status_code == 410
    assert client.post(f"/api/auth/shares/{revoked}/accept", headers=auth(other_t)).status_code == 400

    # An email-locked invite only works for that address.
    res = client.post(
        "/api/auth/shares", json={"email": "r-other@example.com"}, headers=auth(owner_t)
    )
    locked = res.get_json()["share"]["token"]
    assert client.post(f"/api/auth/shares/{locked}/accept", headers=auth(friend_t)).status_code == 400
    assert client.post(f"/api/auth/shares/{locked}/accept", headers=auth(other_t)).status_code == 200

    # Outstanding invites are capped so links cannot be manufactured freely.
    created = 0
    for i in range(40):
        res = client.post(
            "/api/auth/shares", json={"email": f"bulk{i}@example.com"}, headers=auth(owner_t)
        )
        if res.status_code == 200:
            created += 1
            continue
        assert res.status_code == 429, (res.status_code, res.get_json())
        break
    assert created <= 20, created


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
