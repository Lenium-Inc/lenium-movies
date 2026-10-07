"""Tests for the operator account roster (`GET /api/admin/users`).

Run with:  python3 test_admin_users.py

Covers the decisions that are easy to regress silently, and one that is easy to
get wrong in a way that looks correct:
  * an anonymous request is refused (401);
  * a signed-in account *not* on the allowlist is refused with 403, not 401 --
    401 would make the client's fetch wrapper clear a perfectly good token and
    sign the operator out of their own account;
  * an unset or empty `ADMIN_EMAILS` denies everyone. This is the fail-closed
    default, and a permissive one would expose every account to any registrant;
  * an allowlisted account sees the roster, and the response never carries a
    password hash;
  * per-account counts are real, and are not inflated by joining the child
    tables together;
  * a search escapes LIKE wildcards instead of treating `%` as "match anything";
  * `is_admin` on `/api/auth/me` reflects the allowlist and grants nothing.

Uses a throwaway SQLite database and Flask's test client, matching
test_profiles_limits.py.
"""

import os
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_TMP = tempfile.mkdtemp(prefix="admin-tests-")
os.environ["SQLITE_PATH"] = os.path.join(_TMP, "admin.db")
os.environ.pop("DATABASE_URL", None)

import authdb  # noqa: E402

authdb.DATABASE_URL = ""
authdb.PG_AVAILABLE = False

import app as app_module  # noqa: E402

# One store instance for the whole suite on a throwaway file, and it owns the
# singleton. See the long note in test_profiles_limits.py: every suite in this
# directory overwrites `SQLITE_PATH` at import time, so whichever module
# imported last owned the database unless each installs its own store.
_store = authdb.Store(dsn="")
_store.pg = False
_store.sqlite_path = os.path.join(_TMP, "admin.db")
_store.init()

_EMAIL_SEQ = [0]


def _allowlist(*emails):
    os.environ["ADMIN_EMAILS"] = ",".join(emails)


def _fresh_client():
    authdb.set_store(_store)
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def _unique(prefix: str) -> str:
    _EMAIL_SEQ[0] += 1
    return f"{prefix}-{_EMAIL_SEQ[0]}@example.com"


def _account(client, email: str, name: str = "Someone") -> dict:
    """Signup and return the auth header for that session."""
    response = client.post(
        "/api/auth/signup",
        json={"email": email, "name": name, "password": "pw123456"},
    )
    assert response.status_code == 201, response.get_data(as_text=True)
    return {"Authorization": f"Bearer {response.get_json()['token']}"}


def _operator(client, allowlist=None):
    """A fresh allowlisted account: returns `(email, auth_header)`.

    Per-test rather than a shared fixture address, because the suite shares one
    database and `users.email` is UNIQUE -- a fixed operator could only be
    created once, so the second test to ask for it would 409 and the rest of the
    suite would fail on a signup rather than on anything it meant to check.

    `allowlist` receives the generated address and returns what goes into
    `ADMIN_EMAILS`, so a test can write the allowlist in the shape it is about
    (upper-cased, space-padded, wildcarded) without knowing the address first.
    """
    email = _unique("operator")
    _allowlist(allowlist(email) if allowlist else email)
    return email, _account(client, email)


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def test_anonymous_is_refused():
    """A valid allowlisted account, presented without its token. Proves the 401 is
    about the missing session and not about the allowlist."""
    client = _fresh_client()
    _, headers = _operator(client)
    assert client.get("/api/admin/users").status_code == 401
    # Same client, same allowlist, token supplied: the endpoint is reachable.
    assert client.get("/api/admin/users", headers=headers).status_code == 200


def test_signed_in_non_admin_is_forbidden_not_unauthorized():
    """403, not 401. The client's request wrapper clears the stored token on a
    401, so answering "not an admin" that way would sign the operator out."""
    client = _fresh_client()
    _operator(client)
    viewer = _account(client, _unique("plain"))

    response = client.get("/api/admin/users", headers=viewer)
    assert response.status_code == 403, response.get_data(as_text=True)
    assert "error" in response.get_json()


def test_forbidden_leaves_the_session_usable():
    """The rejection must not invalidate anything: the same token still reads
    `/api/auth/me` afterwards."""
    client = _fresh_client()
    _operator(client)
    viewer = _account(client, _unique("plain"))

    assert client.get("/api/admin/users", headers=viewer).status_code == 403
    assert client.get("/api/auth/me", headers=viewer).status_code == 200


def test_empty_allowlist_denies_everyone():
    """The fail-closed default. A permissive fallback here would hand the roster
    to anyone who can register an account."""
    _allowlist()
    client = _fresh_client()
    headers = _account(client, _unique("operator"))
    assert client.get("/api/admin/users", headers=headers).status_code == 403


def test_unset_allowlist_denies_everyone():
    os.environ.pop("ADMIN_EMAILS", None)
    client = _fresh_client()
    headers = _account(client, _unique("operator"))
    assert client.get("/api/admin/users", headers=headers).status_code == 403


def test_allowlisted_account_is_allowed():
    client = _fresh_client()
    _, headers = _operator(client)
    assert client.get("/api/admin/users", headers=headers).status_code == 200


def test_allowlist_match_is_case_insensitive():
    """Signup lowercases the address, so the allowlist has to tolerate case or an
    operator who writes `Operator@Example.com` locks themselves out silently."""
    client = _fresh_client()
    _, headers = _operator(client, allowlist=lambda e: e.upper())
    assert client.get("/api/admin/users", headers=headers).status_code == 200


def test_allowlist_ignores_surrounding_whitespace():
    """A comma-separated list written by hand picks up spaces. Treating those as
    part of the address would deny an operator who did nothing wrong."""
    client = _fresh_client()
    _, headers = _operator(
        client, allowlist=lambda e: f"  {e} , someone-else@example.com "
    )
    assert client.get("/api/admin/users", headers=headers).status_code == 200


def test_allowlist_has_no_wildcard_form():
    """`*@example.com` must not authorise a domain. Every account in these tests
    is `@example.com`, so a wildcard would hand the roster to all of them."""
    client = _fresh_client()
    _, headers = _operator(client, allowlist=lambda e: "*@example.com")
    assert client.get("/api/admin/users", headers=headers).status_code == 403


def test_allowlist_is_read_per_request_not_cached_at_import():
    """Rotating the allowlist has to take effect without a restart, or revoking
    an address is impossible short of a redeploy."""
    client = _fresh_client()
    _, headers = _operator(client)
    assert client.get("/api/admin/users", headers=headers).status_code == 200

    _allowlist()
    assert client.get("/api/admin/users", headers=headers).status_code == 403


# ---------------------------------------------------------------------------
# The payload
# ---------------------------------------------------------------------------


def test_response_never_carries_a_password_hash():
    """This is the one query that reads across every account at once, so it is
    the one place a future edit could start shipping credentials to a browser."""
    client = _fresh_client()
    _, headers = _operator(client)

    body = client.get("/api/admin/users", headers=headers).get_data(as_text=True)
    assert "password" not in body.lower(), body
    assert "pw123456" not in body


def test_is_admin_flag_reflects_the_allowlist_and_grants_nothing():
    client = _fresh_client()
    _, operator = _operator(client)
    viewer = _account(client, _unique("plain"))

    assert client.get("/api/auth/me", headers=operator).get_json()["user"]["is_admin"]
    assert not client.get("/api/auth/me", headers=viewer).get_json()["user"]["is_admin"]
    # And the flag is only a hint: the viewer is still refused by the endpoint.
    assert client.get("/api/admin/users", headers=viewer).status_code == 403


def test_payload_counts_match_the_stored_rows():
    client = _fresh_client()
    _, headers = _operator(client)
    email = _unique("counted")

    account = _account(client, email, name="Counted")
    account_id = authdb.get_store().user_by_email(email)["id"]

    client.post("/api/profiles", headers=account, json={"name": "Adult"})
    client.post("/api/profiles", headers=account, json={"name": "Kid"})
    for title in ("One", "Two", "Three"):
        client.post(
            "/api/auth/history",
            headers=account,
            json={"movie_key": title, "title": title, "progress_seconds": 10},
        )

    users = client.get("/api/admin/users", headers=headers).get_json()["users"]
    row = next(u for u in users if u["email"] == email)

    assert row["profile_count"] == 2, row
    assert row["history_count"] == 3, row
    assert row["active_sessions"] == 1, row
    assert row["last_active"], "a profile with history should report last_active"
    assert row["name"] == "Counted"
    assert account_id  # both sides exercised


def test_counts_are_not_inflated_by_joining_child_tables():
    """A user with 3 profiles and 3 history rows must count 3 and 3, not 9.

    A single JOIN over both child tables produces the cross product, and this
    pins the correlated-subquery shape that avoids it.
    """
    client = _fresh_client()
    _, headers = _operator(client)
    email = _unique("multiplied")

    account = _account(client, email)
    for name in ("A", "B", "C"):
        client.post("/api/profiles", headers=account, json={"name": name})
    for i in range(3):
        client.post(
            "/api/auth/history",
            headers=account,
            json={"movie_key": f"k{i}", "title": f"k{i}", "progress_seconds": 1},
        )

    users = client.get("/api/admin/users", headers=headers).get_json()["users"]
    row = next(u for u in users if u["email"] == email)
    assert (row["profile_count"], row["history_count"]) == (3, 3), row


def test_expired_sessions_are_not_counted_as_active():
    """`sessions` keeps rows past their expiry until the token is next presented.
    Counting them would report a logged-out account as live."""
    client = _fresh_client()
    _, headers = _operator(client)
    email = _unique("stale")

    account = _account(client, email)
    assert _session_count(email) == 1

    _store._execute(
        "UPDATE sessions SET expires_at = ? WHERE user_id = ?",
        ("2000-01-01T00:00:00.000000Z", authdb.get_store().user_by_email(email)["id"]),
    )

    users = client.get("/api/admin/users", headers=headers).get_json()["users"]
    row = next(u for u in users if u["email"] == email)
    assert row["active_sessions"] == 0, row
    # The account still exists and is still listed -- only the session expired.
    assert row is not None and account


def _session_count(email: str) -> int:
    user_id = authdb.get_store().user_by_email(email)["id"]
    rows = _store._query(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", (user_id,), fetch_all=True
    )
    return int(rows[0]["n"])


def test_totals_describe_the_database_not_the_search():
    """Totals sit beside a filtered page. If a search narrowed them, the header
    would read as "3 accounts" while showing one of them."""
    client = _fresh_client()
    _, headers = _operator(client)
    for _ in range(3):
        _account(client, _unique("bulk"))

    unfiltered = client.get("/api/admin/users", headers=headers).get_json()["totals"]
    filtered = client.get(
        "/api/admin/users?q=bogus-nothing", headers=headers
    ).get_json()

    assert filtered["users"] == [], filtered["users"]
    assert filtered["totals"]["users"] == unfiltered["users"]
    assert unfiltered["users"] >= 4


# ---------------------------------------------------------------------------
# Search and paging
# ---------------------------------------------------------------------------


def test_search_matches_email_and_name_case_insensitively():
    client = _fresh_client()
    _, headers = _operator(client)
    email = _unique("findme")
    _account(client, email, name="Zebediah")

    by_email = client.get(f"/api/admin/users?q=FINDME", headers=headers).get_json()
    assert email in [u["email"] for u in by_email["users"]]

    by_name = client.get("/api/admin/users?q=zebediah", headers=headers).get_json()
    assert email in [u["email"] for u in by_name["users"]]


def test_search_with_no_match_returns_an_empty_page_not_an_error():
    client = _fresh_client()
    _, headers = _operator(client)
    payload = client.get("/api/admin/users?q=nothinghere", headers=headers).get_json()
    assert payload["users"] == []


def test_search_escapes_like_wildcards():
    """A search for `50%` must look for those characters, not match every row."""
    client = _fresh_client()
    _, headers = _operator(client)
    _account(client, _unique("plain"))

    # Unescaped, this would match every account in the table.
    payload = client.get("/api/admin/users?q=%25", headers=headers).get_json()
    assert payload["users"] == []

    # And `_`, the single-character wildcard, likewise.
    assert client.get("/api/admin/users?q=_", headers=headers).get_json()["users"] == []


def test_paging_walks_the_roster_without_repeating_or_dropping_rows():
    client = _fresh_client()
    _, headers = _operator(client)
    emails = []
    for _ in range(7):
        email = _unique("paged")
        _account(client, email)
        emails.append(email)

    seen = []
    for offset in (0, 3, 6, 9):
        payload = client.get(
            f"/api/admin/users?limit=3&offset={offset}", headers=headers
        ).get_json()
        seen.extend(u["email"] for u in payload["users"])

    assert len(seen) == len(set(seen)), "a page repeated a row"
    assert set(emails).issubset(set(seen)), sorted(set(emails) - set(seen))
    # Past the end is an empty page, not an error or a wrap-around.
    assert client.get(
        "/api/admin/users?limit=3&offset=9999", headers=headers
    ).get_json()["users"] == []


def test_limit_is_clamped_and_unparseable_values_fall_back():
    client = _fresh_client()
    _, headers = _operator(client)

    assert client.get("/api/admin/users?limit=0", headers=headers).get_json()["limit"] == 1
    assert client.get("/api/admin/users?limit=9999", headers=headers).get_json()["limit"] == 200
    assert client.get("/api/admin/users?limit=abc", headers=headers).get_json()["limit"] == 50
    assert client.get("/api/admin/users?offset=-5", headers=headers).get_json()["offset"] == 0


def test_search_term_is_length_capped():
    client = _fresh_client()
    _, headers = _operator(client)
    payload = client.get("/api/admin/users?q=" + "a" * 500, headers=headers).get_json()
    assert len(payload["search"]) <= 200


def test_newest_accounts_come_first():
    client = _fresh_client()
    _, headers = _operator(client)
    older = _unique("older")
    _account(client, older)
    newer = _unique("newer")
    _account(client, newer)

    users = client.get("/api/admin/users", headers=headers).get_json()["users"]
    emails = [u["email"] for u in users]
    assert emails.index(newer) < emails.index(older), emails


# ---------------------------------------------------------------------------
# The roster must stay read-only
# ---------------------------------------------------------------------------


def test_roster_exposes_no_mutation_route():
    """Every admin verb is refused. This endpoint is a read: an accepted POST or
    DELETE would reopen the mutation surface the PRD closes."""
    client = _fresh_client()
    _, headers = _operator(client)

    assert client.post("/api/admin/users", headers=headers, json={}).status_code == 405
    assert client.delete("/api/admin/users", headers=headers).status_code == 405
    assert client.put("/api/admin/users", headers=headers, json={}).status_code == 405


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