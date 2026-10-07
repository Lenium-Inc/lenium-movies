CREATE SCHEMA "web";
--> statement-breakpoint
CREATE TYPE "web"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "web"."video_provider" AS ENUM('youtube');--> statement-breakpoint
CREATE TABLE "web"."users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "web"."user_role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE "web"."videoAssets" (
	"id" serial PRIMARY KEY NOT NULL,
	"movieId" varchar(128) NOT NULL,
	"provider" "web"."video_provider" NOT NULL,
	"providerVideoId" varchar(128) NOT NULL,
	"type" varchar(64) NOT NULL,
	"name" varchar(512) NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"language" varchar(16),
	"country" varchar(16),
	"thumbnailUrl" text,
	"publishedAt" timestamp with time zone,
	"duration" integer,
	"embedUrl" text NOT NULL,
	"sourceUrl" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "videoAssets_movie_provider_video_unique" ON "web"."videoAssets" USING btree ("movieId","provider","providerVideoId");--> statement-breakpoint
CREATE INDEX "videoAssets_movie_id_idx" ON "web"."videoAssets" USING btree ("movieId");--> statement-breakpoint
-- Hand-added. `public.watch_history` is owned by movie-backend/authdb.py, so it
-- is absent from webTables.ts and drizzle-kit cannot generate for it.
--
-- Deployed, that table has only a primary key and a UNIQUE (user_id, movie_key)
-- constraint, which cannot serve "this account, most recently watched first":
-- Postgres would have to sort the account's entire history before returning the
-- first row, on the page every signed-in viewer loads. This index is purely
-- additive -- no table, no column, no constraint, and no existing row changes.
CREATE INDEX IF NOT EXISTS "watch_history_user_movie_watched_at_idx" ON "public"."watch_history" USING btree ("user_id","watched_at");