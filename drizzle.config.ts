import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

/**
 * `dialect` must agree with the driver `DATABASE_URL` names.
 *
 * This said `mysql` while the connection string has always been a Neon
 * `postgresql://` URL, so `drizzle-kit` generated MySQL DDL that could not have
 * been applied to the database it was pointed at.
 */
/**
 * `schema` points at `webTables.ts` alone, never at `schema.ts`.
 *
 * `schema.ts` re-exports the tables owned by `movie-backend/authdb.py` so
 * `server/db.ts` has one import surface. If drizzle-kit were pointed at it,
 * those tables would be treated as ours to create and the migration would emit
 * `CREATE TABLE watch_history` -- which fails against a database where the
 * table already exists, before reaching the `web` schema it was meant to build.
 */
export default defineConfig({
  schema: "./drizzle/webTables.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});