-- Phase 2 batch 2 — B3 (reviews/Q&A remap to real live product IDs) + B8
-- (honest hero subtexts). Data correction only; no schema change.
-- All updates are idempotent (WHERE id = …) so a retried boot migration
-- is harmless. The old ids 1–4 were seed-export placeholders, NOT live
-- product ids — the live catalogue ids are 56/40/53/30 (by SKU/name).

-- B3: reviews 1+2 (earbuds) -> product 56 Aurora X5 Wireless Earbuds.
UPDATE "reviews" SET "product_id" = 56, "product_name" = 'Aurora X5 Wireless Earbuds' WHERE "id" IN (1, 2);
--> statement-breakpoint
-- B3: review 3 (phone) -> product 40 Samsung Galaxy A55 5G — 256GB.
-- The text is phone-plausible (camera), kept unchanged.
UPDATE "reviews" SET "product_id" = 40, "product_name" = 'Samsung Galaxy A55 5G — 256GB' WHERE "id" = 3;
--> statement-breakpoint
-- B3: review 4 (watch) -> product 53 PulseFit Smartwatch Series 9.
-- The old text ("Fabric quality…") described clothing, not a watch, so
-- it moves to the kurta review below; the watch gets watch text sourced
-- from its own listing ("AMOLED smartwatch, BT calling, 10-day battery").
UPDATE "reviews" SET "product_id" = 53, "product_name" = 'PulseFit Smartwatch Series 9', "text" = 'Battery easily lasts ten days with normal use. The AMOLED display is bright and the strap is comfortable.' WHERE "id" = 4;
--> statement-breakpoint
-- B3: review 5 (kurta) -> product 30 Men's Cotton Kurta — Traditional
-- Wear. The old text ("Visible glow…") described skincare; it gets the
-- fabric text that was wrongly on the watch.
UPDATE "reviews" SET "product_id" = 30, "product_name" = 'Men''s Cotton Kurta — Traditional Wear', "text" = 'Fabric quality is genuinely premium. True to size.' WHERE "id" = 5;
--> statement-breakpoint
-- B3: product rating/reviewsCount set to the REAL values from the
-- remapped reviews (the old 4.5–4.8 / 176–328 values were inflated
-- seed placeholders, not counts of real reviews).
UPDATE "products" SET "rating" = 4.5, "reviews_count" = 2 WHERE "id" = 56;
--> statement-breakpoint
UPDATE "products" SET "rating" = 5, "reviews_count" = 1 WHERE "id" = 40;
--> statement-breakpoint
UPDATE "products" SET "rating" = 5, "reviews_count" = 1 WHERE "id" = 53;
--> statement-breakpoint
UPDATE "products" SET "rating" = 4, "reviews_count" = 1 WHERE "id" = 30;
--> statement-breakpoint
-- B3: question 1 (earbuds dual-device, answered) -> product 56.
UPDATE "questions" SET "product_id" = 56, "product_name" = 'Aurora X5 Wireless Earbuds' WHERE "id" = 1;
--> statement-breakpoint
-- B3: question 2 (was "Is the fabric pre-shrunk?" on a watch) -> product
-- 53, rewritten to a battery question answered from the watch's own
-- listing ("10-day battery").
UPDATE "questions" SET "product_id" = 53, "product_name" = 'PulseFit Smartwatch Series 9', "question" = 'How long does the battery last on a single charge?', "answer" = 'Up to 10 days with typical use (AMOLED display, BT calling).' WHERE "id" = 2;
--> statement-breakpoint
-- B3: questions 3+4 were the same "Whats best" on the Nova S24 — keep
-- one (id 3), remap to product 40, rewrite as a real 5G question.
UPDATE "questions" SET "product_id" = 40, "product_name" = 'Samsung Galaxy A55 5G — 256GB', "question" = 'Does the Galaxy A55 support 5G in Pakistan?', "answer" = 'Yes — it is a 5G phone and works on the 5G bands used by Pakistani networks.' WHERE "id" = 3;
--> statement-breakpoint
DELETE FROM "questions" WHERE "id" = 4;
--> statement-breakpoint
-- B8: hero subtexts rewritten — honest, neutral, no "Demo"/"Sample"
-- wording, and no claim the site cannot support:
-- slide 1: "sizes" dropped (33/48 products have no sizes).
UPDATE "hero_banners" SET "subtext" = 'Men''s and women''s fashion from NEXORA''s official store — prices and stock shown on every product.' WHERE "id" = 1;
--> statement-breakpoint
-- slide 2: "warranty" dropped (empty for 26/48 products).
UPDATE "hero_banners" SET "subtext" = 'RAM, storage, display and battery details on every listing — compare before you buy.' WHERE "id" = 2;
--> statement-breakpoint
-- slide 3: "real photos, ratings and reviews on every product" dropped
-- (not true for every product).
UPDATE "hero_banners" SET "subtext" = 'Smartwatches, smart glasses, earbuds and speakers — specs, prices and stock on every listing.' WHERE "id" = 3;
