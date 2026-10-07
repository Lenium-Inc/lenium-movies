import {
  boolean,
  index,
  integer,
  pgEnum,
  pgSchema,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Tables this layer owns, declared in the `web` schema.
 *
 * `movie-backend/authdb.py` owns the `public` schema and has been writing to it
 * longer than this schema file has existed, so anything the Next.js server needs
 * to *write* goes in `web` instead. `CREATE SCHEMA "web"` is the first statement
 * of the migration precisely because nothing creates it implicitly.
 *
 * Kept in its own file, separate from the externally-managed mapping in
 * `pgOwnedTables.ts`, because `drizzle.config.ts` points `schema` at this path
 * only. If both were in one file, `drizzle-kit generate` would emit a
 * `CREATE TABLE watch_history` and the migration would fail on its first
 * attempt against a database where that table already exists.
 */

/** Node-owned namespace. */
export const web = pgSchema("web");

export const userRole = web.enum("user_role", ["user", "admin"]);

export const videoProvider = web.enum("video_provider", ["youtube"]);

/**
 * The OAuth session mirror.
 *
 * This is not the application's user. It is keyed by the OAuth provider's
 * `openId` and exists so a signed-in request can resolve an identity without a
 * round trip to the OAuth server on every call. The account itself --
 * credentials, profiles, saved titles -- lives in `public.users`, which
 * `authdb.py` owns.
 *
 * That split is why `email` is a plain column and not a foreign key into
 * `public.users`: the OAuth provider will hand us an email belonging to an
 * account that has never signed in through the Python store, and a NOT NULL
 * foreign key would reject the first login of every new user.
 */
export const users = web.table("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: userRole("role").default("user").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const videoAssets = web.table(
  "videoAssets",
  {
    id: serial("id").primaryKey(),
    movieId: varchar("movieId", { length: 128 }).notNull(),
    provider: videoProvider("provider").notNull(),
    providerVideoId: varchar("providerVideoId", { length: 128 }).notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    name: varchar("name", { length: 512 }).notNull(),
    /**
     * A real boolean, not the MySQL `int` flag this column used to be.
     *
     * TMDB answers `official: true | false`, so an `int` forced every writer to
     * decide what `1` meant and every reader to guess the inverse. Postgres will
     * not coerce a JavaScript `true` into an integer, so making it a boolean is
     * what lets the column hold what its name says.
     */
    official: boolean("official").notNull().default(false),
    language: varchar("language", { length: 16 }),
    country: varchar("country", { length: 16 }),
    thumbnailUrl: text("thumbnailUrl"),
    publishedAt: timestamp("publishedAt", { withTimezone: true }),
    duration: integer("duration"),
    embedUrl: text("embedUrl").notNull(),
    sourceUrl: text("sourceUrl").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  table => ({
    /**
     * `providerVideoId` is only unique *within* a provider and a movie, so all
     * three columns make up the key. A bare unique on `providerVideoId` would
     * reject the same upload attached to two movies, and omitting `provider`
     * would let a YouTube id and a Vimeo id collide.
     */
    movieProviderVideoUnique: uniqueIndex("videoAssets_movie_provider_video_unique")
      .on(table.movieId, table.provider, table.providerVideoId),
    movieLookup: index("videoAssets_movie_id_idx").on(table.movieId),
  })
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type VideoAsset = typeof videoAssets.$inferSelect;
export type InsertVideoAsset = typeof videoAssets.$inferInsert;