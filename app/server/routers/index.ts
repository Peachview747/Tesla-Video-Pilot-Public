import { router } from "../trpc";
import { authRouter } from "./auth";
import { videosRouter } from "./videos";

export const appRouter = router({
  auth: authRouter,
  videos: videosRouter,
});

export type AppRouter = typeof appRouter;
