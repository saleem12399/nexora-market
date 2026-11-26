// NEXORA MARKET — single Node.js service: Express API + server-rendered
// storefront/admin, one process, one Render free web service.
// Boots WITHOUT a database: /health answers honestly and data pages show a
// "database not configured" state instead of crash-looping.

import express from "express";
import path from "node:path";
import { checkDb, getDb, isDbConfigured } from "../db";
import * as s from "../db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { callApiAction, registerApi } from "./api";
import * as views from "./views";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve(__dirname, "../../public"), { maxAge: "1d" }));

// Health — works without a DB, reports db status honestly.
app.get("/health", async (_req, res) => {
  const db = await checkDb();
  res.json({ ok: true, service: "nexora-market", version: "1.0.0", demoMode: true, dbConfigured: isDbConfigured(), db: db.ok ? "connected" : "not configured", dbError: db.ok ? undefined : db.error, time: new Date().toISOString() });
});

registerApi(app);

function noDb(res: express.Response, feature: string) {
  res.status(503).send(views.noDbPage(feature));
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
    res.send(views.homepageView(h));
  } catch (e) { res.status(500).send(views.layout("Error", `<div class="card light-panel"><p>Homepage failed to load: ${views.esc((e as Error).message)}</p></div>`)); }
});

app.get("/shop", async (req, res) => {
  const db = getDb();
  if (!db) return noDb(res, "the shop");
  const q: any = req.query;
  const body: any = { category: q.category || undefined, subcategory: q.subcategory || undefined, search: q.search || undefined, sort: q.sort || undefined, inStock: q.inStock ? true : undefined, onDiscount: q.flash ? true : q.onDiscount ? true : undefined, limit: 48, offset: Number(q.offset || 0) };
  const cats = await db.select().from(s.categories).orderBy(asc(s.categories.sortOrder), asc(s.categories.id));
  const data: any = await callApiAction("listProducts", body);
  res.send(views.shopView({ ...data, categories: cats }, { ...(q as any), flash: q.flash }));
});

app.get("/product/:id", async (req, res) => {
  const db = getDb();
  if (!db) return noDb(res, "product pages");
  const id = Number(req.params.id);
  const p = (await db.select().from(s.products).where(eq(s.products.id, id)))[0];
  if (!p) { res.status(404).send(views.layout("Not found", "<p>Product not found.</p>")); return; }
  const imgs = await db.select().from(s.productImages).where(eq(s.productImages.productId, id)).orderBy(asc(s.productImages.sortOrder));
  const full = { ...p, images: imgs.map((i: any) => ({ ...i, url: `/images/products/${(i.storageKey || "").split("/").pop()}` })) };
  const reviews = await db.select().from(s.reviews).where(eq(s.reviews.productId, id));
  const questions = await db.select().from(s.questions).where(eq(s.questions.productId, id));
  res.send(views.productView(full, reviews, questions));
});

app.get("/cart", (_req, res) => res.send(views.cartView()));
app.get("/checkout", (req, res) => {
  const step = Math.min(7, Math.max(1, Number(req.query.step || 1)));
  res.send(views.checkoutView(step));
});
app.get("/track", (_req, res) => res.send(views.trackView()));
app.get("/account", (_req, res) => res.send(views.accountView()));
app.get("/admin", (_req, res) => res.send(views.adminView()));
app.get("/login", (_req, res) => res.send(views.authView("login")));
app.get("/register", (_req, res) => res.send(views.authView("register")));
app.get("/compare", (_req, res) => res.send(views.compareView()));
app.get("/help", (_req, res) => res.send(views.helpView()));
app.get("/policies/:page", (req, res) => {
  if (!["privacy", "terms", "shipping", "returns"].includes(req.params.page)) { res.status(404).send(views.layout("Not found", "<p>Policy not found.</p>")); return; }
  res.send(views.policyView(req.params.page));
});
app.get("/merchants", async (_req, res) => {
  const db = getDb();
  if (!db) return noDb(res, "the Demo Merchants directory");
  const rows = await db.select().from(s.demoMerchants).orderBy(desc(s.demoMerchants.rating));
  res.send(views.merchantsView(rows));
});

// API 404 + error handler
app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "Unknown API action." }));
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err?.message || "Server error" });
});

export const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`NEXORA MARKET listening on :${PORT} — demoMode=true, dbConfigured=${isDbConfigured()}`);
  });
}
export default app;
