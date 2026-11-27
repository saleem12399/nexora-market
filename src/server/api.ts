// API — REST endpoints mirroring the REBUILD-SPEC.md §5 action surface.
// Every action name from the spec exists as POST /api/<actionName> (plus a
// few GET conveniences). No DB -> 503 {"error":"database not configured"}.
// Payments, courier and tracking are not connected to live providers;
// customer views show neutral wording (no real-payment/shipment claims).
// no live gateway, courier or messaging provider is connected.

import crypto from "node:crypto";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, gte, inArray, like, lt, lte, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import * as s from "../db/schema";
import { hashPassword, hashSessionToken, isLegacySha256Hash, newResetToken, newSessionToken, RESET_TOKEN_TTL_MS, SESSION_TTL_MS, verifyLegacySha256, verifyPassword } from "../lib/auth";
import { clientIp, rateLimited, rateLimitBody } from "../lib/rate-limit";
import { OWNER_ROLE } from "../lib/roles";
import { newTotpSecret, totpAuthUrl, totpSecretDisplay, verifyTotp } from "../lib/totp";
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

async function audit(db: TxDb, action: string, actor: string, detail: string) {
  try { await db.insert(s.auditLogs).values({ action, actor, detail, createdAt: Date.now() }); } catch { /* audit must never break the action */ }
}

// Phase 1 (A1) + Phase 2: there is now a REAL staff session system
// (staff table has passwordHash + TOTP, staff_sessions table, HttpOnly
// cookie nx_staff_token). staffRole() reads the SERVER session only —
// the client-asserted x-nexora-role header and body.staffRole are GONE:
// supplying them no longer grants anything (a caller who sends
// x-nexora-role: Super Admin gets 401, as before, but now also with a
// real session system behind it). The fail-closed rule is: NO staff
// session at all => 401 StaffAuthRequiredError. A session whose role
// lacks the area => 403 PermissionDeniedError. Never default to Super
// Admin.
export class StaffAuthRequiredError extends Error {
  constructor() { super("Staff sign-in required — no staff role was supplied."); this.name = "StaffAuthRequiredError"; }
}

// F4: a business failure inside a multi-write flow must THROW so the
// Drizzle transaction rolls back, instead of returning {ok:false} after
// partial writes have already happened.
export class OrderError extends Error {
  status: number; errors?: any;
  constructor(status: number, message: string, errors?: any) { super(message); this.name = "OrderError"; this.status = status; this.errors = errors; }
}

// The transaction client type (for placeOrderInternal/cancelOrder/
// updateReturn, which run inside db.transaction).
type TxDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Staff session cookie (HttpOnly). The same token is accepted as a Bearer
// token for API/curl use; the cookie is what the browser admin UI uses.
const STAFF_COOKIE = "nx_staff_token";
const REAUTH_WINDOW_MS = 10 * 60 * 1000; // destructive actions need a fresh re-auth

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie || "";
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function staffTokenFromRequest(req: Request): string | null {
  const cookies = parseCookies(req);
  if (cookies[STAFF_COOKIE]) return cookies[STAFF_COOKIE];
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

function setStaffCookie(req: Request, res: Response, token: string) {
  if (typeof (res as any).cookie !== "function") return;
  const secure = (req as any).secure || req.headers["x-forwarded-proto"] === "https";
  (res as any).cookie(STAFF_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS });
}

function clearStaffCookie(res: Response) {
  if (typeof (res as any).clearCookie === "function") (res as any).clearCookie(STAFF_COOKIE, { path: "/" });
}

// Staff rows must never leak credentials: strip them everywhere a staff
// row is returned (getBootstrap, listStaff, saveStaff, getStaffSession).
// The UI still needs to know the activation state, so two SAFE booleans
// are exposed (never the hash/secret/token itself).
function publicStaffRow(st: any) {
  if (!st) return null;
  const { passwordHash, totpSecret, setupTokenHash, ...rest } = st;
  return { ...rest, hasPassword: !!passwordHash, setupPending: !!setupTokenHash };
}

async function sessionStaff(db: Db, req: Request): Promise<{ staff: any; session: any } | null> {
  const token = staffTokenFromRequest(req);
  if (!token) return null;
  const rows = await db.select().from(s.staffSessions).where(eq(s.staffSessions.tokenHash, hashSessionToken(token)));
  const sess = rows[0];
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) {
    // B17: purge the expired session row instead of leaving it forever.
    await db.delete(s.staffSessions).where(eq(s.staffSessions.id, sess.id));
    return null;
  }
  const st = (await db.select().from(s.staff).where(eq(s.staff.id, sess.staffId)))[0];
  if (!st || st.status !== "Active") return null;
  return { staff: st, session: sess };
}

function staffRole(req: Request): string | null {
  return (req as any).staff?.role ?? null;
}

function staffSession(req: Request): any | null {
  return (req as any).staffSession ?? null;
}

// Real identity for audit/actor fields — NEVER used as authorisation
// (that is staffRole, from the server session).
function staffRoleLabel(req: Request): string {
  const st = (req as any).staff;
  return st ? `staff:${st.name} <${st.email}> (${st.role})` : "anonymous";
}

// Destructive actions (legacy-return correction, invalid-return cleanup,
// cancelled-order purge) need a password+TOTP re-auth within the last
// 10 minutes. Returns true when the caller may proceed, else sends the
// 403 and returns false.
async function requireStaffReauth(db: Db, req: Request, res: Response, actionName: string): Promise<boolean> {
  const sess = staffSession(req);
  if (!sess || !sess.reauthAt || Date.now() - sess.reauthAt > REAUTH_WINDOW_MS) {
    await audit(db, "RE-AUTH REQUIRED", staffRoleLabel(req), `${actionName} — destructive action needs a fresh password + authenticator confirmation`);
    res.status(403).json({ ok: false, reauthRequired: true, error: "Confirm your password and authenticator code to continue — this action needs a fresh sign-in confirmation." });
    return false;
  }
  return true;
}

// Staff password rule (new staff/owner passwords only): 8+ characters
// with at least one letter and one number. Customer passwords keep the
// existing 6+ rule (C16 unifies this in Phase 3).
function validStaffPassword(pw: string): boolean {
  return typeof pw === "string" && pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

async function createStaffSession(db: Db, staffId: number): Promise<string> {
  const { token, tokenHash } = newSessionToken();
  await db.insert(s.staffSessions).values({ staffId, tokenHash, expiresAt: Date.now() + SESSION_TTL_MS, reauthAt: null, createdAt: Date.now() });
  return token;
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
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) {
    // B17: purge the expired session row instead of leaving it forever.
    await db.delete(s.customerSessions).where(eq(s.customerSessions.id, sess.id));
    return null;
  }
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

// F1: batch-load product images — ONE SELECT ... WHERE productId IN (...)
// for a whole page/list, instead of one SELECT per product (N+1). The
// shape is identical to productWithImages; images stay ordered by
// sortOrder within each product.
async function productsWithImages(db: Db, products: any[]) {
  if (!products.length) return [];
  const ids = products.map((p: any) => p.id);
  const imgs = await db.select().from(s.productImages).where(inArray(s.productImages.productId, ids)).orderBy(asc(s.productImages.sortOrder));
  const byProduct = new Map<number, any[]>();
  for (const img of imgs) {
    const arr = byProduct.get(img.productId) || [];
    arr.push(img);
    byProduct.set(img.productId, arr);
  }
  return products.map((p: any) => {
    const list = byProduct.get(p.id) || [];
    return {
      ...p, sellerName: OFFICIAL_STORE_NAME,
      images: list.map((i: any) => ({ id: i.id, url: imageUrlOf(i), storageKey: i.storageKey, fileName: i.fileName, sortOrder: i.sortOrder, isSample: !!i.isSample })),
      imageUrl: list[0] ? imageUrlOf(list[0]) : "", imageIsSample: list[0] ? !!list[0].isSample : false,
    };
  });
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
        // Resolve the staff session once per request (no token => null,
        // no DB query). Every staff-gated handler reads req.staff from
        // here; nothing is ever taken from a header or the request body.
        const st = await sessionStaff(db, req);
        (req as any).staff = st?.staff || null;
        (req as any).staffSession = st?.session || null;
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
    const staff = (await db.select().from(s.staff)).map(publicStaffRow);
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

  // B22: saveSettings has a server-side allow-list. Anything not on it
  // is REJECTED (400, listing the rejected keys) — especially
  // bigTestReport, backupSnapshot, globalCommission, exportedAt/source
  // and the profile verification/member-since markers, which must never
  // be writable through this endpoint. provider_*_status keys stay
  // settings-area-only (the wrapper already enforces the area).
  const SETTINGS_EDITABLE = new Set([
    "brandName", "tagline", "accentColor", "primaryColor", "secondaryColor",
    "country", "currency", "currencySymbol", "language", "secondaryLanguage",
    "timezone", "freeShippingThreshold", "standardShippingFee",
    "expressShippingFee", "flashRowSize", "flashRotateDays", "flashRowAnchor",
    "flashSaleEndsAt", "supportEmail", "supportPhone",
    "profileName", "profileEmail", "profilePhone", "profileAddress",
    "profileCity", "profileProvince", "profileLanguage",
    "demoMode", "catalogV2",
  ]);
  a("saveSettings", async (req, res, db) => {
    const entries = req.body?.settings || req.body || {};
    const rejected: string[] = [];
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== "string") continue;
      const okKey = SETTINGS_EDITABLE.has(k) || /^provider_[a-z]+_status$/.test(k);
      if (!okKey) { rejected.push(k); continue; }
      if (k.startsWith("provider_")) enforce(req, "settings");
      await db.insert(s.settings).values({ key: k, value: v }).onConflictDoUpdate({ target: s.settings.key, set: { value: v } });
    }
    if (rejected.length) { res.status(400).json({ ok: false, error: `These settings keys are not editable through this endpoint: ${rejected.join(", ")}` }); return; }
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
    res.json({ ok: true, allowed: t.allowed, denied: t.denied, checks: t.checks, liveDenied: denied, liveAllowed: allowed, note: "Reference: 52 allowed / 58 denied (110 checks, 10 roles x 11 areas)." });
  }, { area: "reports" });

  a("runCorrectionAndJourney", async (_req, res, db) => {
    const cfg = await settingsMap(db);
    const report = parseStoredReport(cfg.bigTestReport);
    res.json({ ok: true, alreadyRan: true, report, reportUnparseable: !!cfg.bigTestReport && report === null, note: "Idempotent: re-runs return the stored report. This action must NOT be re-runnable into duplicate data; the journey is re-proven by placing a fresh order through createOrder/advanceOrder in the rebuilt service." });
  }, { area: "reports" });

  // ---- 5.2 Catalogue ----
  a("listProducts", async (req, res, db) => {
    const b = req.body || {};
    // F2: filters, sort, limit/offset and the COUNT all run in SQL now
    // (the old code fetched every product and filtered/sorted in JS).
    // B6: price sorts use the EFFECTIVE (sale) price; B7: newest sorts
    // by published_at; B1: flash is the 11-product pool.
    const effPrice = sql`CASE WHEN ${s.products.salePrice} IS NOT NULL AND ${s.products.salePrice} < ${s.products.price} THEN ${s.products.salePrice} ELSE ${s.products.price} END`;
    const discountFrac = sql`CASE WHEN ${s.products.salePrice} IS NOT NULL AND ${s.products.salePrice} < ${s.products.price} THEN (${s.products.price} - ${s.products.salePrice})::float / ${s.products.price} ELSE 0 END`;
    const escLike = (v: string) => String(v).replace(/[%_\\]/g, "\\$&");
    const conds: any[] = [];
    if (b.category) conds.push(eq(s.products.category, b.category));
    if (b.subcategory) conds.push(eq(s.products.subcategory, b.subcategory));
    // C3 (Phase 3): search covers name, brand, SKU, shortDesc,
    // description AND specs (SQL LIKE, escaped) — "AMOLED", "bio-washed"
    // and "5ATM" must all hit. D5: price filters use the EFFECTIVE
    // (sale) price, the price the customer sees and pays — not list price.
    if (b.search) conds.push(like(sql`lower(${s.products.name} || ' ' || ${s.products.brand} || ' ' || ${s.products.sku} || ' ' || ${s.products.shortDesc} || ' ' || ${s.products.description} || ' ' || ${s.products.specs})`, `%${escLike(String(b.search).toLowerCase())}%`));
    if (b.minPrice != null) conds.push(gte(effPrice, Number(b.minPrice)));
    if (b.maxPrice != null) conds.push(lte(effPrice, Number(b.maxPrice)));
    if (b.minRating != null) conds.push(gte(s.products.rating, Number(b.minRating)));
    if (b.inStock) conds.push(sql`${s.products.stock} > 0`);
    if (b.onDiscount) conds.push(sql`${s.products.salePrice} IS NOT NULL AND ${s.products.salePrice} < ${s.products.price}`);
    if (b.flash) conds.push(and(eq(s.products.isFlash, true), sql`${s.products.salePrice} IS NOT NULL AND ${s.products.salePrice} < ${s.products.price}`));
    if (b.color) conds.push(like(sql`lower(${s.products.colors})`, `%${escLike(String(b.color).toLowerCase())}%`));
    if (b.size) conds.push(like(s.products.sizes, `%${escLike(String(b.size))}%`));
    const where = conds.length ? and(...conds) : undefined;
    let orderBy: any[] = [asc(s.products.id)];
    if (b.sort === "biggest-discount") orderBy = [desc(discountFrac), asc(s.products.id)];
    else if (b.sort === "price-asc") orderBy = [asc(effPrice), asc(s.products.id)];
    else if (b.sort === "price-desc") orderBy = [desc(effPrice), asc(s.products.id)];
    else if (b.sort === "rating") orderBy = [desc(s.products.rating), asc(s.products.id)];
    else if (b.sort === "newest") orderBy = [desc(s.products.publishedAt), desc(s.products.id)];
    const total = Number((await db.select({ n: sql<number>`count(*)` }).from(s.products).where(where))[0]?.n || 0);
    const limit = Math.min(100, Number(b.limit || 48));
    const offset = Math.max(0, Number(b.offset || 0));
    const page = await db.select().from(s.products).where(where).orderBy(...orderBy).limit(limit).offset(offset);
    // F1: one image query for the whole page.
    const out = await productsWithImages(db, page);
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
    else { row = (await db.insert(s.products).values({ ...data, publishedAt: Date.now() }).returning())[0]; }
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

  // B11: the cart/wishlist key is derived server-side ONLY — from the
  // validated customer session (their email) or from a server-set HttpOnly
  // guest cookie (nx_guest). A client-supplied email, header or body value
  // is NEVER trusted as the key: anyone could pass another customer's
  // email and read/mutate their cart. The guest cookie is set on the
  // response the first time a guest needs a cart; the browser sends it
  // back automatically on same-origin requests.
  const GUEST_COOKIE = "nx_guest";
  function newGuestKey(): string {
    return "guest-" + crypto.randomBytes(9).toString("hex");
  }
  function setGuestCookie(req: Request, res: Response, key: string) {
    if (typeof (res as any).cookie !== "function") return;
    const secure = (req as any).secure || req.headers["x-forwarded-proto"] === "https";
    (res as any).cookie(GUEST_COOKIE, key, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 365 * 24 * 60 * 60 * 1000 });
  }
  async function cartKey(db: Db, req: Request, res: Response): Promise<string> {
    const cust = await sessionCustomer(db, req);
    if (cust) return cust.email.toLowerCase();
    const cookies = parseCookies(req);
    const g = cookies[GUEST_COOKIE];
    if (g && /^guest-[0-9a-f]{18}$/.test(g)) return g;
    const fresh = newGuestKey();
    setGuestCookie(req, res, fresh);
    return fresh;
  }
  // B2/B11: when a customer signs in (or registers), move their guest
  // cart/wishlist rows (keyed by the server guest cookie) onto their
  // account email, merging quantities into existing lines (capped at
  // stock). The guest rows are removed, not duplicated.
  async function migrateGuestRows(db: Db, req: Request, email: string) {
    const g = parseCookies(req)[GUEST_COOKIE];
    if (!g || g === email.toLowerCase()) return;
    const emailKey = email.toLowerCase();
    // Cart: merge quantities into existing lines (capped at stock).
    const guestCart = await db.select().from(s.cartItems).where(eq(s.cartItems.customerEmail, g));
    for (const row of guestCart) {
      const existing = (await db.select().from(s.cartItems).where(and(eq(s.cartItems.customerEmail, emailKey), eq(s.cartItems.productId, row.productId))))[0];
      if (existing) {
        const p = (await db.select().from(s.products).where(eq(s.products.id, row.productId)))[0];
        const next = Math.min(existing.qty + row.qty, p?.stock ?? existing.qty);
        await db.update(s.cartItems).set({ qty: next }).where(eq(s.cartItems.id, existing.id));
        await db.delete(s.cartItems).where(eq(s.cartItems.id, row.id));
      } else {
        await db.update(s.cartItems).set({ customerEmail: emailKey }).where(eq(s.cartItems.id, row.id));
      }
    }
    // Wishlist: move rows that are not already saved on the account.
    const guestWish = await db.select().from(s.wishlistItems).where(eq(s.wishlistItems.customerEmail, g));
    for (const row of guestWish) {
      const existing = (await db.select().from(s.wishlistItems).where(and(eq(s.wishlistItems.customerEmail, emailKey), eq(s.wishlistItems.productId, row.productId))))[0];
      if (existing) await db.delete(s.wishlistItems).where(eq(s.wishlistItems.id, row.id));
      else await db.update(s.wishlistItems).set({ customerEmail: emailKey }).where(eq(s.wishlistItems.id, row.id));
    }
  }

  a("getCart", async (req, res, db) => {
    const key = await cartKey(db, req, res);
    const lines = await db.select().from(s.cartItems).where(eq(s.cartItems.customerEmail, key));
    // F1: one product query + one image query for the whole cart.
    const pids = [...new Set(lines.map((l: any) => l.productId))];
    const prods = pids.length ? await db.select().from(s.products).where(inArray(s.products.id, pids)) : [];
    const fullById = new Map((await productsWithImages(db, prods)).map((p: any) => [p.id, p]));
    const out = [];
    for (const l of lines) {
      const full = fullById.get(l.productId);
      if (!full) continue;
      out.push({ ...l, product: full, imageUrl: full.imageUrl, isSample: full.imageIsSample });
    }
    res.json({ ok: true, items: out });
  });

  a("addToCart", async (req, res, db) => {
    const key = await cartKey(db, req, res);
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
    // B11: a cart line can only be changed by its owner — the line must
    // belong to the caller's server-derived key, not just any id.
    const key = await cartKey(db, req, res);
    const { id, qty } = req.body || {};
    const line = (await db.select().from(s.cartItems).where(and(eq(s.cartItems.id, Number(id)), eq(s.cartItems.customerEmail, key))))[0];
    if (!line) { res.status(404).json({ ok: false, error: "Cart line not found." }); return; }
    if (Number(qty) <= 0) { await db.delete(s.cartItems).where(eq(s.cartItems.id, line.id)); res.json({ ok: true, removed: true }); return; }
    const p = (await db.select().from(s.products).where(eq(s.products.id, line.productId)))[0];
    const capped = Math.min(Number(qty), p?.stock ?? 0);
    await db.update(s.cartItems).set({ qty: capped }).where(eq(s.cartItems.id, line.id));
    res.json({ ok: true, qty: capped, adjusted: capped < Number(qty), note: capped < Number(qty) ? `Quantity capped at available stock (${p?.stock}).` : undefined });
  });

  a("removeCartItem", async (req, res, db) => {
    // B11: only the owner's own line can be removed.
    const key = await cartKey(db, req, res);
    await db.delete(s.cartItems).where(and(eq(s.cartItems.id, req.body.id), eq(s.cartItems.customerEmail, key)));
    res.json({ ok: true });
  });

  a("listWishlist", async (req, res, db) => {
    const key = await cartKey(db, req, res);
    const rows = await db.select().from(s.wishlistItems).where(eq(s.wishlistItems.customerEmail, key));
    // F1: one product query + one image query for the whole list.
    const pids = [...new Set(rows.map((r: any) => r.productId))];
    const prods = pids.length ? await db.select().from(s.products).where(inArray(s.products.id, pids)) : [];
    const fullById = new Map((await productsWithImages(db, prods)).map((p: any) => [p.id, p]));
    const out = [];
    for (const r of rows) { const p = fullById.get(r.productId); if (p) out.push(p); }
    res.json({ ok: true, items: out, count: out.length });
  });

  a("addToWishlist", async (req, res, db) => {
    const key = await cartKey(db, req, res);
    const pid = Number(req.body?.productId);
    const ex = await db.select().from(s.wishlistItems).where(and(eq(s.wishlistItems.customerEmail, key), eq(s.wishlistItems.productId, pid)));
    if (!ex.length) await db.insert(s.wishlistItems).values({ customerEmail: key, productId: pid });
    res.json({ ok: true });
  });

  a("removeFromWishlist", async (req, res, db) => {
    const key = await cartKey(db, req, res);
    await db.delete(s.wishlistItems).where(and(eq(s.wishlistItems.customerEmail, key), eq(s.wishlistItems.productId, Number(req.body?.productId))));
    res.json({ ok: true });
  });

  a("listDemoMerchants", async (req, res, db) => {
    let rows = await db.select().from(s.demoMerchants).orderBy(desc(s.demoMerchants.rating));
    if (req.body?.verification) rows = rows.filter((m: any) => m.verification === req.body.verification);
    res.json({ ok: true, merchants: rows, note: "Featured stores directory — these merchants are display profiles, not sellers." });
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

  async function placeOrderInternal(db: TxDb, b: any) {
    const v = validateCustomerInfo({ email: b.customerEmail, phone: b.customerPhone, name: b.customerName });
    if (!v.ok) throw new OrderError(400, "", v.errors);
    const items: { productId: number; qty: number }[] = b.items || [];
    if (!items.length) throw new OrderError(400, "Your cart is empty.");
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
      if (!p) throw new OrderError(400, `Product ${it.productId} not found.`);
      const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
      let qty = Math.max(1, Number(it.qty || 1));
      if (qty > p.stock) { adjustments.push(`${p.name}: quantity reduced from ${qty} to ${p.stock} (available stock).`); qty = p.stock; }
      if (qty <= 0) throw new OrderError(400, `${p.name} is out of stock.`);
      subtotal += price * qty;
      lines.push({ product: p, price, qty });
    }
    let discount = 0;
    const couponCode = String(b.couponCode || b.coupon || "").trim().toUpperCase();
    if (couponCode) {
      const c = (await db.select().from(s.coupons).where(eq(s.coupons.code, couponCode)))[0];
      // B18: REAL per-customer use count from order history (same query as
      // validateCoupon), not the hardcoded 0 the old code passed.
      let customerUses = 0;
      if (b.customerEmail) {
        const mine = await db.select().from(s.orders).where(eq(s.orders.customerEmail, String(b.customerEmail).toLowerCase()));
        customerUses = mine.filter((o: any) => o.discount > 0).length;
      }
      const cv = validateCouponRules(c ? { ...c, discountType: c.discountType as "percent" | "fixed", expiresAt: c.expiresAt || "" } : null, subtotal, customerUses, todayYmdKarachi());
      if (cv.ok) discount = cv.discount || 0;
    }
    const method = (b.shippingMethod || "Standard") as ShippingMethod;
    const totals = computeOrderTotals({ subtotal, discount, shippingMethod: method });
    const paymentMethod = String(b.paymentMethod || "Cash on Delivery");
    const isCod = paymentMethod === "Cash on Delivery";
    const paymentRef = isCod ? "" : (b.paymentRef || txnRef());
    const paymentStatus = isCod ? "Pending (COD)" : `Paid • Ref ${paymentRef}`;
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
      courier: "NEXORA Express", trackingNumber: trackingNumber(on),
      cancelReason: "", idempotencyKey, legacyTest: false, legacyNote: "", createdAt: now,
    }).returning())[0];
    for (const l of lines) {
      await db.insert(s.orderItems).values({ orderId: order.id, productId: l.product.id, productName: l.product.name, price: l.price, qty: l.qty, sellerId: 0 });
      // F5: atomic stock decrement — one UPDATE that only succeeds while
      // enough stock remains. If another order took the stock first, this
      // affects 0 rows and the whole order rolls back (F4) instead of
      // selling stock that is not there.
      const newStock = l.product.stock - l.qty;
      const dec: any = await db.execute(sql`UPDATE "products" SET "stock" = "stock" - ${l.qty} WHERE "id" = ${l.product.id} AND "stock" >= ${l.qty}`);
      if ((dec?.rowCount ?? 0) === 0) throw new OrderError(400, `${l.product.name} is out of stock.`);
      await db.insert(s.inventoryMovements).values({ productId: l.product.id, sku: l.product.sku, type: "Order Reserved (Stock-Out)", qty: -l.qty, balanceAfter: newStock, reference: on, actor: "System", note: `Reserved for order ${on} at checkout`, createdAt: now });
    }
    await db.insert(s.orderEvents).values({ orderId: order.id, status: "Pending", note: `Order placed. Payment: ${paymentMethod}${isCod ? " — cash collected on delivery." : ` from ${b.paymentAccount || ""}, Transaction ${paymentRef} recorded.`}`, location: "NEXORA Karachi Central", actor: "System", createdAt: now });
    await db.insert(s.paymentTransactions).values({ orderId: order.id, orderNumber: on, method: paymentMethod, provider: paymentMethod.replace(" (Demo)", ""), account: b.paymentAccount || (isCod ? "Cash collected on delivery" : ""), reference: paymentRef, amount: totals.total, status: paymentStatus, mode: PAYMENT_MODE_DEMO, createdAt: now });
    if (couponCode && discount > 0) {
      // B18: atomic increment — one UPDATE that only succeeds while the
      // coupon is still under its limit (usageLimit 0 = unbounded, the
      // production values for 000/WELCOME10/FLASH500 are still an open
      // owner decision). No read-then-write race.
      const c = (await db.select().from(s.coupons).where(eq(s.coupons.code, couponCode)))[0];
      if (c) {
        await db.execute(sql`UPDATE "coupons" SET "uses" = "uses" + 1 WHERE "id" = ${c.id} AND ("usage_limit" = 0 OR "uses" < "usage_limit")`);
      }
    }
    // B19: the order-placed notification belongs to the ordering customer
    // (looked up by email; guests get NULL = system-wide, staff view only).
    const notifCustomer = b.customerEmail ? (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${String(b.customerEmail)})`))[0] : null;
    await db.insert(s.notifications).values({ title: "Order placed", body: `${on} confirmed. Total ${formatPkr(totals.total)}. Tracking ${trackingNumber(on)}.`, type: "Order", isRead: false, customerId: notifCustomer?.id ?? null, createdAt: now });
    return { ok: true, order, totals, adjustments, duplicate: false };
  }

  a("createOrder", async (req, res, db) => {
    let r;
    try {
      // F4: the whole order (order + items + stock + movements + events +
      // payment + coupon + notification) commits or rolls back together.
      r = await db.transaction(async (tx) => placeOrderInternal(tx, req.body || {}));
    } catch (e) {
      if (e instanceof OrderError) { res.status(e.status).json({ ok: false, error: e.message || undefined, errors: e.errors }); return; }
      throw e;
    }
    // placeOrderInternal either returns {ok:true} or throws OrderError —
    // there is no {ok:false} return left (F4 rollback needs the throw).
    // Clear the buyer's cart lines for the ordered products.
    if (req.body?.clearCart !== false) {
      const key = await cartKey(db, req, res);
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
    await db.insert(s.orderEvents).values({ orderId: order.id, status: next, note: TRACKING_STEP_NOTES[next] || `${next}.`, location: TRACKING_STEP_LOCATIONS[next] || "NEXORA Express", actor: "System", createdAt: now });
    if (next === "Shipped") {
      await db.insert(s.shipments).values({ orderId: order.id, orderNumber: order.orderNumber, trackingNumber: order.trackingNumber, provider: "NEXORA Express", charge: order.shippingFee, status: SHIPMENT_STATUS, createdAt: now });
    }
    if (next === "Delivered" && order.paymentMethod === "Cash on Delivery") {
      await db.update(s.orders).set({ paymentStatus: "Paid (COD Collected)" }).where(eq(s.orders.id, order.id));
      await db.insert(s.paymentTransactions).values({ orderId: order.id, orderNumber: order.orderNumber, method: order.paymentMethod, provider: "Cash on Delivery", account: "Cash collected on delivery", reference: "", amount: order.total, status: "Paid (COD Collected)", mode: PAYMENT_MODE_DEMO, createdAt: now });
    }
    const updated = (await db.select().from(s.orders).where(eq(s.orders.id, order.id)))[0];
    return { ok: true, order: updated, advancedTo: next };
  }

  a("advanceOrder", async (req, res, db) => {
    const r = await advanceOrderInternal(db, Number(req.body?.orderId));
    if (!r.ok) { res.status(400).json({ ok: false, error: r.error }); return; }
    res.json({ ok: true, order: r.order, advancedTo: r.advancedTo, note: "Each tap advances one step on the 12-step timeline." });
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
    await db.insert(s.orderEvents).values({ orderId: order.id, status, note: `Status set to ${status} by ${staffRoleLabel(req)}.`, location: "NEXORA Head Office", actor: staffRoleLabel(req), createdAt: Date.now() });
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
    // B19: cancellation notifications belong to the ordering customer.
    const notifCust = (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${order.customerEmail})`))[0] || null;
    const reason = String(req.body?.reason || "Cancelled by customer");
    const now = Date.now();
    if (order.status === "Cancelled") { res.status(400).json({ ok: false, error: "This order is already cancelled." }); return; }
    if (order.status === "Delivered") { res.status(400).json({ ok: false, error: "A delivered order cannot be cancelled — please request a return instead." }); return; }
    if (["Shipped", "In Transit", "Arrived at Sorting Facility", "Arrived in Destination City", "Out for Delivery"].includes(order.status)) {
      // F4: refusal workflow writes together or not at all.
      await db.transaction(async (tx) => {
        await tx.insert(s.orderEvents).values({ orderId: order.id, status: order.status, note: `Cancellation requested while ${order.status} — refusal workflow: courier return requested. Reason: ${reason}`, location: "NEXORA Express", actor: "System", createdAt: now });
        await tx.insert(s.notifications).values({ title: "Cancellation requested", body: `${order.orderNumber} is already ${order.status}; a courier return has been requested.`, type: "Order", isRead: false, customerId: notifCust?.id ?? null, createdAt: now });
        await audit(tx, "Order cancellation requested (shipped)", actor, `${order.orderNumber} — ${order.status}`);
      });
      res.json({ ok: true, refused: true, message: "The order has already shipped — a courier return was requested instead of an instant cancellation." });
      return;
    }
    const prepaid = order.paymentStatus.startsWith("Paid (Demo Simulated)") || order.paymentStatus.startsWith("Paid • Ref");
    // F4: the whole cancellation (status + event + stock release + refund
    // record + notification + audit) commits or rolls back together.
    await db.transaction(async (tx) => {
      await tx.update(s.orders).set({ status: "Cancelled", cancelReason: reason, paymentStatus: prepaid ? "Refund Pending" : order.paymentStatus }).where(eq(s.orders.id, order.id));
      await tx.insert(s.orderEvents).values({ orderId: order.id, status: "Cancelled", note: `Order cancelled. Reason: ${reason}`, location: "NEXORA Head Office", actor: "System", createdAt: now });
      // Release reserved stock (checkout-placed orders only).
      const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
      for (const it of items) {
        if (!it.productId) continue;
        const p = (await tx.select().from(s.products).where(eq(s.products.id, it.productId)))[0];
        if (!p) continue;
        const newStock = p.stock + it.qty;
        await tx.update(s.products).set({ stock: newStock }).where(eq(s.products.id, p.id));
        await tx.insert(s.inventoryMovements).values({ productId: p.id, sku: p.sku, type: "Order Cancelled (Stock-In)", qty: it.qty, balanceAfter: newStock, reference: order.orderNumber, actor: "System", note: `Stock released for cancelled order ${order.orderNumber}`, createdAt: now });
      }
      if (prepaid) {
        await tx.insert(s.paymentTransactions).values({ orderId: order.id, orderNumber: order.orderNumber, method: order.paymentMethod, provider: order.paymentMethod.replace(" (Demo)", ""), account: order.paymentAccount, reference: order.paymentRef, amount: order.total, status: "Refund Pending", mode: PAYMENT_MODE_DEMO, createdAt: now });
      }
      await tx.insert(s.notifications).values({ title: "Order cancelled", body: `${order.orderNumber} was cancelled. ${prepaid ? "Refund Pending." : ""}`, type: "Order", isRead: false, customerId: notifCust?.id ?? null, createdAt: now });
      await audit(tx, "Order cancelled", actor, `${order.orderNumber} — ${reason}`);
    });
    res.json({ ok: true, cancelled: true, refundPending: prepaid });
  });

  a("getOrderTracking", async (req, res, db) => {
    const { orderNumber: on, trackingNumber: tn } = req.body || {};
    const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, String(on || ""))))[0];
    if (!order || (tn && order.trackingNumber !== tn)) { res.status(404).json({ ok: false, error: "Order not found — check the order and tracking numbers." }); return; }
    const events = await db.select().from(s.orderEvents).where(eq(s.orderEvents.orderId, order.id)).orderBy(asc(s.orderEvents.createdAt));
    const items = await db.select().from(s.orderItems).where(eq(s.orderItems.orderId, order.id));
    const stepIndex = TRACKING_STEPS.indexOf(order.status as any);
    res.json({ ok: true, order, events, items, stepIndex, steps: TRACKING_STEPS, courier: order.courier, note: "Follow your parcel with the latest verified event." });
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

  a("clearCancelledOrders", async (req, res, db) => {
    // Destructive (deletes orders + their events/items): needs a fresh
    // re-auth, and the actor is audit-logged with the real staff identity.
    if (!await requireStaffReauth(db, req, res, "clearCancelledOrders")) return;
    const cancelled = await db.select().from(s.orders).where(eq(s.orders.status, "Cancelled"));
    for (const o of cancelled) {
      await db.delete(s.orderEvents).where(eq(s.orderEvents.orderId, o.id));
      await db.delete(s.orderItems).where(eq(s.orderItems.orderId, o.id));
      await db.delete(s.orders).where(eq(s.orders.id, o.id));
    }
    await audit(db, "Cancelled orders purged", staffRoleLabel(req), `${cancelled.length} orders removed`);
    res.json({ ok: true, removed: cancelled.length });
  }, { area: "orders" });

  a("listRegisteredCustomers", async (_req, res, db) => {
    const rows = await db.select().from(s.customers).orderBy(asc(s.customers.id));
    res.json({ ok: true, customers: rows.map((c: any) => ({ ...c, passwordHash: undefined, resetTokenHash: undefined })) });
  }, { area: "customers" });

  // ---- 5.4 Customers & auth ----
  a("registerCustomer", async (req, res, db) => {
    const b = req.body || {};
    // B16: 5 registrations/hour per IP (no CAPTCHA provider exists yet —
    // noted as pending owner input; the limit is the mitigation in place).
    if (rateLimited("register:ip:" + clientIp(req), 5, 60 * 60 * 1000)) { res.status(429).json(rateLimitBody()); return; }
    const v = validateCustomerInfo({ email: b.email, phone: b.phone, name: b.name });
    if (!v.ok) { res.status(400).json({ ok: false, errors: v.errors }); return; }
    if (!b.password || String(b.password).length < 6) { res.status(400).json({ ok: false, error: "Password must be at least 6 characters." }); return; }
    if (b.confirmPassword != null && b.confirmPassword !== b.password) { res.status(400).json({ ok: false, error: "Passwords do not match." }); return; }
    const existing = (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${b.email})`))[0];
    if (existing) { res.status(400).json({ ok: false, error: "An account with this email already exists." }); return; }
    const cust = (await db.insert(s.customers).values({ name: b.name, email: b.email.trim(), phone: b.phone, passwordHash: hashPassword(b.password), mustResetPassword: false, emailVerified: false, phoneVerified: false, deletionRequested: false, createdAt: Date.now() }).returning())[0];
    const { token, tokenHash } = newSessionToken();
    await db.insert(s.customerSessions).values({ customerId: cust.id, tokenHash, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
    // B2/B11: a guest cart/wishlist built before registering moves onto
    // the new account.
    await migrateGuestRows(db, req, cust.email);
    res.json({ ok: true, sessionToken: token, customer: { id: cust.id, name: cust.name, email: cust.email, phone: cust.phone } });
  });

  a("loginCustomer", async (req, res, db) => {
    const { email, password } = req.body || {};
    const emailKey = String(email || "").trim().toLowerCase();
    // B16: 5 login attempts / 15 min per IP and per account, then 429.
    // Checked BEFORE the lookup so the limit itself leaks nothing.
    if (rateLimited("login:ip:" + clientIp(req), 5, 15 * 60 * 1000) || (emailKey && rateLimited("login:email:" + emailKey, 5, 15 * 60 * 1000))) {
      await audit(db, "LOGIN RATE LIMITED", emailKey || "anonymous", `login attempts exceeded for ${emailKey || clientIp(req)}`);
      res.status(429).json(rateLimitBody()); return;
    }
    const cust = (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${String(email || "")})`))[0];
    // B16: generic error for unknown email AND wrong password (no
    // enumeration). The passwordless case keeps its own message because
    // it routes the owner to the owner-assisted reset (see A2).
    if (!cust) {
      await audit(db, "LOGIN FAILED", emailKey || "anonymous", "unknown email");
      res.status(401).json({ ok: false, error: "Incorrect email or password." }); return;
    }
    if (!cust.passwordHash) {
      await audit(db, "LOGIN FAILED", cust.email, "account has no password yet");
      res.status(401).json({ ok: false, error: "This account has no password yet. Contact the store owner to set one.", mustResetPassword: true });
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
    if (!ok) {
      await audit(db, "LOGIN FAILED", cust.email, "incorrect password");
      res.status(401).json({ ok: false, error: "Incorrect email or password." }); return;
    }
    const { token, tokenHash } = newSessionToken();
    await db.insert(s.customerSessions).values({ customerId: cust.id, tokenHash, expiresAt: Date.now() + SESSION_TTL_MS, createdAt: Date.now() });
    // B2/B11: a guest cart/wishlist built before signing in moves onto
    // the account (quantities merged, capped at stock).
    await migrateGuestRows(db, req, cust.email);
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
    const wishlist = await db.select().from(s.wishlistItems).where(eq(s.wishlistItems.customerEmail, cust.email.toLowerCase()));
    // B19: the unread count is scoped to this customer's own notifications
    // (system-wide rows have customerId NULL and are staff-view only).
    const unread = await db.select().from(s.notifications).where(and(eq(s.notifications.isRead, false), eq(s.notifications.customerId, cust.id)));
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
    // A2: revoke every OTHER session (stolen/old sessions die on password change).
    const cur = bearerToken(req);
    if (cur) await db.delete(s.customerSessions).where(and(eq(s.customerSessions.customerId, cust.id), ne(s.customerSessions.tokenHash, hashSessionToken(cur))));
    else await db.delete(s.customerSessions).where(eq(s.customerSessions.customerId, cust.id));
    res.json({ ok: true });
  });

  a("requestPasswordReset", async (req, res, db) => {
    const { email } = req.body || {};
    // A2: rate-limited BEFORE the lookup, counted the same whether or not
    // the email exists, so neither the limit nor the timing leaks existence.
    const emailKey = String(email || "").trim().toLowerCase();
    if (rateLimited("reset:ip:" + clientIp(req), 5, 60 * 60 * 1000) || (emailKey && rateLimited("reset:email:" + emailKey, 3, 60 * 60 * 1000))) {
      res.status(429).json(rateLimitBody());
      return;
    }
    // A2: the token is NEVER returned in any API response. It is still
    // created (hash only, 30-min expiry, burned on use) so the reset
    // mechanics stay intact for Phase 2, which must decide how it is
    // delivered: owner-assisted reset via admin OR self-service reset
    // disabled until an email provider is connected. No email provider
    // is invented here. The response is identical whether or not the
    // email exists (no enumeration).
    const genericNote = "If an account exists for this email, reset instructions were requested. No email provider is connected yet, so the reset link cannot be sent by email — contact the store owner for help.";
    const cust = (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${String(email || "")})`))[0];
    if (!cust) { res.json({ ok: true, note: genericNote }); return; }
    const { tokenHash } = newResetToken(); // token value never extracted, never exposed.
    await db.update(s.customers).set({ resetTokenHash: tokenHash, resetExpiresAt: Date.now() + RESET_TOKEN_TTL_MS }).where(eq(s.customers.id, cust.id));
    res.json({ ok: true, note: genericNote });
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
    // A2: revoke ALL sessions — a reset logs every device out.
    await db.delete(s.customerSessions).where(eq(s.customerSessions.customerId, cust.id));
    res.json({ ok: true });
  });

  // ---- Phase 2: owner setup + staff authentication ----
  // Owner first-password procedure (NO email provider exists, so nothing
  // is ever emailed and no provider is invented):
  //   1. The owner picks any secret setup token HE chooses and sets it as
  //      the Vercel env var NEXORA_OWNER_SETUP_TOKEN (Production target),
  //      then redeploys (env changes need a redeploy to take effect).
  //      No token value is ever in code, chat or logs.
  //   2. He opens /admin/setup on his phone and types the setup token
  //      plus the password he wants (8+ characters, letters + numbers).
  //   3. The page shows a one-time authenticator secret (grouped text +
  //      otpauth URL) — he types it into Google/Microsoft Authenticator
  //      (or any TOTP app) as a manual setup key.
  //   4. He types the 6-digit code from the app. ONLY then is the owner
  //      account activated (staff #1, Muhammad Saleem, role Owner), TOTP
  //      is enabled, setup is marked done, and he is signed in to /admin.
  // The setup page works ONLY while no owner setup is complete
  // (settings.ownerSetupDone != "true"). If the owner mistypes the
  // password or secret before step 4, he simply repeats steps 2–3 with
  // the same token — nothing is final until the code verifies. After
  // setup, the endpoint refuses. While signed in the owner can change
  // his password and re-enrol TOTP from the admin panel; if he is ever
  // locked out of BOTH password and authenticator, there is NO
  // self-service recovery — a code/DB step is needed (open item).
  const OWNER_STAFF_ID = 1; // Muhammad Saleem, owner@nexora.demo
  const OWNER_SETUP_TOKEN_ENV = "NEXORA_OWNER_SETUP_TOKEN";
  function ownerSetupTokenMatches(token: string): boolean {
    const env = process.env[OWNER_SETUP_TOKEN_ENV] || "";
    if (!env || !token) return false;
    const a = crypto.createHash("sha256").update(env).digest();
    const b = crypto.createHash("sha256").update(String(token)).digest();
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  async function ownerSetupDone(db: Db): Promise<boolean> {
    const cfg = await settingsMap(db);
    return cfg.ownerSetupDone === "true";
  }
  async function ownerStaffRow(db: Db) {
    return (await db.select().from(s.staff).where(eq(s.staff.id, OWNER_STAFF_ID)))[0] || null;
  }

  a("getOwnerSetupStatus", async (_req, res, db) => {
    const owner = await ownerStaffRow(db);
    res.json({
      ok: true,
      setupAvailable: !(await ownerSetupDone(db)),
      ownerName: owner?.name || "Muhammad Saleem",
      ownerEmail: owner?.email || "owner@nexora.demo",
      hasEnvToken: Boolean(process.env[OWNER_SETUP_TOKEN_ENV]),
      note: "Set NEXORA_OWNER_SETUP_TOKEN in the Vercel dashboard (Production) to a secret only you know, then open /admin/setup.",
    });
  });

  a("ownerSetup", async (req, res, db) => {
    if (rateLimited("owner-setup:ip:" + clientIp(req), 5, 60 * 60 * 1000)) { res.status(429).json(rateLimitBody()); return; }
    if (await ownerSetupDone(db)) { res.status(410).json({ ok: false, error: "Owner setup is already complete. Sign in at /admin." }); return; }
    const { setupToken, password, confirmPassword } = req.body || {};
    if (!process.env[OWNER_SETUP_TOKEN_ENV]) { res.status(503).json({ ok: false, error: "Owner setup is not configured yet — set NEXORA_OWNER_SETUP_TOKEN in the Vercel dashboard first, then redeploy." }); return; }
    if (!ownerSetupTokenMatches(String(setupToken || ""))) {
      await audit(db, "OWNER SETUP FAILED", "anonymous", "invalid setup token");
      res.status(403).json({ ok: false, error: "Invalid setup token." }); return;
    }
    if (!validStaffPassword(String(password || ""))) { res.status(400).json({ ok: false, error: "Password must be at least 8 characters with letters and numbers." }); return; }
    if (confirmPassword != null && confirmPassword !== password) { res.status(400).json({ ok: false, error: "Passwords do not match." }); return; }
    const owner = await ownerStaffRow(db);
    if (!owner) { res.status(500).json({ ok: false, error: "Owner staff record not found." }); return; }
    const secret = newTotpSecret();
    await db.update(s.staff).set({ passwordHash: hashPassword(String(password)), totpSecret: secret, totpEnabled: false, mustResetPassword: true }).where(eq(s.staff.id, owner.id));
    await audit(db, "Owner setup started", `staff:${owner.name} <${owner.email}>`, "password set, authenticator secret issued (TOTP not verified yet)");
    // The secret is returned ONCE, here, for the setup page to display.
    // It is never logged and never returned by any other endpoint.
    res.json({ ok: true, ownerName: owner.name, ownerEmail: owner.email, totpSecret: secret, totpSecretDisplay: totpSecretDisplay(secret), otpauthUrl: totpAuthUrl(secret, owner.email), next: "Enter the 6-digit code from your authenticator app to finish setup." });
  });

  a("ownerSetupVerify", async (req, res, db) => {
    if (rateLimited("owner-setup:ip:" + clientIp(req), 5, 60 * 60 * 1000)) { res.status(429).json(rateLimitBody()); return; }
    if (await ownerSetupDone(db)) { res.status(410).json({ ok: false, error: "Owner setup is already complete. Sign in at /admin." }); return; }
    const { setupToken, totpCode } = req.body || {};
    if (!ownerSetupTokenMatches(String(setupToken || ""))) { res.status(403).json({ ok: false, error: "Invalid setup token." }); return; }
    const owner = await ownerStaffRow(db);
    if (!owner || !owner.totpSecret) { res.status(400).json({ ok: false, error: "Run step 1 of setup first (set your password to get an authenticator secret)." }); return; }
    if (!verifyTotp(owner.totpSecret, String(totpCode || ""))) {
      await audit(db, "OWNER SETUP FAILED", `staff:${owner.name} <${owner.email}>`, "wrong authenticator code");
      res.status(400).json({ ok: false, error: "Incorrect authenticator code — check the code in your authenticator app and try again." }); return;
    }
    await db.update(s.staff).set({ totpEnabled: true, mustResetPassword: false, role: OWNER_ROLE, status: "Active" }).where(eq(s.staff.id, owner.id));
    await db.insert(s.settings).values({ key: "ownerSetupDone", value: "true" }).onConflictDoUpdate({ target: s.settings.key, set: { value: "true" } });
    await audit(db, "Owner setup complete", `staff:${owner.name} <${owner.email}> (Owner)`, "TOTP verified; owner account activated");
    const token = await createStaffSession(db, owner.id);
    setStaffCookie(req, res, token);
    res.json({ ok: true, staff: publicStaffRow({ ...owner, role: OWNER_ROLE, totpEnabled: true }) });
  });

  // ---- Staff sign-in / sessions ----
  a("loginStaff", async (req, res, db) => {
    const { email, password, totpCode } = req.body || {};
    const emailKey = String(email || "").trim().toLowerCase();
    // B16: 5 attempts / 15 min per IP and per account, then 429.
    if (rateLimited("staff-login:ip:" + clientIp(req), 5, 15 * 60 * 1000) || (emailKey && rateLimited("staff-login:email:" + emailKey, 5, 15 * 60 * 1000))) {
      await audit(db, "STAFF LOGIN RATE LIMITED", emailKey || "anonymous", `staff login attempts exceeded for ${emailKey || clientIp(req)}`);
      res.status(429).json(rateLimitBody()); return;
    }
    const st = (await db.select().from(s.staff).where(sql`lower(${s.staff.email}) = lower(${emailKey})`))[0];
    if (!st || st.status !== "Active") {
      await audit(db, "STAFF LOGIN FAILED", emailKey || "anonymous", "unknown or inactive staff email");
      res.status(401).json({ ok: false, error: "Incorrect email or password." }); return;
    }
    if (!st.passwordHash) {
      await audit(db, "STAFF LOGIN FAILED", st.email, "staff account not activated yet");
      res.status(401).json({ ok: false, error: "This staff account has no password yet — ask the owner to activate it.", mustSetup: true }); return;
    }
    if (!verifyPassword(String(password || ""), st.passwordHash)) {
      await audit(db, "STAFF LOGIN FAILED", st.email, "incorrect password");
      res.status(401).json({ ok: false, error: "Incorrect email or password." }); return;
    }
    if (st.totpEnabled) {
      if (!totpCode) { res.json({ ok: false, totpRequired: true, error: "Enter the 6-digit code from your authenticator app." }); return; }
      if (!st.totpSecret || !verifyTotp(st.totpSecret, String(totpCode))) {
        await audit(db, "STAFF LOGIN FAILED", st.email, "incorrect authenticator code");
        res.status(401).json({ ok: false, error: "Incorrect authenticator code." }); return;
      }
    } else {
      // Password is right but TOTP was never enrolled: issue the secret
      // once here and require enrolment before any session is created.
      const secret = st.totpSecret || newTotpSecret();
      if (!st.totpSecret) await db.update(s.staff).set({ totpSecret: secret }).where(eq(s.staff.id, st.id));
      res.json({ ok: false, totpSetupRequired: true, totpSecret: secret, totpSecretDisplay: totpSecretDisplay(secret), otpauthUrl: totpAuthUrl(secret, st.email), error: "Authenticator setup required — add this key to your authenticator app, then enter the 6-digit code." });
      return;
    }
    const token = await createStaffSession(db, st.id);
    setStaffCookie(req, res, token);
    await audit(db, "Staff signed in", `staff:${st.name} <${st.email}> (${st.role})`, "TOTP verified");
    res.json({ ok: true, staff: { ...publicStaffRow(st), totpEnabled: true } });
  });

  a("staffTotpVerify", async (req, res, db) => {
    const { email, password, totpCode } = req.body || {};
    const st = (await db.select().from(s.staff).where(sql`lower(${s.staff.email}) = lower(${String(email || "").trim().toLowerCase()})`))[0];
    if (!st || !st.passwordHash || !verifyPassword(String(password || ""), st.passwordHash)) { res.status(401).json({ ok: false, error: "Incorrect email or password." }); return; }
    if (!st.totpSecret || !verifyTotp(st.totpSecret, String(totpCode || ""))) { res.status(400).json({ ok: false, error: "Incorrect authenticator code." }); return; }
    await db.update(s.staff).set({ totpEnabled: true, mustResetPassword: false }).where(eq(s.staff.id, st.id));
    const token = await createStaffSession(db, st.id);
    setStaffCookie(req, res, token);
    await audit(db, "Staff authenticator enrolled", `staff:${st.name} <${st.email}> (${st.role})`, "TOTP verified on first sign-in");
    res.json({ ok: true, staff: { ...publicStaffRow(st), totpEnabled: true } });
  });

  a("getStaffSession", async (req, res) => {
    const st = (req as any).staff;
    if (!st) { res.json({ ok: true, authenticated: false }); return; }
    res.json({ ok: true, authenticated: true, staff: { ...publicStaffRow(st), totpEnabled: !!st.totpEnabled } });
  });

  a("logoutStaff", async (req, res, db) => {
    const sess = staffSession(req);
    if (sess) await db.delete(s.staffSessions).where(eq(s.staffSessions.id, sess.id));
    clearStaffCookie(res);
    res.json({ ok: true });
  });

  // B17 (staff side): sign out everywhere — revokes ALL staff sessions.
  a("logoutStaffEverywhere", async (req, res, db) => {
    const st = (req as any).staff;
    if (!st) { res.status(401).json({ ok: false, error: "Staff sign-in required." }); return; }
    await db.delete(s.staffSessions).where(eq(s.staffSessions.staffId, st.id));
    clearStaffCookie(res);
    await audit(db, "Staff signed out everywhere", `staff:${st.name} <${st.email}> (${st.role})`, "all staff sessions revoked");
    res.json({ ok: true, note: "Signed out on all devices." });
  });

  a("changeStaffPassword", async (req, res, db) => {
    const st = (req as any).staff;
    if (!st) { res.status(401).json({ ok: false, error: "Staff sign-in required." }); return; }
    const { currentPassword, newPassword, confirmNewPassword } = req.body || {};
    if (!st.passwordHash || !verifyPassword(String(currentPassword || ""), st.passwordHash)) { res.status(400).json({ ok: false, error: "Current password is incorrect." }); return; }
    if (!validStaffPassword(String(newPassword || ""))) { res.status(400).json({ ok: false, error: "New password must be at least 8 characters with letters and numbers." }); return; }
    if (confirmNewPassword != null && confirmNewPassword !== newPassword) { res.status(400).json({ ok: false, error: "New passwords do not match." }); return; }
    await db.update(s.staff).set({ passwordHash: hashPassword(String(newPassword)), mustResetPassword: false }).where(eq(s.staff.id, st.id));
    // B17: revoke every OTHER staff session (this device stays signed in).
    const sess = staffSession(req);
    if (sess) await db.delete(s.staffSessions).where(and(eq(s.staffSessions.staffId, st.id), ne(s.staffSessions.tokenHash, sess.tokenHash)));
    else await db.delete(s.staffSessions).where(eq(s.staffSessions.staffId, st.id));
    await audit(db, "Staff password changed", `staff:${st.name} <${st.email}> (${st.role})`, "other sessions revoked");
    res.json({ ok: true });
  });

  // Fresh password (+ authenticator code if TOTP is on) confirmation for
  // destructive actions. Valid for 10 minutes on this session.
  a("staffReauth", async (req, res, db) => {
    const st = (req as any).staff;
    const sess = staffSession(req);
    if (!st || !sess) { res.status(401).json({ ok: false, error: "Staff sign-in required." }); return; }
    const { password, totpCode } = req.body || {};
    if (!st.passwordHash || !verifyPassword(String(password || ""), st.passwordHash)) { res.status(400).json({ ok: false, error: "Incorrect password." }); return; }
    if (st.totpEnabled && (!st.totpSecret || !verifyTotp(st.totpSecret, String(totpCode || "")))) { res.status(400).json({ ok: false, error: "Incorrect authenticator code." }); return; }
    await db.update(s.staffSessions).set({ reauthAt: Date.now() }).where(eq(s.staffSessions.id, sess.id));
    res.json({ ok: true, note: "Confirmed — destructive actions are unlocked for 10 minutes." });
  });

  // Owner activates a staff account: creates a one-time setup token (24 h)
  // the owner passes to the staff member out of band (e.g. WhatsApp).
  // The staff member then completes setup at /staff/setup. Owner and
  // Super Admin only — a lower role cannot activate accounts.
  a("createStaffSetupToken", async (req, res, db) => {
    const caller = (req as any).staff;
    if (caller.role !== OWNER_ROLE && caller.role !== "Super Admin") { res.status(403).json({ ok: false, error: "Only the Owner or Super Admin can activate staff accounts." }); return; }
    const target = (await db.select().from(s.staff).where(eq(s.staff.id, Number(req.body?.staffId))))[0];
    if (!target) { res.status(404).json({ ok: false, error: "Staff member not found." }); return; }
    const { token, tokenHash } = newResetToken();
    await db.update(s.staff).set({ setupTokenHash: tokenHash, setupExpiresAt: Date.now() + 24 * 60 * 60 * 1000 }).where(eq(s.staff.id, target.id));
    await audit(db, "Staff setup token issued", staffRoleLabel(req), `for ${target.name} <${target.email}> (24 h)`);
    // Returned ONCE — the owner passes it to the staff member out of band.
    res.json({ ok: true, staffId: target.id, email: target.email, setupToken: token, expiresInHours: 24, next: "Send this token to the staff member (e.g. WhatsApp). They complete setup at /staff/setup — it is shown once and never stored in plain text." });
  }, { area: "staff" });

  a("staffSetup", async (req, res, db) => {
    if (rateLimited("staff-setup:ip:" + clientIp(req), 5, 60 * 60 * 1000)) { res.status(429).json(rateLimitBody()); return; }
    const { email, setupToken, password, confirmPassword } = req.body || {};
    const st = (await db.select().from(s.staff).where(sql`lower(${s.staff.email}) = lower(${String(email || "").trim().toLowerCase()})`))[0];
    if (!st || !st.setupTokenHash || st.setupTokenHash !== crypto.createHash("sha256").update(String(setupToken || "")).digest("hex") || !st.setupExpiresAt || st.setupExpiresAt < Date.now()) {
      res.status(400).json({ ok: false, error: "This setup token is invalid or expired — ask the owner for a new one." }); return;
    }
    if (!validStaffPassword(String(password || ""))) { res.status(400).json({ ok: false, error: "Password must be at least 8 characters with letters and numbers." }); return; }
    if (confirmPassword != null && confirmPassword !== password) { res.status(400).json({ ok: false, error: "Passwords do not match." }); return; }
    const secret = newTotpSecret();
    await db.update(s.staff).set({ passwordHash: hashPassword(String(password)), totpSecret: secret, totpEnabled: false, mustResetPassword: true }).where(eq(s.staff.id, st.id));
    await audit(db, "Staff setup started", `staff:${st.name} <${st.email}> (${st.role})`, "password set, authenticator secret issued (TOTP not verified yet)");
    res.json({ ok: true, name: st.name, email: st.email, totpSecret: secret, totpSecretDisplay: totpSecretDisplay(secret), otpauthUrl: totpAuthUrl(secret, st.email), next: "Enter the 6-digit code from your authenticator app to finish setup." });
  });

  a("staffSetupVerify", async (req, res, db) => {
    const { email, setupToken, totpCode } = req.body || {};
    const st = (await db.select().from(s.staff).where(sql`lower(${s.staff.email}) = lower(${String(email || "").trim().toLowerCase()})`))[0];
    if (!st || !st.setupTokenHash || st.setupTokenHash !== crypto.createHash("sha256").update(String(setupToken || "")).digest("hex") || !st.setupExpiresAt || st.setupExpiresAt < Date.now()) {
      res.status(400).json({ ok: false, error: "This setup token is invalid or expired — ask the owner for a new one." }); return;
    }
    if (!st.totpSecret || !verifyTotp(st.totpSecret, String(totpCode || ""))) { res.status(400).json({ ok: false, error: "Incorrect authenticator code." }); return; }
    await db.update(s.staff).set({ totpEnabled: true, mustResetPassword: false, setupTokenHash: null, setupExpiresAt: null }).where(eq(s.staff.id, st.id));
    const token = await createStaffSession(db, st.id);
    setStaffCookie(req, res, token);
    await audit(db, "Staff setup complete", `staff:${st.name} <${st.email}> (${st.role})`, "TOTP verified; account activated");
    res.json({ ok: true, staff: { ...publicStaffRow(st), totpEnabled: true } });
  });

  // Owner-assisted staff password reset (Owner / Super Admin only): clears
  // the password + TOTP and issues a fresh one-time setup token (24 h).
  // All of the member's sessions are revoked. There is no self-service
  // staff reset — the owner is the recovery path.
  a("resetStaffPassword", async (req, res, db) => {
    const caller = (req as any).staff;
    if (caller.role !== OWNER_ROLE && caller.role !== "Super Admin") { res.status(403).json({ ok: false, error: "Only the Owner or Super Admin can reset staff passwords." }); return; }
    const target = (await db.select().from(s.staff).where(eq(s.staff.id, Number(req.body?.staffId))))[0];
    if (!target) { res.status(404).json({ ok: false, error: "Staff member not found." }); return; }
    if (target.id === caller.id) { res.status(400).json({ ok: false, error: "Use Change Password for your own account." }); return; }
    const { token, tokenHash } = newResetToken();
    await db.update(s.staff).set({ passwordHash: null, totpSecret: null, totpEnabled: false, mustResetPassword: true, setupTokenHash: tokenHash, setupExpiresAt: Date.now() + 24 * 60 * 60 * 1000 }).where(eq(s.staff.id, target.id));
    await db.delete(s.staffSessions).where(eq(s.staffSessions.staffId, target.id));
    await audit(db, "Staff password reset by owner", staffRoleLabel(req), `for ${target.name} <${target.email}> — all sessions revoked, fresh setup token issued (24 h)`);
    res.json({ ok: true, staffId: target.id, email: target.email, setupToken: token, expiresInHours: 24, next: "Send this token to the staff member (e.g. WhatsApp). They complete setup at /staff/setup." });
  }, { area: "staff" });

  // CUSTOMER PASSWORD-RESET DECISION (Phase 2, B4): with no email provider,
  // self-service reset cannot deliver a token, so it stays DISABLED as a
  // delivery channel (requestPasswordReset returns a generic note and
  // never a token — A2). The working path is OWNER-ASSISTED reset: the
  // owner (staff area "customers") creates a one-time token here, passes
  // it to the customer out of band (e.g. WhatsApp), and the customer
  // completes it via the normal resetPassword endpoint (30-min expiry,
  // burned on use, all sessions revoked). No email provider is invented.
  a("adminResetCustomerPassword", async (req, res, db) => {
    const { customerId, email } = req.body || {};
    const cust = customerId
      ? (await db.select().from(s.customers).where(eq(s.customers.id, Number(customerId))))[0]
      : (await db.select().from(s.customers).where(sql`lower(${s.customers.email}) = lower(${String(email || "").trim().toLowerCase()})`))[0];
    if (!cust) { res.status(404).json({ ok: false, error: "Customer not found." }); return; }
    const { token, tokenHash } = newResetToken();
    await db.update(s.customers).set({ resetTokenHash: tokenHash, resetExpiresAt: Date.now() + RESET_TOKEN_TTL_MS }).where(eq(s.customers.id, cust.id));
    await audit(db, "Customer password reset token issued (owner-assisted)", staffRoleLabel(req), `for ${cust.email} (30 min)`);
    // Returned ONCE to the staff caller — the owner passes it to the
    // customer out of band. It is never emailed and never logged.
    res.json({ ok: true, customerId: cust.id, email: cust.email, resetToken: token, expiresInMinutes: 30, next: "Send this token to the customer (e.g. WhatsApp). They use it once at Sign In → Forgot password, within 30 minutes." });
  }, { area: "customers" });

  // B17: sign out everywhere for customers — revokes ALL customer sessions.
  a("logoutCustomerEverywhere", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    await db.delete(s.customerSessions).where(eq(s.customerSessions.customerId, cust.id));
    await audit(db, "Customer signed out everywhere", cust.email, "all customer sessions revoked");
    res.json({ ok: true, note: "Signed out on all devices." });
  });

  // B17: purge expired sessions (customer + staff). Safe to call anytime.
  a("purgeExpiredSessions", async (_req, res, db) => {
    const now = Date.now();
    const c = await db.delete(s.customerSessions).where(lt(s.customerSessions.expiresAt, now)).returning({ id: s.customerSessions.id });
    const st = await db.delete(s.staffSessions).where(lt(s.staffSessions.expiresAt, now)).returning({ id: s.staffSessions.id });
    res.json({ ok: true, purgedCustomerSessions: c.length, purgedStaffSessions: st.length });
  }, { area: "settings" });

  a("requestAccountDeletion", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    await db.update(s.customers).set({ deletionRequested: true }).where(eq(s.customers.id, cust.id));
    res.json({ ok: true, note: "Account deletion requested. The owner reviews deletion requests before any data is removed." });
  });

  // B14: real notification preferences, persisted on the customer row
  // (customers.notif_prefs, JSON). The account panel reads/writes these.
  const DEFAULT_NOTIF_PREFS = { orderUpdates: true, promotions: true, supportReplies: true };
  function parseNotifPrefs(raw: string | null | undefined) {
    try { const p = JSON.parse(raw || "{}"); return { ...DEFAULT_NOTIF_PREFS, orderUpdates: p.orderUpdates !== false, promotions: p.promotions !== false, supportReplies: p.supportReplies !== false }; }
    catch { return { ...DEFAULT_NOTIF_PREFS }; }
  }
  a("getNotifPrefs", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    res.json({ ok: true, prefs: parseNotifPrefs(cust.notifPrefs) });
  });
  a("saveNotifPrefs", async (req, res, db) => {
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const b = req.body?.prefs || req.body || {};
    const prefs = {
      orderUpdates: b.orderUpdates !== false,
      promotions: b.promotions !== false,
      supportReplies: b.supportReplies !== false,
    };
    await db.update(s.customers).set({ notifPrefs: JSON.stringify(prefs) }).where(eq(s.customers.id, cust.id));
    res.json({ ok: true, prefs });
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
    if (!PAYMENT_STATUSES_SOURCED.includes(status as any) && !status.startsWith("Paid (Demo Simulated)") && !status.startsWith("Paid • Ref")) {
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
    const row = (await db.insert(s.returns).values({ returnNumber: rn, orderNumber: order.orderNumber, productName: b.productName, qty: Number(b.qty || 1), refundAmount, reason: `${b.reason || ""} • ${b.pickupMethod || "Home Pickup"}`, status: "Requested", refundStage: 0, legacyFlag: false, legacyNote: "", customerName: cust?.name || order.customerName, createdAt: Date.now() }).returning())[0];
    res.json({ ok: true, return: row });
  });

  a("updateReturn", async (req, res, db) => {
    const ret = (await db.select().from(s.returns).where(eq(s.returns.id, Number(req.body?.id))))[0];
    if (!ret) { res.status(404).json({ ok: false, error: "Return not found." }); return; }
    const stage = Math.min(8, Math.max(0, Number(req.body?.refundStage ?? ret.refundStage + 1)));
    // F4: stage update + restock + movement commit or roll back together.
    await db.transaction(async (tx) => {
      await tx.update(s.returns).set({ refundStage: stage, status: REFUND_STAGE_LABELS[stage] }).where(eq(s.returns.id, ret.id));
      if (stage === 4) {
        // Restock once, reference-guarded against duplicates.
        const ref = `RET-${ret.returnNumber}-restock`;
        const existing = await tx.select().from(s.inventoryMovements).where(eq(s.inventoryMovements.reference, ref));
        if (!existing.length) {
          const prod = (await tx.select().from(s.products).where(eq(s.products.name, ret.productName)))[0];
          if (prod) {
            const newStock = prod.stock + ret.qty;
            await tx.update(s.products).set({ stock: newStock }).where(eq(s.products.id, prod.id));
            await tx.insert(s.inventoryMovements).values({ productId: prod.id, sku: prod.sku, type: "Return Restock (Stock-In)", qty: ret.qty, balanceAfter: newStock, reference: ref, actor: staffRoleLabel(req), note: `Restocked at refund stage 4 for ${ret.returnNumber}`, createdAt: Date.now() });
          }
        }
      }
    });
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
      discrepancies.push({ returnNumber: "RET-DEMO-001", fault: onOrder ? "none" : "Product is not an item on the order", product: r1.productName, orderStatus: order?.status, offeredCorrection: "Aurora X5 Wireless Earbuds, Rs 5,499 — the genuine item on Delivered order NX-DEMO-100001" });
    }
    const r2 = (await db.select().from(s.returns).where(eq(s.returns.returnNumber, "RET-DEMO-002")))[0];
    if (r2) {
      const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, r2.orderNumber)))[0];
      discrepancies.push({ returnNumber: "RET-DEMO-002", fault: `Order is ${order?.status}; product is not an item on the order`, product: r2.productName, orderStatus: order?.status, offeredCorrection: "None — correction correctly refused in the Muse copy" });
    }
    res.json({ ok: true, discrepancies, decision: "PENDING — owner must choose correctLegacyReturn or markLegacyReturns per return (staff 'refunds' area + ownerApproved:true required). Until decided, both rows are seeded exactly as exported." });
  }, { area: "refunds" });

  // B21: staff auth (refunds area, via the wrapper) + a FRESH password +
  // authenticator re-confirmation (destructive: rewrites a return row).
  // The body flag is only an extra confirmation now, not the authorisation.
  // The audit log records the REAL acting staff identity, not "Owner".
  a("correctLegacyReturn", async (req, res, db) => {
    if (!await requireStaffReauth(db, req, res, "correctLegacyReturn")) return;
    if (!req.body?.ownerApproved) { res.status(403).json({ ok: false, error: "ownerApproved:true is required — this is an owner-gated treatment." }); return; }
    const ret = (await db.select().from(s.returns).where(eq(s.returns.returnNumber, String(req.body?.returnNumber || "RET-DEMO-001"))))[0];
    if (!ret) { res.status(404).json({ ok: false, error: "Return not found." }); return; }
    const order = (await db.select().from(s.orders).where(eq(s.orders.orderNumber, ret.orderNumber)))[0];
    if (!order || order.status !== "Delivered") { res.status(400).json({ ok: false, error: "Correction is only allowed when the sole fault is the product mapping on a Delivered order. This return does not qualify." }); return; }
    const original = `${ret.productName} — Rs ${ret.refundAmount}`;
    await db.update(s.returns).set({ productName: "Aurora X5 Wireless Earbuds", refundAmount: 5499, legacyNote: `Corrected by owner approval. Original: ${original}` }).where(eq(s.returns.id, ret.id));
    await audit(db, "Legacy return corrected", staffRoleLabel(req), `RET-DEMO-001 original preserved in note: ${original}`);
    res.json({ ok: true });
  }, { area: "refunds" });

  a("markLegacyReturns", async (req, res, db) => {
    if (!await requireStaffReauth(db, req, res, "markLegacyReturns")) return;
    if (!req.body?.ownerApproved) { res.status(403).json({ ok: false, error: "ownerApproved:true is required — this is an owner-gated treatment." }); return; }
    const nums: string[] = req.body?.returnNumbers || ["RET-DEMO-001", "RET-DEMO-002"];
    for (const n of nums) {
      await db.update(s.returns).set({ legacyFlag: true, legacyNote: "Marked as legacy by owner approval — original record preserved untouched." }).where(eq(s.returns.returnNumber, n));
    }
    await audit(db, "Legacy returns marked", staffRoleLabel(req), nums.join(", "));
    res.json({ ok: true, marked: nums });
  }, { area: "refunds" });

  a("cleanupInvalidReturns", async (req, res, db) => {
    // Destructive (deletes rows): needs a fresh re-auth, like the other
    // legacy corrections.
    if (!await requireStaffReauth(db, req, res, "cleanupInvalidReturns")) return;
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
    await db.insert(s.notifications).values({ title: "Support reply", body: `Agent replied to ${t.ticketNumber}: ${String(req.body?.reply || "").slice(0, 120)}`, type: "Support", isRead: false, createdAt: Date.now() });
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

  a("listNotifications", async (req, res, db) => {
    // B9/B19: staff (customers area) see the global list; a signed-in
    // customer sees ONLY their own rows (customerId = their id — the
    // system-wide rows with customerId NULL are staff-view only). Anyone
    // else gets 401. This used to return every notification to anyone.
    if (staffRole(req)) {
      if (!await enforceOr401(db, req, res, "customers", "listNotifications")) return;
      const rows = await db.select().from(s.notifications).orderBy(desc(s.notifications.createdAt));
      res.json({ ok: true, notifications: rows, unread: rows.filter((n: any) => !n.isRead).length });
      return;
    }
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const rows = await db.select().from(s.notifications).where(eq(s.notifications.customerId, cust.id)).orderBy(desc(s.notifications.createdAt));
    res.json({ ok: true, notifications: rows, unread: rows.filter((n: any) => !n.isRead).length, mine: true });
  });
  a("addNotification", async (req, res, db) => {
    // B9: creating a notification is a staff action (customers area).
    if (!await enforceOr401(db, req, res, "customers", "addNotification")) return;
    const row = (await db.insert(s.notifications).values({ title: req.body?.title || "", body: req.body?.body || "", type: req.body?.type || "General", isRead: false, createdAt: Date.now() }).returning())[0];
    res.json({ ok: true, notification: row });
  });
  a("markNotificationsRead", async (req, res, db) => {
    // B19: a customer marks ONLY their own rows read; staff mark all.
    if (staffRole(req)) {
      if (!await enforceOr401(db, req, res, "customers", "markNotificationsRead")) return;
      await db.update(s.notifications).set({ isRead: true });
      res.json({ ok: true });
      return;
    }
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    await db.update(s.notifications).set({ isRead: true }).where(eq(s.notifications.customerId, cust.id));
    res.json({ ok: true });
  });
  a("markNotificationRead", async (req, res, db) => {
    // B19: a customer can only mark their own row read (404 otherwise);
    // staff can mark any.
    if (staffRole(req)) {
      if (!await enforceOr401(db, req, res, "customers", "markNotificationRead")) return;
      await db.update(s.notifications).set({ isRead: true }).where(eq(s.notifications.id, req.body.id));
      res.json({ ok: true });
      return;
    }
    const cust = await requireCustomer(db, req, res); if (!cust) return;
    const updated = await db.update(s.notifications).set({ isRead: true }).where(and(eq(s.notifications.id, req.body.id), eq(s.notifications.customerId, cust.id))).returning();
    if (!updated.length) { res.status(404).json({ ok: false, error: "Notification not found." }); return; }
    res.json({ ok: true });
  });
  a("deleteNotification", async (req, res, db) => {
    // B9: deleting a notification is a staff action (customers area).
    if (!await enforceOr401(db, req, res, "customers", "deleteNotification")) return;
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
    res.json({ ok: true, staff: rows.map(publicStaffRow) });
  }, { area: "staff" });
  a("saveStaff", async (req, res, db) => {
    const b = req.body || {};
    const caller = (req as any).staff;
    // Only the Owner can grant the Owner role (or take it away).
    if (b.role === OWNER_ROLE && caller.role !== OWNER_ROLE) { res.status(403).json({ ok: false, error: "Only the Owner can grant the Owner role." }); return; }
    if (b.id) {
      const existing = (await db.select().from(s.staff).where(eq(s.staff.id, b.id)))[0];
      if (existing && existing.role === OWNER_ROLE && b.role !== OWNER_ROLE && caller.role !== OWNER_ROLE) { res.status(403).json({ ok: false, error: "Only the Owner can change the Owner's role." }); return; }
    }
    // New staff rows start with NO usable password and TOTP off — the
    // owner activates them with a one-time setup token (createStaffSetupToken).
    let row;
    if (b.id) { await db.update(s.staff).set({ name: b.name, email: b.email, role: b.role, department: b.department ?? "", status: b.status ?? "Active" }).where(eq(s.staff.id, b.id)); row = (await db.select().from(s.staff).where(eq(s.staff.id, b.id)))[0]; }
    else row = (await db.insert(s.staff).values({ name: b.name, email: b.email, role: b.role, department: b.department ?? "", status: b.status ?? "Active" }).returning())[0];
    await audit(db, "Staff saved", staffRoleLabel(req), `${row.name} <${row.email}> (${row.role})`);
    res.json({ ok: true, staff: publicStaffRow(row) });
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
    // F1: one image query for the whole homepage — every section below
    // reuses this map instead of one SELECT per product.
    const withImages = await productsWithImages(db, products);
    const byId = new Map(withImages.map((p: any) => [p.id, p]));
    const pool = products.filter((p: any) => p.isFlash && p.salePrice != null && p.salePrice < p.price);
    const flashRow = computeFlashRow({
      poolSkus: pool.map((p: any) => p.sku),
      rowSize: Number(cfg.flashRowSize || 5), rotateDays: Number(cfg.flashRotateDays || 2),
      anchor: cfg.flashRowAnchor || "2026-11-25",
    });
    const flashProducts = [];
    for (const sku of flashRow.skus) { const p = products.find((x: any) => x.sku === sku); if (p) flashProducts.push(byId.get(p.id)); }
    const categoryImages = [
      ["Men's Fashion", "NX2-MEN-001"], ["Women's Fashion", "NX2-WOM-004"], ["Mobile Phones", "NX2-PHN-003"],
      ["Mobile Accessories", "NX2-ACC-005"], ["Smart Wearables", "NX2-WEA-005"], ["Audio & Electronics", "NX2-AUD-003"],
      ["Jewelry & Accessories", "NX2-JEW-003"], ["Beauty & Personal Care", "NX2-BEA-003"], ["Kids & Baby Fashion", "NX2-KID-003"],
    ];
    const categories = [];
    for (const [name, sku] of categoryImages) {
      const p = products.find((x: any) => x.sku === sku);
      categories.push({ category: name, count: products.filter((x: any) => x.category === name).length, productSku: sku, imageUrl: p ? (byId.get(p.id)?.imageUrl || "") : "", imageIsSample: true });
    }
    // Best sellers from real order data (non-cancelled, non-legacy).
    const orders = await db.select().from(s.orders);
    const liveIds = new Set(orders.filter((o: any) => !o.legacyTest && o.status !== "Cancelled").map((o: any) => o.id));
    const items = await db.select().from(s.orderItems);
    const soldQty: Record<number, number> = {};
    for (const it of items) if (liveIds.has(it.orderId) && it.productId) soldQty[it.productId] = (soldQty[it.productId] || 0) + it.qty;
    const bestIds = Object.entries(soldQty).sort((a, b) => b[1] - a[1]).map(([id]) => Number(id));
    const bestSellers = [];
    for (const id of bestIds) { const p = products.find((x: any) => x.id === id); if (p) bestSellers.push(byId.get(p.id)); }
    const featured = products.filter((p: any) => p.isFeatured);
    const bestSellersOut = { source: "sales", products: bestSellers, fallback: bestSellers.length < 3 ? { label: "Featured Products (fewer than 3 products have real sales yet)", products: featured.map((p: any) => byId.get(p.id)) } : null };
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
      recommended = { mode: "own-orders", categories: [...cats], products: recs.map((p: any) => byId.get(p.id)) };
    } else {
      recommended = { mode: "featured", products: featured.slice(0, 6).map((p: any) => byId.get(p.id)) };
    }
    const reviews = await db.select().from(s.reviews).orderBy(desc(s.reviews.id));
    const heroOut = [];
    for (const b of banners) {
      const p = b.productId ? products.find((x: any) => x.id === b.productId) : null;
      heroOut.push({ ...b, imageUrl: p ? (byId.get(p.id)?.imageUrl || "") : "", imageIsSample: true, ctaTarget: safeJson(b.ctaTarget), cta2Target: safeJson(b.cta2Target) });
    }
    res.json({
      ok: true, banners: heroOut, collections, sections,
      flashRow: { ...flashRow, products: flashProducts },
      flashEndsAt: cfg.flashSaleEndsAt || "",
      categories, bestSellers: bestSellersOut, recommended,
      newArrivals: [...products].sort((a: any, b: any) => (Number(b.publishedAt ?? 0) - Number(a.publishedAt ?? 0)) || (b.id - a.id)).slice(0, 8).map((p: any) => byId.get(p.id)),
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
