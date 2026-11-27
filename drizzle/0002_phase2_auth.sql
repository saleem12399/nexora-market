-- Phase 2 batch 1 — owner/staff auth + B7/B19/B14 columns.
-- Additive only (new columns/tables + backfills); safe to apply on the
-- live database. Every statement is IF NOT EXISTS / idempotent so a
-- retried boot migration is harmless.
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "password_hash" text;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "totp_secret" text;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "must_reset_password" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "setup_token_hash" text;
--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "setup_expires_at" bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "staff_id" integer NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" bigint NOT NULL,
  "reauth_at" bigint,
  "created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "published_at" bigint;
--> statement-breakpoint
-- B7 backfill: staggered by id from 2025-09-01, one day per id, so the
-- highest id is newest initially. These are seed-order dates, NOT real
-- publication dates — documented honestly in the progress log.
-- NOTE: the day arithmetic MUST be bigint — id * 86400000 overflows int4
-- (72 * 86400000 = 6.2B > 2.1B) and aborts the whole migration.
UPDATE "products" SET "published_at" = 1756684800000::bigint + "id"::bigint * 86400000::bigint WHERE "published_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "customer_id" integer;
--> statement-breakpoint
-- B19 backfill: order-linked notifications get the customer of that order.
-- Welcome / flash-sale / price-drop notices stay NULL (system-wide, staff
-- view only).
UPDATE "notifications" n SET "customer_id" = c."id"
FROM "orders" o JOIN "customers" c ON lower(c."email") = lower(o."customer_email")
WHERE n."customer_id" IS NULL AND n."body" LIKE '%' || o."order_number" || '%';
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "notif_prefs" text DEFAULT '' NOT NULL;
--> statement-breakpoint
