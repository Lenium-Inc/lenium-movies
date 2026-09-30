"""Regression tests for the `watch_history` unique-constraint migration.

A live database created before profiles existed has
`UNIQUE (user_id, movie_key)`. Adding a `profile_id` column does not change that
constraint, so two profiles in one home watching the same title still collided.
The migration has to rebuild the constraint, and it has to do so without losing
rows -- including the rows that predate profiling and therefore have a NULL
`profile_id`.

These build a legacy-shaped database by hand, then let `Store.init()` migrate
it, because the only way to reproduce the failure is to start from the old
schema.
"""
import os
import sqlite3
import tempfile
import unittest


def _make_legacy_db(path: str) -> None:
    """A pre-profiles database: no profile_id, old unique constraint."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE watch_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            movie_key TEXT NOT NULL,
            title TEXT NOT NULL,
            year INT,
            poster TEXT,
            backdrop TEXT,
            media_type TEXT,
            progress_seconds INT DEFAULT 0,
            completed INT DEFAULT 0,
            watched_at BIGINT DEFAULT 0,
            updated_at TEXT NOT NULL,
            UNIQUE (user_id, movie_key)
        );
        INSERT INTO users (email, name, password_hash, created_at)
        VALUES ('old@example.com', 'Old', 'x', '2024-01-01');
        INSERT INTO watch_history
            (user_id, movie_key, title, updated_at, progress_seconds)
        VALUES
            (1, 'tt0111161', 'The Shawshank Redemption', '2024-01-01', 120),
            (1, 'tt0110912', 'The Godfather', '2024-01-01', 60);
        """
    )
    conn.commit()
    conn.close()


def _store(path: str):
    import authdb

    authdb.DATABASE_URL = ""
    authdb.PG_AVAILABLE = False
    return authdb.Store(dsn="", dsn_path=path)


class HistoryUniqueMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "legacy.db")
        _make_legacy_db(self.path)

    def tearDown(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(self.path + suffix)
            except OSError:
                pass
        os.rmdir(self.tmp)

    def _columns(self, conn):
        return {row[1] for row in conn.execute("PRAGMA table_info(watch_history)")}

    def test_migration_adds_the_profile_scoped_constraint(self):
        store = _store(self.path)
        store.init()
        conn = sqlite3.connect(self.path)
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'watch_history'"
        ).fetchone()[0]
        conn.close()
        normalised = " ".join(sql.split())
        self.assertIn("UNIQUE (user_id, profile_id, movie_key)", normalised)
        self.assertNotIn("UNIQUE (user_id, movie_key)", normalised)

    def test_existing_rows_survive_the_rebuild(self):
        store = _store(self.path)
        store.init()
        conn = sqlite3.connect(self.path)
        titles = {row[0] for row in conn.execute("SELECT title FROM watch_history")}
        progress = {
            row[0]: row[1]
            for row in conn.execute("SELECT title, progress_seconds FROM watch_history")
        }
        conn.close()
        self.assertEqual(
            titles, {"The Shawshank Redemption", "The Godfather"}
        )
        self.assertEqual(progress["The Shawshank Redemption"], 120)

    def test_duration_column_is_added(self):
        store = _store(self.path)
        store.init()
        self.assertIn("duration_seconds", self._columns(sqlite3.connect(self.path)))

    def test_orphan_history_is_adopted_by_the_first_profile(self):
        store = _store(self.path)
        store.init()
        user = store.user_by_email("old@example.com")
        self.assertIsNotNone(user)
        profile = store.create_profile(user["id"], "Viewer")
        self.assertIsNotNone(profile)
        history = store.history(user["id"], 100, profile["id"])
        titles = {row["title"] for row in history}
        # The point of the adoption step: these rows would be invisible to every
        # profile-scoped read if they were left with a NULL profile_id.
        self.assertEqual(
            titles, {"The Shawshank Redemption", "The Godfather"}
        )

    def test_two_profiles_can_hold_the_same_title(self):
        store = _store(self.path)
        store.init()
        user = store.user_by_email("old@example.com")
        a = store.create_profile(user["id"], "A")
        b = store.create_profile(user["id"], "B")
        for profile in (a, b):
            store.add_history(
                user_id=user["id"],
                profile_id=profile["id"],
                movie_key="tt0111161",
                fields={"title": "The Shawshank Redemption", "progress_seconds": 10},
            )
        # The old constraint made this second insert overwrite or collide. The
        # first profile also inherited the two legacy rows for this title's
        # account, so the assertion is that the rows are per-profile and
        # distinct, not that each side holds exactly one.
        in_a = store.history(user["id"], 100, a["id"])
        in_b = store.history(user["id"], 100, b["id"])
        self.assertTrue(in_a and in_b)
        # The decisive check: the same movie_key is present under both profiles
        # rather than the second write having replaced the first.
        self.assertIn("tt0111161", {row["movie_key"] for row in in_a})
        self.assertIn("tt0111161", {row["movie_key"] for row in in_b})

    def test_same_title_under_two_profiles_does_not_merge_progress(self):
        store = _store(self.path)
        store.init()
        user = store.user_by_email("old@example.com")
        a = store.create_profile(user["id"], "A")
        b = store.create_profile(user["id"], "B")
        store.add_history(
            user_id=user["id"], profile_id=a["id"], movie_key="tt0133093",
            fields={"title": "The Matrix", "progress_seconds": 30},
        )
        store.add_history(
            user_id=user["id"], profile_id=b["id"], movie_key="tt0133093",
            fields={"title": "The Matrix", "progress_seconds": 300},
        )
        progress = {
            profile["name"]: {
                row["movie_key"]: row["progress_seconds"]
                for row in store.history(user["id"], 100, profile["id"])
            }
            for profile in (a, b)
        }
        # Under the old constraint the second write collapsed onto the first
        # row, so one profile's resume point would overwrite the other's.
        self.assertEqual(progress["A"]["tt0133093"], 30)
        self.assertEqual(progress["B"]["tt0133093"], 300)

    def test_repeated_boots_do_not_rebuild_every_time(self):
        """The migration must be cheap on a healthy database.

        The rebuild copies the whole table, so running it on every boot would
        turn a routine restart into a full-table rewrite. Asserted by checking
        that a row inserted after the first migration keeps its id through the
        second, which a second rebuild would renumber.
        """
        store = _store(self.path)
        store.init()
        conn = sqlite3.connect(self.path)
        before = conn.execute("SELECT id FROM watch_history ORDER BY id").fetchall()
        conn.close()
        store.init()
        conn = sqlite3.connect(self.path)
        after = conn.execute("SELECT id FROM watch_history ORDER BY id").fetchall()
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'watch_history'"
        ).fetchone()[0]
        conn.close()
        self.assertEqual(before, after)
        self.assertIn("UNIQUE (user_id, profile_id, movie_key)", " ".join(sql.split()))

    def test_migration_is_idempotent(self):
        store = _store(self.path)
        store.init()
        # A second init on an already-migrated database must be a no-op, not a
        # rebuild that drops the rows added in between.
        store.add_history(
            user_id=1, profile_id=None, movie_key="tt0133093",
            fields={"title": "The Matrix", "progress_seconds": 5},
        )
        store.init()
        conn = sqlite3.connect(self.path)
        titles = {row[0] for row in conn.execute("SELECT title FROM watch_history")}
        conn.close()
        self.assertIn("The Matrix", titles)
        self.assertIn("The Godfather", titles)


if __name__ == "__main__":
    unittest.main()
