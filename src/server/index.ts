// NEXORA MARKET — single Node.js service: Express API + server-rendered
// storefront/admin, one process, one Render free web service.
// Boots WITHOUT a database: /health answers honestly and data pages show a
// "database not configured" state instead of crash-looping.

import express from "express";
import compression from "compression";
import path from "node:path";
import { checkDb, getDb, isDbConfigured } from "../db";
import { getBootStatus } from "../db/boot-migrate";
import * as s from "../db/schema";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { callApiAction, imageUrlOf, productsWithImages, registerApi } from "./api";
import * as views from "./views";

const app = express();
// C13: security headers. No helmet dependency — the headers are set
// directly. CSP allows the site's own scripts/styles/images; inline
// handlers ('unsafe-inline') are still required because the storefront
// uses inline onclick handlers throughout — a strict CSP without them
// would break the site, so removing inline handlers is future work, not
// silently done here. frame-ancestors 'self' blocks clickjacking;
// CORS is same-origin only (no Access-Control-Allow-Origin is ever set).
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  next();
});
// F7: gzip/deflate compression for HTML + JSON responses (pool stays max 1).
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve(__dirname, "../../public"), { maxAge: "1d" }));

// Health — works without a DB, reports db status honestly.
app.get("/health", async (_req, res) => {
  const db = await checkDb();
  // F8: which migrations has the live DB actually applied? (drizzle's own
  // tracking table — the hash is sha256 of the migration file.)
  let migrations: string[] | null = null;
  try {
    const d = getDb();
    if (d) {
      const rows: any = await d.execute('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at');
      migrations = (rows?.rows || rows || []).map((r: any) => String(r.hash).slice(0, 12));
    }
  } catch { migrations = null; }
  res.json({ ok: true, service: "nexora-market", version: "1.0.0", demoMode: true, dbConfigured: isDbConfigured(), db: db.ok ? "connected" : "not configured", dbError: db.ok ? undefined : db.error, bootMigration: getBootStatus(), migrationsApplied: migrations, time: new Date().toISOString() });
});

registerApi(app);

function noDb(res: express.Response, feature: string) {
  res.status(503).send(views.noDbPage(feature));
}

// C7: business details for the footer / policy / About / Contact pages,
// read from settings on every page render. Empty until the owner supplies
// them (see views.detailsBlock — never invented).
async function businessDetails(db: any): Promise<views.BusinessDetails> {
  const rows = await db.select().from(s.settings);
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = r.value;
  return { name: m.businessName || "", ntn: m.businessNTN || "", address: m.businessAddress || "", phone: m.businessPhone || "", email: m.businessEmail || "", returnsAddress: m.returnsAddress || "" };
}
async function detailsOrUndefined(): Promise<views.BusinessDetails | undefined> {
  const db = getDb();
  if (!db) return undefined;
  try { return await businessDetails(db); } catch { return undefined; }
}

// ---- Storefront pages ----
// Storefront pages call the API actions in-process (callApiAction) instead
// of HTTP-fetching their own server: the payload is identical, and it works
// where no HTTP listener exists (Vercel serverless). See api.ts.
app.get("/", async (_req, res) => {
  const db = getDb();
  if (!db) return noDb(res, "the homepage");
  try {
    const h = await callApiAction("getHomepage", {});
    res.send(views.homepageView(h, await businessDetails(db)));
  } catch (e) { console.error("[homepage]", (e as Error).message); res.status(500).send(views.layout("Error", `<div class="card light-panel"><p>Homepage failed to load. Please try again.</p></div>`)); }
});

app.get("/shop", async (req, res) => {
  const db = getDb();
  if (!db) return noDb(res, "the shop");
  const q: any = req.query;
  // B1: ?flash=1 passes flash:true (the 11-product pool) — it used to be
  // mapped to onDiscount, which shows all 44 discounted products.
  const body: any = { category: q.category || undefined, subcategory: q.subcategory || undefined, search: q.search || undefined, sort: q.sort || undefined, inStock: q.inStock ? true : undefined, onDiscount: q.onDiscount ? true : undefined, flash: q.flash ? true : undefined, minPrice: q.minPrice ? Number(q.minPrice) : undefined, maxPrice: q.maxPrice ? Number(q.maxPrice) : undefined, minRating: q.minRating ? Number(q.minRating) : undefined, limit: 24, offset: Number(q.offset || 0) };
  const cats = await db.select().from(s.categories).orderBy(asc(s.categories.sortOrder), asc(s.categories.id));
  // B5: the "Smartwatches only" shortcut renders only when the current
  // category actually has a Smartwatches subcategory.
  let hasSmartwatches = false;
  if (q.category) {
    const subs = await db.select({ sub: s.products.subcategory }).from(s.products).where(eq(s.products.category, String(q.category)));
    hasSmartwatches = subs.some((r: any) => r.sub === "Smartwatches");
  }
  const data: any = await callApiAction("listProducts", body);
  res.send(views.shopView({ ...data, categories: cats, hasSmartwatches }, { ...(q as any), flash: q.flash }, await businessDetails(db)));
});

app.get("/product/:id", async (req, res) => {
  const db = getDb();
  if (!db) return noDb(res, "product pages");
  // C12: validate the route param first — /product/abc is a 404, not a 500.
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).send(views.layout("Not found", "<p>Product not found.</p>")); return; }
  const p = (await db.select().from(s.products).where(eq(s.products.id, id)))[0];
  if (!p) { res.status(404).send(views.layout("Not found", "<p>Product not found.</p>")); return; }
  const imgs = await db.select().from(s.productImages).where(eq(s.productImages.productId, id)).orderBy(asc(s.productImages.sortOrder));
  const full = { ...p, images: imgs.map((i: any) => ({ ...i, url: imageUrlOf(i) })) };
  const reviews = await db.select().from(s.reviews).where(eq(s.reviews.productId, id));
  const questions = await db.select().from(s.questions).where(eq(s.questions.productId, id));
  // D2: related products — same category, excluding self, 4 items.
  let related: any[] = [];
  try {
    const rel = await callApiAction("listProducts", { category: p.category, limit: 5 });
    related = (rel.products || []).filter((x: any) => x.id !== id).slice(0, 4);
  } catch { related = []; }
  res.send(views.productView(full, reviews, questions, related, await businessDetails(db)));
});

app.get("/cart", async (_req, res) => res.send(views.cartView(await detailsOrUndefined())));
app.get("/wishlist", async (_req, res) => res.send(views.wishlistView(await detailsOrUndefined())));
app.get("/admin/setup", async (_req, res) => res.send(views.ownerSetupView(await detailsOrUndefined())));
app.get("/staff/setup", async (_req, res) => res.send(views.staffSetupView(await detailsOrUndefined())));
app.get("/checkout", async (req, res) => {
  const step = Math.min(7, Math.max(1, Number(req.query.step || 1)));
  res.send(views.checkoutView(step, await detailsOrUndefined()));
});
app.get("/track", async (_req, res) => res.send(views.trackView(await detailsOrUndefined())));
app.get("/account", async (_req, res) => res.send(views.accountView(await detailsOrUndefined())));
app.get("/admin", async (_req, res) => res.send(views.adminView(await detailsOrUndefined())));
app.get("/login", async (_req, res) => res.send(views.authView("login", await detailsOrUndefined())));
app.get("/register", async (_req, res) => res.send(views.authView("register", await detailsOrUndefined())));
app.get("/compare", async (req, res) => {
  // D3: real compare — up to 3 products by ?ids=1,2,3, side-by-side spec table.
  const db = getDb();
  const ids = String(req.query.ids || "").split(",").map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 3);
  let products: any[] = [];
  if (db && ids.length) {
    const rows = await db.select().from(s.products).where(inArray(s.products.id, ids));
    const ordered = ids.map((id) => rows.find((r: any) => r.id === id)).filter(Boolean);
    products = await productsWithImages(db, ordered);
  }
  res.send(views.compareView(products, await detailsOrUndefined()));
});
app.get("/help", async (_req, res) => res.send(views.helpView(await detailsOrUndefined())));
app.get("/policies/:page", async (req, res) => {
  if (!["privacy", "terms", "shipping", "returns"].includes(req.params.page)) { res.status(404).send(views.layout("Not found", "<p>Policy not found.</p>")); return; }
  res.send(views.policyView(req.params.page, await detailsOrUndefined()));
});
// C7/D6: About + Contact shells (render configured details, or the
// [OWNER TO SUPPLY] placeholder until the owner supplies them).
app.get("/about", async (_req, res) => res.send(views.aboutView(await detailsOrUndefined())));
app.get("/contact", async (_req, res) => res.send(views.contactView(await detailsOrUndefined())));
app.get("/merchants", async (_req, res) => {
  const db = getDb();
  if (!db) return noDb(res, "the Merchants directory");
  const rows = await db.select().from(s.demoMerchants).orderBy(desc(s.demoMerchants.rating));
  res.send(views.merchantsView(rows, await businessDetails(db)));
});

// API 404 + error handler (C12: generic message to the client, full
// error in the server log only).
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Unknown API action." }));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const errId = `ERR-${Date.now().toString(36).toUpperCase()}`;
  console.error("[express]", errId, err);
  res.status(500).json({ ok: false, error: `Something went wrong. Reference: ${errId}` });
});

export const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`NEXORA MARKET listening on :${PORT} — demoMode=true, dbConfigured=${isDbConfigured()}`);
  });
}
export default app;
