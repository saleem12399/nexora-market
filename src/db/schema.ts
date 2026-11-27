// Drizzle schema — 30 tables + __drizzle_migrations (managed by Drizzle).
// Ported 1:1 from the Muse copy's migrations 0001-0011 (SQLite -> Postgres).
// Epoch-ms timestamps are bigint ms; money is integer PKR.
// NO declared foreign keys (relationships are enforced in application code,
// exactly as in the Muse copy). sellerId = 0 is the Official Store sentinel.

import { bigint, boolean, integer, pgTable, real, serial, text } from "drizzle-orm/pg-core";

const ms = () => bigint("created_at", { mode: "number" });

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  parent: text("parent").notNull().default(""),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  icon: text("icon").notNull().default(""),
  productCount: integer("product_count").notNull().default(0),
});

export const staff = pgTable("staff", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  department: text("department").notNull().default(""),
  status: text("status").notNull().default("Active"),
  // Phase 2 — real staff auth. passwordHash NULL = account not activated
  // yet (no usable password until the owner activates it via a one-time
  // setup token, or the staff member completes staff setup). TOTP is
  // mandatory for the Owner and for every activated staff account.
  passwordHash: text("password_hash"),
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  mustResetPassword: boolean("must_reset_password").notNull().default(true),
  setupTokenHash: text("setup_token_hash"),
  setupExpiresAt: bigint("setup_expires_at", { mode: "number" }),
});

// Phase 2 — staff sessions (server-issued, stored only as SHA-256 hash).
// Issued as an HttpOnly cookie (nx_staff_token) on staff sign-in; the
// Bearer form of the same token is accepted for API/curl use.
export const staffSessions = pgTable("staff_sessions", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  // Last password+TOTP re-authentication (for destructive actions:
  // legacy-return correction, invalid-return cleanup, cancelled-order
  // purge). NULL = never re-authenticated in this session.
  reauthAt: bigint("reauth_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const sellers = pgTable("sellers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().default(""),
  status: text("status").notNull().default(""),
});
// Legacy table, kept for schema parity. MUST stay 0 rows (single-company model).

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  shortDesc: text("short_desc").notNull().default(""),
  description: text("description").notNull().default(""),
  category: text("category").notNull(),
  subcategory: text("subcategory").notNull().default(""),
  brand: text("brand").notNull().default(""),
  price: integer("price").notNull(),
  salePrice: integer("sale_price"),
  priceHistory: text("price_history").notNull().default(""),
  stock: integer("stock").notNull().default(0),
  sold: integer("sold").notNull().default(0),
  rating: real("rating").notNull().default(0),
  reviewsCount: integer("reviews_count").notNull().default(0),
  status: text("status").notNull().default("Published"),
  sellerId: integer("seller_id").notNull().default(0),
  sellerName: text("seller_name").notNull().default("NEXORA MARKET — Official Store"),
  isFlash: boolean("is_flash").notNull().default(false),
  isFeatured: boolean("is_featured").notNull().default(false),
  // Phase 2 (B7): real arrival date. Backfilled from seed order (staggered
  // by id, so the highest id is newest initially); new products get the
  // creation time. New Arrivals + /shop?sort=newest sort by this, not id.
  publishedAt: bigint("published_at", { mode: "number" }),
  colors: text("colors").notNull().default(""),
  sizes: text("sizes").notNull().default(""),
  specs: text("specs").notNull().default(""),
  warranty: text("warranty").notNull().default(""),
  warehouse: text("warehouse").notNull().default("Karachi Central"),
  tile: text("tile").notNull().default(""),
  tileColor: text("tile_color").notNull().default(""),
});

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNumber: text("order_number").notNull().unique(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone").notNull(),
  recipientName: text("recipient_name").notNull().default(""),
  address: text("address").notNull().default(""),
  area: text("area").notNull().default(""),
  city: text("city").notNull().default(""),
  province: text("province").notNull().default(""),
  postalCode: text("postal_code").notNull().default(""),
  landmark: text("landmark").notNull().default(""),
  deliveryInstructions: text("delivery_instructions").notNull().default(""),
  deliverySlot: text("delivery_slot").notNull().default(""),
  pickupPoint: text("pickup_point").notNull().default(""),
  shippingMethod: text("shipping_method").notNull().default("Standard"),
  shippingFee: integer("shipping_fee").notNull().default(0),
  subtotal: integer("subtotal").notNull(),
  discount: integer("discount").notNull().default(0),
  total: integer("total").notNull(),
  status: text("status").notNull().default("Pending"),
  paymentMethod: text("payment_method").notNull(),
  paymentStatus: text("payment_status").notNull().default("Pending (COD)"),
  paymentAccount: text("payment_account").notNull().default(""),
  paymentRef: text("payment_ref").notNull().default(""),
  courier: text("courier").notNull().default("NEXORA Express (Demo)"),
  trackingNumber: text("tracking_number").notNull().default(""),
  cancelReason: text("cancel_reason").notNull().default(""),
  idempotencyKey: text("idempotency_key").notNull().default(""),
  legacyTest: boolean("legacy_test").notNull().default(false),
  legacyNote: text("legacy_note").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  productId: integer("product_id"), // null for legacy products no longer in the catalogue
  productName: text("product_name").notNull(),
  price: integer("price").notNull(),
  qty: integer("qty").notNull(),
  sellerId: integer("seller_id").notNull().default(0),
});

export const orderEvents = pgTable("order_events", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  status: text("status").notNull(),
  note: text("note").notNull().default(""),
  location: text("location").notNull().default(""),
  actor: text("actor").notNull().default("System"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const cartItems = pgTable("cart_items", {
  id: serial("id").primaryKey(),
  customerEmail: text("customer_email").notNull(),
  productId: integer("product_id").notNull(),
  qty: integer("qty").notNull(),
});

export const wishlistItems = pgTable("wishlist_items", {
  id: serial("id").primaryKey(),
  customerEmail: text("customer_email").notNull(),
  productId: integer("product_id").notNull(),
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  ticketNumber: text("ticket_number").notNull().unique(),
  customerName: text("customer_name").notNull(),
  subject: text("subject").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default(""),
  priority: text("priority").notNull().default("Low"),
  status: text("status").notNull().default("Open"),
  agent: text("agent").notNull().default("Unassigned"),
  orderNumber: text("order_number").notNull().default(""),
  lastReply: text("last_reply").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const returns = pgTable("returns", {
  id: serial("id").primaryKey(),
  returnNumber: text("return_number").notNull().unique(),
  orderNumber: text("order_number").notNull(),
  productName: text("product_name").notNull(),
  qty: integer("qty").notNull().default(1),
  refundAmount: integer("refund_amount").notNull(),
  reason: text("reason").notNull().default(""),
  status: text("status").notNull().default("Requested"),
  refundStage: integer("refund_stage").notNull().default(0),
  legacyFlag: boolean("legacy_flag").notNull().default(false),
  legacyNote: text("legacy_note").notNull().default(""),
  customerName: text("customer_name").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  productName: text("product_name").notNull().default(""),
  customerName: text("customer_name").notNull(),
  rating: integer("rating").notNull(),
  text: text("text").notNull().default(""),
  verified: boolean("verified").notNull().default(false),
  helpful: integer("helpful").notNull().default(0),
  sellerReply: text("seller_reply").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull().default(0),
});

export const questions = pgTable("questions", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  productName: text("product_name").notNull().default(""),
  customerName: text("customer_name").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull().default(""),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  type: text("type").notNull().default(""),
  isRead: boolean("is_read").notNull().default(false),
  // Phase 2 (B19): owning customer, NULL = system-wide admin notice
  // (visible only in the staff global view, never to customers).
  customerId: integer("customer_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  discountType: text("discount_type").notNull(),
  value: integer("value").notNull(),
  minOrder: integer("min_order").notNull().default(0),
  status: text("status").notNull().default("Active"),
  expiresAt: text("expires_at").notNull().default(""),
  usageLimit: integer("usage_limit").notNull().default(0),
  perCustomerLimit: integer("per_customer_limit").notNull().default(0),
  scopeType: text("scope_type").notNull().default("all"),
  scopeValue: text("scope_value").notNull().default(""),
  uses: integer("uses").notNull().default(0),
});

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull().default(""),
  passwordHash: text("password_hash"), // NULL = no usable password; owner sets one via the reset flow (see README)
  mustResetPassword: boolean("must_reset_password").notNull().default(false),
  emailVerified: boolean("email_verified").notNull().default(false),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  deletionRequested: boolean("deletion_requested").notNull().default(false),
  resetTokenHash: text("reset_token_hash"),
  resetExpiresAt: bigint("reset_expires_at", { mode: "number" }),
  // Phase 2 (B14): notification preferences as a JSON string, e.g.
  // {"orderUpdates":true,"supportReplies":true,"offers":false}. Empty =
  // all on (the default).
  notifPrefs: text("notif_prefs").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const productImages = pgTable("product_images", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  storageKey: text("storage_key").notNull(),
  blobUrl: text("blob_url").notNull().default(""),
  fileName: text("file_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isSample: boolean("is_sample").notNull().default(false),
});

export const customerSessions = pgTable("customer_sessions", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const customerAddresses = pgTable("customer_addresses", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  label: text("label").notNull().default("Home"),
  recipient: text("recipient").notNull().default(""),
  phone: text("phone").notNull().default(""),
  address: text("address").notNull().default(""),
  area: text("area").notNull().default(""),
  city: text("city").notNull().default(""),
  province: text("province").notNull().default(""),
  postalCode: text("postal_code").notNull().default(""),
  landmark: text("landmark").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  deliverySlot: text("delivery_slot").notNull().default(""),
  pickupPoint: text("pickup_point").notNull().default(""),
  isDefault: boolean("is_default").notNull().default(false),
});

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull(),
  sku: text("sku").notNull().default(""),
  type: text("type").notNull(),
  qty: integer("qty").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  reference: text("reference").notNull().default(""),
  actor: text("actor").notNull().default("System"),
  note: text("note").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const paymentTransactions = pgTable("payment_transactions", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  orderNumber: text("order_number").notNull(),
  method: text("method").notNull(),
  provider: text("provider").notNull().default(""),
  account: text("account").notNull().default(""),
  reference: text("reference").notNull().default(""),
  amount: integer("amount").notNull(),
  status: text("status").notNull(),
  mode: text("mode").notNull().default("Demo Simulation — no gateway connected"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const shipments = pgTable("shipments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  orderNumber: text("order_number").notNull(),
  trackingNumber: text("tracking_number").notNull(),
  provider: text("provider").notNull().default("NEXORA Express (Demo)"),
  charge: integer("charge").notNull().default(0),
  status: text("status").notNull().default("Created (Simulated) — no courier API connected"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const payouts = pgTable("payouts", {
  id: serial("id").primaryKey(),
  sellerId: integer("seller_id").notNull().default(0),
  amount: integer("amount").notNull().default(0),
  status: text("status").notNull().default(""),
});
// Legacy table, kept for schema parity. MUST stay 0 rows (single-company model).

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  actor: text("actor").notNull().default("System"),
  detail: text("detail").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const demoMerchants = pgTable("demo_merchants", {
  id: serial("id").primaryKey(),
  storeName: text("store_name").notNull(),
  ownerName: text("owner_name").notNull().default(""),
  categoryFocus: text("category_focus").notNull().default(""),
  city: text("city").notNull().default(""),
  rating: real("rating").notNull().default(0),
  reviewsCount: integer("reviews_count").notNull().default(0),
  joined: text("joined").notNull().default(""),
  verification: text("verification").notNull().default("Unverified"),
});

export const heroBanners = pgTable("hero_banners", {
  id: serial("id").primaryKey(),
  headline: text("headline").notNull(),
  subtext: text("subtext").notNull().default(""),
  ctaLabel: text("cta_label").notNull().default(""),
  ctaTarget: text("cta_target").notNull().default(""),
  cta2Label: text("cta2_label").notNull().default(""),
  cta2Target: text("cta2_target").notNull().default(""),
  productId: integer("product_id"),
  imageKey: text("image_key").notNull().default(""),
  startsAt: text("starts_at").notNull().default(""),
  endsAt: text("ends_at").notNull().default(""),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const homeCollections = pgTable("home_collections", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tagline: text("tagline").notNull().default(""),
  category: text("category").notNull().default(""),
  subcategory: text("subcategory").notNull().default(""),
  productId: integer("product_id"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const homeSections = pgTable("home_sections", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  visible: boolean("visible").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

/**
 * saved_searches — table exists in the 30-table schema; no fields, rows or
 * behaviour appear in any source (REBUILD-SPEC.md §14.10). Minimal
 * per-customer saved-search store; the feature is unlisted in the UI until
 * the Muse copy's behaviour is verified during acceptance.
 */
export const savedSearches = pgTable("saved_searches", {
  id: serial("id").primaryKey(),
  customerEmail: text("customer_email").notNull(),
  query: text("query").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

void ms;
