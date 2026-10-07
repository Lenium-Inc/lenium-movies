/**
 * Neon Postgres schema for the Next.js server.
 *
 * This was written against `drizzle-orm/mysql-core` while `DATABASE_URL` has
 * always been a `postgresql://` Neon connection string, so the driver, the
 * dialect, and the URL described three different databases. Every query failed
 * at the driver rather than at the schema, which is why it presented as "the
 * database is not available".
 *
 * The database is not empty, so ownership is the organizing principle here:
 *
 * * `webTables.ts` -- tables this layer owns, in the `web` schema. Generated
 *   into migrations by `drizzle.config.ts`.
 * * `pgOwnedTables.ts` -- tables `movie-backend/authdb.py` owns in `public`.
 *   Mapped for reading, excluded from migrations.
 *
 * This module is the single import surface, so `server/db.ts` has one place to
 * import from regardless of which file a table's ownership puts it in.
 */
export * from "./webTables";
export * from "./pgOwnedTables";