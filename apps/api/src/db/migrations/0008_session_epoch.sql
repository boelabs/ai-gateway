ALTER TABLE "dashboard_sessions" ADD COLUMN "user_epoch" integer;--> statement-breakpoint
ALTER TABLE "dashboard_users" ADD COLUMN "session_epoch" integer DEFAULT 0 NOT NULL;