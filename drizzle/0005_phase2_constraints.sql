-- Phase 2 batch 4 — F5 (UNIQUE on orders.idempotency_key) + F6 (FKs).
-- F5: PARTIAL unique index — every seeded order shares "" (empty), so
-- only real non-empty keys are unique. QA orders placed so far use
-- distinct non-empty keys. If two non-empty keys ever collide, this
-- statement fails and the whole file rolls back (the boot migrator
-- reports it on /health) — that is the honest signal, not a silent skip.
CREATE UNIQUE INDEX "idx_orders_idempotency_key_unique" ON "orders" ("idempotency_key") WHERE "idempotency_key" <> '';
--> statement-breakpoint
-- F6: foreign keys with explicit ON DELETE behaviour. Added NOT VALID on
-- purpose: the live rows cannot be deleted or re-checked from this
-- environment, and a VALIDATE failure would roll back the whole
-- migration. The constraints ARE enforced for every NEW row from now
-- on; validating the historical rows is a separate read-only check
-- (see finalization-progress.md). product_id on order_items stays
-- nullable (legacy items) and gets NO FK, per the brief.
ALTER TABLE "order_items" ADD CONSTRAINT "fk_order_items_order_id" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "fk_product_images_product_id" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "fk_customer_addresses_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "fk_customer_sessions_customer_id" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
