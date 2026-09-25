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


def _is_expired(value: str | None) -> bool:
    if not value:
        return True
    try:
        dt = datetime.strptime(value, _ISO).replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > dt
    except (ValueError, TypeError):
        return True


class Store:
    """Tiny dual-driver data layer. `sqlite3` by default, Postgres when a
    `DATABASE_URL` is configured and psycopg is installed."""

    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = (dsn or DATABASE_URL).strip()
        self.pg = bool(self.dsn) and PG_AVAILABLE
        self.sqlite_path = os.environ.get(
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
                    CREATE TABLE IF NOT EXISTS watch_history (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
                        UNIQUE (user_id, movie_key)
                    )
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
                    CREATE TABLE IF NOT EXISTS watch_history (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL,
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
                        UNIQUE (user_id, movie_key)
                    )
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
                conn.commit()
        finally:
            conn.close()

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
    ) -> None:
        existing = self._query(
            "SELECT id FROM watch_history WHERE user_id = ? AND movie_key = ? LIMIT 1",
            (user_id, movie_key),
        )
        proofs = ["title", "year", "poster", "backdrop", "media_type"]
        values = {
            key: fields.get(key)
            for key in proofs
        }
        progress = int(fields.get("progress_seconds") or 0)
        duration = int(fields.get("duration_seconds") or 0)
        completed = 1 if fields.get("completed") else 0
        watched_at = int(fields.get("watched_at") or time.time() * 1000)
        if existing:
            self._execute(
                "UPDATE watch_history SET title = ?, year = ?, poster = ?, backdrop = ?, "
                "media_type = ?, progress_seconds = ?, duration_seconds = ?, completed = ?, "
                "watched_at = ?, updated_at = ? WHERE user_id = ? AND movie_key = ?",
                (
                    values["title"],
                    values["year"],
                    values["poster"],
                    values["backdrop"],
                    values["media_type"],
                    progress,
                    duration,
                    completed,
                    watched_at,
                    _now(),
                    user_id,
                    movie_key,
                ),
            )
        else:
            self._execute(
                "INSERT INTO watch_history (user_id, movie_key, title, year, poster, backdrop, "
                "media_type, progress_seconds, duration_seconds, completed, watched_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    user_id,
                    movie_key,
                    values["title"],
                    values["year"],
                    values["poster"],
                    values["backdrop"],
                    values["media_type"],
                    progress,
                    duration,
                    completed,
                    watched_at,
                    _now(),
                ),
            )

    def history(self, user_id: int, limit: int = 100) -> list[dict]:
        rows = self._query(
            "SELECT movie_key, title, year, poster, backdrop, media_type, "
            "progress_seconds, duration_seconds, completed, watched_at "
            "FROM watch_history WHERE user_id = ? ORDER BY watched_at DESC LIMIT ?",
            (user_id, limit),
            fetch_all=True,
        )
        return rows or []

    def remove_history(self, user_id: int, movie_key: str) -> None:
        self._execute(
            "DELETE FROM watch_history WHERE user_id = ? AND movie_key = ?",
            (user_id, movie_key),
        )

    def clear_history(self, user_id: int) -> None:
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


_store: Store | None = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store()
        _store.init()
    return _store


def serialize_user(user: dict | None) -> dict | None:
    if not user:
        return None
    return {
        "id": str(user.get("id")),
        "email": user.get("email"),
        "name": user.get("display_name") or user.get("name") or "",
        "created_at": _to_iso(user.get("created_at")),
    }