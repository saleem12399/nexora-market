// Seed — reads seed/*.json (copied from ~/workspace/nexora-rebuild/data/),
// inserts in dependency order, preserves original integer ids and all live
// values exactly. Idempotent: skips when products already exist, unless
// --force (owner-gated wipe; never the default).
//
// Customer passwords: the export contains NO hash values (PBKDF2 format
// only). Customers are seeded with passwordHash NULL and
// mustResetPassword=true; the owner sets passwords (owner-assisted reset;
// self-service reset by email is unavailable — no email provider is
// connected). NEVER invent or default a password.
//
// Owner's order NX-DEMO-98524600 (id 12, Rs 23,463, COD Pending) is seeded
// unchanged — no step writes to existing orders.
//
// Usage:
//   npm run db:seed            seed (idempotent skip if already seeded)
//   npm run db:seed -- --force reseed from scratch (owner-gated)
//   npm run db:validate        validate the JSON files only (no DB needed)

import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "./index";
import * as s from "./schema";

export const SEED_DIR = path.resolve(__dirname, "../../seed");

function read<T = any>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), "utf8"));
}

export function toMs(v: string | number | undefined | null): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

function normName(x: string): string {
  return (x || "")
    .toLowerCase()
    .replace(/\(demo\)/g, "")
    .replace(/smart watch/g, "smartwatch")
    .replace(/'/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Resolve an order-item product name to a catalogue product id (or null for legacy products). */
export function resolveProductId(itemName: string, products: { id: number; name: string }[]): number | null {
  const n = normName(itemName);
  let best: { id: number; score: number } | null = null;
  for (const p of products) {
    const pn = normName(p.name.split("—")[0]);
    const full = normName(p.name);
    let score = 0;
    if (pn === n || full === n) score = 100;
    else if (pn.startsWith(n) || n.startsWith(pn)) score = 90;
    else {
      const a = new Set(n.match(/.{1,3}/g) || []);
      const b = new Set(pn.match(/.{1,3}/g) || []);
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      score = (inter / Math.max(1, a.size)) * 80;
    }
    if (score > 60 && (!best || score > best.score)) best = { id: p.id, score };
  }
  return best ? best.id : null;
}

export interface SeedCounts {
  settings: number; categories: number; staff: number; customers: number;
  coupons: number; products: number; productImages: number; orders: number;
  orderItems: number; orderEvents: number; returns: number; reviews: number;
  questions: number; tickets: number; notifications: number; demoMerchants: number;
  shipments: number; paymentTransactions: number; inventoryMovements: number;
  addresses: number; heroBanners: number; homeCollections: number;
  homeSections: number; auditLogs: number; sellers: number; payouts: number;
}

export function loadSeedData() {
  const products = read<any>("products.json").products;
  const productImages = read<any>("product_images.json").images;
  const categories = read<any>("categories.json").categories;
  const orders = read<any>("orders.json").orders;
  const timelines = read<any>("order_tracking.json").timelines;
  const customers = read<any>("customers.json").customers;
  const coupons = read<any>("coupons.json").coupons;
  const staff = read<any>("staff.json").staff;
  const reviews = read<any>("reviews.json").reviews;
  const returns = read<any>("returns.json").returns;
  const shipments = read<any>("shipments.json").shipments;
  const paymentTxns = read<any>("payment_transactions.json").transactions;
  const movements = read<any>("inventory_movements.json").movements;
  const tickets = read<any>("tickets.json").tickets;
  const questions = read<any>("questions.json").questions;
  const notifications = read<any>("notifications.json").notifications;
  const auditLogs = read<any>("audit_log.json").logs;
  const merchants = read<any>("demo_merchants.json").merchants;
  const addresses = read<any>("addresses.json").addresses;
  const settingsRaw = read<any>("settings.json");
  const homepage = read<any>("homepage.json");
  const homepageAdmin = read<any>("homepage_admin.json");
  const phase2 = read<any>("phase2_status.json");
  const bigTest = read<any>("big_test_report.json");

  // Order items: export carries no item ids and no productId — assign ids
  // deterministically (orders by id asc, items in listed order) and resolve
  // productId by name; legacy products (not in the catalogue) get null.
  const orderItems: any[] = [];
  let itemId = 1;
  for (const o of [...orders].sort((a: any, b: any) => a.id - b.id)) {
    for (const it of o.items || []) {
      orderItems.push({
        id: itemId++, orderId: o.id,
        productId: resolveProductId(it.productName, products),
        productName: it.productName, price: it.price, qty: it.qty,
        sellerId: it.sellerId ?? 0,
      });
    }
  }
  // Order events: export carries no event ids — assign deterministically.
  const orderEvents: any[] = [];
  let evId = 1;
  for (const t of [...timelines].sort((a: any, b: any) => a.orderId - b.orderId)) {
    for (const e of t.events || []) {
      orderEvents.push({
        id: evId++, orderId: t.orderId, status: e.status,
        note: e.note || "", location: e.location || "",
        actor: "System", createdAt: toMs(e.createdAt),
      });
    }
  }
  // Settings: flatten to key/value strings; skip export metadata keys.
  const settings: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(settingsRaw)) {
    if (k === "exportedAt" || k === "source") continue;
    settings.push({ key: k, value: typeof v === "string" ? v : JSON.stringify(v) });
  }
  settings.push({ key: "bigTestReport", value: JSON.stringify(bigTest.report ?? bigTest) });
  for (const p of phase2.providers || []) {
    settings.push({ key: `provider_${p.key}_status`, value: p.status });
  }
  // Addresses are keyed by customer email in the export.
  const addressRows: any[] = [];
  const emailToCustomer = new Map(customers.map((c: any) => [c.email.toLowerCase(), c.id]));
  for (const [email, list] of Object.entries(addresses)) {
    for (const a of list as any[]) {
      addressRows.push({ ...a, customerId: emailToCustomer.get((email as string).toLowerCase()) ?? null });
    }
  }
  const counts: SeedCounts = {
    settings: settings.length, categories: categories.length, staff: staff.length,
    customers: customers.length, coupons: coupons.length, products: products.length,
    productImages: productImages.length, orders: orders.length,
    orderItems: orderItems.length, orderEvents: orderEvents.length,
    returns: returns.length, reviews: reviews.length, questions: questions.length,
    tickets: tickets.length, notifications: notifications.length,
    demoMerchants: merchants.length, shipments: shipments.length,
    paymentTransactions: paymentTxns.length, inventoryMovements: movements.length,
    addresses: addressRows.length, heroBanners: homepageAdmin.banners.length,
    homeCollections: homepageAdmin.collections.length,
    homeSections: homepage.sections.length, auditLogs: auditLogs.length,
    sellers: 0, payouts: 0,
  };
  return {
    products, productImages, categories, orders, timelines, customers, coupons,
    staff, reviews, returns, shipments, paymentTxns, movements, tickets,
    questions, notifications, auditLogs, merchants, addressRows, settings,
    homepage, homepageAdmin, phase2, bigTest, orderItems, orderEvents, counts,
  };
}

export function validateSeed(): { ok: boolean; counts: SeedCounts; problems: string[] } {
  const d = loadSeedData();
  const problems: string[] = [];
  const c = d.counts;
  const expect: Partial<SeedCounts> = {
    products: 48, categories: 114, orders: 14, orderItems: 19, orderEvents: 52,
    returns: 4, reviews: 5, questions: 3, tickets: 3, notifications: 46,
    auditLogs: 48, demoMerchants: 10, shipments: 1, paymentTransactions: 5,
    inventoryMovements: 6, addresses: 1, heroBanners: 3, homeCollections: 5,
    homeSections: 9, customers: 3, coupons: 5, staff: 9, productImages: 48,
    sellers: 0, payouts: 0,
  };
  for (const [k, v] of Object.entries(expect)) {
    if ((c as any)[k] !== v) problems.push(`count ${k}: expected ${v}, got ${(c as any)[k]}`);
  }
  const owner = d.orders.find((o: any) => o.orderNumber === "NX-DEMO-98524600");
  if (!owner) problems.push("owner order NX-DEMO-98524600 missing");
  else {
    if (owner.total !== 23463) problems.push(`owner order total ${owner.total} != 23463`);
    if (owner.paymentStatus !== "Pending (COD)") problems.push(`owner order paymentStatus ${owner.paymentStatus}`);
    if (owner.status !== "Pending") problems.push(`owner order status ${owner.status}`);
    if (owner.subtotal - owner.discount + owner.shippingFee !== owner.total) problems.push("owner order money does not reconcile");
  }
  const journey = d.orders.find((o: any) => o.orderNumber === "NX-DEMO-97530481");
  if (!journey || journey.total !== 4761) problems.push("journey order NX-DEMO-97530481 total != 4761");
  const flashPool = d.products.filter((p: any) => p.isFlash && p.salePrice != null && p.salePrice < p.price);
  if (flashPool.length !== 11) problems.push(`flash pool ${flashPool.length} != 11`);
  if (d.products.some((p: any) => p.sellerId !== 0)) problems.push("product with sellerId != 0");
  if (d.customers.some((cu: any) => cu.passwordHash)) problems.push("export contains a password hash value (must not be seeded)");
  const unresolved = d.orderItems.filter((i: any) => i.productId == null);
  // Legacy items are expected to be unresolved (7 of 19: "Men's Premium
  // Cotton Kurta" is a legacy name — the catalogue kurta is "Men's Cotton
  // Kurta"; plus Nova S24, Ceramic Dinner Set, Basmati Rice, RunnerFlex
  // Shoes, Tower Fan, Keyboard — products no longer in the catalogue).
  // Their names/prices are preserved verbatim as snapshots with productId null.
  if (unresolved.length !== 7) problems.push(`unresolved order items ${unresolved.length} != 7 (legacy)`);
  return { ok: problems.length === 0, counts: c, problems };
}

async function setSequences(db: any, tables: string[]) {
  for (const t of tables) {
    await db.execute(sql.raw(
      `SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), true)`,
    ));
  }
}

// Seed the database from seed/*.json. Reusable as runSeed() for the optional
// Vercel boot migration (src/db/boot-migrate.ts) — that path never calls
// process.exit, so the library function throws instead of exiting and
// returns early (instead of exiting) when the data is already seeded.
export async function runSeed(force = false): Promise<void> {
  const db = getDb();
  if (!db) {
    throw new Error("DATABASE_URL is not set — cannot seed. Run with a live Postgres (see RENDER-DEPLOY.md).");
  }
  const d = loadSeedData();
  const existing = await db.select({ id: s.products.id }).from(s.products).limit(1);
  if (existing.length > 0 && !force) {
    console.log("Products already seeded — skipping (idempotent). Use --force to reseed (owner-gated).");
    return;
  }
  if (force) {
    console.log("FORCE reseed: wiping seeded tables…");
    for (const t of ["saved_searches","audit_logs","inventory_movements","payment_transactions","shipments","customer_sessions","customer_addresses","product_images","notifications","questions","reviews","returns","tickets","wishlist_items","cart_items","order_events","order_items","orders","coupons","customers","products","staff","categories","demo_merchants","hero_banners","home_collections","home_sections","settings"]) {
      await db.execute(sql.raw(`DELETE FROM ${t}`));
    }
  }
  const ins = async (table: any, rows: any[]) => {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(table).values(rows.slice(i, i + 200)).onConflictDoNothing();
    }
  };
  // Dependency order (spec §6).
  await ins(s.settings, d.settings);
  await ins(s.categories, d.categories.map((c: any) => ({
    id: c.id, name: c.name, parent: c.parent ?? "", active: !!c.active,
    sortOrder: c.sortOrder ?? 0, icon: c.icon ?? "", productCount: c.productCount ?? 0,
  })));
  await ins(s.staff, d.staff);
  await ins(s.customers, d.customers.map((c: any) => ({
    id: c.id, name: c.name, email: c.email, phone: c.phone || "",
    passwordHash: null, mustResetPassword: true,
    emailVerified: !!c.emailVerified, phoneVerified: !!c.phoneVerified,
    deletionRequested: !!c.deletionRequested, createdAt: toMs(c.createdAt),
  })));
  await ins(s.coupons, d.coupons.map((c: any) => ({
    id: c.id, code: c.code, discountType: c.discountType, value: c.value,
    minOrder: c.minOrder ?? 0, status: c.status, expiresAt: c.expiresAt ?? "",
    usageLimit: c.usageLimit ?? 0, perCustomerLimit: c.perCustomerLimit ?? 0,
    scopeType: c.scopeType ?? "all", scopeValue: c.scopeValue ?? "", uses: c.uses ?? 0,
  })));
  await ins(s.products, d.products.map((p: any) => ({
    id: p.id, sku: p.sku, name: p.name, shortDesc: p.shortDesc ?? "",
    description: p.description ?? "", category: p.category, subcategory: p.subcategory ?? "",
    brand: p.brand ?? "", price: p.price, salePrice: p.salePrice ?? null,
    priceHistory: p.priceHistory ?? "", stock: p.stock, sold: p.sold ?? 0,
    rating: p.rating ?? 0, reviewsCount: p.reviewsCount ?? 0, status: p.status,
    sellerId: 0, sellerName: "NEXORA MARKET — Official Store",
    isFlash: !!p.isFlash, isFeatured: !!p.isFeatured, colors: p.colors ?? "",
    sizes: p.sizes ?? "", specs: p.specs ?? "", warranty: p.warranty ?? "",
    warehouse: p.warehouse ?? "Karachi Central", tile: p.tile ?? "", tileColor: p.tileColor ?? "",
  })));
  await ins(s.productImages, d.productImages.map((i: any) => ({
    id: i.id, productId: i.productId, storageKey: i.storageKey,
    blobUrl: i.blobUrl ?? "", fileName: i.fileName, sortOrder: i.sortOrder ?? 0,
    isSample: !!i.isSample,
  })));
  await ins(s.orders, d.orders.map((o: any) => ({
    id: o.id, orderNumber: o.orderNumber, customerName: o.customerName,
    customerEmail: o.customerEmail, customerPhone: o.customerPhone,
    recipientName: o.recipientName ?? "", address: o.address ?? "", area: o.area ?? "",
    city: o.city ?? "", province: o.province ?? "", postalCode: o.postalCode ?? "",
    landmark: o.landmark ?? "", deliveryInstructions: o.deliveryInstructions ?? "",
    deliverySlot: o.deliverySlot ?? "", pickupPoint: o.pickupPoint ?? "",
    shippingMethod: o.shippingMethod ?? "Standard", shippingFee: o.shippingFee ?? 0,
    subtotal: o.subtotal, discount: o.discount ?? 0, total: o.total,
    status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus,
    paymentAccount: o.paymentAccount ?? "", paymentRef: o.paymentRef ?? "",
    courier: o.courier ?? "NEXORA Express (Demo)", trackingNumber: o.trackingNumber ?? "",
    cancelReason: o.cancelReason ?? "", idempotencyKey: o.idempotencyKey ?? o.idempotency_key ?? "",
    legacyTest: !!o.legacyTest, legacyNote: o.legacyNote ?? "", createdAt: toMs(o.createdAt),
  })));
  await ins(s.orderItems, d.orderItems);
  await ins(s.orderEvents, d.orderEvents);
  await ins(s.returns, d.returns.map((r: any) => ({
    id: r.id, returnNumber: r.returnNumber, orderNumber: r.orderNumber,
    productName: r.productName, qty: r.qty ?? 1, refundAmount: r.refundAmount,
    reason: r.reason ?? "", status: r.status, refundStage: r.refundStage ?? 0,
    legacyFlag: !!r.legacyFlag, legacyNote: r.legacyNote ?? "",
    customerName: r.customerName ?? "", createdAt: toMs(r.createdAt),
  })));
  await ins(s.reviews, d.reviews.map((r: any) => ({
    id: r.id, productId: r.productId, productName: r.productName ?? "",
    customerName: r.customerName, rating: r.rating, text: r.text ?? "",
    verified: !!r.verified, helpful: r.helpful ?? 0, sellerReply: r.sellerReply ?? "",
    createdAt: toMs(r.createdAt),
  })));
  await ins(s.questions, d.questions);
  await ins(s.tickets, d.tickets.map((t: any) => ({
    id: t.id, ticketNumber: t.ticketNumber, customerName: t.customerName,
    subject: t.subject, description: t.description ?? "", category: t.category ?? "",
    priority: t.priority ?? "Low", status: t.status, agent: t.agent ?? "Unassigned",
    orderNumber: t.orderNumber ?? "", lastReply: t.lastReply ?? "", createdAt: toMs(t.createdAt),
  })));
  await ins(s.notifications, d.notifications.map((n: any) => ({
    id: n.id, title: n.title, body: n.body ?? "", type: n.type ?? "",
    isRead: !!n.isRead, createdAt: toMs(n.createdAt),
  })));
  await ins(s.demoMerchants, d.merchants);
  await ins(s.shipments, d.shipments.map((sh: any) => ({
    id: sh.id, orderId: sh.orderId, orderNumber: sh.orderNumber,
    trackingNumber: sh.trackingNumber, provider: sh.provider,
    charge: sh.charge ?? 0, status: sh.status, createdAt: toMs(sh.createdAt),
  })));
  await ins(s.paymentTransactions, d.paymentTxns.map((t: any) => ({
    id: t.id, orderId: t.orderId, orderNumber: t.orderNumber, method: t.method,
    provider: t.provider ?? "", account: t.account ?? "", reference: t.reference ?? "",
    amount: t.amount, status: t.status, mode: t.mode ?? "Demo Simulation — no gateway connected",
    createdAt: toMs(t.createdAt),
  })));
  await ins(s.inventoryMovements, d.movements.map((m: any) => ({
    id: m.id, productId: m.productId, sku: m.sku ?? "", type: m.type, qty: m.qty,
    balanceAfter: m.balanceAfter, reference: m.reference ?? "", actor: m.actor ?? "System",
    note: m.note ?? "", createdAt: toMs(m.createdAt),
  })));
  await ins(s.customerAddresses, d.addressRows.map((a: any) => ({
    id: a.id, customerId: a.customerId, label: a.label ?? "Home",
    recipient: a.recipient ?? "", phone: a.phone ?? "", address: a.address ?? "",
    area: a.area ?? "", city: a.city ?? "", province: a.province ?? "",
    postalCode: a.postalCode ?? "", landmark: a.landmark ?? "",
    instructions: a.instructions ?? "", deliverySlot: a.deliverySlot ?? "",
    pickupPoint: a.pickupPoint ?? "", isDefault: !!a.isDefault,
  })));
  await ins(s.heroBanners, d.homepageAdmin.banners.map((b: any) => ({
    id: b.id, headline: b.headline, subtext: b.subtext ?? "",
    ctaLabel: b.ctaLabel ?? "", ctaTarget: typeof b.ctaTarget === "string" ? b.ctaTarget : JSON.stringify(b.ctaTarget ?? {}),
    cta2Label: b.cta2Label ?? "", cta2Target: typeof b.cta2Target === "string" ? b.cta2Target : JSON.stringify(b.cta2Target ?? {}),
    productId: b.productId ?? null, imageKey: b.imageKey ?? "",
    startsAt: b.startsAt ?? "", endsAt: b.endsAt ?? "", active: b.active !== false,
    sortOrder: b.sortOrder ?? 0,
  })));
  await ins(s.homeCollections, d.homepageAdmin.collections.map((c: any) => ({
    id: c.id, name: c.name, tagline: c.tagline ?? "", category: c.category ?? "",
    subcategory: c.subcategory ?? "", productId: c.productId ?? null,
    active: c.active !== false, sortOrder: c.sortOrder ?? 0,
  })));
  await ins(s.homeSections, d.homepage.sections.map((sec: any, i: number) => ({
    id: i + 1, key: sec.key, visible: sec.visible !== false, sortOrder: sec.sortOrder ?? i,
  })));
  await ins(s.auditLogs, d.auditLogs.map((a: any) => ({
    id: a.id, action: a.action, actor: a.actor ?? "System",
    detail: a.detail ?? "", createdAt: toMs(a.createdAt),
  })));
  // finalizeSingleCompany (unconditional, spec §5.1): 0 sellers, 0 payouts,
  // all products sellerId 0 — already true in the seed, enforced here too.
  await db.execute(sql.raw(`DELETE FROM sellers`));
  await db.execute(sql.raw(`DELETE FROM payouts`));
  await db.execute(sql.raw(`UPDATE products SET seller_id = 0, seller_name = 'NEXORA MARKET — Official Store'`));
  await setSequences(db, ["categories","staff","staff_sessions","products","orders","order_items","order_events","cart_items","wishlist_items","tickets","returns","reviews","questions","notifications","coupons","customers","product_images","customer_sessions","customer_addresses","inventory_movements","payment_transactions","shipments","audit_logs","demo_merchants","hero_banners","home_collections","home_sections","saved_searches"]);
  console.log("Seed complete:", JSON.stringify(d.counts));
  console.log("Customers seeded with NO usable password (passwordHash NULL, mustResetPassword=true). Owner sets passwords (owner-assisted; no email provider) — see README.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--validate")) {
    const v = validateSeed();
    console.log(JSON.stringify({ ok: v.ok, counts: v.counts, problems: v.problems }, null, 2));
    process.exit(v.ok ? 0 : 1);
  }
  const force = args.includes("--force");
  await runSeed(force);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
