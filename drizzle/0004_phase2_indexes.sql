-- Phase 2 batch 4 — F3: secondary indexes on the columns the hot
-- queries filter/join on. All IF NOT EXISTS, so a retried boot migration
-- is harmless. No data change.
CREATE INDEX IF NOT EXISTS "idx_orders_customer_email" ON "orders" ("customer_email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cart_items_customer_email" ON "cart_items" ("customer_email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wishlist_items_customer_email" ON "wishlist_items" ("customer_email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_product_images_product_id" ON "product_images" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_items_order_id" ON "order_items" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_events_order_id" ON "order_events" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_customer_sessions_token_hash" ON "customer_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_returns_order_number" ON "returns" ("order_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_category" ON "products" ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_products_status" ON "products" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_created_at" ON "orders" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_logs_created_at" ON "audit_logs" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notifications_is_read" ON "notifications" ("is_read");
--> statement-breakpoint
