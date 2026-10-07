import { and, desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  InsertUser,
  User,
  users,
  videoAssets,
  watchHistory,
  type VideoAsset,
  type WatchHistoryEntry,
} from "../drizzle/schema";
import * as schema from "../drizzle/schema";
import { ENV } from "./_core/env";

/**
 * Neon Postgres access for the Next.js server.
 *
 * Pool sizing is a memory decision, not a throughput one. This process runs
 * under a 512 MB cap alongside the media proxy, and every connection the pool
 * holds open costs a backend on Neon's side and a socket buffer here. Five is
 * enough to cover a burst of concurrent `users` lookups without becoming the
 * thing that gets the instance OOM-killed, and it is well under Neon's default
 * connection ceiling.
 *
 * `DATABASE_URL` should point at Neon's pooled endpoint (`-pooler` in the host).
 * That matters more than the pool here does: Neon's pooler multiplexes many
 * client connections over one, so `max` above is a cap on concurrency, not on
 * server-side sessions.
 */

const POOL_MAX_CONNECTIONS = 5;
const POOL_IDLE_TIMEOUT_MS = 30_000;
const POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * How long any single statement may run before Postgres cancels it.
 *
 * Without this a query against an unreachable network can hold a pool slot for
 * as long as the TCP keepalive allows, and five stuck statements are a database
 * that looks down for the whole process.
 */
const STATEMENT_TIMEOUT_MS = 10_000;

let pool: Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;
let registeredShutdown = false;

function connectionString(): string | null {
  const value = process.env.DATABASE_URL?.trim();
  return value ? value : null;
}

function buildPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: POOL_MAX_CONNECTIONS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    // Applied to the session rather than the query, so it covers every statement
    // the driver sends, including ones Drizzle builds internally.
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: "freestream-web",
  });
}

function registerShutdownHandlers(instance: Pool): void {
  if (registeredShutdown) return;
  registeredShutdown = true;

  const release = () => {
    void instance.end().catch(() => {});
  };
  // `beforeExit` does not fire when there are open handles, and a pool is
  // exactly that, so the signal handlers are the ones that actually matter:
  // without them the process stays alive for the pool's idle timeout on every
  // deploy.
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
}

/**
 * The database handle, or null when none is configured or reachable.
 *
 * Null is a normal answer, not a failure: a preview deploy and the test suite
 * run without a `DATABASE_URL`, and every caller here already degrades rather
 * than throwing. What this function will not do is retry -- a connection that
 * cannot be made is cached as "no handle" for the life of the process, so the
 * next call is a null check instead of another dial.
 */
export async function getDb(): Promise<NodePgDatabase<typeof schema> | null> {
  if (_db) return _db;
  const url = connectionString();
  if (!url) return null;
  try {
    pool = buildPool(url);
    registerShutdownHandlers(pool);
    // `pg` connects lazily, so this is the first thing that can actually fail.
    // It is a 1-query round trip on a fresh deploy, and it is worth it: a pool
    // that has never verified its credentials would otherwise report "database
    // unavailable" for every write while looking healthy in the logs.
    const client = await pool.connect();
    client.release();
    _db = drizzle(pool, { schema });
    return _db;
  } catch (error) {
    console.warn("[Database] Failed to connect:", error);
    // Drop the half-built pool rather than leaking its sockets on a failed
    // connect; `end()` is safe to call on a pool that never connected.
    void pool?.end().catch(() => {});
    pool = null;
    _db = null;
    return null;
  }
}

/**
 * Close the pool and forget the handle.
 *
 * Exposed for tests and for an orderly shutdown. `pg.Pool.end()` resolves once
 * every checked-out client has been returned, so calling this without a timeout
 * can hang behind a stuck query -- the statement timeout above is what bounds
 * that.
 */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = null;
  _db = null;
  registeredShutdown = false;
  if (current) await current.end().catch(() => {});
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }
  const values: InsertUser = { openId: user.openId };
  const updateSet: Partial<typeof users.$inferInsert> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  for (const field of textFields) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (!Object.keys(updateSet).length) updateSet.lastSignedIn = new Date();
  // `onDuplicateKeyUpdate` is MySQL's spelling. The Postgres equivalent is an
  // `ON CONFLICT ... DO UPDATE`, which Drizzle also requires a conflict target
  // for -- without one it cannot emit the clause at all, which is why the
  // `openId` column's unique constraint is load-bearing and not decorative.
  await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({ target: users.openId, set: updateSet });
}

export async function getUserByOpenId(
  openId: string
): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);
  return result[0];
}

/**
 * Read a viewer's resume points from `public.watch_history`.
 *
 * Deliberately a read. The player writes progress through
 * `movie-backend/authdb.py`, which owns that table and keys it on
 * `UNIQUE (user_id, movie_key)`. A second writer here would have to either
 * duplicate the row into a `web` copy -- two sources of truth for one resume
 * point -- or race the Python upsert against a unique index it does not own.
 * Neither is worth it to avoid a SELECT.
 *
 * `profileId` is optional because the live table's unique key ignores it, so a
 * caller may legitimately want one profile's rows and a caller without a profile
 * may want all of them.
 */
export async function listWatchProgress(
  userId: string,
  profileId?: string,
  limit = 50
): Promise<WatchHistoryEntry[]> {
  const db = await getDb();
  if (!db) return [];
  // No profile means "every profile on this account", which is a scope on
  // `userId` alone rather than a NULL test: the live column is nullable, but
  // rows with no profile id are the account owner's, not everyone's.
  const scope = profileId
    ? and(eq(watchHistory.userId, userId), eq(watchHistory.profileId, profileId))
    : eq(watchHistory.userId, userId);
  return db
    .select()
    .from(watchHistory)
    .where(scope)
    .orderBy(desc(watchHistory.watchedAt))
    .limit(limit);
}

/**
 * Normalized provider assets for a title, for the trailer picker.
 *
 * Read from `web.videoAssets`, which this layer owns. `providerVideoId` is
 * distinct per provider, so it is part of the uniqueness guarantee together with
 * `movieId` and `provider` rather than a bare unique column: one movie id, one
 * YouTube upload, is one row, and re-running a TMDB sync must not duplicate it.
 */
export async function listVideoAssets(
  movieId: string,
  provider?: string
): Promise<VideoAsset[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(videoAssets)
    .where(
      provider
        ? and(
            eq(videoAssets.movieId, movieId),
            eq(videoAssets.provider, provider as VideoAsset["provider"])
          )
        : eq(videoAssets.movieId, movieId)
    );
}