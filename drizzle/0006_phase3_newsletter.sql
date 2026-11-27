-- Phase 3 batch C — D6 (footer newsletter list).
-- No mailing provider is connected yet; this table only records who asked
-- to hear from the store. Email is unique (one row per address).
CREATE TABLE IF NOT EXISTS "newsletter_signups" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "created_at" bigint NOT NULL,
  CONSTRAINT "newsletter_signups_email_unique" UNIQUE("email")
);
--> statement-breakpoint
