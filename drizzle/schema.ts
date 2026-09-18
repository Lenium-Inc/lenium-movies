import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  uniqueIndex,
  index,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const videoAssets = mysqlTable(
  "videoAssets",
  {
    id: int("id").autoincrement().primaryKey(),
    movieId: varchar("movieId", { length: 128 }).notNull(),
    provider: mysqlEnum("provider", ["youtube"]).notNull(),
    providerVideoId: varchar("providerVideoId", { length: 128 }).notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    name: varchar("name", { length: 512 }).notNull(),
    official: int("official").notNull().default(0),
    language: varchar("language", { length: 16 }),
    country: varchar("country", { length: 16 }),
    thumbnailUrl: text("thumbnailUrl"),
    publishedAt: timestamp("publishedAt"),
    duration: int("duration"),
    embedUrl: text("embedUrl").notNull(),
    sourceUrl: text("sourceUrl").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    movieProviderVideoUnique: uniqueIndex(
      "videoAssets_movie_provider_video_unique"
    ).on(table.movieId, table.provider, table.providerVideoId),
    movieLookup: index("videoAssets_movie_id_idx").on(table.movieId),
  })
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type VideoAsset = typeof videoAssets.$inferSelect;
export type InsertVideoAsset = typeof videoAssets.$inferInsert;
