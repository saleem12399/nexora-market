CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor" text DEFAULT 'System' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_email" text NOT NULL,
	"product_id" integer NOT NULL,
	"qty" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"product_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"discount_type" text NOT NULL,
	"value" integer NOT NULL,
	"min_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"expires_at" text DEFAULT '' NOT NULL,
	"usage_limit" integer DEFAULT 0 NOT NULL,
	"per_customer_limit" integer DEFAULT 0 NOT NULL,
	"scope_type" text DEFAULT 'all' NOT NULL,
	"scope_value" text DEFAULT '' NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"label" text DEFAULT 'Home' NOT NULL,
	"recipient" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"province" text DEFAULT '' NOT NULL,
	"postal_code" text DEFAULT '' NOT NULL,
	"landmark" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"delivery_slot" text DEFAULT '' NOT NULL,
	"pickup_point" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"password_hash" text,
	"must_reset_password" boolean DEFAULT false NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"phone_verified" boolean DEFAULT false NOT NULL,
	"deletion_requested" boolean DEFAULT false NOT NULL,
	"reset_token_hash" text,
	"reset_expires_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "customers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "demo_merchants" (
	"id" serial PRIMARY KEY NOT NULL,
	"store_name" text NOT NULL,
	"owner_name" text DEFAULT '' NOT NULL,
	"category_focus" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"rating" real DEFAULT 0 NOT NULL,
	"reviews_count" integer DEFAULT 0 NOT NULL,
	"joined" text DEFAULT '' NOT NULL,
	"verification" text DEFAULT 'Unverified' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hero_banners" (
	"id" serial PRIMARY KEY NOT NULL,
	"headline" text NOT NULL,
	"subtext" text DEFAULT '' NOT NULL,
	"cta_label" text DEFAULT '' NOT NULL,
	"cta_target" text DEFAULT '' NOT NULL,
	"cta2_label" text DEFAULT '' NOT NULL,
	"cta2_target" text DEFAULT '' NOT NULL,
	"product_id" integer,
	"image_key" text DEFAULT '' NOT NULL,
	"starts_at" text DEFAULT '' NOT NULL,
	"ends_at" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_collections" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"subcategory" text DEFAULT '' NOT NULL,
	"product_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "home_sections_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"qty" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"actor" text DEFAULT 'System' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"actor" text DEFAULT 'System' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer,
	"product_name" text NOT NULL,
	"price" integer NOT NULL,
	"qty" integer NOT NULL,
	"seller_id" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text NOT NULL,
	"recipient_name" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"province" text DEFAULT '' NOT NULL,
	"postal_code" text DEFAULT '' NOT NULL,
	"landmark" text DEFAULT '' NOT NULL,
	"delivery_instructions" text DEFAULT '' NOT NULL,
	"delivery_slot" text DEFAULT '' NOT NULL,
	"pickup_point" text DEFAULT '' NOT NULL,
	"shipping_method" text DEFAULT 'Standard' NOT NULL,
	"shipping_fee" integer DEFAULT 0 NOT NULL,
	"subtotal" integer NOT NULL,
	"discount" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"payment_method" text NOT NULL,
	"payment_status" text DEFAULT 'Pending (COD)' NOT NULL,
	"payment_account" text DEFAULT '' NOT NULL,
	"payment_ref" text DEFAULT '' NOT NULL,
	"courier" text DEFAULT 'NEXORA Express (Demo)' NOT NULL,
	"tracking_number" text DEFAULT '' NOT NULL,
	"cancel_reason" text DEFAULT '' NOT NULL,
	"idempotency_key" text DEFAULT '' NOT NULL,
	"legacy_test" boolean DEFAULT false NOT NULL,
	"legacy_note" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"order_number" text NOT NULL,
	"method" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"account" text DEFAULT '' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"amount" integer NOT NULL,
	"status" text NOT NULL,
	"mode" text DEFAULT 'Demo Simulation — no gateway connected' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"seller_id" integer DEFAULT 0 NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"storage_key" text NOT NULL,
	"blob_url" text DEFAULT '' NOT NULL,
	"file_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"short_desc" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"subcategory" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"price" integer NOT NULL,
	"sale_price" integer,
	"price_history" text DEFAULT '' NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"rating" real DEFAULT 0 NOT NULL,
	"reviews_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'Published' NOT NULL,
	"seller_id" integer DEFAULT 0 NOT NULL,
	"seller_name" text DEFAULT 'NEXORA MARKET — Official Store' NOT NULL,
	"is_flash" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"colors" text DEFAULT '' NOT NULL,
	"sizes" text DEFAULT '' NOT NULL,
	"specs" text DEFAULT '' NOT NULL,
	"warranty" text DEFAULT '' NOT NULL,
	"warehouse" text DEFAULT 'Karachi Central' NOT NULL,
	"tile" text DEFAULT '' NOT NULL,
	"tile_color" text DEFAULT '' NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"customer_name" text NOT NULL,
	"question" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" serial PRIMARY KEY NOT NULL,
	"return_number" text NOT NULL,
	"order_number" text NOT NULL,
	"product_name" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"refund_amount" integer NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Requested' NOT NULL,
	"refund_stage" integer DEFAULT 0 NOT NULL,
	"legacy_flag" boolean DEFAULT false NOT NULL,
	"legacy_note" text DEFAULT '' NOT NULL,
	"customer_name" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "returns_return_number_unique" UNIQUE("return_number")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"customer_name" text NOT NULL,
	"rating" integer NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"helpful" integer DEFAULT 0 NOT NULL,
	"seller_reply" text DEFAULT '' NOT NULL,
	"created_at" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_email" text NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"order_number" text NOT NULL,
	"tracking_number" text NOT NULL,
	"provider" text DEFAULT 'NEXORA Express (Demo)' NOT NULL,
	"charge" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'Created (Simulated) — no courier API connected' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"department" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_number" text NOT NULL,
	"customer_name" text NOT NULL,
	"subject" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'Low' NOT NULL,
	"status" text DEFAULT 'Open' NOT NULL,
	"agent" text DEFAULT 'Unassigned' NOT NULL,
	"order_number" text DEFAULT '' NOT NULL,
	"last_reply" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "tickets_ticket_number_unique" UNIQUE("ticket_number")
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_email" text NOT NULL,
	"product_id" integer NOT NULL
);
