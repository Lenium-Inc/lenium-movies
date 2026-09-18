import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  getMovieById,
  getMovieTrailer,
  getPopularMovies,
  isTmdbConfigured,
  searchMovies,
} from "./providers/tmdb";

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
    status: publicProcedure.query(() => ({
      provider: "tmdb",
      configured: isTmdbConfigured(),
    })),
    popular: publicProcedure
      .input(
        z
          .object({ limit: z.number().int().min(1).max(40).default(20) })
          .optional()
      )
      .query(({ input }) => getPopularMovies(input?.limit ?? 20)),
    search: publicProcedure
      .input(
        z.object({
          query: z.string().trim().min(1).max(120),
          type: z.enum(["movie", "tv", "multi"]).default("multi"),
          limit: z.number().int().min(1).max(40).default(20),
        })
      )
      .query(({ input }) => searchMovies(input.query, input.type, input.limit)),
    movieById: publicProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .query(({ input }) => getMovieById(input.id)),
    movieTrailer: publicProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .query(({ input }) => getMovieTrailer(input.id)),
  }),
});

export type AppRouter = typeof appRouter;
