import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  username: varchar("username", { length: 255 }),
  firstName: varchar("first_name", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const telegramSessions = pgTable("telegram_sessions", {
  id: serial("id").primaryKey(),
  authToken: varchar("auth_token", { length: 255 }).notNull().unique(),
  userId: integer("user_id").references(() => users.id),
  verified: boolean("verified").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id)
    .notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  filePath: text("file_path"),
  fileUrl: text("file_url"),
  thumbnailUrl: text("thumbnail_url"),
  duration: integer("duration"),
  fileSize: bigint("file_size", { mode: "number" }),
  youtubeUrl: text("youtube_url"),
  status: varchar("status", { length: 50 }).default("pending").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
