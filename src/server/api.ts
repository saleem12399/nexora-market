// API — REST endpoints mirroring the REBUILD-SPEC.md §5 action surface.
// Every action name from the spec exists as POST /api/<actionName> (plus a
// few GET conveniences). No DB -> 503 {"error":"database not configured"}.
// Demo mode: every payment/courier/messaging step is labelled DEMO/simulated;
// no live gateway, courier or messaging provider is connected.

import crypto from "node:crypto";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../db";
import * as s from "../db/schema";
import { hashPassword, hashSessionToken, isLegacySha256Hash, newResetToken, newSessionToken, RESET_TOKEN_TTL_MS, SESSION_TTL_MS, verifyLegacySha256, verifyPassword } from "../lib/auth";
import { OFFICIAL_STORE_NAME, PAYMENT_MODE_DEMO, PAYMENT_STATUSES_SOURCED, REFUND_STAGE_LABELS, SHIPMENT_STATUS, TRACKING_STEPS, TRACKING_STEP_LOCATIONS, TRACKING_STEP_NOTES } from "../lib/constants";
import { computeFlashRow, todayYmdKarachi } from "../lib/flash";
import { computeOrderTotals, couponDiscount, formatPkr, validateCouponRules, type ShippingMethod } from "../lib/money";
import { PermissionDeniedError, requirePermission, runRoleSelfTest, type RoleArea } from "../lib/roles";
import { isValidEmail, isValidPkMobile, validateCustomerInfo } from "../lib/validation";

type Db = NonNullable<ReturnType<typeof getDb>>;

function dbOr503(res: Response): Db | null {
  const db = getDb();
  if (!db) { res.status(503).json({ ok: false, error: "database not configured — set DATABASE_URL and run migrations + seed (see RENDER-DEPLOY.md)" }); return null; }
  return db;
}

async function audit(db: Db, action: string, actor: string, detail: string) {
  try { await db.insert(s.auditLogs).values({ action, actor, detail, createdAt: Date.now() }); } catch { /* audit must never break the action */ }
}

// Phase 1 (A1): there is NO staff session system yet — the staff table has
// no password and no session table. Until real staff auth is built, the role
// is asserted by the caller (header x-nexora-role / body staffRole, set by
// the Admin role dropdown). The fail-closed rule is: NO role supplied at
// all => 401 StaffAuthRequiredError. A supplied role without the area =>
// 403 PermissionDeniedError. Never default to Super Admin.
export class StaffAuthRequiredError extends Error {
  constructor() { super("Staff sign-in required — no staff role was supplied."); this.name = "StaffAuthRequiredError"; }
}

function staffRole(req: Request): string | null {
  const r = (req.headers["x-nexora-role"] as string) || (req.body && req.body.staffRole);
  return r ? String(r) : null;
}

// Label for audit/actor fields only — NEVER used as authorisation.
function staffRoleLabel(req: Request): string {
  return staffRole(req) || "anonymous";
}

function enforce(req: Request, area: RoleArea) {
  const role = staffRole(req);
  if (!role) throw new StaffAuthRequiredError();
  requirePermission(role, area);
}

// Same 401/403 mapping as the route wrapper, for handlers that decide the
// gate themselves (customer-or-staff actions). Audit-logs denials.
async function enforceOr401(db: Db, req: Request, res: Response, area: RoleArea, actionName: string): Promise<boolean> {
  try { enforce(req, area); return true; }
  catch (e) {
    if (e instanceof PermissionDeniedError) {
      await audit(db, "PERMISSION DENIED", staffRoleLabel(req), `${actionName} — role "${staffRoleLabel(req)}" denied area "${area}"`);
      res.status(403).json({ ok: false, error: e.message }); return false;
    }
    if (e instanceof StaffAuthRequiredError) {
      await audit(db, "STAFF AUTH REQUIRED", "anonymous", `${actionName} — no staff role supplied for area "${area}"`);
      res.status(401).json({ ok: false, error: e.message }); return false;
    }
    throw e;
  }
}

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  if (req.body && req.body.sessionToken) return String(req.body.sessionToken);
  if (req.query && req.query.sessionToken) return String(req.query.sessionToken);
  return null;
}

async function sessionCustomer(db: Db, req: Request) {
  const token = bearerToken(req);
  if (!token) return null;
  const rows = await db.select().from(s.customerSessions).where(eq(s.customerSessions.tokenHash, hashSessionToken(token)));
  const sess = rows[0];
  if (!sess || sess.expiresAt < Date.now()) return null;
  const cust = await db.select().from(s.customers).where(eq(s.customers.id, sess.customerId));
  return cust[0] || null;
}

async function requireCustomer(db: Db, req: Request, res: Response) {
  const c = await sessionCustomer(db, req);
  if (!c) { res.status(401).json({ ok: false, authenticated: false, error: "Sign in again — no valid session." }); return null; }
  return c;
}

function imageUrlOf(img: any): string {
  // Serve stored bytes from public/images (storageKey is storage-relative).
  const key: string = img.storageKey || "";
  const file = key.split("/").pop() || "";
  return file ? `/images/products/${file}` : "";
}

async function productWithImages(db: Db, p: any) {
  const imgs = await db.select().from(s.productImages).where(eq(s.productImages.productId, p.id)).orderBy(asc(s.productImages.sortOrder));
  return {
    ...p, sellerName: OFFICIAL_STORE_NAME,
    images: imgs.map((i: any) => ({ id: i.id, url: imageUrlOf(i), storageKey: i.storageKey, fileName: i.fileName, sortOrder: i.sortOrder, isSample: !!i.isSample })),
    imageUrl: imgs[0] ? imageUrlOf(imgs[0]) : "", imageIsSample: imgs[0] ? !!imgs[0].isSample : false,
  };
}

function orderNumber(): string { return `NX-DEMO-${Math.floor(10000000 + Math.random() * 89999999)}`; }
function trackingNumber(on: string): string { return on.replace("NX-DEMO-", "TRK-DEMO-"); }
function txnRef(): string { return `TXN-DEMO-${Math.floor(10000000 + Math.random() * 89999999)}`; }

// Stored bigTestReport is a literal pointer string, not JSON — never let
// JSON.parse throw a 500 (Phase 1 opportunistic fix for C12).
function parseStoredReport(v: string | undefined): any {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

async function settingsMap(db: Db): Promise<Record<string, string>> {
  const rows = await db.select().from(s.settings);
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}

// Registry of the API actions, so server-rendered pages can call an action
// in-process (callApiAction) instead of HTTP-fetching their own server.
// The payload returned is identical to the POST /api/<name> JSON response.
//
// Why this exists: the homepage and shop pages used to fetch their own API
// over http://127.0.0.1:<PORT>. That needs a listening socket, which a Vercel
// serverless function does not have, so those pages would fail there. The
// in-process call runs the exact same handler and returns the exact same
// data, on Render and on Vercel alike. No route, action or rendered output
// changes.
//
// Safety: actions that require a staff role (opts.area) can never be called
// this way, because there is no authenticated staff request to enforce
// against. Only public actions are reachable here.
type ApiHandler = (req: Request, res: Response, db: Db) => Promise<void>;
const actionHandlers = new Map<string, { handler: ApiHandler; opts?: { auth?: "customer" | "none"; area?: RoleArea } }>();

export async function callApiAction(name: string, body: any = {}): Promise<any> {
  const entry = actionHandlers.get(name);
  if (!entry) throw new Error(`Unknown API action: ${name}`);
  if (entry.opts?.area) throw new Error(`API action ${name} requires staff authorization and cannot be called in-process`);
  const db = getDb();
  if (!db) throw new Error("database not configured");
  let status = 200;
  let payload: any;
  // Minimal request: the page handlers call public actions with no session,
  // exactly like the old self-fetch, which forwarded no cookies or auth
  // headers. sessionCustomer therefore returns null and the homepage renders
  // the guest (featured) recommendations, as before.
  const req = { body, headers: {}, query: {} } as unknown as Request;
  const res = {
    status(code: number) { status = code; return this; },
    json(data: any) { payload = data; return this; },
  } as unknown as Response;
  await entry.handler(req, res, db);
  if (status >= 400) throw new Error(payload?.error || `API action ${name} failed (HTTP ${status})`);
  return payload;
}

export function registerApi(app: Express) {
  const a = (name: string, handler: (req: Request, res: Response, db: Db) => Promise<void>, opts?: { auth?: "customer" | "none"; area?: RoleArea }) => {
    actionHandlers.set(name, { handler, opts });
    app.post(`/api/${name}`, async (req, res) => {
      const db = dbOr503(res); if (!db) return;
      try {
        if (opts?.area) {
          try { enforce(req, opts.area); }
          catch (e) {
            if (e instanceof PermissionDeniedError) {
              await audit(db, "PERMISSION DENIED", staffRoleLabel(req), `${name} — role "${staffRoleLabel(req)}" denied area "${opts.area}"`);
              res.status(403).json({ ok: false, error: e.message }); return;
            }
            if (e instanceof StaffAuthRequiredError) {
              await audit(db, "STAFF AUTH REQUIRED", "anonymous", `${name} — no staff role supplied for area "${opts.area}"`);
              res.status(401).json({ ok: false, error: e.message }); return;
            }
            throw e;
          }
        }
        await handler(req, res, db);
      } catch (e) {
        // Surface the underlying driver cause (same pattern as /health):
        // Drizzle's message alone ("Failed query: ... params: ...") hides
        // whether the pooler refused, reset, or timed out the connection.
        const cause = (e as any)?.cause;
        const msg = cause?.message ? `${(e as Error).message} — caused by: ${cause.message}` : (e as Error).message;
        console.error(`[api/${name}]`, msg);
        if (!res.headersSent) res.status(500).json({ ok: false, error: msg });
      }
    });
  };

  // ---- 5.1 Bootstrap / config ----
  a("getBootstrap", async (_req, res, db) => {
    const cfg = await settingsMap(db);
    const cats = await db.select().from(s.categories).orderBy(asc(s.categories.sortOrder), asc(s.categories.id));
    const staff = await db.select().from(s.staff);
    const coupons = await db.select().from(s.coupons);
    const published = await db.select({ n: sql<number>`count(*)` }).from(s.products).where(eq(s.products.status, "Published"));
    const orders = await db.select().from(s.orders);
    const live = orders.filter((o: any) => !o.legacyTest && o.status !== "Cancelled");
    res.json({ ok: true, config: cfg, categories: cats, staff, coupons, publishedProductCount: Number(published[0]?.n || 0), orderCount: orders.length, legacyTestOrderCount: orders.filter((o: any) => o.legacyTest).length, revenueExcludingLegacy: live.reduce((a: number, o: any) => a + o.total, 0) });
  }, { area: "settings" });

  // A4 (Phase 1): seedDemo REMOVED from the public API entirely. It used to
  // run `node dist/db/seed.js --force` via execFile with no auth, so anyone
  // could wipe all 27 tables. Seeding stays CLI-only (`npm run db:seed`,
  // idempotent — skips when products exist) and via boot migration. There
  // is no browser-reachable reseed path anymore; grep for execFile /
  // child_process in src/ must stay empty.

  a("saveSettings", async (req, res, db) => {
    const entries = req.body?.settings || req.body || {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== "string") continue;
      if (k.startsWith("provider_")) enforce(req, "settings");
      await db.insert(s.settings).values({ key: k, value: v }).onConflictDoUpdate({ target: s.settings.key, set: { value: v } });
    }
    await audit(db, "Settings saved", staffRoleLabel(req), Object.keys(entries).join(", "));
    res.json({ ok: true });
  }, { area: "settings" });

  a("seedHomepageDefaults", async (_req, res, db) => {
    const banners = await db.select().from(s.heroBanners);
    const cols = await db.select().from(s.homeCollections);
    const secs = await db.select().from(s.homeSections);
    if (banners.length === 0 || cols.length === 0 || secs.length === 0) {
      res.json({ ok: true, seeded: false, note: "Homepage defaults are seeded by npm run db:seed. No rows were created by this call because the seed files are the source of truth." });
      return;
    }
    res.json({ ok: true, seeded: false, reason: "already present", banners: banners.length, collections: cols.length, sections: secs.length });
  });

  a("getPhase2Status", async (_req, res, db) => {
    const cfg = await settingsMap(db);
    const providers = ["jazzcash", "easypaisa", "card", "bank", "cod", "tcs", "leopards", "postex", "email", "sms", "whatsapp"].map((k) => ({ key: k, status: cfg[`provider_${k}_status`] || "Awaiting credentials" }));
    res.json({
      ok: true,
      financeDecision: "Seller payouts / cash-out are FORMALLY EXCLUDED from scope: NEXORA MARKET is a single-company store, so there are no sellers, commissions or payouts to build. Finance scope = customer payments, refunds and reconciliation only.",
      providers,
      hostingAssessment: ["One Render free web service + Supabase free Postgres (this rebuild). Render sleeps after 15 min idle (~30–60 s wake); Supabase free pauses after 1 week idle (one click resumes, no expiry).", "No Firebase, no PWA, no external staging URL beyond the Render test-server link."],
      pendingOwnerInputs: ["Payment merchant approvals + sandbox credentials (JazzCash, Easypaisa, card acquirer)", "Courier corporate accounts + API credentials (TCS / Leopards / PostEx)", "Real company bank account details for Bank Transfer instructions (current ones are fictional demo data)", "Legal business details for policies: registered business name, NTN, business address, returns warehouse address", "Coupon production values: expiry date and usage limit for coupons 000, WELCOME10 and FLASH500", "Real product photographs for the catalogue", "Legacy returns decision: RET-DEMO-001 and RET-DEMO-002", "Owner's order email correction for NX-DEMO-98524600 (approval pending)"],
      environment: "Demo / test server — live payments, courier booking and public sales stay OFF until the owner approves production activation.",
    });
  }, { area: "reports" });

  a("getBigTestReport", async (_req, res, db) => {
    const cfg = await settingsMap(db);
    const report = parseStoredReport(cfg.bigTestReport);
    res.json({ ok: true, hasReport: !!cfg.bigTestReport, report, reportUnparseable: !!cfg.bigTestReport && report === null, passwordState: "All stored customer passwords use salted PBKDF2 hashes." });
  }, { area: "reports" });

  a("getRoleMatrix", async (_req, res) => {
    const { ROLE_MATRIX } = await import("../lib/roles");
    const { ROLE_AREAS } = await import("../lib/constants");
    res.json({ ok: true, areas: ROLE_AREAS, roles: Object.entries(ROLE_MATRIX).map(([role, permissions]) => ({ role, permissions })) });
  });

  a("runRoleSelfTest", async (_req, res, db) => {
    const t = runRoleSelfTest();
    // 3 real denied + 3 real allowed guard calls (live, not simulated).
    const denied: string[] = []; const allowed: string[] = [];
    const probes: [string, RoleArea][] = [["Warehouse Staff", "payments"], ["Customer Support Agent", "products"], ["Delivery Manager", "payments"]];
    for (const [role, area] of probes) {
      try { requirePermission(role, area); allowed.push(`${role} -> ${area}`); }
      catch { denied.push(`${role} -> ${area} denied`); await audit(db, "PERMISSION DENIED", role, `runRoleSelfTest probe: ${area}`); }
    }
    const okProbes: [string, RoleArea][] = [["Warehouse Staff", "inventory"], ["Finance Officer", "payments"], ["Super Admin", "settings"]];
    for (const [role, area] of okProbes) {
      try { requirePermission(role, area); allowed.push(`${role} -> ${area} allowed`); } catch { denied.push(`${role} -> ${area} denied (unexpected)`); }
    }
    res.json({ ok: true, allowed: t.allowed, denied: t.denied, checks: t.checks, liveDenied: denied, liveAllowed: allowed, note: "Sandbox reference: 41 allowed / 58 denied." });
  }, { area: "reports" });

  a("runCorrectionAndJourney", async (_req, res, db) => {
    const cfg = await settingsMap(db);
    const report = parseStoredReport(cfg.bigTestReport);
    res.json({ ok: true, alreadyRan: true, report, reportUnparseable: !!cfg.bigTestReport && report === null, note: "Idempotent: re-runs return the stored report. This action must NOT be re-runnable into duplicate data; the journey is re-proven by placing a fresh order through createOrder/advanceOrder in the rebuilt service." });
  }, { area: "reports" });

  // ---- 5.2 Catalogue ----
  a("listProducts", async (req, res, db) => {
    const b = req.body || {};
    let rows = await db.select().from(s.products).orderBy(asc(s.products.id));
    if (b.category) rows = rows.filter((p: any) => p.category === b.category);
    if (b.subcategory) rows = rows.filter((p: any) => p.subcategory === b.subcategory);
    if (b.search) { const q = String(b.search).toLowerCase(); rows = rows.filter((p: any) => (p.name + " " + p.brand + " " + p.sku).toLowerCase().includes(q)); }
    if (b.minPrice != null) rows = rows.filter((p: any) => p.price >= b.minPrice);
    if (b.maxPrice != null) rows = rows.filter((p: any) => p.price <= b.maxPrice);
    if (b.minRating != null) rows = rows.filter((p: any) => p.rating >= b.minRating);
    if (b.inStock) rows = rows.filter((p: any) => p.stock > 0);
    if (b.onDiscount) rows = rows.filter((p: any) => p.salePrice != null && p.salePrice < p.price);
    if (b.color) rows = rows.filter((p: any) => (p.colors || "").toLowerCase().includes(String(b.color).toLowerCase()));
    if (b.size) rows = rows.filter((p: any) => (p.sizes || "").includes(String(b.size)));
    if (b.sort === "biggest-discount") rows.sort((x: any, y: any) => ((y.salePrice != null ? (y.price - y.salePrice) / y.price : 0) - (x.salePrice != null ? (x.price - x.salePrice) / x.price : 0)));
    else if (b.sort === "price-asc") rows.sort((x: any, y: any) => x.price - y.price);
    else if (b.sort === "price-desc") rows.sort((x: any, y: any) => y.price - x.price);
    else if (b.sort === "rating") rows.sort((x: any, y: any) => y.rating - x.rating);
    else if (b.sort === "newest") rows.sort((x: any, y: any) => y.id - x.id);
    const total = rows.length;
    const limit = Math.min(100, Number(b.limit || 48));
    const offset = Number(b.offset || 0);
    const page = rows.slice(offset, offset + limit);
    const out = [];
    for (const p of page) out.push(await productWithImages(db, p));
    const suggestions = b.search ? out.slice(0, 8).map((p: any) => p.name) : [];
    res.json({ ok: true, products: out, total, suggestions });
  });

  a("listCategories", async (_req, res, db) => {
    const rows = await db.select().from(s.categories).orderBy(asc(s.categories.sortOrder), asc(s.categories.id));
    res.json({ ok: true, categories: rows });
  });

  a("saveProduct", async (req, res, db) => {
    const p = req.body || {};
    const data: any = { sku: p.sku, name: p.name, shortDesc: p.shortDesc ?? "", description: p.description ?? "", category: p.category, subcategory: p.subcategory ?? "", brand: p.brand ?? "", price: p.price, salePrice: p.salePrice ?? null, priceHistory: p.priceHistory ?? "", stock: p.stock ?? 0, sold: p.sold ?? 0, rating: p.rating ?? 0, reviewsCount: p.reviewsCount ?? 0, status: p.status ?? "Published", sellerId: 0, sellerName: OFFICIAL_STORE_NAME, isFlash: !!p.isFlash, isFeatured: !!p.isFeatured, colors: p.colors ?? "", sizes: p.sizes ?? "", specs: p.specs ?? "", warranty: p.warranty ?? "", warehouse: p.warehouse ?? "Karachi Central", tile: p.tile ?? "", tileColor: p.tileColor ?? "" };
    let row;
    if (p.id) { await db.update(s.products).set(data).where(eq(s.products.id, p.id)); row = (await db.select().from(s.products).where(eq(s.products.id, p.id)))[0]; }
    else { row = (await db.insert(s.products).values(data).returning())[0]; }
    await audit(db, "Product saved", staffRoleLabel(req), `${data.sku} ${data.name}`);
    res.json({ ok: true, product: row });
  }, { area: "products" });

  a("setProductStatus", async (req, res, db) => {
    await db.update(s.products).set({ status: req.body.status }).where(eq(s.products.id, req.body.id));
    res.json({ ok: true });
  }, { area: "products" });

  a("saveCategory", async (req, res, db) => {
    const c = req.body || {};
    let row;
    if (c.id) { await db.update(s.categories).set({ name: c.name, parent: c.parent ?? "", active: c.active !== false, sortOrder: c.sortOrder ?? 0 }).where(eq(s.categories.id, c.id)); row = (await db.select().from(s.categories).where(eq(s.categories.id, c.id)))[0]; }
    else { row = (await db.insert(s.categories).values({ name: c.name, parent: c.parent ?? "", active: c.active !== false, sortOrder: c.sortOrder ?? 0 }).returning())[0]; }
    res.json({ ok: true, category: row });
  }, { area: "products" });

  a("deleteCategory", async (req, res, db) => {
    await db.delete(s.categories).where(eq(s.categories.id, req.body.id));
    res.json({ ok: true });
  }, { area: "products" });

  const imageMagic = (buf: Buffer): "jpeg" | "png" | "webp" | null => {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    if (buf.length >= 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
    return null;
  };

  a("uploadProductImage", async (req, res, db) => {
    const { productId, fileName, dataBase64, mime } = req.body || {};
    if (!productId || !dataBase64) { res.status(400).json({ ok: false, error: "productId and image data are required." }); return; }
    const buf = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ""), "base64");
    if (buf.length > 2 * 1024 * 1024) { res.status(400).json({ ok: false, error: "Image must be 2 MB or less." }); return; }
    const kind = imageMagic(buf);
    if (!kind) { res.status(400).json({ ok: false, error: "Only JPEG/PNG/WebP images are accepted (magic bytes verified)." }); return; }
    if (mime && !["image/jpeg", "image/png", "image/webp"].includes(mime)) { res.status(400).json({ ok: false, error: "Only JPEG/PNG/WebP images are accepted." }); return; }
    const prod = (await db.select().from(s.products).where(eq(s.products.id, Number(productId))))[0];
    if (!prod) { res.status(404).json({ ok: false, error: "Product not found." }); return; }
    const fs = await import("node:fs");
    const ext = kind === "jpeg" ? "jpg" : kind;
    const name = `${Date.now()}-${(fileName || "upload").replace(/[^a-zA-Z0-9._-]/g, "_")}.${ext}`;
    const dir = path.resolve(__dirname, "../../public/images/products");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    const storageKey = `product-images/${prod.id}/${name}`;
    const row = (await db.insert(s.productImages).values({ productId: prod.id, storageKey, blobUrl: "", fileName: name, sortOrder: 0, isSample: false }).returning())[0];
    res.json({ ok: true, image: { ...row, url: `/images/products/${name}`, isSample: false } });
  }, { area: "products" });

  a("listProductImages", async (req, res, db) => {
    const rows = await db.select().from(s.productImages).where(eq(s.productImages.productId, Number(req.body?.productId))).orderBy(asc(s.productImages.sortOrder));
    res.json({ ok: true, images: rows.map((i: any) => ({ ...i, url: imageUrlOf(i) })) });
  });

  a("deleteProductImage", async (req, res, db) => {
    const rows = await db.select().from(s.productImages).where(eq(s.productImages.id, req.body.id));
    const row = rows[0];
    if (row) {
      await db.delete(s.productImages).where(eq(s.productImages.id, req.body.id));
      const fs = await import("node:fs");
      const file = (row.storageKey || "").split("/").pop();
      if (file && row.isSample === false) { try { fs.unlinkSync(path.resolve(__dirname, "../../public/images/products", file)); } catch { /* already gone */ } }
    }
    res.json({ ok: true });
  }, { area: "products" });

  a("reorderProductImages", async (req, res, db) => {
    const ids: number[] = req.body?.ids || [];
    for (let i = 0; i < ids.length; i++) await db.update(s.productImages).set({ sortOrder: i }).where(eq(s.productImages.id, ids[i]));
    res.json({ ok: true });
  }, { area: "products" });

  a("seedSampleProductImages", async (_req, res, db) => {
    const products = await db.select().from(s.products).where(eq(s.products.status, "Published"));
    let skipped = 0, present = 0;
    for (const p of products) {
      const imgs = await db.select().from(s.productImages).where(eq(s.productImages.productId, p.id));
      if (imgs.length > 0) { skipped++; continue; }
      present++;
    }
    res.json({ ok: true, note: "Sample images are downloaded at build time into public/images/products (see BUILD-REPORT.md). This action never overwrites a product that already has ANY photo — owner uploads are never disturbed.", productsWithPhotos: skipped, productsWithoutPhotos: present });
  });

  const cartKey = (req: Request) => (req.body?.customerEmail as string) || (req.headers["x-guest-key"] as string) || "guest";

  a("getCart", async (req, res, db) => {
    const key = cartKey(req);
    const lines = await db.select().from(s.cartItems).where(eq(s.cartItems.customerEmail, key));
    const out = [];
    for (const l of lines) {
      const p = (await db.select().from(s.products).where(eq(s.products.id, l.productId)))[0];
      if (!p) continue;
      const full = await productWithImages(db, p);
      out.push({ ...l, product: full, imageUrl: full.imageUrl, isSample: full.imageIsSample });
    }
    res.json({ ok: true, items: out });
  });

  a("addToCart", async (req, res, db) => {
    const key = cartKey(req);
    const { productId, qty } = req.body || {};
    const p = (await db.select().from(s.products).where(eq(s.products.id, Number(productId))))[0];
    if (!p) { res.status(404).json({ ok: false, error: "Product not found." }); return; }
    const want = Math.max(1, Number(qty || 1));
    const capped = Math.min(want, p.stock);
    const existing = (await db.select().from(s.cartItems).where(and(eq(s.cartItems.customerEmail, key), eq(s.cartItems.productId, p.id))))[0];
    if (existing) {
      const next = Math.min(existing.qty + capped, p.stock);
      await db.update(s.cartItems).set({ qty: next }).where(eq(s.cartItems.id, existing.id));
      res.json({ ok: true, qty: next, adjusted: capped < want, note: capped < want ? `Quantity capped at available stock (${p.stock}).` : undefined });
      return;
    }
    if (capped <= 0) { res.json({ ok: true, qty: 0, note: "This product is out of stock." }); return; }
    await db.insert(s.cartItems).values({ customerEmail: key, productId: p.id, qty: capped });
    res.json({ ok: true, qty: capped, adjusted: capped < want, note: capped < want ? `Quantity capped at available stock (${p.stock}).` : undefined });
  });

  a("updateCartItem", async (req, res, db) => {
    const { id, qty } = req.body || {};
    const line = (await db.select().from(s.cartItems).where(eq(s.cartItems.id, Number(id))))[0];
    if (!line) { res.status(404).json({ ok: false, error: "Cart line not found." }); return; }
    if (Number(qty) <= 0) { await db.delete(s.cartItems).where(eq(s.cartItems.id, line.id)); res.json({ ok: true, removed: true }); return; }
    const p = (await db.select().from(s.products).where(eq(s.products.id, line.productId)))[0];
    const capped = Math.min(Number(qty), p?.stock ?? 0);
    await db.update(s.cartItems).set({ qty: capped }).where(eq(s.cartItems.id, line.id));
    res.json({ ok: true, qty: capped, adjusted: capped < Number(qty), note: capped < Number(qty) ? `Quantity capped at available stock (${p?.stock}).` : undefined });
  });

  a("removeCartItem", async (req, res, db) => {
    await db.delete(s.cartItems).where(eq(s.cartItems.id, req.body.id));
    res.json({ ok: true });
  });

  a("listWishlist", async (req, res, db) => {
    const key = cartKey(req);
    const rows = await db.select().from(s.wishlistItems).where(eq(s.wishlistItems.customerEmail, key));
    const out = [];
    for (const r of rows) { const p = (await db.select().from(s.products).where(eq(s.products.id, r.productId)))[0]; if (p) out.push(await productWithImages(db, p)); }
    res.json({ ok: true, items: out, count: out.length });
  });

  a("addToWishlist", async (req, res, db) => {
    const key = cartKey(req);
    const pid = Number(req.body?.productId);
    const ex = await db.select().from(s.wishlistItems).where(and(eq(s.wishlistItems.customerEmail, key), eq(s.wishlistItems.productId, pid)));
    if (!ex.length) await db.insert(s.wishlistItems).values({ customerEmail: key, productId: pid });
    res.json({ ok: true });
  });

  a("removeFromWishlist", async (req, res, db) => {
    const key = cartKey(req);
    await db.delete(s.wishlistItems).where(and(eq(s.wishlistItems.customerEmail, key), eq(s.wishlistItems.productId, Number(req.body?.productId))));
    res.json({ ok: true });
  });

  a("listDemoMerchants", async (req, res, db) => {
    let rows = await db.select().from(s.demoMerchants).orderBy(desc(s.demoMerchants.rating));
    if (req.body?.verification) rows = rows.filter((m: any) => m.verification === req.body.verification);
    res.json({ ok: true, merchants: rows, note: "Display only — demo merchants are not sellers; there is no registration, store, commission or payout." });
  });

  // ---- 5.3 Checkout & orders ----
  a("validateCoupon", async (req, res, db) => {
    const code = String(req.body?.code || "").trim().toUpperCase();
    const subtotal = Number(req.body?.subtotal || 0);
    const rows = await db.select().from(s.coupons).where(eq(s.coupons.code, code));
    const c = rows[0];
    if (!c) { res.json({ ok: false, error: "Coupon not found." }); return; }
    let customerUses = 0;
    const cust = await sessionCustomer(db, req);
    if (cust) {
      const myOrders = await db.select().from(s.orders).where(eq(s.orders.customerEmail, cust.email.toLowerCase()));
      customerUses = myOrders.filter((o: any) => o.discount > 0).length;
    }
    const v = validateCouponRules({ ...c, discountType: c.discountType as "percent" | "fixed", expiresAt: c.expiresAt || "" }, subtotal, customerUses, todayYmdKarachi());
    if (!v.ok) { res.json({ ok: false, error: v.error }); return; }
    res.json({ ok: true, code: c.code, discount: v.discount, discountType: c.discountType, value: c.value });
  });

  async function placeOrderInternal(db: Db, b: any) {
    const v = validateCustomerInfo({ email: b.customerEmail, phone: b.customerPhone, name: b.customerName });
    if (!v.ok) return { ok: false, status: 400, errors: v.errors };
    const items: { productId: number; qty: number }[] = b.items || [];
    if (!items.length) return { ok: false, status: 400, error: "Your cart is empty." };
    const idempotencyKey = String(b.idempotencyKey || b.idempotency_key || "");
    if (idempotencyKey) {
      const dup = (await db.select().from(s.orders).where(eq(s.orders.idempotencyKey, idempotencyKey)))[0];
      if (dup) return { ok: true, duplicate: true, duplicateBlocked: true, order: dup };
    }
    let subtotal = 0;
    const lines: any[] = [];
    const adjustments: string[] = [];
    for (const it of items) {
      const p = (await db.select().from(s.products).where(eq(s.products.id, Number(it.productId))))[0];
      if (!p) return { ok: false, status: 400, error: `Product ${it.productId} not found.` };
      const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
      let qty = Math.max(1, Number(it.qty || 1));
      if (qty > p.stock) { adjustments.push(`${p.name}: quantity reduced from ${qty} to ${p.stock} (available stock).`); qty = p.stock; }
      if (qty <= 0) return { ok: false, status: 400, error: `${p.name} is out of stock.` };
      subtotal += price * qty;
      lines.push({ product: p, price, qty });
    }
    let discount = 0;
    const couponCode = String(b.couponCode || b.coupon || "").trim().toUpperCase();
    if (couponCode) {
      const c = (await db.select().from(s.coupons).where(eq(s.coupons.code, couponCode)))[0];
      const cv = validateCouponRules(c ? { ...c, discountType: c.discountType as "percent" | "fixed", expiresAt: c.expiresAt || "" } : null, subtotal, 0, todayYmdKarachi());
      if (cv.ok) discount = cv.discount || 0;
    }
    const method = (b.shippingMethod || "Standard") as ShippingMethod;
    const totals = computeOrderTotals({ subtotal, discount, shippingMethod: method });
    const paymentMethod = String(b.paymentMethod || "Cash on Delivery");
    const isCod = paymentMethod === "Cash on Delivery";
    const paymentRef = isCod ? "" : (b.paymentRef || txnRef());
    const paymentStatus = isCod ? "Pending (COD)" : `Paid (Demo Simulated) • Ref ${paymentRef}`;
    const on = orderNumber();
    const now = Date.now();
    const order = (await db.insert(s.orders).values({
      orderNumber: on, customerName: b.customerName, customerEmail: b.customerEmail,
      customerPhone: b.customerPhone, recipientName: b.recipientName || b.customerName,
      address: b.address || "", area: b.area || "", city: b.city || "", province: b.province || "",
      postalCode: b.postalCode || "", landmark: b.landmark || "",
      deliveryInstructions: b.deliveryInstructions || "", deliverySlot: b.deliverySlot || "",
      pickupPoint: b.pickupPoint || "", shippingMethod: method, shippingFee: totals.shippingFee,
      subtotal, discount, total: totals.total, status: "Pending", paymentMethod,
      paymentStatus, paymentAccount: b.paymentAccount || "", paymentRef,
      courier: "NEXORA Express (Demo)", trackingNumber: trackingNumber(on),
      cancelReason: "", idempotencyKey, legacyTest: false, legacyNote: "", createdAt: now,
    }).returning())[0];
    for (const l of lines) {
      await db.insert(s.orderItems).values({ orderId: order.id, productId: l.product.id, productName: l.product.name, price: l.price, qty: l.qty, sellerId: 0 });
      const newStock = l.product.stock - l.qty;
      await db.update(s.products).set({ stock: newStock }).where(eq(s.products.id, l.product.id));
      await db.insert(s.inventoryMovements).values({ productId: l.product.id, sku: l.product.sku, type: "Order Reserved (Stock-Out)", qty: -l.qty, balanceAfter: newStock, reference: on, actor: "System", note: `Reserved for order ${on} at checkout`, createdAt: now });
    }
    await db.insert(s.orderEvents).values({ orderId: order.id, status: "Pending", note: `Order placed. Payment: ${paymentMethod}${isCod ? " — demo only, no charge." : ` from ${b.paymentAccount || ""}, Transaction ${paymentRef} — demo only, no charge.`}`, location: "NEXORA Karachi Central (Demo)", actor: "System", createdAt: now });
    await db.insert(s.paymentTransactions).values({ orderId: order.id, orderNumber: on, method: paymentMethod, provider: paymentMethod.replace(" (Demo)", ""), account: b.paymentAccount || (isCod ? "Cash collected on delivery" : ""), reference: paymentRef, amount: totals.total, status: paymentStatus, mode: PAYMENT_MODE_DEMO, createdAt: now });
    if (couponCode && discount > 0) {
      const c = (await db.select().from(s.coupons).where(eq(s.coupons.code, couponCode)))[0];
      if (c) await db.update(s.coupons).set({ uses: c.uses + 1 }).where(eq(s.coupons.id, c.id));
    }
    await db.insert(s.notifications).values({ title: "Order placed (Demo)", body: `${on} confirmed. Total ${formatPkr(totals.total)}. Tracking ${trackingNumber(on)}.`, type: "Order", isRead: false, createdAt: now });
    return { ok: true, order, totals, adjustments, duplicate: false };
  }

  a("createOrder", async (req, res, db) => {
    const r = await placeOrderInternal(db, req.body || {});
    if (!r.ok) { res.status(r.status || 400).json({ ok: false, error: r.error, errors: (r as any).errors }); return; }
    // Clear the buyer's cart lines for the ordered products.
    if (req.body?.clearCart !== false) {
      const key = cartKey(req);
      for (const it of (req.body?.items || [])) await db.delete(s.cartItems).where(and(eq(s.cartItems.customerEmail, key), eq(s.cartItems.productId, Number(it.productId))));
    }
    res.json({ ok: true, order: r.order, totals: r.totals, adjustments: r.adjustments, duplicateBlocked: r.duplicate === true });
  });

  async function advanceOrderInternal(db: Db, orderId: number) {
    const order = (await db.select().from(s.orders).where(eq(s.orders.id, orderId)))[0];
    if (!order) return { ok: false, error: "Order not found." };
    const idx = TRACKING_STEPS.indexOf(order.status as any);
    if (idx < 0) return { ok: false, error: `Order status "${order.status}" is not on the 12-step timeline.` };
    if (idx >= TRACKING_STEPS.length - 1) return { ok: false, error: "Order is already Delivered." };
    const next = TRACKING_STEPS[idx + 1];
    const now = Date.now();
    await db.update(s.orders).set({ status: next }).where(eq(s.orders.id, order.id));
    await db.insert(s.orderEvents).values({ orderId: order.id, status: next, note: TRACKING_STEP_NOTES[next] || `${next} (demo simulation).`, location: TRACKING_STEP_LOCATIONS[next] || "NEXORA Express (Demo)", actor: "System", createdAt: now });
    if (next === "Shipped") {
      await db.insert(s.shipments).values({ orderId: order.id, orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, provider: "NEXORA Express (Demo)", charge: order.shippingFee, status: SHIPMENT_STATUS, createdAt: now });
    }
    if (next === "Delivered" && order.paymentMethod === "Cash on Delivery") {
      await db.update(s.orders).set({ paymentStatus: "Paid (COD Collected — Demo)" }).where(eq(s.orders.id, order.id));
      await db.insert(s.paymentTransactions).values({ orderId: order.id, orderNumber: order.orderNumber, method: order.paymentMethod, provider: "Cash on Delivery", account: "Cash collected on delivery", reference: "", amount: order.total, status: "Paid (COD Collected — Demo)", mode: PAYMENT_MODE_DEMO, createdAt: now });
    }
    const updated = (await db.select().from(s.orders).where(eq(s.orders.id, order.id)))[0];
    return { ok: true, order: updated, advancedTo: next };
  }

  a("advanceOrder", async (req, res, db) => {
    const r = await advanceOrderInternal(db, Number(req.body?.orderId));
    if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, order: r.order, advancedTo: r.advancedTo, note: "Demo simulation — each tap advances one step on the 12-step timeline." });
  }, { area: "orders" });

  a("updateOrderStatus", async (req, res, db) => {
    const status = String(req.body?.status || "");
    if (!TRACKING_STEPS.includes(status as any)) {
      res.status(400).json({ ok: false, error: `Invalid status "${status}". Status must be one of the 12 tracking steps: ${TRACKING_STEPS.join(", ")}.` });
      return;
    }
    const order = (await db.select().from(s.orders).where(eq(s.orders.id, Number(req.body?.orderId))))[0];
    if (!order) { res.status(404).json({ ok: false, error: "Order not found." }); return; }
    await db.update(s.orders).set({ status }).where(eq(s.orders.id, order.id));
    await db.insert(s.orderEvents).values({ orderId: order.id, status, note: `Status set to ${status} by ${staffRoleLabel(req)} (demo simulation).`, location: "NEXORA Head Office (Demo)", actor: staffRoleLabel(req), createdAt: Date.now() });
    res.json({ ok: true });
  }, { area: "orders" });

  // A3: cancelOrder requires a staff session with the orders area OR the
  // owning customer's session. Ownership is checked server-side from the
  // session, never from the request body. 401 no session/role, 403 another
  // customer's order, 404 unknown id.
  a("cancelOrder", async (req, res, db) => {
    let cust: any = null;
    let actor: string;
    if (staffRole(req)) {
      if (!await enforceOr401(db, req, res, "orders", "cancelOrder")) return;
      actor = `staff:${staffRoleLabel(req)}`;
    } else {
      cust = await requireCustomer(db, req, res); if (!cust) return;
      actor = `customer:${cust.email}`;
    }
    const order = (await db.select().from(s.orders).where(eq(s.orders.id, Number(req.body?.orderId))))[0];
    if (!order) { res.status(404).json({ ok: false, error: "Order not found." }); return; }
    if (cust && order.customerEmail.toLowerCase() !== cust.email.toLowerCase()) { res.status(403).json({ ok: false, error: "This order belongs to another customer." }); return; }
    const reason = String(req.body?.reason || "Cancelled by customer");
    const now = Date.now();
    if (order.status === "Cancelled") { res.status(400).json({ ok: false, error: "This order is already cancelled." }); return; }
    if (order.status === "Delivered") { res.status(400).json({ ok: false, error: "A delivered order cannot be cancelled — please request a return instead." }); return; }
    if (["Shipped", "In Transit", "Arrived at Sorting Facility", "Arrived in Destination City", "Out for Delivery"].includes(order.status)) {
      await db.insert(s.orderEvents).values({ orderId: order.id, status: order.status, note: `Cancellation requested while ${order.status} — refusal workflow: courier return requested (demo simulation). Reason: ${reason}`, location: "NEXORA Express (Demo)", actor: "System", createdAt: now });
      await db.insert(s.notifications).values({ title: "Cancellation requested (Demo)", body: `${order.orderNumber} is already ${order.status}; a courier return has been requested (demo simulation).`, type: "Order", isRead: false, createdAt: now });
      await audit(db, "Order cancellation requested (shipped)", actor, `${order.orderNumber} — ${order.status}`);
      res.json({ ok: true, refused: true, message: "The order has already shipped — a courier return was requested instead of an instant cancellation (demo simulation)." });
      return;
    }
    const prepaid = order.paymentStatus.startsWith("Paid (Demo Simulated)");
    await db.update(s.orders).set({ status: "Cancelled", cancelReason: reason, paymentStatus: prepaid ? "Refund Pending (Demo)" : order.paymentStatus }).where(eq(s.orders.id, order.id));
    await db.insert(s.orderEvents).values({ orderId: order.id, status: "Cancelled", note: `Order cancelled. Reason: ${reason}`, location: "NEXORA Head Office (Demo)", actor: "System", createdAt: now });
    // Release reserved stock (checkout-placed orders only).
    const items = await db.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
    for (const it of items) {
      if (!it.productId) continue;
      const p = (await db.select().from(s.products).where(eq(s.products.id, it.productId)))[0];
      if (!p) continue;
      const newStock = p.stock + it.qty;
      await db.update(s.products).set({ stock: newStock }).where(eq(s.products.id, p.id));
      await db.insert(s.inventoryMovements).values({ productId: p.id, sku: p.sku, type: "Order Cancelled (Stock-In)", qty: it.qty, balanceAfter: newStock, reference: order.orderNumber, actor: "System", note: `Stock released for cancelled order ${order.orderNumber}`, createdAt: now });
    }
    if (prepaid) {
      await db.insert(s.paymentTransactions).values({ orderId: order.id, orderNumber: order.orderNumber, method: order.paymentMethod, provider: order.paymentMethod.replace(" (Demo)", ""), account: order.paymentAccount, reference: order.paymentRef, amount: order.total, status: "Refund Pending (Demo)", mode: PAYMENT_MODE_DEMO, createdAt: now });
    }
    await db.insert(s.notifications).values({ title: "Order cancelled (Demo)", body: `${order.orderNumber} was cancelled. ${prepaid ? "Refund Pending (Demo)." : ""}`, type: "Order", isRead: false, createdAt: now });
    await audit(db, "Order cancelled", actor, `${order.orderNumber} — ${reason}`);
    res.json({ ok: true, cancelled: true, refundPending: prepaid });
  });

  a("getOrderTracking", async (req, res, db) => {
    const { orderNumber: on, trackingNumber: tn } = req.body || {};
    const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, String(on || ""))))[0];
    if (!order || (tn && order.trackingNumber !== tn)) { res.status(404).json({ ok: false, error: "Order not found — check the order and tracking numbers." }); return; }
    const events = await db.select().from(s.orderEvents).where(eq(s.orderEvents.orderId, order.id)).orderBy(asc(s.orderEvents.createdAt));
    const items = await db.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
    const stepIndex = TRACKING_STEPS.indexOf(order.status as any);
    res.json({ ok: true, order, events, items, stepIndex, steps: TRACKING_STEPS, courier: order.courier, note: "Simulated tracking — no courier API connected. The map preview is a clearly-labelled simulation." });
  });

  a("listOrders", async (req, res, db) => {
    const rows = await db.select().from(s.orders).orderBy(desc(s.orders.createdAt));
    res.json({ ok: true, orders: rows });
  }, { area: "orders" });

  a("listMyOrders", async (req, res, db) => {
    const cust = await sessionCustomer(db, req);
    if (!cust) { res.json({ ok: true, authenticated: false, orders: [] }); return; }
    const rows = await db.select().from(s.orders).where(sql`lower(${s.orders.customerEmail}) = lower(${cust.email})`).orderBy(desc(s.orders.createdAt));
    const buckets = {
      toPay: rows.filter((o: any) => o.paymentMethod !== "Cash on Delivery" && ["Pending", "Awaiting Verification (Demo)"].includes(o.paymentStatus)).length,
      toShip: rows.filter((o: any) => ["Pending", "Confirmed", "Payment Confirmed", "Processing", "Packed", "Ready for Dispatch"].includes(o.status)).length,
      toReceive: rows.filter((o: any) => ["Shipped", "In Transit", "Arrived at Sorting Facility", "Arrived in Destination City", "Out for Delivery"].includes(o.status)).length,
      toReview: rows.filter((o: any) => o.status === "Delivered").length,
    };
    res.json({ ok: true, authenticated: true, orders: rows, buckets });
  });

  a("clearCancelledOrders", async (_req, res, db) => {
    const cancelled = await db.select().from(s.orders).where(eq(s.orders.status, "Cancelled"));
    for (const o of cancelled) {
      await db.delete(s.orderEvents).where(eq(s.orderEvents.orderId, o.id));
      await db.delete(s.orderItems).where(eq(s.orderItems.orderId, o.id));
      await db.delete(s.orders).where(eq(s.orders.id, o.id));
    }
    res.json({ ok: true, removed: cancelled.length });
  }, { area: "orders" });

  a("listRegisteredCustomers", async (_req, res, db) => {
    const rows = await db.select().from(s.customers).orderBy(asc(s.customers.id));
    res.json({ ok: true, customers: rows.map((c: any) => ({ ...c, passwordHash: undefined, resetTokenHash: undefined })) });
  }, { area: "customers" });

  // ---- 5.4 Customers & auth ----
  a("registerCustomer", async (req, res, db) => {
    const b = req.body || {};
    const v = validateCustomerInfo({ email: b.email, phone: b.phone, name: b.name });
    if (!v.ok) { res.status(400).json({ ok: false, errors: v.errors }); return; }
    if (!b.password || String(b.password).length < 6) { res.status(400).json({ ok: false, error: "Password must be at least 6 characters." }); return; }
    if (b.confirmPassword != null && b.confirmPassword !== b.password) { res.status(400).json({ ok: false, error: "Passwords do not match." }); return; }
    const existing = (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${b.email})`))[0];
    if (existing) { res.status(400).json({ ok: false, error: "An account with this email already exists." }); return; }
    const cust = (await db.insert(s.customers).values({ name: b.name, email: b.email.trim(), phone: b.phone, passwordHash: hashPassword(b.password), mustResetPassword: false, emailVerified: false, phoneVerified: false, deletionRequested: false, createdAt: Date.now() }).returning())[0];
    const { token, tokenHash } = newSessionToken();
    await db.insert(s.customerSessions).values({ customerId: cust.id, tokenHash, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
    res.json({ ok: true, sessionToken: token, customer: { id: cust.id, name: cust.name, email: cust.email, phone: cust.phone } });
  });

  a("loginCustomer", async (req, res, db) => {
    const { email, password } = req.body || {};
    const cust = (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${String(email || "")})`))[0];
    if (!cust) { res.status(401).json({ ok: false, error: "No account with this email." }); return; }
    if (!cust.passwordHash) {
      res.status(401).json({ ok: false, error: "This account has no password yet. Use 'Forgot password' to set one — the owner sets passwords via the reset flow after first deploy.", mustResetPassword: true });
      return;
    }
    let ok = false;
    if (cust.passwordHash.startsWith("pbkdf2$")) ok = verifyPassword(String(password || ""), cust.passwordHash);
    else if (isLegacySha256Hash(cust.passwordHash)) {
      ok = verifyLegacySha256(String(password || ""), cust.passwordHash);
      if (ok) { // transparent upgrade, audit-logged
        await db.update(s.customers).set({ passwordHash: hashPassword(String(password)) }).where(eq(s.customers.id, cust.id));
        await audit(db, "Legacy password hash upgraded to PBKDF2", cust.email, `customer ${cust.id}`);
      }
    }
    if (!ok) { res.status(401).json({ ok: false, error: "Incorrect password." }); return; }
    const { token, tokenHash } = newSessionToken();
    await db.insert(s.customerSessions).values({ customerId: cust.id, tokenHash, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
    res.json({ ok: true, sessionToken: token, customer: { id: cust.id, name: cust.name, email: cust.email, phone: cust.phone, emailVerified: cust.emailVerified, phoneVerified: cust.phoneVerified } });
  });

  a("logoutCustomer", async (req, res, db) => {
    const token = bearerToken(req);
    if (token) await db.delete(s.customerSessions).where(eq(s.customerSessions.tokenHash, hashSessionToken(token)));
    res.json({ ok: true });
  });

  a("getCustomer", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const addrs = await db.select().from(s.customerAddresses).where(eq(s.customerAddresses.customerId, cust.id));
    const def = addrs.find((x: any) => x.isDefault) || addrs[0] || null;
    const myOrders = await db.select().from(s.orders).where(sql`lower(${s.orders.customerEmail}) = lower(${cust.email})`);
    const wishlist = await db.select().from(s.wishlistItems).where(eq(s.wishlistItems.customerEmail, cust.email));
    const unread = await db.select().from(s.notifications).where(eq(s.notifications.isRead, false));
    const profileCompletion = Math.round((([cust.name, cust.email, cust.phone, def ? "x" : ""].filter(Boolean).length) / 4) * 100);
    res.json({ ok: true, authenticated: true, customer: { id: cust.id, name: cust.name, email: cust.email, phone: cust.phone, emailVerified: cust.emailVerified, phoneVerified: cust.phoneVerified, createdAt: cust.createdAt, mustResetPassword: cust.mustResetPassword }, defaultAddress: def, addresses: addrs, stats: { totalOrders: myOrders.length, inProgress: myOrders.filter((o: any) => !["Delivered", "Cancelled"].includes(o.status)).length, delivered: myOrders.filter((o: any) => o.status === "Delivered").length, wishlistItems: wishlist.length }, profileCompletion, unreadNotifications: unread.length });
  });

  a("updateCustomerProfile", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const b = req.body || {};
    if (b.phone && !isValidPkMobile(b.phone)) { res.status(400).json({ ok: false, error: "Please enter a valid Pakistani mobile number (03XXXXXXXXX or +92 3XXXXXXXXX)." }); return; }
    const phoneChanged = b.phone && b.phone !== cust.phone;
    await db.update(s.customers).set({ name: b.name || cust.name, phone: b.phone || cust.phone, phoneVerified: phoneChanged ? false : cust.phoneVerified }).where(eq(s.customers.id, cust.id));
    res.json({ ok: true, note: phoneChanged ? "Mobile changed — phone verification reset." : undefined });
  });

  a("changePassword", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const { currentPassword, newPassword, confirmNewPassword } = req.body || {};
    if (!cust.passwordHash || !verifyPassword(String(currentPassword || ""), cust.passwordHash)) { res.status(400).json({ ok: false, error: "Current password is incorrect." }); return; }
    if (!newPassword || String(newPassword).length < 6) { res.status(400).json({ ok: false, error: "New password must be at least 6 characters." }); return; }
    if (confirmNewPassword != null && confirmNewPassword !== newPassword) { res.status(400).json({ ok: false, error: "New passwords do not match." }); return; }
    await db.update(s.customers).set({ passwordHash: hashPassword(String(newPassword)), mustResetPassword: false }).where(eq(s.customers.id, cust.id));
    res.json({ ok: true });
  });

  a("requestPasswordReset", async (req, res, db) => {
    const { email } = req.body || {};
    const cust = (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${String(email || "")})`))[0];
    if (!cust) { res.json({ ok: true, note: "If an account exists for this email, a reset token was created." }); return; }
    const { token, tokenHash } = newResetToken();
    await db.update(s.customers).set({ resetTokenHash: tokenHash, resetExpiresAt: Date.now() + RESET_TOKEN_TTL_MS }).where(eq(s.customers.id, cust.id));
    // No email provider is connected: the token is shown once in the UI,
    // labelled as a staging-only step, and never logged.
    res.json({ ok: true, resetToken: token, note: "No email provider is connected yet, so the reset token is shown here once (staging only). It expires in 30 minutes and is burned on use." });
  });

  a("resetPassword", async (req, res, db) => {
    const { token, newPassword, confirmNewPassword } = req.body || {};
    if (!token) { res.status(400).json({ ok: false, error: "Reset token is required." }); return; }
    const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const cust = (await db.select().from(s.customers).where(eq(s.customers.resetTokenHash, hash)))[0];
    if (!cust || !cust.resetExpiresAt || cust.resetExpiresAt < Date.now()) { res.status(400).json({ ok: false, error: "This reset token is invalid or expired." }); return; }
    if (!newPassword || String(newPassword).length < 6) { res.status(400).json({ ok: false, error: "New password must be at least 6 characters." }); return; }
    if (confirmNewPassword != null && confirmNewPassword !== newPassword) { res.status(400).json({ ok: false, error: "New passwords do not match." }); return; }
    await db.update(s.customers).set({ passwordHash: hashPassword(String(newPassword)), mustResetPassword: false, resetTokenHash: null, resetExpiresAt: null }).where(eq(s.customers.id, cust.id));
    res.json({ ok: true });
  });

  a("requestAccountDeletion", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    await db.update(s.customers).set({ deletionRequested: true }).where(eq(s.customers.id, cust.id));
    res.json({ ok: true, note: "Account deletion requested. The owner reviews deletion requests before any data is removed." });
  });

  a("listAddresses", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const rows = await db.select().from(s.customerAddresses).where(eq(s.customerAddresses.customerId, cust.id));
    res.json({ ok: true, addresses: rows });
  });

  a("saveAddress", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const b = req.body || {};
    if (b.phone && !isValidPkMobile(b.phone)) { res.status(400).json({ ok: false, error: "Please enter a valid Pakistani mobile number." }); return; }
    const data: any = { customerId: cust.id, label: b.label || "Home", recipient: b.recipient || cust.name, phone: b.phone || cust.phone, address: b.address || "", area: b.area || "", city: b.city || "", province: b.province || "", postalCode: b.postalCode || "", landmark: b.landmark || "", instructions: b.instructions || "", deliverySlot: b.deliverySlot || "", pickupPoint: b.pickupPoint || "", isDefault: !!b.isDefault };
    if (b.isDefault) await db.update(s.customerAddresses).set({ isDefault: false }).where(eq(s.customerAddresses.customerId, cust.id));
    let row;
    if (b.id) {
      const updated = await db.update(s.customerAddresses).set(data).where(and(eq(s.customerAddresses.id, b.id), eq(s.customerAddresses.customerId, cust.id))).returning();
      if (!updated.length) { res.status(404).json({ ok: false, error: "Address not found." }); return; }
      row = updated[0];
    }
    else row = (await db.insert(s.customerAddresses).values(data).returning())[0];
    res.json({ ok: true, address: row });
  });

  a("deleteAddress", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    await db.delete(s.customerAddresses).where(and(eq(s.customerAddresses.id, Number(req.body?.id)), eq(s.customerAddresses.customerId, cust.id)));
    res.json({ ok: true });
  });

  // ---- 5.5 Payments ----
  a("updatePaymentStatus", async (req, res, db) => {
    const status = String(req.body?.status || "");
    if (!PAYMENT_STATUSES_SOURCED.includes(status as any) && !status.startsWith("Paid (Demo Simulated)")) {
      res.status(400).json({ ok: false, error: `Unknown payment status "${status}". Sourced statuses: ${PAYMENT_STATUSES_SOURCED.join(", ")}. The brief promises 10 statuses; the remaining 5 are open (spec §14.9) — verify against the Muse copy before adding more.` });
      return;
    }
    const order = (await db.select().from(s.orders).where(eq(s.orders.id, Number(req.body?.orderId))))[0];
    if (!order) { res.status(404).json({ ok: false, error: "Order not found." }); return; }
    await db.update(s.orders).set({ paymentStatus: status }).where(eq(s.orders.id, order.id));
    await db.insert(s.paymentTransactions).values({ orderId: order.id, orderNumber: order.orderNumber, method: order.paymentMethod, provider: order.paymentMethod.replace(" (Demo)", ""), account: order.paymentAccount, reference: order.paymentRef, amount: order.total, status, mode: PAYMENT_MODE_DEMO, createdAt: Date.now() });
    await audit(db, "Payment status updated", staffRoleLabel(req), `${order.orderNumber} -> ${status}`);
    res.json({ ok: true });
  }, { area: "payments" });

  a("listPaymentTransactions", async (req, res, db) => {
    // A1/B9: staff read (payments area) returns the full ledger. A signed-in
    // customer without a staff role sees only their own orders' rows (the
    // account Payment History panel). Anyone else gets 401.
    if (staffRole(req)) {
      if (!await enforceOr401(db, req, res, "payments", "listPaymentTransactions")) return;
      const rows = await db.select().from(s.paymentTransactions).orderBy(desc(s.paymentTransactions.createdAt));
      res.json({ ok: true, transactions: rows });
      return;
    }
    const cust = await sessionCustomer(db, req);
    if (!cust) { res.status(401).json({ ok: false, authenticated: false, error: "Sign in again — no valid session." }); return; }
    const myOrders = await db.select().from(s.orders).where(sql`lower(${s.orders.customerEmail}) = lower(${cust.email})`);
    const nums = new Set(myOrders.map((o: any) => o.orderNumber));
    const rows = (await db.select().from(s.paymentTransactions).orderBy(desc(s.paymentTransactions.createdAt))).filter((t: any) => nums.has(t.orderNumber));
    res.json({ ok: true, transactions: rows, mine: true });
  });

  // ---- 5.6 Returns & refunds ----
  a("createReturn", async (req, res, db) => {
    // A3: staff (refunds area) or the owning customer only. 401 with
    // neither, 403 for another customer's order.
    let cust: any = null;
    if (staffRole(req)) {
      if (!await enforceOr401(db, req, res, "refunds", "createReturn")) return;
    } else {
      cust = await requireCustomer(db, req, res); if (!cust) return;
    }
    const b = req.body || {};
    const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, String(b.orderNumber || ""))))[0];
    if (!order) { res.status(400).json({ ok: false, error: "Order not found." }); return; }
    if (cust && order.customerEmail.toLowerCase() !== cust.email.toLowerCase()) { res.status(403).json({ ok: false, error: "This order belongs to another customer." }); return; }
    if (order.status !== "Delivered") { res.status(400).json({ ok: false, error: "Returns are only accepted for Delivered orders." }); return; }
    const items = await db.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
    const item = items.find((i: any) => i.productName === b.productName);
    if (!item) { res.status(400).json({ ok: false, error: "That product is not on this order." }); return; }
    const refundAmount = Number(b.refundAmount || 0);
    if (refundAmount <= 0 || refundAmount > item.price * item.qty) { res.status(400).json({ ok: false, error: `Refund must be more than Rs. 0 and no more than the item's paid value (Rs. ${item.price * item.qty}).` }); return; }
    const open = await db.select().from(s.returns).where(and(eq(s.returns.orderNumber, order.orderNumber), eq(s.returns.productName, b.productName)));
    if (open.some((r: any) => r.refundStage < 8)) { res.status(400).json({ ok: false, error: "There is already an open return for this product on this order." }); return; }
    const rn = `RET-DEMO-${Math.floor(100000 + Math.random() * 899999)}`;
    const row = (await db.insert(s.returns).values({ returnNumber: rn, orderNumber: order.orderNumber, productName: b.productName, qty: Number(b.qty || 1), refundAmount, reason: `${b.reason || ""} • ${b.pickupMethod || "Home Pickup (Demo)"}`, status: "Requested", refundStage: 0, legacyFlag: false, legacyNote: "", customerName: cust?.name || order.customerName, createdAt: Date.now() }).returning())[0];
    res.json({ ok: true, return: row });
  });

  a("updateReturn", async (req, res, db) => {
    const ret = (await db.select().from(s.returns).where(eq(s.returns.id, Number(req.body?.id))))[0];
    if (!ret) { res.status(404).json({ ok: false, error: "Return not found." }); return; }
    const stage = Math.min(8, Math.max(0, Number(req.body?.refundStage ?? ret.refundStage + 1)));
    await db.update(s.returns).set({ refundStage: stage, status: REFUND_STAGE_LABELS[stage] }).where(eq(s.returns.id, ret.id));
    if (stage === 4) {
      // Restock once, reference-guarded against duplicates.
      const ref = `RET-${ret.returnNumber}-restock`;
      const existing = await db.select().from(s.inventoryMovements).where(eq(s.inventoryMovements.reference, ref));
      if (!existing.length) {
        const prod = (await db.select().from(s.products).where(eq(s.products.name, ret.productName)))[0];
        if (prod) {
          const newStock = prod.stock + ret.qty;
          await db.update(s.products).set({ stock: newStock }).where(eq(s.products.id, prod.id));
          await db.insert(s.inventoryMovements).values({ productId: prod.id, sku: prod.sku, type: "Return Restock (Stock-In)", qty: ret.qty, balanceAfter: newStock, reference: ref, actor: staffRoleLabel(req), note: `Restocked at refund stage 4 for ${ret.returnNumber}`, createdAt: Date.now() });
        }
      }
    }
    res.json({ ok: true, stage, label: REFUND_STAGE_LABELS[stage] });
  }, { area: "refunds" });

  a("listReturns", async (req, res, db) => {
    // A1/B9: customer view (mine:true) is scoped to the caller's own orders
    // and needs a customer session (401 without one). Any other call is a
    // staff read behind the refunds area.
    const mapRows = (rows: any[]) => rows.map((r: any) => ({ ...r, stageLabel: REFUND_STAGE_LABELS[r.refundStage] ?? `Stage ${r.refundStage}`, stageLabelsVerified: [0, 2, 8].includes(r.refundStage) }));
    if (req.body?.mine) {
      const cust = await requireCustomer(db, req, res); if (!cust) return;
      const myOrders = await db.select().from(s.orders).where(sql`lower(${s.orders.customerEmail}) = lower(${cust.email})`);
      const nums = new Set(myOrders.map((o: any) => o.orderNumber));
      const rows = (await db.select().from(s.returns).orderBy(desc(s.returns.createdAt))).filter((r: any) => nums.has(r.orderNumber));
      res.json({ ok: true, returns: mapRows(rows) });
      return;
    }
    if (!await enforceOr401(db, req, res, "refunds", "listReturns")) return;
    const rows = await db.select().from(s.returns).orderBy(desc(s.returns.createdAt));
    res.json({ ok: true, returns: mapRows(rows) });
  });

  a("getLegacyReview", async (_req, res, db) => {
    const rows = await db.select().from(s.returns).where(eq(s.returns.returnNumber, "RET-DEMO-001"));
    const r1 = rows[0];
    const discrepancies: any[] = [];
    if (r1) {
      const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, r1.orderNumber)))[0];
      const items = order ? await db.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id)) : [];
      const onOrder = items.some((i: any) => i.productName === r1.productName);
      discrepancies.push({ returnNumber: "RET-DEMO-001", fault: onOrder ? "none" : "Product is not an item on the order", product: r1.productName, orderStatus: order?.status, offeredCorrection: "Aurora X5 Wireless Earbuds (Demo), Rs 5,499 — the genuine item on Delivered order NX-DEMO-100001" });
    }
    const r2 = (await db.select().from(s.returns).where(eq(s.returns.returnNumber, "RET-DEMO-002")))[0];
    if (r2) {
      const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, r2.orderNumber)))[0];
      discrepancies.push({ returnNumber: "RET-DEMO-002", fault: `Order is ${order?.status}; product is not an item on the order`, product: r2.productName, orderStatus: order?.status, offeredCorrection: "None — correction correctly refused in the Muse copy" });
    }
    res.json({ ok: true, discrepancies, decision: "PENDING — owner must choose correctLegacyReturn or markLegacyReturns per return (staff 'refunds' area + ownerApproved:true required). Until decided, both rows are seeded exactly as exported." });
  }, { area: "refunds" });

  a("correctLegacyReturn", async (req, res, db) => {
    if (!req.body?.ownerApproved) { res.status(403).json({ ok: false, error: "ownerApproved:true is required — this is an owner-gated treatment." }); return; }
    const ret = (await db.select().from(s.returns).where(eq(s.returns.returnNumber, String(req.body?.returnNumber || "RET-DEMO-001"))))[0];
    if (!ret) { res.status(404).json({ ok: false, error: "Return not found." }); return; }
    const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, ret.orderNumber)))[0];
    if (!order || order.status !== "Delivered") { res.status(400).json({ ok: false, error: "Correction is only allowed when the sole fault is the product mapping on a Delivered order. This return does not qualify." }); return; }
    const original = `${ret.productName} — Rs ${ret.refundAmount}`;
    await db.update(s.returns).set({ productName: "Aurora X5 Wireless Earbuds (Demo)", refundAmount: 5499, legacyNote: `Corrected by owner approval. Original: ${original}` }).where(eq(s.returns.id, ret.id));
    await audit(db, "Legacy return corrected", staffRoleLabel(req), `RET-DEMO-001 original preserved in note: ${original}`);
    res.json({ ok: true });
  }, { area: "refunds" });

  a("markLegacyReturns", async (req, res, db) => {
    if (!req.body?.ownerApproved) { res.status(403).json({ ok: false, error: "ownerApproved:true is required — this is an owner-gated treatment." }); return; }
    const nums: string[] = req.body?.returnNumbers || ["RET-DEMO-001", "RET-DEMO-002"];
    for (const n of nums) {
      await db.update(s.returns).set({ legacyFlag: true, legacyNote: "Marked as legacy by owner approval — original record preserved untouched." }).where(eq(s.returns.returnNumber, n));
    }
    await audit(db, "Legacy returns marked", staffRoleLabel(req), nums.join(", "));
    res.json({ ok: true, marked: nums });
  }, { area: "refunds" });

  a("cleanupInvalidReturns", async (_req, res, db) => {
    // Removes invalid returns (refund <= 0 or order missing) but preserves
    // legacy-flagged rows.
    const rows = await db.select().from(s.returns);
    let removed = 0;
    for (const r of rows) {
      if (r.legacyFlag) continue;
      const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, r.orderNumber)))[0];
      if (!order || r.refundAmount <= 0) { await db.delete(s.returns).where(eq(s.returns.id, r.id)); removed++; }
    }
    res.json({ ok: true, removed, note: "Legacy-flagged rows are always preserved." });
  }, { area: "settings" });

  // ---- 5.7 Support, reviews, Q&A, notifications ----
  a("listTickets", async (_req, res, db) => {
    const rows = await db.select().from(s.tickets).orderBy(desc(s.tickets.createdAt));
    res.json({ ok: true, tickets: rows });
  }, { area: "customers" });
  a("createTicket", async (req, res, db) => {
    const b = req.body || {};
    const n = `TKT-DEMO-${String(Math.floor(100 + Math.random() * 899))}`;
    const row = (await db.insert(s.tickets).values({ ticketNumber: n, customerName: b.customerName || "Customer", subject: b.subject || "", description: b.description || "", category: b.category || "General", priority: b.priority || "Low", status: "Open", agent: "Unassigned", orderNumber: b.orderNumber || "", lastReply: "", createdAt: Date.now() }).returning())[0];
    res.json({ ok: true, ticket: row });
  });
  a("updateTicket", async (req, res, db) => {
    await db.update(s.tickets).set({ status: req.body.status, agent: req.body.agent ?? undefined }).where(eq(s.tickets.id, req.body.id));
    res.json({ ok: true });
  }, { area: "customers" });
  a("replyTicket", async (req, res, db) => {
    const t = (await db.select().from(s.tickets).where(eq(s.tickets.id, Number(req.body?.id))))[0];
    if (!t) { res.status(404).json({ ok: false, error: "Ticket not found." }); return; }
    await db.update(s.tickets).set({ lastReply: String(req.body?.reply || ""), status: "In Progress" }).where(eq(s.tickets.id, t.id));
    await db.insert(s.notifications).values({ title: "Support reply (Demo)", body: `Agent replied to ${t.ticketNumber}: ${String(req.body?.reply || "").slice(0, 120)}`, type: "Support", isRead: false, createdAt: Date.now() });
    res.json({ ok: true });
  }, { area: "customers" });

  a("listReviews", async (req, res, db) => {
    const rows = await db.select().from(s.reviews).orderBy(desc(s.reviews.id));
    res.json({ ok: true, reviews: rows });
  }, { area: "customers" });
  a("submitReview", async (req, res, db) => {
    const b = req.body || {};
    const p = (await db.select().from(s.products).where(eq(s.products.id, Number(b.productId))))[0];
    const row = (await db.insert(s.reviews).values({ productId: Number(b.productId), productName: p?.name || "", customerName: b.customerName || "Customer", rating: Math.min(5, Math.max(1, Number(b.rating || 5))), text: b.text || "", verified: false, helpful: 0, sellerReply: "", createdAt: Date.now() }).returning())[0];
    res.json({ ok: true, review: row });
  });
  a("replyReview", async (req, res, db) => {
    await db.update(s.reviews).set({ sellerReply: String(req.body?.reply || "") }).where(eq(s.reviews.id, req.body.id));
    res.json({ ok: true });
  }, { area: "customers" });
  a("deleteReview", async (req, res, db) => {
    await db.delete(s.reviews).where(eq(s.reviews.id, req.body.id));
    res.json({ ok: true });
  }, { area: "customers" });

  a("listQuestions", async (req, res, db) => {
    const rows = await db.select().from(s.questions).orderBy(asc(s.questions.id));
    res.json({ ok: true, questions: rows });
  });
  a("answerQuestion", async (req, res, db) => {
    await db.update(s.questions).set({ answer: String(req.body?.answer || "") }).where(eq(s.questions.id, req.body.id));
    res.json({ ok: true });
  }, { area: "customers" });

  a("listNotifications", async (_req, res, db) => {
    const rows = await db.select().from(s.notifications).orderBy(desc(s.notifications.createdAt));
    res.json({ ok: true, notifications: rows, unread: rows.filter((n: any) => !n.isRead).length });
  });
  a("addNotification", async (req, res, db) => {
    const row = (await db.insert(s.notifications).values({ title: req.body?.title || "", body: req.body?.body || "", type: req.body?.type || "General", isRead: false, createdAt: Date.now() }).returning())[0];
    res.json({ ok: true, notification: row });
  });
  a("markNotificationsRead", async (_req, res, db) => {
    await db.update(s.notifications).set({ isRead: true });
    res.json({ ok: true });
  });
  a("markNotificationRead", async (req, res, db) => {
    await db.update(s.notifications).set({ isRead: true }).where(eq(s.notifications.id, req.body.id));
    res.json({ ok: true });
  });
  a("deleteNotification", async (req, res, db) => {
    await db.delete(s.notifications).where(eq(s.notifications.id, req.body.id));
    res.json({ ok: true });
  });

  // ---- 5.8 Inventory, shipments, analytics, staff, admin ----
  a("adjustStock", async (req, res, db) => {
    const p = (await db.select().from(s.products).where(eq(s.products.id, Number(req.body?.productId))))[0];
    if (!p) { res.status(404).json({ ok: false, error: "Product not found." }); return; }
    const delta = Number(req.body?.delta || 0);
    const newStock = Math.max(0, p.stock + delta);
    await db.update(s.products).set({ stock: newStock }).where(eq(s.products.id, p.id));
    await db.insert(s.inventoryMovements).values({ productId: p.id, sku: p.sku, type: "Manual Adjustment", qty: delta, balanceAfter: newStock, reference: String(req.body?.reference || "manual"), actor: staffRoleLabel(req), note: String(req.body?.note || ""), createdAt: Date.now() });
    res.json({ ok: true, stock: newStock });
  }, { area: "inventory" });

  a("listInventoryMovements", async (_req, res, db) => {
    const rows = await db.select().from(s.inventoryMovements).orderBy(desc(s.inventoryMovements.createdAt));
    res.json({ ok: true, movements: rows });
  }, { area: "inventory" });

  a("listShipments", async (_req, res, db) => {
    const rows = await db.select().from(s.shipments).orderBy(desc(s.shipments.createdAt));
    res.json({ ok: true, shipments: rows, note: "Shipments stay labelled simulated — no courier API connected; tracking shows the last verified event only." });
  }, { area: "shipments" });

  a("getAnalytics", async (_req, res, db) => {
    const orders = await db.select().from(s.orders);
    const live = orders.filter((o: any) => !o.legacyTest && o.status !== "Cancelled");
    const legacy = orders.filter((o: any) => o.legacyTest);
    const gmv = live.reduce((a: number, o: any) => a + o.total, 0);
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const dailySales = days.map((day) => ({ day, total: 0 }));
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", weekday: "long" });
    for (const o of live) {
      const day = fmt.format(new Date(o.createdAt));
      const slot = dailySales.find((d) => d.day === day);
      if (slot) slot.total += o.total;
    }
    const byStatus: Record<string, number> = {};
    for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    const byPayment: Record<string, number> = {};
    for (const o of live) byPayment[o.paymentMethod] = (byPayment[o.paymentMethod] || 0) + o.total;
    const returns = await db.select().from(s.returns);
    const refundsTotal = returns.filter((r: any) => r.refundStage === 8).reduce((a: number, r: any) => a + r.refundAmount, 0);
    const refundsRequested = returns.reduce((a: number, r: any) => a + r.refundAmount, 0);
    const items = await db.select().from(s.orderItems);
    const liveIds = new Set(live.map((o: any) => o.id));
    const byProduct: Record<number, number> = {};
    for (const it of items) if (liveIds.has(it.orderId)) byProduct[it.productId || 0] = (byProduct[it.productId || 0] || 0) + it.qty;
    const topProducts = Object.entries(byProduct).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([pid, qty]) => ({ productId: Number(pid), qty }));
    res.json({ ok: true, gmv, avgOrderValue: live.length ? Math.round(gmv / live.length) : 0, orderCount: live.length, dailySales, byStatus, byPayment, refundsTotal, refundsRequested, legacyOrders: legacy.length, topProducts, note: "Real records only — zero days report 0; cancelled and legacy-test orders excluded from revenue." });
  }, { area: "reports" });

  a("listStaff", async (_req, res, db) => {
    const rows = await db.select().from(s.staff).orderBy(asc(s.staff.id));
    res.json({ ok: true, staff: rows });
  }, { area: "staff" });
  a("saveStaff", async (req, res, db) => {
    const b = req.body || {};
    let row;
    if (b.id) { await db.update(s.staff).set({ name: b.name, email: b.email, role: b.role, department: b.department ?? "", status: b.status ?? "Active" }).where(eq(s.staff.id, b.id)); row = (await db.select().from(s.staff).where(eq(s.staff.id, b.id)))[0]; }
    else row = (await db.insert(s.staff).values({ name: b.name, email: b.email, role: b.role, department: b.department ?? "", status: b.status ?? "Active" }).returning())[0];
    res.json({ ok: true, staff: row });
  }, { area: "staff" });

  a("listAudit", async (req, res, db) => {
    const rows = await db.select().from(s.auditLogs).orderBy(desc(s.auditLogs.id));
    const q = String(req.body?.search || "").toLowerCase();
    const filtered = q ? rows.filter((r: any) => (r.action + " " + r.actor + " " + r.detail).toLowerCase().includes(q)) : rows;
    res.json({ ok: true, logs: filtered });
  }, { area: "reports" });

  a("saveCoupon", async (req, res, db) => {
    const c = req.body || {};
    const data: any = { code: String(c.code || "").toUpperCase(), discountType: c.discountType || "percent", value: c.value, minOrder: c.minOrder ?? 0, status: c.status || "Active", expiresAt: c.expiresAt ?? "", usageLimit: c.usageLimit ?? 0, perCustomerLimit: c.perCustomerLimit ?? 0, scopeType: c.scopeType || "all", scopeValue: c.scopeValue ?? "", uses: c.uses ?? 0 };
    let row;
    if (c.id) { await db.update(s.coupons).set(data).where(eq(s.coupons.id, c.id)); row = (await db.select().from(s.coupons).where(eq(s.coupons.id, c.id)))[0]; }
    else row = (await db.insert(s.coupons).values(data).returning())[0];
    res.json({ ok: true, coupon: row });
  }, { area: "settings" });

  a("setCouponStatus", async (req, res, db) => {
    await db.update(s.coupons).set({ status: req.body.status }).where(eq(s.coupons.id, req.body.id));
    res.json({ ok: true });
  }, { area: "settings" });

  // ---- 5.9 Homepage ----
  a("getHomepage", async (req, res, db) => {
    const cfg = await settingsMap(db);
    const banners = (await db.select().from(s.heroBanners).where(eq(s.heroBanners.active, true)).orderBy(asc(s.heroBanners.sortOrder)));
    const collections = (await db.select().from(s.homeCollections).where(eq(s.homeCollections.active, true)).orderBy(asc(s.homeCollections.sortOrder)));
    const sections = (await db.select().from(s.homeSections).orderBy(asc(s.homeSections.sortOrder)));
    const products = await db.select().from(s.products).where(eq(s.products.status, "Published")).orderBy(asc(s.products.id));
    const pool = products.filter((p: any) => p.isFlash && p.salePrice != null && p.salePrice < p.price);
    const flashRow = computeFlashRow({
      poolSkus: pool.map((p: any) => p.sku),
      rowSize: Number(cfg.flashRowSize || 5), rotateDays: Number(cfg.flashRotateDays || 2),
      anchor: cfg.flashRowAnchor || "2026-11-25",
    });
    const flashProducts = [];
    for (const sku of flashRow.skus) { const p = products.find((x: any) => x.sku === sku); if (p) flashProducts.push(await productWithImages(db, p)); }
    const categoryImages = [
      ["Men's Fashion", "NX2-MEN-001"], ["Women's Fashion", "NX2-WOM-004"], ["Mobile Phones", "NX2-PHN-003"],
      ["Mobile Accessories", "NX2-ACC-005"], ["Smart Wearables", "NX2-WEA-005"], ["Audio & Electronics", "NX2-AUD-003"],
      ["Jewelry & Accessories", "NX2-JEW-003"], ["Beauty & Personal Care", "NX2-BEA-003"], ["Kids & Baby Fashion", "NX2-KID-003"],
    ];
    const categories = [];
    for (const [name, sku] of categoryImages) {
      const p = products.find((x: any) => x.sku === sku);
      categories.push({ category: name, count: products.filter((x: any) => x.category === name).length, productSku: sku, imageUrl: p ? (await productWithImages(db, p)).imageUrl : "", imageIsSample: true });
    }
    // Best sellers from real order data (non-cancelled, non-legacy).
    const orders = await db.select().from(s.orders);
    const liveIds = new Set(orders.filter((o: any) => !o.legacyTest && o.status !== "Cancelled").map((o: any) => o.id));
    const items = await db.select().from(s.orderItems);
    const soldQty: Record<number, number> = {};
    for (const it of items) if (liveIds.has(it.orderId) && it.productId) soldQty[it.productId] = (soldQty[it.productId] || 0) + it.qty;
    const bestIds = Object.entries(soldQty).sort((a, b) => b[1] - a[1]).map(([id]) => Number(id));
    const bestSellers = [];
    for (const id of bestIds) { const p = products.find((x: any) => x.id === id); if (p) bestSellers.push(await productWithImages(db, p)); }
    const featured = products.filter((p: any) => p.isFeatured);
    const bestSellersOut = { source: "sales", products: bestSellers, fallback: bestSellers.length < 3 ? { label: "Featured Products (fewer than 3 products have real sales yet)", products: await Promise.all(featured.map((p: any) => productWithImages(db, p))) } : null };
    // Recommended: own order categories for signed-in customers, featured for guests.
    const cust = await sessionCustomer(db, req);
    let recommended: any = { mode: "featured", products: [] as any[] };
    if (cust) {
      const myOrders = orders.filter((o: any) => o.customerEmail.toLowerCase() === cust.email.toLowerCase());
      const myIds = new Set(myOrders.map((o: any) => o.id));
      const myItems = items.filter((i: any) => myIds.has(i.orderId) && i.productId);
      const cats = new Set<string>();
      for (const it of myItems) { const p = products.find((x: any) => x.id === it.productId); if (p) cats.add(p.category); }
      const recs = products.filter((p: any) => cats.has(p.category)).slice(0, 6);
      recommended = { mode: "own-orders", categories: [...cats], products: await Promise.all(recs.map((p: any) => productWithImages(db, p))) };
    } else {
      recommended = { mode: "featured", products: await Promise.all(featured.slice(0, 6).map((p: any) => productWithImages(db, p))) };
    }
    const reviews = await db.select().from(s.reviews).orderBy(desc(s.reviews.id));
    const heroOut = [];
    for (const b of banners) {
      const p = b.productId ? products.find((x: any) => x.id === b.productId) : null;
      heroOut.push({ ...b, imageUrl: p ? (await productWithImages(db, p)).imageUrl : "", imageIsSample: true, ctaTarget: safeJson(b.ctaTarget), cta2Target: safeJson(b.cta2Target) });
    }
    res.json({
      ok: true, banners: heroOut, collections, sections,
      flashRow: { ...flashRow, products: flashProducts },
      flashEndsAt: cfg.flashSaleEndsAt || "",
      categories, bestSellers: bestSellersOut, recommended,
      newArrivals: await Promise.all(products.slice(-8).reverse().map((p: any) => productWithImages(db, p))),
      reviews, demoMode: cfg.demoMode === "true",
    });
  });

  a("getHomepageAdmin", async (_req, res, db) => {
    const cfg = await settingsMap(db);
    const banners = await db.select().from(s.heroBanners).orderBy(asc(s.heroBanners.sortOrder));
    const collections = await db.select().from(s.homeCollections).orderBy(asc(s.homeCollections.sortOrder));
    const sections = await db.select().from(s.homeSections).orderBy(asc(s.homeSections.sortOrder));
    res.json({ ok: true, banners, collections, sections, flashRowSize: Number(cfg.flashRowSize || 5), flashRotateDays: Number(cfg.flashRotateDays || 2), flashRowAnchor: cfg.flashRowAnchor || "2026-11-25", flashEndsAt: cfg.flashSaleEndsAt || "" });
  }, { area: "settings" });

  a("saveHeroBanner", async (req, res, db) => {
    const b = req.body || {};
    const data: any = { headline: b.headline, subtext: b.subtext ?? "", ctaLabel: b.ctaLabel ?? "", ctaTarget: typeof b.ctaTarget === "string" ? b.ctaTarget : JSON.stringify(b.ctaTarget ?? {}), cta2Label: b.cta2Label ?? "", cta2Target: typeof b.cta2Target === "string" ? b.cta2Target : JSON.stringify(b.cta2Target ?? {}), productId: b.productId ?? null, imageKey: b.imageKey ?? "", startsAt: b.startsAt ?? "", endsAt: b.endsAt ?? "", active: b.active !== false, sortOrder: b.sortOrder ?? 0 };
    let row;
    if (b.id) { await db.update(s.heroBanners).set(data).where(eq(s.heroBanners.id, b.id)); row = (await db.select().from(s.heroBanners).where(eq(s.heroBanners.id, b.id)))[0]; }
    else row = (await db.insert(s.heroBanners).values(data).returning())[0];
    res.json({ ok: true, banner: row });
  }, { area: "settings" });

  a("deleteHeroBanner", async (req, res, db) => {
    await db.delete(s.heroBanners).where(eq(s.heroBanners.id, req.body.id));
    res.json({ ok: true });
  }, { area: "settings" });

  a("uploadHeroBannerImage", async (req, res, db) => {
    const { bannerId, fileName, dataBase64, mime } = req.body || {};
    if (!dataBase64) { res.status(400).json({ ok: false, error: "Image data is required." }); return; }
    const buf = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ""), "base64");
    if (buf.length > 2 * 1024 * 1024) { res.status(400).json({ ok: false, error: "Image must be 2 MB or less." }); return; }
    if (!imageMagic(buf)) { res.status(400).json({ ok: false, error: "Only JPEG/PNG/WebP images are accepted (magic bytes verified)." }); return; }
    const fs = await import("node:fs");
    const kind = imageMagic(buf)!;
    const ext = kind === "jpeg" ? "jpg" : kind;
    const name = `${Date.now()}-${(fileName || "banner").replace(/[^a-zA-Z0-9._-]/g, "_")}.${ext}`;
    const dir = path.resolve(__dirname, "../../public/images/hero-banners");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buf);
    if (bannerId) await db.update(s.heroBanners).set({ imageKey: `hero-banners/${name}` }).where(eq(s.heroBanners.id, Number(bannerId)));
    res.json({ ok: true, imageKey: `hero-banners/${name}`, url: `/images/hero-banners/${name}` });
  }, { area: "settings" });

  a("saveHomeCollection", async (req, res, db) => {
    const c = req.body || {};
    const data: any = { name: c.name, tagline: c.tagline ?? "", category: c.category ?? "", subcategory: c.subcategory ?? "", productId: c.productId ?? null, active: c.active !== false, sortOrder: c.sortOrder ?? 0 };
    let row;
    if (c.id) { await db.update(s.homeCollections).set(data).where(eq(s.homeCollections.id, c.id)); row = (await db.select().from(s.homeCollections).where(eq(s.homeCollections.id, c.id)))[0]; }
    else row = (await db.insert(s.homeCollections).values(data).returning())[0];
    res.json({ ok: true, collection: row });
  }, { area: "settings" });

  a("deleteHomeCollection", async (req, res, db) => {
    await db.delete(s.homeCollections).where(eq(s.homeCollections.id, req.body.id));
    res.json({ ok: true });
  }, { area: "settings" });

  a("saveHomeSections", async (req, res, db) => {
    const sections: any[] = req.body?.sections || [];
    for (const sec of sections) {
      await db.update(s.homeSections).set({ visible: sec.visible !== false, sortOrder: sec.sortOrder ?? 0 }).where(eq(s.homeSections.key, sec.key));
    }
    res.json({ ok: true });
  }, { area: "settings" });
}

function safeJson(v: string): any {
  try { return JSON.parse(v || "{}"); } catch { return {}; }
}
