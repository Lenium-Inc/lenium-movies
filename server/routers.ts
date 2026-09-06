import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { getVideoAssetsByMovieId, upsertVideoAsset } from "./db";
import { getMovieById, getOfficialMovieVideo, getPopularMovies, isTmdbConfigured, searchMovies } from "./providers/tmdb";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  catalog: router({
    status: publicProcedure.query(() => ({ provider: "tmdb", configured: isTmdbConfigured() })),
    popular: publicProcedure.input(z.object({ limit: z.number().int().min(1).max(40).default(20) }).optional()).query(({ input }) => getPopularMovies(input?.limit ?? 20)),
    search: publicProcedure.input(z.object({ query: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(40).default(20) })).query(({ input }) => searchMovies(input.query, input.limit)),
    movieById: publicProcedure.input(z.object({ id: z.number().int().positive() })).query(({ input }) => getMovieById(input.id)),
    trailer: publicProcedure.input(z.object({ movieId: z.number().int().positive() })).query(async ({ input }) => {
      const cached = await getVideoAssetsByMovieId(String(input.movieId));
      const cachedTrailer = cached.find((asset) => asset.provider === "youtube" && asset.official === 1 && ["Trailer", "Teaser", "Featurette", "Clip"].includes(asset.type));
      if (cachedTrailer) return { asset: cachedTrailer, cached: true };
      const candidate = await getOfficialMovieVideo(input.movieId);
      if (!candidate) return { asset: null, cached: false };
      const asset = await upsertVideoAsset({ ...candidate, official: candidate.official ? 1 : 0 });
      return { asset: asset ?? candidate, cached: false };
    }),
  }),
});

export type AppRouter = typeof appRouter;
