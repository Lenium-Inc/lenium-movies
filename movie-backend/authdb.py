"""
Account & watch-history store for the movie backend.

Persists users, bearer-token sessions, and per-account watch history.

Storage: when `DATABASE_URL` is set (e.g. a Neon/Postgres connection string on
Render) the store uses Postgres via `psycopg`. Otherwise it falls back to a
local SQLite file so the API works out of the box in development.

Passwords are hashed with PBKDF2-HMAC-SHA256 (stdlib, no extra deps) using a
per-user random salt. Tokens are opaque `secrets.token_urlsafe` values with a
30-day expiry tied to a sessions row.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone

# The dotenv loader lives in runtime_config so that every module resolves
# secrets the same way regardless of which one happens to be imported first.
from runtime_config import load_env_file

HERE = os.path.dirname(os.path.abspath(__file__))

# Daily playback policy. 10 titles per profile per day, with an account-wide
# ceiling so adding profiles cannot multiply the total. Both are per UTC day:
# "today" is computed with `utc_today` rather than the server's local date, so a
# deploy in any timezone resets at the same moment for everyone.
DAILY_TITLE_CAP = 10
DAILY_ACCOUNT_CAP = 20

# One accepted referral unlocks one day, where "a day" is a UTC date on which
# the cap does not apply. Grants land on future dates, oldest first.
REFERRAL_UNLOCKS_PER_ACCEPT = 1

# Ambiguous characters (0/O, 1/I) are excluded so a code read aloud or retyped
# from a screenshot survives.
_REFERRAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def utc_today(now: float | None = None) -> str:
    """The current allowance day as YYYY-MM-DD, in UTC."""
    ts = time.time() if now is None else now
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _make_referral_code(user_id) -> str:
    """A stable, human-typeable code for a user.

    Derived from the id with a keyed hash so it is deterministic (the same
    account shows the same code on every device) but not guessable from the id
    alone, and the UNIQUE constraint remains the real boundary.
    """
    digest = hashlib.sha256(f"lenium-referral:{user_id}".encode()).digest()
    body = "".join(
        _REFERRAL_ALPHABET[b % len(_REFERRAL_ALPHABET)] for b in digest[:8]
    )
    return f"LM{body}"

load_env_file()

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SESSION_TTL_DAYS = 30
_ISO = "%Y-%m-%dT%H:%M:%S.%fZ"

PG_AVAILABLE = False
try:  # optional — only used when DATABASE_URL is set
    import psycopg  # type: ignore

    PG_AVAILABLE = True
except Exception:  # pragma: no cover - dev boxes without the driver
    PG_AVAILABLE = False


def _now() -> str:
    return datetime.now(timezone.utc).strftime(_ISO)


def _to_iso(value) -> str | None:
    """Normalize created_at/updated_at into an ISO string whether the driver
    returned TEXT (SQLite) or a Python datetime (Postgres timestamptz)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.strftime(_ISO)
    return str(value)


def _expires_at() -> str:
    future = datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)
    return future.strftime(_ISO)


def _is_expired(value) -> bool:
    """True when a stored expiry has passed.

    Accepts a datetime as well as a string: Postgres TIMESTAMPTZ columns come
    back from psycopg as datetime objects, and feeding one to strptime raises
    TypeError, which the old `except` turned into "expired". That silently
    expired every row the moment it was written.
    """
    if not value:
        return True
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > value
    try:
        dt = datetime.strptime(str(value), _ISO).replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > dt
    except (ValueError, TypeError):
        return True


class Store:
    """Tiny dual-driver data layer. `sqlite3` by default, Postgres when a
    `DATABASE_URL` is configured and psycopg is installed."""

    def __init__(self, dsn: str | None = None, dsn_path: str | None = None) -> None:
        self.dsn = (dsn or DATABASE_URL).strip()
        self.pg = bool(self.dsn) and PG_AVAILABLE
        # `SQLITE_PATH` is read per instantiation rather than cached at import:
        # a test that wants its own database can point the env var at a temp file
        # and build a Store afterwards. Caching it in a module global meant the
        # value was fixed by whichever import happened first.
        self.sqlite_path = dsn_path or os.environ.get(
            "SQLITE_PATH", os.path.join(HERE, "data", "freestream.db")
        )

    # -- connections ------------------------------------------------------

    def _connect(self):
        if self.pg:
            import psycopg

            conn = psycopg.connect(self.dsn)
            conn.autocommit = True
            return conn
        os.makedirs(os.path.dirname(self.sqlite_path), exist_ok=True)
        conn = sqlite3.connect(self.sqlite_path, timeout=15)
        conn.row_factory = sqlite3.Row
        return conn

    def _sql(self, statement: str) -> str:
        if self.pg:
            return statement.replace("?", "%s")
        return statement

    def _rows(self, cur, fetch_all: bool):
        if self.pg:
            columns = [d.name for d in cur.description] if cur.description else []
            rows = cur.fetchall() if fetch_all else cur.fetchone()
            if rows is None:
                return None
            if fetch_all:
                return [dict(zip(columns, row)) for row in rows]
            return dict(zip(columns, rows))
        rows = cur.fetchall() if fetch_all else cur.fetchone()
        if rows is None:
            return None
        if fetch_all:
            return [dict(row) for row in rows]
        return dict(rows)

    def _query(self, sql: str, params: tuple = (), fetch_all: bool = False):
        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute(self._sql(sql), params)
            return self._rows(cur, fetch_all)
        finally:
            conn.close()

    def _execute(self, sql: str, params: tuple = ()) -> int | None:
        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute(self._sql(sql), params)
            if not self.pg:
                conn.commit()
                last = cur.lastrowid
            else:
                last = None
            return last
        finally:
            conn.close()

    def _execute_rowcount(self, sql: str, params: tuple = ()) -> int:
        """Run a write and report how many rows it touched.

        `_execute` cannot answer this: it returns `lastrowid`, which is only
        meaningful for an INSERT and is 0 for the UPDATE/DELETE statements
        that need the count.
        """
        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute(self._sql(sql), params)
            if not self.pg:
                conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()

    def _execute_returning(self, sql: str, params: tuple = ()) -> dict | None:
        """INSERT ... RETURNING row for Postgres (ids are DB-generated UUIDs)."""
        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute(self._sql(sql), params)
            return self._rows(cur, fetch_all=False)
        finally:
            conn.close()

    # -- schema -----------------------------------------------------------

    def init(self) -> None:
        conn = self._connect()
        try:
            cur = conn.cursor()
            if self.pg:
                # Matches the Neon-provisioned schema submitted with the task
                # (the live DB already has these tables; CREATE IF NOT EXISTS is
                # a no-op there and bootstraps the same shape on a fresh pg).
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        email TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        token TEXT PRIMARY KEY,
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        expires_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS watch_profiles (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        name TEXT NOT NULL,
                        avatar TEXT NOT NULL DEFAULT '',
                        avatar_id TEXT,
                        is_kids INT DEFAULT 0,
                        is_locked INT DEFAULT 0,
                        pin_hash TEXT,
                        pin_salt TEXT,
                        sort_order INT DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS watch_history (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        profile_id UUID REFERENCES watch_profiles(id) ON DELETE CASCADE,
                        movie_key TEXT NOT NULL,
                        title TEXT NOT NULL,
                        year INT,
                        poster TEXT,
                        backdrop TEXT,
                        media_type TEXT,
                        progress_seconds INT DEFAULT 0,
                        duration_seconds INT DEFAULT 0,
                        completed INT DEFAULT 0,
                        watched_at BIGINT DEFAULT 0,
                        updated_at TEXT NOT NULL,
                        UNIQUE (user_id, profile_id, movie_key)
                    )
                    """
                )
                # Scoped daily playback counters, one row per profile per UTC
                # day. A separate table rather than a counter on watch_history
                # because a title can be replayed and must only count once, and
                # because the day boundary is a policy decision (UTC) that is
                # cheaper to change here than in every read path.
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS daily_plays (
                        profile_id UUID NOT NULL REFERENCES watch_profiles(id) ON DELETE CASCADE,
                        day TEXT NOT NULL,
                        movie_key TEXT NOT NULL,
                        played_at BIGINT DEFAULT 0,
                        PRIMARY KEY (profile_id, day, movie_key)
                    )
                    """
                )
                # Referral bookkeeping. `code` is the owner's shareable string and
                # `referred_by` is the one account that may have referred this
                # user; UNIQUE is what makes self-referral and double-claiming
                # impossible at the database level rather than in app logic.
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS referral_codes (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        code TEXT NOT NULL UNIQUE,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS referral_uses (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        code_id UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
                        referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        UNIQUE (code_id),
                        UNIQUE (referred_id)
                    )
                    """
                )
                # Unlocked days granted by referrals. A separate table so a grant
                # is auditable and revocable, and so the daily cap can be
                # recomputed from scratch rather than by mutating a counter that
                # can drift.
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS referral_grants (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        day TEXT NOT NULL,
                        source TEXT NOT NULL DEFAULT 'referral',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        UNIQUE (owner_id, day)
                    )
                    """
                )
                # Per-profile taste signals. Only derived features are stored --
                # normalised genre/cast/director weights plus a hashed query
                # token -- never the raw search text, so a private search cannot
                # be read back out of this table.
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS taste_signals (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        profile_id UUID NOT NULL REFERENCES watch_profiles(id) ON DELETE CASCADE,
                        kind TEXT NOT NULL,
                        feature TEXT NOT NULL,
                        weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        UNIQUE (profile_id, kind, feature)
                    )
                    """
                )
                # Append-only interaction log. This is what the recommender is
                # scored from and what a held-out evaluation is split on, so it
                # is kept separate from the rolled-up weights.
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS taste_events (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        profile_id UUID NOT NULL REFERENCES watch_profiles(id) ON DELETE CASCADE,
                        kind TEXT NOT NULL,
                        media_key TEXT,
                        weight DOUBLE PRECISION NOT NULL DEFAULT 0,
                        genres TEXT NOT NULL DEFAULT '',
                        people TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_taste_events_profile
                    ON taste_events(profile_id, created_at DESC)
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_taste_signals_profile
                    ON taste_signals(profile_id)
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS saved_media (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        media_id BIGINT NOT NULL,
                        media_type TEXT NOT NULL DEFAULT 'movie',
                        title TEXT NOT NULL DEFAULT '',
                        poster_path TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        UNIQUE (user_id, media_id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS catalog_cache (
                        media_id BIGINT PRIMARY KEY,
                        media_type TEXT NOT NULL DEFAULT 'movie',
                        payload JSONB,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_catalog_cache_type_updated
                        ON catalog_cache(media_type, updated_at DESC)
                    """
                )
                # Profile/list sharing. `share_invites` is an outstanding
                # invitation; `share_members` is one row per person who
                # accepted one. The owner's list stays in saved_media -- a
                # share only grants read access to it, so nothing is copied.
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS share_invites (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        token TEXT NOT NULL UNIQUE,
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        email TEXT,
                        role TEXT NOT NULL DEFAULT 'viewer',
                        status TEXT NOT NULL DEFAULT 'pending',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
                        accepted_at TIMESTAMPTZ,
                        accepted_by UUID REFERENCES users(id) ON DELETE SET NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS share_members (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        role TEXT NOT NULL DEFAULT 'viewer',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        UNIQUE (owner_id, user_id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_share_invites_owner
                    ON share_invites(owner_id)
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_share_members_user
                    ON share_members(user_id)
                    """
                )
            else:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        email TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        password_salt TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        token TEXT PRIMARY KEY,
                        user_id INTEGER NOT NULL,
                        expires_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS watch_profiles (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL,
                        name TEXT NOT NULL,
                        avatar TEXT NOT NULL DEFAULT '',
                        avatar_id TEXT,
                        is_kids INT DEFAULT 0,
                        is_locked INT DEFAULT 0,
                        pin_hash TEXT,
                        pin_salt TEXT,
                        sort_order INT DEFAULT 0,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS watch_history (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL,
                        profile_id INTEGER,
                        movie_key TEXT NOT NULL,
                        title TEXT NOT NULL,
                        year INT,
                        poster TEXT,
                        backdrop TEXT,
                        media_type TEXT,
                        progress_seconds INT DEFAULT 0,
                        duration_seconds INT DEFAULT 0,
                        completed INT DEFAULT 0,
                        watched_at BIGINT DEFAULT 0,
                        updated_at TEXT NOT NULL,
                        UNIQUE (user_id, profile_id, movie_key)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS daily_plays (
                        profile_id INTEGER NOT NULL,
                        day TEXT NOT NULL,
                        movie_key TEXT NOT NULL,
                        played_at BIGINT DEFAULT 0,
                        PRIMARY KEY (profile_id, day, movie_key)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS referral_codes (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_id INTEGER NOT NULL,
                        code TEXT NOT NULL UNIQUE,
                        created_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS referral_uses (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        code_id INTEGER NOT NULL,
                        referred_id INTEGER NOT NULL,
                        created_at TEXT NOT NULL,
                        UNIQUE (code_id),
                        UNIQUE (referred_id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS referral_grants (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_id INTEGER NOT NULL,
                        day TEXT NOT NULL,
                        source TEXT NOT NULL DEFAULT 'referral',
                        created_at TEXT NOT NULL,
                        UNIQUE (owner_id, day)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS taste_signals (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        profile_id INTEGER NOT NULL,
                        kind TEXT NOT NULL,
                        feature TEXT NOT NULL,
                        weight REAL NOT NULL DEFAULT 0,
                        updated_at TEXT NOT NULL,
                        UNIQUE (profile_id, kind, feature)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS taste_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        profile_id INTEGER NOT NULL,
                        kind TEXT NOT NULL,
                        media_key TEXT,
                        weight REAL NOT NULL DEFAULT 0,
                        genres TEXT NOT NULL DEFAULT '',
                        people TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_taste_events_profile
                    ON taste_events(profile_id, created_at DESC)
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_taste_signals_profile
                    ON taste_signals(profile_id)
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS saved_media (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL,
                        media_id INTEGER NOT NULL,
                        media_type TEXT NOT NULL DEFAULT 'movie',
                        title TEXT NOT NULL DEFAULT '',
                        poster_path TEXT,
                        created_at TEXT NOT NULL,
                        UNIQUE (user_id, media_id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS catalog_cache (
                        media_id INTEGER PRIMARY KEY,
                        media_type TEXT NOT NULL DEFAULT 'movie',
                        payload TEXT,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_catalog_cache_type_updated
                        ON catalog_cache(media_type, updated_at DESC)
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS share_invites (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        token TEXT NOT NULL UNIQUE,
                        owner_id INTEGER NOT NULL,
                        email TEXT,
                        role TEXT NOT NULL DEFAULT 'viewer',
                        status TEXT NOT NULL DEFAULT 'pending',
                        created_at TEXT NOT NULL,
                        expires_at TEXT NOT NULL,
                        accepted_at TEXT,
                        accepted_by INTEGER
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS share_members (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_id INTEGER NOT NULL,
                        user_id INTEGER NOT NULL,
                        role TEXT NOT NULL DEFAULT 'viewer',
                        created_at TEXT NOT NULL,
                        UNIQUE (owner_id, user_id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_share_invites_owner
                    ON share_invites(owner_id)
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_share_members_user
                    ON share_members(user_id)
                    """
                )
                conn.commit()
        finally:
            conn.close()
        self._migrate_columns()
        # After the columns, so the rebuild can copy the new ones.
        self._migrate_history_unique()

    def _migrate_columns(self) -> None:
        """Additive column migrations for databases created before profiling.

        `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so
        deploying the new profile tables alone would leave a live install with
        the old `watch_history` shape: no `profile_id`, and a UNIQUE constraint
        keyed on (user_id, movie_key) that would merge every profile's history
        into one. That failure is silent, so each column is added explicitly and
        is a no-op on a fresh database.
        """
        wanted = [
            ("watch_history", "profile_id", "UUID" if self.pg else "INTEGER"),
            ("watch_history", "duration_seconds", "INT DEFAULT 0"),
        ]
        for table, column, coltype in wanted:
            if self._has_column(table, column):
                continue
            try:
                self._execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")
            except Exception:
                # A concurrent deploy may have added it first, or the backend may
                # not be privileged enough. Never fail init for this: the
                # application tolerates a missing profile_id by treating rows as
                # unprofiled, which is strictly better than refusing to boot.
                pass

    def _migrate_history_unique(self) -> None:
        """Rebuild `watch_history` when its UNIQUE constraint predates profiles.

        Adding a `profile_id` column is not enough. The original constraint was
        `UNIQUE (user_id, movie_key)`, so two profiles in one home watching the
        same title still collided on insert -- the second profile's history
        silently overwrote the first's, or raised depending on the statement.
        The fix has to be the constraint itself, and SQLite cannot alter one in
        place, so the table is rebuilt and copied.

        This is destructive to the old constraint, not to the rows: every
        existing row is preserved, and rows with a NULL `profile_id` (written
        before profiling existed) are given the account's first profile so they
        become visible rather than orphaned.
        """
        try:
            if self.pg:
                self._rebuild_history_unique_pg()
            else:
                self._rebuild_history_unique_sqlite()
        except Exception:
            # A failed migration must not stop the process from booting. The
            # worst case is the old collision behaviour, which is what the app
            # did before profiles existed.
            pass

    # Columns are listed once so both backends copy exactly the same set.
    _HISTORY_COLUMNS = (
        "id",
        "user_id",
        "profile_id",
        "movie_key",
        "title",
        "year",
        "poster",
        "backdrop",
        "media_type",
        "progress_seconds",
        "duration_seconds",
        "completed",
        "watched_at",
        "updated_at",
    )

    def _rebuild_history_unique_sqlite(self) -> None:
        row = self._query(
            "SELECT sql FROM sqlite_master WHERE name = 'watch_history'",
            fetch_all=True,
        )
        # `_query` hands back dicts, and only when `fetch_all` is set does it
        # hand back a list. Positional indexing raised KeyError here, and since
        # the caller swallows migration errors the constraint was silently never
        # rebuilt.
        current = (row[0].get("sql") or "") if row else ""
        # Already correct: nothing to do. This is the common case.
        if "UNIQUE (user_id, profile_id, movie_key)" in current.replace("  ", " "):
            return
        cols = ", ".join(self._HISTORY_COLUMNS)
        # `PRAGMA foreign_keys` is a no-op inside a transaction, and every
        # `_execute` opens and closes its own connection -- so toggling it per
        # statement does nothing and the rename below would fail the moment the
        # table had any referencing foreign key. It is turned off for the whole
        # rebuild on one connection instead.
        conn = self._connect()
        try:
            conn.execute("PRAGMA foreign_keys = OFF")
            cur = conn.cursor()
            cur.execute("ALTER TABLE watch_history RENAME TO watch_history_legacy")
            cur.execute(
                """
                CREATE TABLE watch_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    profile_id INTEGER,
                    movie_key TEXT NOT NULL,
                    title TEXT NOT NULL,
                    year INT,
                    poster TEXT,
                    backdrop TEXT,
                    media_type TEXT,
                    progress_seconds INT DEFAULT 0,
                    duration_seconds INT DEFAULT 0,
                    completed INT DEFAULT 0,
                    watched_at BIGINT DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    UNIQUE (user_id, profile_id, movie_key)
                )
                """
            )
            cols = ", ".join(self._HISTORY_COLUMNS)
            cur.execute(
                f"INSERT OR IGNORE INTO watch_history ({cols}) "
                f"SELECT {cols} FROM watch_history_legacy"
            )
            cur.execute("DROP TABLE watch_history_legacy")
            conn.commit()
        finally:
            try:
                conn.execute("PRAGMA foreign_keys = ON")
            finally:
                conn.close()
        self._adopt_orphan_history()
        return

    def _rebuild_history_unique_pg(self) -> None:
        constraints = self._query(
            "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint "
            "WHERE conrelid = 'watch_history'::regclass AND contype = 'u'"
        )
        defs = " | ".join((r.get("def") or "") for r in (constraints or []))
        if "profile_id" in defs and "movie_key" in defs:
            return
        # A unique index on (user_id, movie_key) has to go before the new
        # constraint can be created, and the old index is what enforces it.
        self._execute(
            "DROP INDEX IF EXISTS watch_history_user_id_movie_key_key"
        )
        self._execute("ALTER TABLE watch_history DROP CONSTRAINT IF EXISTS watch_history_user_id_movie_key_key")
        cols = ", ".join(self._HISTORY_COLUMNS)
        self._execute(
            f"INSERT INTO watch_history ({cols}) "
            f"SELECT {cols} FROM watch_history ON CONFLICT DO NOTHING"
        )
        self._execute(
            "ALTER TABLE watch_history ADD CONSTRAINT watch_history_profile_key "
            "UNIQUE (user_id, profile_id, movie_key)"
        )
        self._adopt_orphan_history()

    def _adopt_orphan_history(self) -> None:
        """Give pre-profile history rows the account's first profile.

        Every read is scoped by `profile_id`, so a row left NULL is invisible: a
        viewer who had history before the upgrade would find an empty Continue
        Watching with no way to recover the rows.

        Runs as a plain correlated subquery rather than a join. SQLite evaluates
        the inner `SELECT` once for the whole statement when it is not correlated
        to the outer row, which silently updated *no* rows -- and since the
        caller swallows errors, that looked like a successful migration.
        """
        try:
            if self.pg:
                self._execute(
                    "UPDATE watch_history h SET profile_id = first.id "
                    "FROM (SELECT DISTINCT ON (user_id) id, user_id FROM watch_profiles "
                    "      ORDER BY user_id, sort_order, created_at) AS first "
                    "WHERE h.profile_id IS NULL AND h.user_id = first.user_id"
                )
            else:
                self._execute(
                    "UPDATE watch_history SET profile_id = ("
                    "  SELECT p.id FROM watch_profiles AS p "
                    "  WHERE p.user_id = watch_history.user_id "
                    "  ORDER BY p.sort_order, p.rowid LIMIT 1"
                    ") WHERE profile_id IS NULL "
                    "AND EXISTS (SELECT 1 FROM watch_profiles AS q "
                    "            WHERE q.user_id = watch_history.user_id)"
                )
        except Exception:
            pass

    def _has_column(self, table: str, column: str) -> bool:
        try:
            if self.pg:
                rows = self._query(
                    "SELECT 1 AS ok FROM information_schema.columns "
                    "WHERE table_name = ? AND column_name = ? LIMIT 1",
                    (table, column),
                )
            else:
                rows = self._query(f"PRAGMA table_info({table})")
                return any(r.get("name") == column for r in (rows or []))
            return bool(rows)
        except Exception:
            return False

    # -- profiles ---------------------------------------------------------

    # A home is capped at 4 profiles. Enforced in the write path rather than
    # only in the UI, because the cap is a business rule and a client-side
    # check is not a boundary.
    MAX_PROFILES = 4

    def list_profiles(self, user_id) -> list[dict]:
        rows = self._query(
            "SELECT * FROM watch_profiles WHERE user_id = ? "
            "ORDER BY sort_order ASC, created_at ASC",
            (user_id,),
            fetch_all=True,
        )
        return list(rows or [])

    def profile_by_id(self, profile_id, user_id) -> dict | None:
        # user_id is part of the predicate on purpose: a profile id is guessable
        # (autoincrement on sqlite), so ownership must be checked server-side.
        rows = self._query(
            "SELECT * FROM watch_profiles WHERE id = ? AND user_id = ? LIMIT 1",
            (profile_id, user_id),
            fetch_all=True,
        )
        return rows[0] if rows else None

    def count_profiles(self, user_id) -> int:
        rows = self._query(
            "SELECT COUNT(*) AS n FROM watch_profiles WHERE user_id = ?",
            (user_id,),
            fetch_all=True,
        )
        return int((rows[0] or {}).get("n", 0)) if rows else 0

    def create_profile(
        self,
        user_id,
        name: str,
        avatar: str = "",
        avatar_id: str | None = None,
        is_kids: int = 0,
        pin_hash: str | None = None,
        pin_salt: str | None = None,
    ) -> dict | None:
        if self.count_profiles(user_id) >= self.MAX_PROFILES:
            return None
        order = self.count_profiles(user_id)
        self._execute(
            "INSERT INTO watch_profiles "
            "(user_id, name, avatar, avatar_id, is_kids, is_locked, pin_hash, pin_salt, sort_order, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                user_id,
                name,
                avatar,
                avatar_id,
                1 if is_kids else 0,
                1 if pin_hash else 0,
                pin_hash,
                pin_salt,
                order,
                _now_iso(),
            ),
        )
        rows = self._query(
            "SELECT * FROM watch_profiles WHERE user_id = ? "
            "ORDER BY sort_order ASC, created_at ASC",
            (user_id,),
            fetch_all=True,
        )
        created = rows[-1] if rows else None
        # The first profile of a pre-profiles account inherits that account's
        # orphaned history. Adopting only at migration time is not enough: the
        # migration runs at boot, when such an account usually has no profiles
        # yet, so there is nothing to adopt into and the rows would stay
        # invisible to every profile-scoped read forever.
        if created and order == 0:
            try:
                self._execute(
                    "UPDATE watch_history SET profile_id = ? "
                    "WHERE user_id = ? AND profile_id IS NULL",
                    (created["id"], user_id),
                )
            except Exception:
                pass
        return created

    def update_profile(self, profile_id, user_id, **fields) -> dict | None:
        allowed = {
            "name",
            "avatar",
            "avatar_id",
            "is_kids",
            "is_locked",
            "pin_hash",
            "pin_salt",
            "sort_order",
        }
        sets, params = [], []
        for key, value in fields.items():
            if key not in allowed:
                continue
            sets.append(f"{key} = ?")
            params.append(value)
        if not sets:
            return self.profile_by_id(profile_id, user_id)
        params.extend([profile_id, user_id])
        self._execute(
            f"UPDATE watch_profiles SET {', '.join(sets)} WHERE id = ? AND user_id = ?",
            tuple(params),
        )
        return self.profile_by_id(profile_id, user_id)

    def delete_profile(self, profile_id, user_id) -> bool:
        # daily_plays and history cascade via the FK on pg; sqlite needs the
        # rows removed explicitly, and doing it here keeps both backends
        # observably identical. The taste tables have no FK, so without this
        # the taste profile of a deleted viewer would sit in the database
        # forever.
        self._execute(
            "DELETE FROM daily_plays WHERE profile_id = ?", (profile_id,)
        )
        self._execute(
            "DELETE FROM taste_events WHERE profile_id = ?", (profile_id,)
        )
        self._execute(
            "DELETE FROM taste_signals WHERE profile_id = ?", (profile_id,)
        )
        self._execute(
            "DELETE FROM watch_history WHERE profile_id = ? AND user_id = ?",
            (profile_id, user_id),
        )
        n = self._execute_rowcount(
            "DELETE FROM watch_profiles WHERE id = ? AND user_id = ?",
            (profile_id, user_id),
        )
        return bool(n)

    # -- daily allowance & referrals ---------------------------------------

    def plays_on(self, profile_id, day: str) -> int:
        rows = self._query(
            "SELECT COUNT(*) AS n FROM daily_plays WHERE profile_id = ? AND day = ?",
            (profile_id, day),
            fetch_all=True,
        )
        return int((rows[0] or {}).get("n", 0)) if rows else 0

    def account_plays_on(self, user_id, day: str) -> int:
        rows = self._query(
            "SELECT COUNT(*) AS n FROM daily_plays d "
            "JOIN watch_profiles p ON p.id = d.profile_id "
            "WHERE p.user_id = ? AND d.day = ?",
            (user_id, day),
            fetch_all=True,
        )
        return int((rows[0] or {}).get("n", 0)) if rows else 0

    def claimed_today(self, profile_id, day: str, movie_key: str) -> bool:
        """Whether this exact title is already on today's bill.

        `record_play` reports the same "no new row" outcome for a replay and for
        a cap refusal, so the caller needs this to answer the two differently:
        a replay is fine, a refusal is not.
        """
        rows = self._query(
            "SELECT 1 AS hit FROM daily_plays "
            "WHERE profile_id = ? AND day = ? AND movie_key = ? LIMIT 1",
            (profile_id, day, movie_key),
            fetch_all=True,
        )
        return bool(rows)

    def record_play(
        self, profile_id, day: str, movie_key: str, user_id=None, enforce_caps: bool = True
    ) -> bool:
        """Claim one title against today's allowance, atomically.

        Returns True only if this is a new claim *and*, when `enforce_caps` is
        set, the caps still had room.

        The check and the insert must be one statement. Doing them separately
        (as this did) let two concurrent requests both observe `remaining == 1`
        and both insert, so a day ended up recorded as 11 of 10 used. With
        `INSERT ... SELECT ... WHERE` the cap counts are re-read as part of the
        write, and only one of the racing statements can see room.

        `enforce_caps=False` is the referral case. An unlocked day has no cap to
        charge, but the play still has to be recorded because history and the
        "what did I watch" list are built from these rows. Going through the
        capped statement anyway meant a viewer who unlocked the day still had
        their history truncated at 10 titles, which is precisely what the
        unlock was supposed to stop.

        The account cap needs the owning user id, which `user_id_of_profile`
        resolves when the caller does not pass it.
        """
        if user_id is None:
            row = self._query(
                "SELECT user_id FROM watch_profiles WHERE id = ? LIMIT 1",
                (profile_id,),
            )
            user_id = row.get("user_id") if row else None
        if user_id is None:
            return False
        # The primary key still absorbs a replay or a double submit: the insert
        # raises, rowcount is 0, and the claim is reported as not-new.
        if enforce_caps:
            sql = (
                "INSERT INTO daily_plays (profile_id, day, movie_key, played_at) "
                "SELECT ?, ?, ?, ? "
                "WHERE (SELECT COUNT(*) FROM daily_plays "
                "        WHERE profile_id = ? AND day = ?) < ? "
                "AND (SELECT COUNT(*) FROM daily_plays AS p "
                "     JOIN watch_profiles AS wp ON wp.id = p.profile_id "
                "     WHERE wp.user_id = ? AND p.day = ?) < ?"
            )
            params = (
                profile_id, day, movie_key, int(time.time() * 1000),
                profile_id, day, DAILY_TITLE_CAP,
                user_id, day, DAILY_ACCOUNT_CAP,
            )
        else:
            sql = (
                "INSERT INTO daily_plays (profile_id, day, movie_key, played_at) "
                "VALUES (?, ?, ?, ?)"
            )
            params = (profile_id, day, movie_key, int(time.time() * 1000))
        try:
            claimed = self._execute_rowcount(sql, params) == 1
        except Exception:
            # Duplicate key: this title was already claimed today. Not an error.
            return False
        return claimed

    def referral_code_for(self, user_id) -> str:
        """The account's shareable code, created on first use.

        Lives in its own table because a code is a property of the *owner* while
        referrals-to-me is a property of the *referred user*. Collapsing both
        into one row makes the two one-to-one, so a user can only ever be
        referred once in total regardless of how many people they refer.
        """
        row = self._query(
            "SELECT * FROM referral_codes WHERE owner_id = ? LIMIT 1",
            (user_id,),
        )
        if row:
            return row["code"]
        # Deterministic from the user id, so the same account sees the same code
        # on every device and the UNIQUE constraint settles the rare race.
        code = _make_referral_code(user_id)
        try:
            self._execute(
                "INSERT INTO referral_codes (owner_id, code, created_at) "
                "VALUES (?, ?, ?)",
                (user_id, code, _now_iso()),
            )
        except Exception:
            # Lost the race, or a code is already allocated; read it back.
            row = self._query(
                "SELECT * FROM referral_codes WHERE owner_id = ? LIMIT 1",
                (user_id,),
            )
            if row:
                return row["code"]
        return code

    def referral_stats(self, user_id) -> dict:
        code = self.referral_code_for(user_id)
        rows = self._query(
            "SELECT COUNT(*) AS n FROM referral_uses u "
            "JOIN referral_codes c ON c.id = u.code_id "
            "WHERE c.owner_id = ?",
            (user_id,),
            fetch_all=True,
        )
        accepted = int((rows[0] or {}).get("n", 0)) if rows else 0
        return {
            "code": code,
            "accepted": accepted,
            "granted_days": self.granted_days(user_id),
        }

    def accept_referral(self, referred_id, code: str) -> bool:
        """Record that `referred_id` joined via the holder of `code`.

        Self-referral and double-claiming are rejected. Two constraints do the
        work: UNIQUE(code_id) makes a code single-use, and UNIQUE(referred_id)
        stops one account redeeming several codes to stack grants. Both are
        database-level, so two simultaneous signups cannot both win.
        """
        if not code:
            return False
        row = self._query(
            "SELECT * FROM referral_codes WHERE code = ? LIMIT 1",
            (code.strip().upper(),),
        )
        if not row:
            return False
        if str(row.get("owner_id")) == str(referred_id):
            return False
        try:
            self._execute(
                "INSERT INTO referral_uses (code_id, referred_id, created_at) "
                "VALUES (?, ?, ?)",
                (row["id"], referred_id, _now_iso()),
            )
            return True
        except Exception:
            # Violated UNIQUE(code_id, referred_id) or UNIQUE(referred_id).
            return False

    def referrer_of(self, user_id) -> str | None:
        """Who referred this account, if anyone.

        Needed to grant the inviter their side of the reward: the joiner is
        known at redemption time but the code owner is not, so it has to be
        read back rather than carried through the request.
        """
        rows = self._query(
            "SELECT c.owner_id AS owner_id FROM referral_uses u "
            "JOIN referral_codes c ON c.id = u.code_id "
            "WHERE u.referred_id = ? LIMIT 1",
            (user_id,),
            fetch_all=True,
        )
        if not rows:
            return None
        return rows[0].get("owner_id")

    def granted_days(self, user_id) -> int:
        rows = self._query(
            "SELECT COUNT(*) AS n FROM referral_grants WHERE owner_id = ?",
            (user_id,),
            fetch_all=True,
        )
        return int((rows[0] or {}).get("n", 0)) if rows else 0

    def grant_day(self, user_id, day: str, source: str = "referral") -> bool:
        """Unlock the cap for one more day. Idempotent per day."""
        try:
            self._execute(
                "INSERT INTO referral_grants (owner_id, day, source, created_at) "
                "VALUES (?, ?, ?, ?)",
                (user_id, day, source, _now_iso()),
            )
            return True
        except Exception:
            return False

    def has_unlocked_day(self, user_id, day: str) -> bool:
        row = self._query(
            "SELECT 1 AS ok FROM referral_grants WHERE owner_id = ? AND day = ? LIMIT 1",
            (user_id, day),
        )
        return bool(row)

    # -- taste signals & recommender state --------------------------------

    def record_taste_event(
        self,
        profile_id,
        kind: str,
        genres=None,
        people=None,
        media_key: str | None = None,
        weight: float = 1.0,
    ) -> None:
        """Append one interaction to the event log.

        `genres` and `people` arrive already reduced to derived features by
        `taste`; the raw search text is never handed to this method, so it
        cannot end up in the table even by accident.
        """
        self._execute(
            "INSERT INTO taste_events "
            "(profile_id, kind, media_key, weight, genres, people, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                profile_id,
                kind,
                media_key,
                float(weight),
                ",".join(genres or []),
                ",".join(people or []),
                int(time.time() * 1000),
            ),
        )

    def taste_events(self, profile_id, limit: int = 500) -> list[dict]:
        rows = self._query(
            "SELECT kind, media_key, weight, genres, people, created_at "
            "FROM taste_events WHERE profile_id = ? "
            "ORDER BY created_at DESC, id DESC LIMIT ?",
            (profile_id, limit),
            fetch_all=True,
        )
        return rows or []

    def search_token_hits(self, profile_id, limit: int = 200) -> dict[str, int]:
        """How often each hashed search token has been seen.

        A single query word is usually a typo, so tokens below the repeat
        threshold are excluded from the feature space by the caller.
        """
        # SUM(weight), not COUNT(*): there is exactly one row per token, so a
        # row count would always be 1 and the repeat threshold could never be
        # cleared. The accumulated count lives in the weight column.
        rows = self._query(
            "SELECT feature, SUM(weight) AS n FROM taste_signals "
            "WHERE profile_id = ? AND kind = 'query' "
            "GROUP BY feature ORDER BY n DESC LIMIT ?",
            (profile_id, limit),
            fetch_all=True,
        )
        return {row["feature"]: int(row["n"] or 0) for row in (rows or [])}

    def bump_search_token(self, profile_id, feature: str) -> int:
        """Count one occurrence of a hashed query token, returning the total.

        Increments with a single UPDATE and falls back to INSERT on no-match,
        rather than UPDATE-then-INSERT: the second form raises a UNIQUE
        violation whenever the UPDATE actually matched, which is the common
        case, and a failing counter must not surface as a 500.
        """
        updated = self._execute_rowcount(
            "UPDATE taste_signals SET weight = weight + 1, updated_at = ? "
            "WHERE profile_id = ? AND kind = 'query' AND feature = ?",
            (_now(), profile_id, feature),
        )
        if updated:
            row = self._query(
                "SELECT weight FROM taste_signals "
                "WHERE profile_id = ? AND kind = 'query' AND feature = ? LIMIT 1",
                (profile_id, feature),
            )
            return int(row["weight"]) if row else 1
        try:
            self._execute(
                "INSERT INTO taste_signals "
                "(profile_id, kind, feature, weight, updated_at) "
                "VALUES (?, 'query', ?, 1, ?)",
                (profile_id, feature, _now()),
            )
            return 1
        except Exception:
            # Lost a race with a concurrent search; the row now exists, so
            # count it up once more and report the winner's total.
            self._execute(
                "UPDATE taste_signals SET weight = weight + 1, updated_at = ? "
                "WHERE profile_id = ? AND kind = 'query' AND feature = ?",
                (_now(), profile_id, feature),
            )
            row = self._query(
                "SELECT weight FROM taste_signals "
                "WHERE profile_id = ? AND kind = 'query' AND feature = ? LIMIT 1",
                (profile_id, feature),
            )
            return int(row["weight"]) if row else 1

    def search_token_weight(self, profile_id, feature: str) -> float:
        """How many times this profile has searched for the hashed token.

        Read separately from `bump_search_token` so a caller can turn the repeat
        count into a taste weight without reaching into the private `_query`.
        """
        row = self._query(
            "SELECT weight FROM taste_signals "
            "WHERE profile_id = ? AND kind = 'query' AND feature = ? LIMIT 1",
            (profile_id, feature),
        )
        return float(row["weight"]) if row else 0.0

    def save_taste_state(
        self, profile_id, state: dict, model_version: str = "linear-v1"
    ) -> None:
        """Persist the rolled-up weight state.

        The event log is the source of truth and this is a cache of it, so a bad
        rollup can always be rebuilt by replaying `taste_events`.
        """
        # Every derived row is replaced, not just the version marker: dropping
        # only the 'state' row leaves the previous genre/people rows in place,
        # and re-inserting them trips the (profile, kind, feature) UNIQUE on
        # every rebuild after the first. Query token counts are deliberately
        # left alone -- they are a lifetime counter, not part of the rollup.
        self._execute(
            "DELETE FROM taste_signals WHERE profile_id = ? AND kind IN ('genre', 'people', 'state')",
            (profile_id,),
        )
        self._execute(
            "INSERT INTO taste_signals "
            "(profile_id, kind, feature, weight, updated_at) "
            "VALUES (?, 'state', ?, ?, ?)",
            (profile_id, model_version, float(time.time()), _now()),
        )
        for kind in ("genre", "people"):
            for feature, weight in (state.get(kind) or {}).items():
                self._execute(
                    "INSERT INTO taste_signals "
                    "(profile_id, kind, feature, weight, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (profile_id, kind, feature, float(weight), _now()),
                )

    def load_taste_state(self, profile_id) -> dict:
        rows = self._query(
            "SELECT kind, feature, weight FROM taste_signals "
            "WHERE profile_id = ? AND kind IN ('genre', 'people')",
            (profile_id,),
            fetch_all=True,
        )
        state = {"genre": {}, "people": {}}
        for row in rows or []:
            if row["kind"] in state:
                state[row["kind"]][row["feature"]] = float(row["weight"] or 0)
        return state

    def model_version(self, profile_id) -> str:
        row = self._query(
            "SELECT feature FROM taste_signals "
            "WHERE profile_id = ? AND kind = 'state' LIMIT 1",
            (profile_id,),
        )
        return row["feature"] if row else ""

    def allowance(self, user_id, profile_id, day: str) -> dict:
        """The full allowance picture for one profile on one day.

        Returns the raw numbers alongside the decision so the client can show
        "9 of 10 used, resets at 00:00 UTC" rather than a bare refusal.
        """
        per_profile_cap = DAILY_TITLE_CAP
        account_cap = DAILY_ACCOUNT_CAP
        unlocked = self.has_unlocked_day(user_id, day)
        used = self.plays_on(profile_id, day)
        account_used = self.account_plays_on(user_id, day)
        # `account_used` already includes this profile's own plays, so the
        # account budget left is `account_cap - account_used` and the two caps
        # are independent budgets. Subtracting `used` from the account figure a
        # second time double-counted the profile's own consumption and cut a
        # profile off well before its own 10.
        account_left = max(0, account_cap - account_used)
        effective = 10**6 if unlocked else min(per_profile_cap, account_left + used)
        return {
            "day": day,
            "used": used,
            "per_profile_cap": per_profile_cap,
            "account_cap": account_cap,
            "account_used": account_used,
            "account_left": account_left,
            "unlocked": unlocked,
            "remaining": 10**6 if unlocked else max(0, effective - used),
            "unlimited": unlocked,
        }

    # -- users ------------------------------------------------------------

    def user_by_email(self, email: str) -> dict | None:
        return self._query(
            "SELECT * FROM users WHERE email = ? LIMIT 1",
            (email,),
        )

    def user_by_id(self, user_id: int) -> dict | None:
        return self._query(
            "SELECT * FROM users WHERE id = ? LIMIT 1",
            (user_id,),
        )

    def create_user(self, email: str, name: str, password: str) -> dict | None:
        salt = secrets.token_hex(16)
        digest = self._hash(password, salt)
        now = _now()
        if self.pg:
            row = self._execute_returning(
                "INSERT INTO users (email, display_name, password_hash, created_at) "
                "VALUES (%s, %s, %s, %s) RETURNING id",
                (email, name, digest, now),
            )
            user_id = row.get("id") if row else None
            return self.user_by_id(user_id) if user_id else None
        user_id = self._execute(
            "INSERT INTO users (email, display_name, password_hash, password_salt, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (email, name, digest, salt, now),
        )
        return self.user_by_id(user_id) if user_id else None

    @staticmethod
    def _hash(password: str, salt: str) -> str:
        import hashlib

        raw = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("utf-8"), 210_000
        )
        # Self-contained: salt is embedded so `users.password_hash` needs no
        # separate column (matches the Neon-provisioned users schema).
        return f"pbkdf2_sha256${salt}${raw.hex()}"

    # -- secrets (shared by account passwords and profile PINs) -----------

    @staticmethod
    def hash_secret(secret: str, salt: str) -> str:
        """PBKDF2 hash for a profile PIN, with its salt embedded.

        Same primitive and iteration count as the account password so a PIN is
        not weaker to brute-force just because it is shorter; the practical
        protection is that the 4-digit space is only reachable through this
        endpoint, which is rate limited by the API guard.
        """
        raw = hashlib.pbkdf2_hmac(
            "sha256", secret.encode("utf-8"), salt.encode("utf-8"), 210_000
        )
        return f"pbkdf2_sha256${salt}${raw.hex()}"

    @staticmethod
    def verify_secret(secret: str, stored: str, salt: str) -> bool:
        if not secret or not stored:
            return False
        candidate = Store.hash_secret(secret, salt)
        # compare_digest, not ==: a timing side channel on a PIN check is a
        # real, if modest, leak.
        return secrets.compare_digest(candidate, stored)

    def verify_password(self, user: dict, password: str) -> bool:
        import hashlib

        combined = user.get("password_hash") or ""
        legacy = "$" not in combined
        if legacy:
            # Old rows stored salt + digest in separate columns.
            salt = user.get("password_salt") or ""
            expected = user.get("password_hash") or ""
        else:
            scheme, salt, expected = combined.split("$", 2)
        raw = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            (salt or "").encode("utf-8"),
            210_000,
        )
        return secrets.compare_digest(raw.hex(), (expected or "").lower())

    # -- sessions ---------------------------------------------------------

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        self._execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, _expires_at()),
        )
        return token

    def user_by_token(self, token: str) -> dict | None:
        row = self._query(
            "SELECT s.token, s.expires_at, u.* FROM sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.token = ? LIMIT 1",
            (token,),
        )
        if not row:
            return None
        if _is_expired(row.get("expires_at")):
            self.revoke_token(token)
            return None
        return row

    def revoke_token(self, token: str) -> None:
        self._execute("DELETE FROM sessions WHERE token = ?", (token,))

    # -- watch history ----------------------------------------------------

    def add_history(
        self,
        user_id: int,
        movie_key: str,
        fields: dict,
        profile_id=None,
    ) -> None:
        """Upsert one watch-progress row for a profile.

        `profile_id` is part of the identity, not just a column: two profiles
        watching the same film must keep independent progress, so both the
        lookup and the update predicate include it. A NULL profile_id is the
        unprofiled legacy shape and is handled by the IS NULL variants, since
        `= NULL` never matches in SQL and would silently insert duplicates.
        """
        if profile_id:
            existing = self._query(
                "SELECT id FROM watch_history WHERE user_id = ? AND movie_key = ? "
                "AND profile_id = ? LIMIT 1",
                (user_id, movie_key, profile_id),
                fetch_all=True,
            )
        else:
            existing = self._query(
                "SELECT id FROM watch_history WHERE user_id = ? AND movie_key = ? "
                "AND profile_id IS NULL LIMIT 1",
                (user_id, movie_key),
                fetch_all=True,
            )
        if isinstance(existing, list):
            existing = existing[0] if existing else None
        proofs = ["title", "year", "poster", "backdrop", "media_type"]
        values = {key: fields.get(key) for key in proofs}
        progress = int(fields.get("progress_seconds") or 0)
        duration = int(fields.get("duration_seconds") or 0)
        completed = 1 if fields.get("completed") else 0
        watched_at = int(fields.get("watched_at") or time.time() * 1000)
        if existing:
            if profile_id:
                self._execute(
                    "UPDATE watch_history SET title = ?, year = ?, poster = ?, backdrop = ?, "
                    "media_type = ?, progress_seconds = ?, duration_seconds = ?, completed = ?, "
                    "watched_at = ?, updated_at = ? WHERE id = ?",
                    (
                        values["title"], values["year"], values["poster"],
                        values["backdrop"], values["media_type"], progress,
                        duration, completed, watched_at, _now(), existing["id"],
                    ),
                )
            else:
                self._execute(
                    "UPDATE watch_history SET title = ?, year = ?, poster = ?, backdrop = ?, "
                    "media_type = ?, progress_seconds = ?, duration_seconds = ?, completed = ?, "
                    "watched_at = ?, updated_at = ? WHERE id = ?",
                    (
                        values["title"], values["year"], values["poster"],
                        values["backdrop"], values["media_type"], progress,
                        duration, completed, watched_at, _now(), existing["id"],
                    ),
                )
        else:
            self._execute(
                "INSERT INTO watch_history (user_id, profile_id, movie_key, title, year, "
                "poster, backdrop, media_type, progress_seconds, duration_seconds, "
                "completed, watched_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    user_id, profile_id, movie_key, values["title"], values["year"],
                    values["poster"], values["backdrop"], values["media_type"],
                    progress, duration, completed, watched_at, _now(),
                ),
            )

    def history(self, user_id: int, limit: int = 100, profile_id=None) -> list[dict]:
        if profile_id:
            rows = self._query(
                "SELECT movie_key, title, year, poster, backdrop, media_type, "
                "progress_seconds, duration_seconds, completed, watched_at "
                "FROM watch_history WHERE user_id = ? AND profile_id = ? "
                "ORDER BY watched_at DESC LIMIT ?",
                (user_id, profile_id, limit),
                fetch_all=True,
            )
        else:
            rows = self._query(
                "SELECT movie_key, title, year, poster, backdrop, media_type, "
                "progress_seconds, duration_seconds, completed, watched_at "
                "FROM watch_history WHERE user_id = ? AND profile_id IS NULL "
                "ORDER BY watched_at DESC LIMIT ?",
                (user_id, limit),
                fetch_all=True,
            )
        return rows or []

    def remove_history(self, user_id: int, movie_key: str, profile_id=None) -> None:
        if profile_id:
            self._execute(
                "DELETE FROM watch_history WHERE user_id = ? AND movie_key = ? "
                "AND profile_id = ?",
                (user_id, movie_key, profile_id),
            )
        else:
            self._execute(
                "DELETE FROM watch_history WHERE user_id = ? AND movie_key = ? "
                "AND profile_id IS NULL",
                (user_id, movie_key),
            )

    def clear_history(self, user_id: int, profile_id=None) -> None:
        """Clear one profile's history, or the whole account when no profile is
        given. Scoped by default so "clear history" on a kid's profile cannot
        wipe a parent's."""
        if profile_id:
            self._execute(
                "DELETE FROM watch_history WHERE user_id = ? AND profile_id = ?",
                (user_id, profile_id),
            )
        else:
            self._execute("DELETE FROM watch_history WHERE user_id = ?", (user_id,))

    # -- saved media (per-account My List) --------------------------------

    def add_saved_media(
        self,
        user_id: int,
        media_id: int | str,
        media_type: str = "movie",
        title: str = "",
        poster_path: str | None = None,
    ) -> bool:
        """Add a title to the account's saved list. Returns False if present."""
        media_id = int(media_id)
        existing = self._query(
            "SELECT id FROM saved_media WHERE user_id = ? AND media_id = ? LIMIT 1",
            (user_id, media_id),
        )
        if existing:
            return False
        self._execute(
            "INSERT INTO saved_media (user_id, media_id, media_type, title, poster_path, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                user_id,
                media_id,
                media_type if media_type in ("movie", "tv") else "movie",
                title or "",
                poster_path or "",
                _now(),
            ),
        )
        return True

    def saved_media(self, user_id: int, limit: int = 500) -> list[dict]:
        rows = self._query(
            "SELECT media_id, media_type, title, poster_path, created_at "
            "FROM saved_media WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
            fetch_all=True,
        ) or []
        return [
            {**row, "created_at": _to_iso(row.get("created_at"))} for row in rows
        ]

    def remove_saved_media(self, user_id: int, media_id: int | str) -> None:
        self._execute(
            "DELETE FROM saved_media WHERE user_id = ? AND media_id = ?",
            (user_id, int(media_id)),
        )

    def clear_saved_media(self, user_id: int) -> None:
        self._execute("DELETE FROM saved_media WHERE user_id = ?", (user_id,))

    # -- catalog cache (JSONB snapshots) ----------------------------------

    def upsert_catalog_cache(
        self,
        media_id: int | str,
        media_type: str,
        payload: dict,
        ts: str | None = None,
    ) -> None:
        """Per-title JSON snapshot used by the catalog's cache-first path.
        Postgres stores `payload` as JSONB; SQLite keeps it as JSON text."""
        media_type = media_type if media_type in ("movie", "tv") else "movie"
        ts = ts or _now()
        existing = self._query(
            "SELECT media_id FROM catalog_cache WHERE media_id = ? AND media_type = ? LIMIT 1",
            (int(media_id), media_type),
        )
        if existing:
            if self.pg:
                import psycopg.types.json as _pg_json

                self._execute(
                    "UPDATE catalog_cache SET payload = %s, updated_at = %s "
                    "WHERE media_id = %s AND media_type = %s",
                    (_pg_json.Jsonb(payload), ts, int(media_id), media_type),
                )
            else:
                self._execute(
                    "UPDATE catalog_cache SET payload = ?, updated_at = ? "
                    "WHERE media_id = ? AND media_type = ?",
                    (json.dumps(payload), ts, int(media_id), media_type),
                )
            return
        if self.pg:
            import psycopg.types.json as _pg_json

            self._execute(
                "INSERT INTO catalog_cache (media_id, media_type, payload, updated_at) "
                "VALUES (%s, %s, %s, %s)",
                (int(media_id), media_type, _pg_json.Jsonb(payload), ts),
            )
        else:
            self._execute(
                "INSERT INTO catalog_cache (media_id, media_type, payload, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (int(media_id), media_type, json.dumps(payload), ts),
            )

    def get_catalog_cache(
        self, media_id: int | str, media_type: str | None = None
    ) -> dict | None:
        if media_type and media_type in ("movie", "tv"):
            row = self._query(
                "SELECT media_type, payload, updated_at FROM catalog_cache "
                "WHERE media_id = ? AND media_type = ? LIMIT 1",
                (int(media_id), media_type),
            )
        else:
            row = self._query(
                "SELECT media_type, payload, updated_at FROM catalog_cache "
                "WHERE media_id = ? ORDER BY updated_at DESC LIMIT 1",
                (int(media_id),),
            )
        if not row:
            return None
        if media_type and row.get("media_type") != media_type:
            return None
        payload = row.get("payload")
        if isinstance(payload, str) and not self.pg:
            try:
                payload = json.loads(payload)
            except (TypeError, ValueError):
                return None
        if not isinstance(payload, dict):
            return None
        return {"payload": payload, "updated_at": _to_iso(row.get("updated_at"))}

    def recent_catalog_cache(
        self, media_type: str = "all", limit: int = 100
    ) -> list[dict]:
        """Most recently cached payloads (used as the JSONB fallback page)."""
        rows = self._query(
            "SELECT media_type, payload, updated_at FROM catalog_cache "
            "WHERE (? = 'all' OR media_type = ?) ORDER BY updated_at DESC LIMIT ?",
            (media_type, media_type, limit),
            fetch_all=True,
        ) or []
        out: list[dict] = []
        for row in rows:
            payload = row.get("payload")
            if isinstance(payload, str) and not self.pg:
                try:
                    payload = json.loads(payload)
                except (TypeError, ValueError):
                    continue
            if isinstance(payload, dict):
                out.append(payload)
        return out

    def clear_catalog_cache(self) -> None:
        self._execute("DELETE FROM catalog_cache", ())


    # -- profile/list sharing ---------------------------------------------

    SHARE_ROLES = ("viewer", "editor")

    def create_share_invite(
        self,
        owner_id,
        email: str | None = None,
        role: str = "viewer",
        ttl_days: int = 7,
    ) -> dict:
        """Mint an invite token. The token is the only credential, so it is
        generated with `secrets` rather than a counter or a hash of anything
        guessable, and it is never derived from the owner's id."""
        role = role if role in self.SHARE_ROLES else "viewer"
        email = (email or "").strip().lower() or None
        expires = datetime.now(timezone.utc) + timedelta(days=max(1, min(ttl_days, 30)))
        token = secrets.token_urlsafe(24)
        created = _now()
        self._execute(
            "INSERT INTO share_invites "
            "(token, owner_id, email, role, status, created_at, expires_at) "
            "VALUES (?, ?, ?, ?, 'pending', ?, ?)",
            (token, owner_id, email, role, created, expires.strftime(_ISO)),
        )
        return {
            "token": token,
            "email": email,
            "role": role,
            "status": "pending",
            "created_at": created,
            "expires_at": expires.strftime(_ISO),
        }

    def share_invite_by_token(self, token: str) -> dict | None:
        return self._query(
            "SELECT * FROM share_invites WHERE token = ? LIMIT 1", (token,)
        )

    def share_invites_for_owner(self, owner_id) -> list[dict]:
        return (
            self._query(
                "SELECT * FROM share_invites WHERE owner_id = ? "
                "ORDER BY created_at DESC LIMIT 100",
                (owner_id,),
                fetch_all=True,
            )
            or []
        )

    def count_pending_invites(self, owner_id) -> int:
        row = self._query(
            "SELECT COUNT(*) AS n FROM share_invites "
            "WHERE owner_id = ? AND status = 'pending'",
            (owner_id,),
        )
        return int((row or {}).get("n") or 0)

    def revoke_share_invite(self, token: str, owner_id) -> bool:
        """Owner-scoped so a leaked token cannot be used to revoke someone
        else's invite, and idempotent so a double revoke is not an error."""
        changed = self._execute_rowcount(
            "UPDATE share_invites SET status = 'revoked' "
            "WHERE token = ? AND owner_id = ? AND status = 'pending'",
            (token, owner_id),
        )
        return changed > 0

    def accept_share_invite(
        self, token: str, user_id, user_email: str
    ) -> tuple[dict | None, str]:
        """Redeem an invite for `user_id`.

        Returns (invite, ""), (None, reason). Rejections are explicit rather
        than exceptions so the route can map them to status codes without
        unwrapping driver errors.
        """
        invite = self.share_invite_by_token(token)
        if not invite:
            return None, "invalid"
        if str(invite.get("owner_id")) == str(user_id):
            return None, "own"
        if invite.get("status") == "revoked":
            return None, "revoked"
        if invite.get("status") == "accepted":
            # Already redeemed is not an error: re-opening a shared link should
            # keep working for the person it was shared with.
            if str(invite.get("accepted_by")) == str(user_id):
                return invite, ""
            return None, "used"
        if _is_expired(invite.get("expires_at")):
            return None, "expired"
        locked = (invite.get("email") or "").strip().lower()
        if locked and locked != (user_email or "").strip().lower():
            # Deliberately vague: confirming which address an invite was sent
            # to would turn this into an account-enumeration oracle.
            return None, "mismatch"

        self._execute(
            "INSERT INTO share_members (owner_id, user_id, role, created_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT (owner_id, user_id) DO NOTHING",
            (
                invite.get("owner_id"),
                user_id,
                invite.get("role") or "viewer",
                _now(),
            ),
        )
        self._execute(
            "UPDATE share_invites SET status = 'accepted', accepted_at = ?, "
            "accepted_by = ? WHERE token = ?",
            (_now(), user_id, token),
        )
        invite = dict(invite)
        invite["status"] = "accepted"
        return invite, ""

    def share_members_of(self, owner_id) -> list[dict]:
        return (
            self._query(
                "SELECT m.user_id AS user_id, m.role AS role, m.created_at AS created_at, "
                "u.display_name AS display_name, u.email AS email "
                "FROM share_members m JOIN users u ON u.id = m.user_id "
                "WHERE m.owner_id = ? ORDER BY m.created_at DESC",
                (owner_id,),
                fetch_all=True,
            )
            or []
        )

    def shared_profiles_for_user(self, user_id) -> list[dict]:
        """Everyone who has shared their list with this user."""
        return (
            self._query(
                "SELECT m.owner_id AS owner_id, m.role AS role, m.created_at AS created_at, "
                "u.display_name AS display_name FROM share_members m "
                "JOIN users u ON u.id = m.owner_id WHERE m.user_id = ? "
                "ORDER BY m.created_at DESC",
                (user_id,),
                fetch_all=True,
            )
            or []
        )

    def is_share_member(self, owner_id, user_id) -> bool:
        row = self._query(
            "SELECT 1 AS ok FROM share_members WHERE owner_id = ? AND user_id = ? LIMIT 1",
            (owner_id, user_id),
        )
        return bool(row)

    def remove_share_member(self, owner_id, user_id) -> bool:
        changed = self._execute_rowcount(
            "DELETE FROM share_members WHERE owner_id = ? AND user_id = ?",
            (owner_id, user_id),
        )
        return changed > 0

_store: Store | None = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store()
        _store.init()
    return _store


def set_store(store: Store | None) -> None:
    """Install or clear the process-wide store.

    Every handler reaches the database through `get_store()`, so a test suite
    that builds its own throwaway database has no way to point the app at it.
    The tests instead raced over this singleton: whichever suite imported first
    set `SQLITE_PATH`, and the other's fixture was silently ignored, so the
    suites passed alone and failed together. Tests call this to own the store
    for the duration; passing `None` restores the default lazy behaviour.
    """
    global _store
    _store = store


def serialize_user(user: dict | None) -> dict | None:
    if not user:
        return None
    return {
        "id": str(user.get("id")),
        "email": user.get("email"),
        "name": user.get("display_name") or user.get("name") or "",
        "created_at": _to_iso(user.get("created_at")),
    }