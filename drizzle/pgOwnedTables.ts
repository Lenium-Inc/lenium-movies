import { bigint, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

/**
 * Tables owned by `movie-backend/authdb.py`, mapped here for reading.
 *
 * Declared outside `webTables.ts` so `drizzle.config.ts` can point `schema` at
 * that file alone. If these were in the same file, `drizzle-kit generate` would
 * treat them as tables this layer owns and emit a `CREATE TABLE watch_history`,
 * which fails against a database where the table already exists -- taking the
 * `web` schema down with it, since the failure lands before those statements.
 *
 * The mapping is read-only by design. `authdb.py` writes these columns; this
 * layer serves a "continue watching" shelf from the same rows the player wrote.
 *
 * Two details are dictated by what is deployed rather than by what would be
 * tidier, and both are worth knowing before changing them:
 *
 * * The live unique key is `(user_id, movie_key)` with `profile_id` as an
 *   ordinary nullable column, so there is one row per user per title, not one
 *   per profile. Widening it to `(user_id, profile_id, movie_key)` would
 *   contradict a constraint that is already enforced and would turn every
 *   `ON CONFLICT` upsert in `authdb.py` into a raised error.
 * * `completed` is an `integer` flag, `watched_at` is a `bigint` epoch, and
 *   `updated_at` is `text`. Inconsistent, but it is the live representation, so
 *   the types match reality rather than reinterpreting it.
 */
export const watchHistory = pgTable(
  "watch_history",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    profileId: uuid("profile_id"),
    movieKey: text("movie_key").notNull(),
    title: text("title"),
    year: integer("year"),
    poster: text("poster"),
    backdrop: text("backdrop"),
    mediaType: text("media_type"),
    progressSeconds: integer("progress_seconds").default(0),
    durationSeconds: integer("duration_seconds").default(0),
    completed: integer("completed").default(0),
    watchedAt: bigint("watched_at", { mode: "number" }).default(0),
    updatedAt: text("updated_at").notNull(),
  },
  table => ({
    /**
     * Additive index for the continue-watching read.
     *
     * The deployed table carries only a primary key and the
     * `(user_id, movie_key)` unique constraint, so "this account, most recent
     * first" is a sequential scan of the account's entire history, on the page
     * every signed-in viewer loads. This creates no table and alters no column.
     */
    userMovieRecent: index("watch_history_user_movie_watched_at_idx").on(
      table.userId,
      table.watchedAt
    ),
  })
);

export type WatchHistoryEntry = typeof watchHistory.$inferSelect;