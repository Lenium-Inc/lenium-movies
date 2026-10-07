import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../drizzle/schema";
import { watchHistory as pgOwnedWatchHistory } from "../drizzle/pgOwnedTables";
import { videoAssets } from "../drizzle/webTables";

/**
 * Ownership of the tables in `drizzle/`, asserted rather than documented.
 *
 * The schema is split across `webTables.ts` and `pgOwnedTables.ts` for a reason
 * that is invisible from inside `server/db.ts` and is easy to undo:
 * `drizzle-kit` generates migrations from whatever `drizzle.config.ts` points
 * it at, so moving `watch_history` into the owned file makes the migration emit
 * `CREATE TABLE watch_history` and fail on a database where `authdb.py` has
 * already created it. That failure lands before the `web` statements, so the
 * whole migration rolls back and the deploy reports a generic schema error.
 *
 * These assertions read drizzle's resolved table config, so they need no
 * database -- the failure being guarded is a wrong import shape, which is
 * knowable statically.
 */

const columnsOf = (table: any) => getTableConfig(table).columns;
const indexColumns = (table: any, name: string): string[] => {
  const found = getTableConfig(table).indexes.find(
    (index: any) => index.config.name === name
  );
  if (!found) throw new Error(`index ${name} is missing`);
  return found.config.columns.map((column: any) => column.name);
};

describe("schema ownership", () => {
  it("maps watch_history into the public schema that authdb.py owns", () => {
    // Same object, not a copy: schema.ts is a re-export, so server/db.ts gets
    // one import surface without the config file seeing this table.
    expect(schema.watchHistory).toBe(pgOwnedWatchHistory);

    const config = getTableConfig(schema.watchHistory);
    expect(config.name).toBe("watch_history");
    // Not `web`. A `web.watch_history` would be a second source of truth for a
    // resume point, and every resume would depend on which writer ran last.
    // `undefined` here is not "unknown": drizzle resolves a bare `pgTable` to
    // the connection's `search_path`, which is `public` -- the same place
    // `authdb.py` creates it.
    expect(config.schema ?? "public").toBe("public");
    expect(config.schema).not.toBe("web");
  });

  it("puts the writable tables in the web schema", () => {
    expect(getTableConfig(schema.users).schema).toBe("web");
    expect(getTableConfig(videoAssets).schema).toBe("web");

    // `users` lives in `web`, not `public`. If it were in `public` it would
    // shadow the account table authdb.py owns, and `server/db.ts` would query a
    // `role` and an `openId` column that table has never had -- failing at plan
    // time with a message naming neither the mismatch nor the right table.
    expect(getTableConfig(schema.users).name).toBe("users");
    const columns = columnsOf(schema.users);
    expect(columns.map(c => c.name)).toContain("openId");
    expect(columns.map(c => c.name)).toContain("role");
  });

  it("matches the unique key authdb.py actually enforces", () => {
    const columns = indexColumns(
      schema.watchHistory,
      "watch_history_user_movie_watched_at_idx"
    );
    // Deliberately not (user_id, profile_id, movie_key). The live constraint
    // ignores profile_id, so a reader that assumed a profile-scoped key would
    // build an ON CONFLICT target the table has never had.
    expect(columns).toEqual(["user_id", "watched_at"]);
  });

  it("scopes the videoAssets unique key across all three columns", () => {
    const columns = indexColumns(
      videoAssets,
      "videoAssets_movie_provider_video_unique"
    );
    expect(columns).toEqual(["movieId", "provider", "providerVideoId"]);
  });

  it("maps official as a boolean rather than an int", () => {
    const column = columnsOf(videoAssets).find(c => c.name === "official");
    expect(column?.dataType).toBe("boolean");
  });
});
