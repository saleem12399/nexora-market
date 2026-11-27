-- Phase 5 — F6 historical FK validation (READ-ONLY COUNT; never fails, never deletes/modifies rows).
-- The four FKs added in migration 0005 are NOT VALID: they are enforced for
-- every NEW row from now on, but the historical rows were never checked, and
-- a VALIDATE CONSTRAINT failure would roll back the whole migration file.
-- This migration ONLY counts orphan rows per FK and records the four counts
-- as JSON in settings key "fkOrphanCounts" (readable via the public API
-- action getFkOrphanCounts — four integers only, no PII, no credentials).
-- It must NEVER fail the boot migration: the whole count lives inside one
-- DO block with an exception handler. A counting failure records
-- {"error":"count failed"} instead of aborting, so later migrations are
-- never blocked by this one. No row is deleted, updated or inserted except
-- the single settings key (upsert).
DO $$
DECLARE
  c_order_items int := -1;
  c_product_images int := -1;
  c_customer_addresses int := -1;
  c_customer_sessions int := -1;
BEGIN
  SELECT count(*) INTO c_order_items FROM "order_items" oi WHERE NOT EXISTS (SELECT 1 FROM "orders" o WHERE o."id" = oi."order_id");
  SELECT count(*) INTO c_product_images FROM "product_images" pi WHERE NOT EXISTS (SELECT 1 FROM "products" p WHERE p."id" = pi."product_id");
  SELECT count(*) INTO c_customer_addresses FROM "customer_addresses" ca WHERE NOT EXISTS (SELECT 1 FROM "customers" c WHERE c."id" = ca."customer_id");
  SELECT count(*) INTO c_customer_sessions FROM "customer_sessions" cs WHERE NOT EXISTS (SELECT 1 FROM "customers" c WHERE c."id" = cs."customer_id");
  INSERT INTO "settings" ("key", "value") VALUES ('fkOrphanCounts', jsonb_build_object('checkedAt', to_char(now() AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD"T"HH24:MI:SS'), 'orderItemsOrderId', c_order_items, 'productImagesProductId', c_product_images, 'customerAddressesCustomerId', c_customer_addresses, 'customerSessionsCustomerId', c_customer_sessions)::text)
  ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value";
EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO "settings" ("key", "value") VALUES ('fkOrphanCounts', '{"error":"count failed"}')
    ON CONFLICT ("key") DO UPDATE SET "value" = '{"error":"count failed"}';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;
--> statement-breakpoint
