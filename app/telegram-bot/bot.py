#!/usr/bin/env python3
"""
Telegram bot for Tesla Video Player.

Handles:
- /start <auth_token>  -- QR-code authentication flow
- YouTube URL messages  -- downloads video via yt-dlp and stores metadata
"""

import os
import asyncio
import re
import uuid
import logging
import subprocess
import json
import sys
import shutil
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

APP_DIR = Path(__file__).resolve().parents[1]
load_dotenv(APP_DIR / ".env")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)
# Telegram request URLs contain the bot token. Keep them out of INFO logs.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
DATABASE_URL = os.environ["DATABASE_URL"]
UPLOADS_DIR = os.environ.get("UPLOADS_DIR", str(APP_DIR / "uploads" / "videos"))
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")
COOKIES_FILE = os.environ.get("COOKIES_FILE", str(Path(__file__).resolve().parent / "cookies.txt"))
DOWNLOAD_FORMAT = (
    "bestvideo[ext=mp4][vcodec^=avc1][height<=720]+bestaudio[ext=m4a]"
    "/best[ext=mp4][height<=720]/best[height<=720]"
)


def downloader_command():
    """Use this bot's environment rather than a different yt-dlp on PATH."""
    command = [
        sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress",
        "--socket-timeout", "20", "--retries", "3", "--fragment-retries", "3",
    ]
    if os.path.exists(COOKIES_FILE):
        command.extend(["--cookies", COOKIES_FILE])
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        command.extend(["--ffmpeg-location", str(Path(ffmpeg).parent)])
    return command


def download_error(stderr):
    """Report the actual final error instead of cutting off an earlier warning."""
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("ERROR:")]
    return (errors[-1] if errors else "\n".join(lines[-3:]) or "No error details returned.")[:700]


async def run_downloader(command, timeout):
    return await asyncio.to_thread(
        subprocess.run, command, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
    )

YOUTUBE_RE = re.compile(
    r"(https?://)?(www\.)?(youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)[\w\-]+"
)

Path(UPLOADS_DIR).mkdir(parents=True, exist_ok=True)


def get_db():
    """Return a new database connection."""
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def get_or_create_user(telegram_user) -> int:
    """Ensure a user row exists and return the user id."""
    conn = get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM users WHERE telegram_id = %s",
                (telegram_user.id,),
            )
            row = cur.fetchone()
            if row:
                return row["id"]

            cur.execute(
                """
                INSERT INTO users (telegram_id, username, first_name, created_at)
                VALUES (%s, %s, %s, NOW())
                RETURNING id
                """,
                (telegram_user.id, telegram_user.username, telegram_user.first_name),
            )
            conn.commit()
            return cur.fetchone()["id"]
    finally:
        conn.close()


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start with optional auth_token for QR login."""
    if not update.effective_user or not update.message:
        return

    user_id = get_or_create_user(update.effective_user)
    args = context.args

    if args and len(args) == 1:
        auth_token = args[0]
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE telegram_sessions
                    SET verified = TRUE, user_id = %s
                    WHERE auth_token = %s
                      AND verified = FALSE
                      AND expires_at > (NOW() AT TIME ZONE 'UTC')
                    """,
                    (user_id, auth_token),
                )
                if cur.rowcount > 0:
                    conn.commit()
                    await update.message.reply_text(
                        "You are now logged in! Return to the browser to continue."
                    )
                else:
                    await update.message.reply_text(
                        "Login token is invalid or expired. Please try scanning the QR code again."
                    )
        finally:
            conn.close()
    else:
        await update.message.reply_text(
            "Welcome to Tesla Video Player Bot!\n\n"
            "Send me a YouTube link and I'll download it for you.\n"
            "To log in to the web app, scan the QR code shown on screen."
        )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle incoming messages -- look for YouTube URLs."""
    if not update.effective_user or not update.message or not update.message.text:
        return

    text = update.message.text.strip()
    match = YOUTUBE_RE.search(text)

    if not match:
        await update.message.reply_text(
            "Send me a YouTube URL and I'll download the video for you."
        )
        return

    youtube_url = match.group(0)
    if not youtube_url.startswith("http"):
        youtube_url = "https://" + youtube_url

    user_id = get_or_create_user(update.effective_user)

    status_msg = await update.message.reply_text("Fetching video info...")

    try:
        # Get video metadata first
        info_cmd = [*downloader_command(), "--dump-single-json", "--skip-download", youtube_url]
        logger.info("Fetching metadata for a requested video")
        info_result = await run_downloader(info_cmd, timeout=120)
        if info_result.returncode != 0:
            error = download_error(info_result.stderr)
            logger.error("Video metadata failed: %s", error)
            await status_msg.edit_text(f"Failed to fetch video info:\n{error}")
            return

        info = json.loads(info_result.stdout)
        title = info.get("title", "Untitled")
        duration = info.get("duration")

        await status_msg.edit_text(f"Downloading: {title}...")

        # Generate a unique filename
        file_id = uuid.uuid4().hex[:12]
        safe_title = re.sub(r'[^\w\s\-]', '', title)[:80].strip()
        filename = f"{file_id}_{safe_title}.%(ext)s"
        output_template = os.path.join(UPLOADS_DIR, filename)

        # Download with yt-dlp in H.264 MP4 format
        dl_cmd = [
            *downloader_command(),
            "-f", DOWNLOAD_FORMAT,
            "--merge-output-format", "mp4",
            "--no-simulate", "--print", "after_move:%(filepath)j",
            "-o", output_template,
            youtube_url,
        ]
        logger.info("Downloading video job %s (up to 720p)", file_id)
        dl_result = await run_downloader(dl_cmd, timeout=1200)

        if dl_result.returncode != 0:
            error = download_error(dl_result.stderr)
            logger.error("Video job %s failed: %s", file_id, error)
            await status_msg.edit_text(f"Download failed:\n{error}")
            return

        # yt-dlp reports the final merged path; never select a partial file.
        paths = []
        for line in dl_result.stdout.splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, str):
                    paths.append(Path(value))
            except json.JSONDecodeError:
                continue
        finished = next((candidate for candidate in reversed(paths) if candidate.is_file() and candidate.suffix in (".mp4", ".mkv", ".webm")), None)
        if finished is None or finished.stat().st_size == 0:
            raise RuntimeError("The downloader did not produce a complete video file.")
        if not finished.resolve().is_relative_to(Path(UPLOADS_DIR).resolve()):
            raise RuntimeError("The downloaded file was outside the configured video directory.")
        file_path = str(finished.resolve())
        filename = finished.name
        file_size = finished.stat().st_size
        file_url = f"{BASE_URL}/uploads/videos/{filename}"

        # Generate thumbnail
        thumbnail_filename = f"{file_id}_thumb.jpg"
        thumbnail_path = os.path.join(UPLOADS_DIR, thumbnail_filename)
        try:
            await asyncio.to_thread(subprocess.run,
                [
                    "ffmpeg", "-i", file_path,
                    "-ss", "00:00:02",
                    "-vframes", "1",
                    "-vf", "scale=640:-1",
                    "-y",
                    thumbnail_path,
                ],
                capture_output=True,
                timeout=30,
            )
        except Exception:
            thumbnail_path = None

        thumbnail_url = (
            f"{BASE_URL}/uploads/videos/{thumbnail_filename}"
            if thumbnail_path and os.path.exists(thumbnail_path)
            else None
        )

        # Insert into database
        conn = get_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO videos
                        (user_id, title, file_path, file_url, thumbnail_url,
                         duration, file_size, youtube_url, status, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'ready', NOW())
                    """,
                    (
                        user_id, title, file_path, file_url, thumbnail_url,
                        duration, file_size, youtube_url,
                    ),
                )
                conn.commit()
        finally:
            conn.close()

        size_mb = file_size / (1024 * 1024)
        duration_str = (
            f"{duration // 60}:{duration % 60:02d}" if duration else "unknown"
        )
        await status_msg.edit_text(
            f"Downloaded: {title}\n"
            f"Duration: {duration_str}\n"
            f"Size: {size_mb:.1f} MB\n\n"
            f"The video is now available in your library."
        )
        logger.info("Video job %s is ready (%s bytes)", file_id, file_size)

    except subprocess.TimeoutExpired:
        await status_msg.edit_text("Download timed out. Please try a shorter video.")
    except Exception as e:
        logger.exception("Error downloading video")
        await status_msg.edit_text(f"An error occurred: {str(e)[:200]}")


def main():
    import asyncio
    asyncio.set_event_loop(asyncio.new_event_loop())
    application = Application.builder().token(BOT_TOKEN).concurrent_updates(4).build()

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(
        MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message)
    )

    logger.info("Bot starting...")
    application.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=False)


if __name__ == "__main__":
    main()
