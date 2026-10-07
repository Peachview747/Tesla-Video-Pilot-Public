import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./trpc";
import { eq, and } from "drizzle-orm";
import { videos } from "../drizzle/schema";
import { db } from "./db";
import { SESSION_COOKIE_NAME } from "../shared/const";
import { telegramSessions, users } from "../drizzle/schema";
import { gt } from "drizzle-orm";

const app = express();
const PORT = parseInt(process.env.PORT || "5000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Parse allowed origins from env
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:5173", "http://localhost:5000"];

// Always allow same-origin requests (page and API served from the same host:port).
app.use(
  cors((req, callback) => {
    const origin = req.header("Origin");
    const host = req.header("Host");
    let sameOrigin = !origin;
    if (origin && host) {
      try {
        sameOrigin = new URL(origin).host === host;
      } catch {
        sameOrigin = false;
      }
    }
    callback(null, {
      origin: sameOrigin || (!!origin && allowedOrigins.includes(origin)),
      credentials: true,
    });
  }),
);

app.use(cookieParser());
if (process.env.RELEASE_ID) {
  app.use((_req, res, next) => {
    res.setHeader("X-MK8-Release", process.env.RELEASE_ID!);
    next();
  });
}

// Serve uploaded video files as static assets (original MP4s)
const uploadsDir =
  process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsDir));

// ---------------------------------------------------------------------------
// Bulletproof Drive-mode stream: MPEG-TS (mpeg1video + mp2) for JSMpeg
// Never uses a <video> element on the client — Tesla cannot pause it.
// ---------------------------------------------------------------------------
async function resolveUserFromCookie(req: express.Request) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  if (!sessionId) return null;
  const session = await db.query.telegramSessions.findFirst({
    where: and(
      eq(telegramSessions.authToken, sessionId),
      eq(telegramSessions.verified, true),
      gt(telegramSessions.expiresAt, new Date()),
    ),
  });
  if (!session?.userId) return null;
  return db.query.users.findFirst({ where: eq(users.id, session.userId) });
}

app.get("/api/stream/:videoId.ts", async (req, res) => {
  try {
    const videoId = parseInt(req.params.videoId, 10);
    if (!Number.isFinite(videoId)) {
      res.status(400).send("bad video id");
      return;
    }

    const user = await resolveUserFromCookie(req);
    if (!user) {
      res.status(401).send("login required");
      return;
    }

    const video = await db.query.videos.findFirst({
      where: and(eq(videos.id, videoId), eq(videos.userId, user.id)),
    });

    if (!video || !video.filePath) {
      res.status(404).send("video not found");
      return;
    }

    const filePath = video.filePath;
    if (!fs.existsSync(filePath)) {
      // Fallback: try resolving relative to uploadsDir
      const basename = path.basename(filePath);
      const alt = path.join(uploadsDir, basename);
      if (!fs.existsSync(alt)) {
        res.status(404).send("file missing on disk");
        return;
      }
      // use alt
      streamMpegTs(alt, res);
      return;
    }

    streamMpegTs(filePath, res);
  } catch (err) {
    console.error("[stream] error", err);
    if (!res.headersSent) res.status(500).send("stream error");
  }
});

function streamMpegTs(inputPath: string, res: express.Response) {
  // Quality tuned for Tesla hotspot / cellular: 720p-ish, low-latency TS.
  // -bf 0 is required by JSMpeg (no B-frames).
  // The client consumes a live stream, so pace the encoder at playback speed.
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-i",
    inputPath,
    "-f",
    "mpegts",
    "-codec:v",
    "mpeg1video",
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-r",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    "1500k",
    "-maxrate",
    "1800k",
    "-bufsize",
    "800k",
    "-bf",
    "0",
    "-g",
    "30",
    "-codec:a",
    "mp2",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-muxdelay",
    "0.001",
    "pipe:1",
  ];

  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  // Allow the Cloudflare Worker / tunnel to stream without buffering the whole file
  res.setHeader("X-Accel-Buffering", "no");

  ff.stdout.pipe(res);

  ff.stderr.on("data", (chunk) => {
    // Keep logs short; useful when diagnosing on the laptop
    const line = chunk.toString().trim();
    if (line) console.error("[ffmpeg]", line.slice(0, 200));
  });

  const cleanup = () => {
    if (!ff.killed) {
      ff.kill("SIGKILL");
    }
  };

  res.on("close", cleanup);
  res.on("error", cleanup);
  ff.on("error", (err) => {
    console.error("[ffmpeg] spawn error", err);
    cleanup();
    if (!res.headersSent) res.status(500).send("ffmpeg failed to start");
  });
  ff.on("close", (code) => {
    if (code !== 0 && code !== null && !res.writableEnded) {
      // client already disconnected is fine
    }
  });
}

// tRPC middleware
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

// Serve the built frontend (production)
const distDir = process.env.DIST_DIR || path.join(process.cwd(), "dist");
app.use(express.static(distDir));

// SPA fallback: serve index.html for any non-API, non-static route
app.get("/{*path}", (_req, res) => {
  res.sendFile("index.html", { root: distDir });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Bulletproof stream: GET /api/stream/:videoId.ts`);
});
