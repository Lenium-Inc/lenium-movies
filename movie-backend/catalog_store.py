"""
Persistent write-through cache for the aggregated catalog.

The live catalog endpoints fetch everything fresh from the upstream providers
and every batch they serve is upserted here, so this DB permanently grows with
whatever users actually browse. It also doubles as a graceful fallback when an
upstream call fails, so browsing never fully breaks. There is no seed worker —
the catalog here is a pure side-effect of live traffic, not the source of it.

Storage mirrors `authdb.py`: SQLite by default (WAL mode, busy timeout) so it
works out of the box in dev and on Render. `provider_id` is the unique key — a
namespaced identity like `tmdb-123`, `omdb-tt1234567`, or `trakt-<slug>` —
so the same title from different sources upserts rather than duplicating.
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.environ.get(
    "CATALOG_DB_PATH", os.path.join(HERE, "data", "catalog.db")
)

_ISO = "%Y-%m-%dT%H:%M:%S.%fZ"


def _now() -> str:
    return datetime.now(timezone.utc).strftime(_ISO)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS media_items (
  provider_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL,
  year INTEGER,
  poster_url TEXT,
  backdrop_url TEXT,
  overview TEXT NOT NULL DEFAULT '',
  vote_average REAL,
  popularity REAL,
  genres TEXT NOT NULL DEFAULT '[]',
  genres_key TEXT NOT NULL DEFAULT '',
  runtime INTEGER,
  director TEXT,
  cast TEXT NOT NULL DEFAULT '[]',
  country TEXT,
  language TEXT,
  release_date TEXT,
  imdb_id TEXT,
  tmdb_id TEXT,
  source TEXT NOT NULL DEFAULT 'tmdb',
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_type_year ON media_items(media_type, year DESC);
CREATE INDEX IF NOT EXISTS idx_media_popularity ON media_items(popularity DESC);
CREATE INDEX IF NOT EXISTS idx_media_genre ON media_items(genres_key);
"""


class CatalogStore:
    """Read/write cache for the aggregated catalog."""

    def __init__(self, path: str | None = None) -> None:
        self.db_path = path or DB_PATH
        self._ensure_schema()

    # -- connections ------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    def _ensure_schema(self) -> None:
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA)
            conn.commit()
        finally:
            conn.close()

    def _query(self, sql: str, params: tuple = (), fetch_all: bool = True):
        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute(sql, params)
            rows = cur.fetchall() if fetch_all else cur.fetchone()
            if rows is None:
                return None
            if fetch_all:
                return [dict(row) for row in rows]
            return dict(rows)
        finally:
            conn.close()

    # -- writes -----------------------------------------------------------

    def upsert_items(self, items: list[dict]) -> int:
        """Upsert normalized MediaItem dicts; returns the number touched."""
        if not items:
            return 0
        conn = self._connect()
        now = _now()
        sql = """
        INSERT INTO media_items (
          provider_id, title, media_type, year, poster_url, backdrop_url,
          overview, vote_average, popularity, genres, genres_key, runtime,
          director, cast, country, language, release_date, imdb_id, tmdb_id,
          source, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(provider_id) DO UPDATE SET
          title = excluded.title,
          media_type = excluded.media_type,
          year = excluded.year,
          poster_url = excluded.poster_url,
          backdrop_url = excluded.backdrop_url,
          overview = COALESCE(NULLIF(excluded.overview, ''), media_items.overview),
          vote_average = COALESCE(excluded.vote_average, media_items.vote_average),
          popularity = COALESCE(excluded.popularity, media_items.popularity),
          genres = excluded.genres,
          genres_key = excluded.genres_key,
          runtime = COALESCE(excluded.runtime, media_items.runtime),
          director = COALESCE(excluded.director, media_items.director),
          cast = COALESCE(excluded.cast, media_items.cast),
          country = COALESCE(excluded.country, media_items.country),
          language = COALESCE(excluded.language, media_items.language),
          release_date = COALESCE(excluded.release_date, media_items.release_date),
          imdb_id = COALESCE(excluded.imdb_id, media_items.imdb_id),
          tmdb_id = COALESCE(excluded.tmdb_id, media_items.tmdb_id),
          source = excluded.source,
          updated_at = excluded.updated_at
        """
        params = [
            (
                i.get("provider_id"),
                i.get("title") or "Untitled",
                i.get("media_type") or "movie",
                i.get("year"),
                i.get("poster_url") or "",
                i.get("backdrop_url") or "",
                i.get("overview") or "",
                i.get("vote_average"),
                i.get("popularity"),
                json.dumps(i.get("genres") or []),
                i.get("genres_key") or "",
                i.get("runtime"),
                i.get("director") or "",
                json.dumps(i.get("cast") or []),
                i.get("country") or "",
                i.get("language") or "",
                i.get("release_date") or "",
                i.get("imdb_id") or "",
                i.get("tmdb_id"),
                i.get("source") or "tmdb",
                now,
                now,
            )
            for i in items
        ]
        try:
            cur = conn.cursor()
            cur.executemany(sql, params)
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()

    # -- reads ------------------------------------------------------------

    def page(self, media_type: str = "all", genre: str | None = None,
             page: int = 1, per_page: int = 24) -> list[dict]:
        offset = max(page - 1, 0) * per_page
        genre = (genre or "").strip().lower()
        sql = """
        SELECT * FROM media_items
        WHERE (? = 'all' OR media_type = ?)
          AND (? = '' OR genres_key LIKE '%' || ? || '%')
        ORDER BY popularity DESC, year DESC
        LIMIT ? OFFSET ?
        """
        return self._query(sql, (media_type, media_type, genre, genre, per_page, offset))

    def count(self, media_type: str = "all", genre: str | None = None) -> int:
        genre = (genre or "").strip().lower()
        sql = """
        SELECT COUNT(*) AS n FROM media_items
        WHERE (? = 'all' OR media_type = ?)
          AND (? = '' OR genres_key LIKE '%' || ? || '%')
        """
        row = self._query(sql, (media_type, media_type, genre, genre), fetch_all=False)
        return int((row or {}).get("n") or 0)

    def search(self, query: str, media_type: str = "all", limit: int = 24) -> list[dict]:
        q = query.strip().lower()
        if not q:
            return []
        sql = """
        SELECT * FROM media_items
        WHERE (? = 'all' OR media_type = ?)
          AND (lower(title) LIKE ? OR overview LIKE ? OR imdb_id = ?)
        ORDER BY popularity DESC, year DESC
        LIMIT ?
        """
        like = f"%{q}%"
        return self._query(sql, (media_type, media_type, like, like, q, limit))

    def count_all(self) -> int:
        row = self._query("SELECT COUNT(*) AS n FROM media_items", fetch_all=False)
        return int((row or {}).get("n") or 0)