import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { router, publicProcedure, protectedProcedure } from "../trpc";
import { videos } from "../../drizzle/schema";

export const videosRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      return [];
    }

    const userVideos = await ctx.db.query.videos.findMany({
      where: and(
        eq(videos.userId, ctx.user.id),
        eq(videos.status, "ready")
      ),
      orderBy: (videos, { desc }) => [desc(videos.createdAt)],
    });

    return userVideos.map((v) => ({
      id: v.id,
      title: v.title,
      thumbnailUrl: v.thumbnailUrl,
      duration: v.duration,
      fileSize: v.fileSize,
    }));
  }),

  get: publicProcedure
    .input(z.object({ videoId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        return null;
      }

      const video = await ctx.db.query.videos.findFirst({
        where: and(
          eq(videos.id, input.videoId),
          eq(videos.userId, ctx.user.id)
        ),
      });

      if (!video) {
        return null;
      }

      return {
        id: video.id,
        title: video.title,
        fileUrl: video.fileUrl,
        thumbnailUrl: video.thumbnailUrl,
        duration: video.duration,
        fileSize: video.fileSize,
        youtubeUrl: video.youtubeUrl,
        status: video.status,
        createdAt: video.createdAt,
      };
    }),

  delete: protectedProcedure
    .input(z.object({ videoId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const video = await ctx.db.query.videos.findFirst({
        where: and(
          eq(videos.id, input.videoId),
          eq(videos.userId, ctx.user.id)
        ),
      });

      if (!video) {
        return { success: false };
      }

      // Delete from database
      await ctx.db.delete(videos).where(eq(videos.id, input.videoId));

      // Optionally delete file from disk
      if (video.filePath) {
        try {
          const fs = await import("fs/promises");
          await fs.unlink(video.filePath);
        } catch {
          // File may already be deleted; ignore
        }
      }

      return { success: true };
    }),
});
