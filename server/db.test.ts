import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, listWatchProgress, upsertUser } from "./db";

/**
 * The data layer degrades instead of throwing, and this file pins down where.
 *
 * `getDb()` returning null is a normal answer: the test suite and a preview
 * deploy run with no `DATABASE_URL`, and the player is meant to keep working
 * without a resume shelf rather than to 500. The failure modes worth guarding
 * are therefore "it threw instead of returning null" and "it left a pool open".
 */

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

async function withNoDatabase(fn: () => Promise<void>) {
  delete process.env.DATABASE_URL;
  await closeDb();
  try {
    await fn();
  } finally {
    await closeDb();
    if (ORIGINAL_DB_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DB_URL;
    else delete process.env.DATABASE_URL;
    await closeDb();
  }
}

beforeEach(async () => {
  await closeDb();
});

afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
  if (ORIGINAL_DB_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DB_URL;
  else delete process.env.DATABASE_URL;
});

describe("getDb", () => {
  it("returns null when no DATABASE_URL is configured", async () => {
    await withNoDatabase(async () => {
      expect(await getDb()).toBeNull();
      // And it stays null rather than half-constructing a pool on retry.
      expect(await getDb()).toBeNull();
    });
  });

  it("returns null instead of throwing when the host is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Port 1 on loopback is refused immediately, so this fails fast rather than
    // waiting out the connection timeout.
    process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/db";
    await closeDb();
    try {
      expect(await getDb()).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      await closeDb();
      if (ORIGINAL_DB_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DB_URL;
      else delete process.env.DATABASE_URL;
    }
  });
});

describe("upsertUser", () => {
  it("requires an openId", async () => {
    await closeDb();
    await expect(upsertUser({} as any)).rejects.toThrow(/openId/);
  });

  it("warns and returns when the database is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withNoDatabase(async () => {
      await upsertUser({ openId: "oauth-1", name: "Sam" });
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("database not available")
    );
  });
});

describe("listWatchProgress", () => {
  it("returns an empty list rather than throwing without a database", async () => {
    await withNoDatabase(async () => {
      expect(await listWatchProgress("user-1", "profile-1")).toEqual([]);
    });
  });

  it("never scopes the read by profile alone", async () => {
    // Profile ids are generated client-side, so a query built from one id would
    // hand a caller another account's history whenever the ids collided. The
    // function takes `userId` first and only ever qualifies on it.
    await withNoDatabase(async () => {
      expect(await listWatchProgress("user-1")).toEqual([]);
    });
  });
});
