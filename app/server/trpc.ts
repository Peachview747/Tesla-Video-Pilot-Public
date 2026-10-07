import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { eq, and, gt } from "drizzle-orm";
import { db } from "./db";
import { telegramSessions, users } from "../drizzle/schema";
import { SESSION_COOKIE_NAME } from "../shared/const";

export async function createContext({ req, res }: CreateExpressContextOptions) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;

  let user: typeof users.$inferSelect | null = null;

  if (sessionId) {
    const session = await db.query.telegramSessions.findFirst({
      where: and(
        eq(telegramSessions.authToken, sessionId),
        eq(telegramSessions.verified, true),
        gt(telegramSessions.expiresAt, new Date())
      ),
    });

    if (session?.userId) {
      const foundUser = await db.query.users.findFirst({
        where: eq(users.id, session.userId),
      });
      if (foundUser) {
        user = foundUser;
      }
    }
  }

  return { req, res, user, db };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});
