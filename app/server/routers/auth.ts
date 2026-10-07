import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { router, publicProcedure } from "../trpc";
import { telegramSessions, users } from "../../drizzle/schema";
import { SESSION_COOKIE_NAME, ONE_YEAR_MS } from "../../shared/const";

export const authRouter = router({
  generateAuthToken: publicProcedure.mutation(async ({ ctx }) => {
    const authToken = uuidv4();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes for QR auth

    await ctx.db.insert(telegramSessions).values({
      authToken,
      verified: false,
      expiresAt,
    });

    return { authToken };
  }),

  checkAuthStatus: publicProcedure
    .input(z.object({ authToken: z.string() }))
    .query(async ({ ctx, input }) => {
      const session = await ctx.db.query.telegramSessions.findFirst({
        where: and(
          eq(telegramSessions.authToken, input.authToken),
          gt(telegramSessions.expiresAt, new Date())
        ),
      });

      if (!session) {
        return { verified: false, userId: undefined };
      }

      return {
        verified: session.verified,
        userId: session.userId ?? undefined,
      };
    }),

  loginWithTelegram: publicProcedure
    .input(z.object({ authToken: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const session = await ctx.db.query.telegramSessions.findFirst({
        where: and(
          eq(telegramSessions.authToken, input.authToken),
          eq(telegramSessions.verified, true),
          gt(telegramSessions.expiresAt, new Date())
        ),
      });

      if (!session || !session.userId) {
        return { success: false };
      }

      // Create a long-lived session token for the cookie
      const sessionToken = uuidv4();
      const cookieExpires = new Date(Date.now() + ONE_YEAR_MS);

      await ctx.db.insert(telegramSessions).values({
        authToken: sessionToken,
        userId: session.userId,
        verified: true,
        expiresAt: cookieExpires,
      });

      ctx.res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        // Only mark secure when actually served over HTTPS. Over plain HTTP on a
        // LAN/hotspot IP, a secure cookie is silently dropped and login loops.
        secure: ctx.req.secure,
        sameSite: "lax",
        maxAge: ONE_YEAR_MS,
        path: "/",
      });

      return { success: true };
    }),

  me: publicProcedure.query(async ({ ctx }) => {
    return ctx.user ?? null;
  }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    const sessionId = ctx.req.cookies?.[SESSION_COOKIE_NAME];

    if (sessionId) {
      await ctx.db
        .delete(telegramSessions)
        .where(eq(telegramSessions.authToken, sessionId));
    }

    ctx.res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });

    return { success: true };
  }),
});
