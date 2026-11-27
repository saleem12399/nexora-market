// Server-rendered HTML views (no frontend build step).
// Theme: navy #101828 / blue #315EFB / amber #F59E0B, mobile-first, 0px
// horizontal overflow at 390px. .light-panel pins the light palette inside
// hardcoded light surfaces so text stays dark-on-light in both modes.

import { formatPkr } from "../lib/money";
import { REFUND_STAGE_LABELS } from "../lib/constants";

export interface BusinessDetails { name?: string; ntn?: string; address?: string; phone?: string; email?: string; returnsAddress?: string; }

// C7: footer / policy / About / Contact render the business details from
// settings when the owner has supplied them; until then the honest
// [OWNER TO SUPPLY] placeholder stays — details are NEVER invented.
export function detailsBlock(d?: BusinessDetails): string {
  if (!d || !d.name) return `<p><strong>[OWNER TO SUPPLY]</strong> — registered business name, NTN, business address, returns warehouse address, phone/email. These details will appear here once the owner supplies them.</p>`;
  const parts: string[] = [`<strong>${esc(d.name)}</strong>`];
  if (d.address) parts.push(esc(d.address));
  if (d.phone) parts.push(esc(d.phone));
  if (d.email) parts.push(`<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>`);
  if (d.ntn) parts.push(`NTN ${esc(d.ntn)}`);
  if (d.returnsAddress) parts.push(`Returns: ${esc(d.returnsAddress)}`);
  return `<p>${parts.join(" · ")}</p>`;
}

export function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Display name: the live DB stores "(Demo)" in product names; strip it at
// render time (never rewrite DB rows). Admin lists keep the stored name raw.
export function dispName(s: any): string {
  return String(s ?? "").replace(/ \(Demo\)$/, "");
}

// Display text: strip stored demo wording from live-DB text at render time
// (reviews, Q&A, notifications, merchant names). Live rows were seeded
// before the seed cleanup, so their "(Demo)" / "demo use" / "demo purchase"
// / "— simulated demo event" phrasing survives in the DB; never rewrite rows.
// POLISH (owner wording, 2026-11-27): the word "demo" is never shown to
// customers. Stored "(Demo Simulated)"-style statuses are REWRITTEN to the
// "(Educational Project)" wording (not stripped) so the honesty label stays.
export function cleanText(s: any): string {
  let t = String(s ?? "");
  t = t.replace(/ \(Demo Simulated\)/g, " (Educational Project)").replace(/ \(COD Collected — Demo\)/g, " (COD Collected — Educational Project)");
  t = t.replace(/Refund Pending \(Demo\)/g, "Refund Pending (Educational Project)").replace(/Awaiting Verification \(Demo\)/g, "Awaiting Verification (Educational Project)");
  t = t.replace(/Refunded \(Demo\)/g, "Refunded (Educational Project)");
  t = t.replace(/ \(Demo\)/g, "").replace(/ \(Demo Simulated\)/g, "").replace(/ \(demo simulation\)/g, "");
  t = t.replace(/Demo Simulation — /g, "").replace(/ — demo only, no charge/g, "").replace(/ — simulated demo event\./g, ".");
  t = t.replace(/ in demo data\./g, ".").replace(/ in the demo simulation\./g, ".").replace(/demo electronics/g, "electronics");
  t = t.replace(/demo purchase/g, "purchase").replace(/demo use/g, "use");
  return t.replace(/\s{2,}/g, " ").trim();
}

// Display description: strip the seed "Demo product: ... DEMO DATA" wording
// and its special clauses (medical claims, gold plating, stock demo,
// AI-features, not-a-real-offer, out-of-stock demo, cosmetic demo).
export function dispDesc(s: any): string {
  let t = String(s ?? "");
  t = t.replace(/^Demo product:\s*/i, "");
  t = t.replace(/;\s*no medical claims are made\.?/i, "");
  t = t.replace(/;\s*no medical claims\.?/i, "");
  t = t.replace(/;\s*plating is demo-grade, not solid gold\.?/i, "");
  t = t.replace(/;\s*AI features are demonstrated, not live services\.?/i, "");
  t = t.replace(/,?\s*not a real offer\.?/i, "");
  t = t.replace(/Only a few left in demo stock\.?\s*/i, "");
  t = t.replace(/Shown out of stock to demonstrate stock states\.?\s*/i, "");
  t = t.replace(/Cosmetic demo listing;?\s*/i, "");
  t = t.replace(/\s*[\u2014\u2013-]\s*cosmetic demo product\.?/i, "");
  t = t.replace(/\s*DEMO DATA[ \u2014\u2013-]*simulated listing\.?/i, "");
  t = t.replace(/\s*DEMO DATA\.?/i, "");
  t = t.replace(/\s*\(demo\)/gi, "").replace(/\s*\(demo state\)/gi, "").replace(/\s*\(Demo claim\)/i, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

export function layout(title: string, body: string, opts?: { active?: string; noDb?: boolean; admin?: boolean; details?: BusinessDetails }): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — NEXORA MARKET</title><link rel="stylesheet" href="/css/style.css"><link rel="icon" href="/favicon.ico" type="image/x-icon"></head>
<body>
<header class="topbar"><a class="brand" href="/">NEXORA <span>MARKET</span></a>
<form class="headersearch" method="get" action="/shop" role="search"><input name="search" type="search" placeholder="Search products…" aria-label="Search products"><button class="btn small" type="submit">Search</button></form>
<button class="menu-btn" onclick="document.getElementById('nav').classList.toggle('open')" aria-label="Menu">☰ Menu</button>
<nav id="nav" class="nav">
<a href="/">Home</a><a href="/shop">Shop</a><a href="/merchants">Merchants</a><a href="/help">Help Center</a><a href="/policies/shipping">Policies</a>
<a href="/cart">Cart <span class="badge" id="cartCount">0</span></a><a href="/wishlist">Wishlist</a><a href="/compare">Compare <span class="badge" id="compareCount">0</span></a><a href="/account">My Account</a><a href="/admin">Admin</a>
</nav></header>
<div class="edu-notice"><strong>EDUCATIONAL PROJECT</strong> — Created for AI Course Assignment. No real orders or payments are processed.</div>
${opts?.admin ? `<div class="demo-banner">DEMO / TRIAL MODE — No live payment gateway, courier or messaging provider is connected. Every payment, shipment and tracking step is a simulation.</div>` : ""}
<main class="wrap">${body}</main>
<footer class="footer"><p><strong>NEXORA MARKET</strong> — Shop Smarter. Live Better.</p>
<p>All prices in PKR. Cash on Delivery is collected only at delivery. 14-day return window.</p>
${detailsBlock(opts?.details)}
<form class="newsform" onsubmit="return doSubscribeNewsletter(event)"><label>Offers by email <input id="nlEmail" type="email" required placeholder="you@example.com"></label><button class="btn small">Subscribe</button></form><p class="note" id="nlMsg">No mailing provider is connected yet — your email is saved on the store's list and no marketing email is sent until one is connected.</p>
<p><a href="/about">About</a> · <a href="/contact">Contact</a> · <a href="/policies/privacy">Privacy</a> · <a href="/policies/terms">Terms</a> · <a href="/policies/shipping">Shipping</a> · <a href="/policies/returns">Returns &amp; Refunds</a></p></footer>
<nav class="bottomnav"><a href="/">Home</a><a href="/shop">Shop</a><a href="/wishlist">Wishlist</a><a href="/cart">Cart</a><a href="/track">Track</a><a href="/account">Account</a></nav>
<script src="/js/app.js"></script></body></html>`;
}

export function noDbPage(feature: string): string {
  return layout("Database not configured", `<div class="card light-panel"><h1>Database not configured</h1>
<p>The ${esc(feature)} needs a database. This test server has no <code>DATABASE_URL</code> set yet.</p>
<p>To finish setup: create the Supabase Postgres database, set <code>DATABASE_URL</code> (plus <code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code>) in your host's environment variables (Vercel: Settings → Environment Variables), then run <code>npm run db:migrate &amp;&amp; npm run db:seed</code>. See <code>VERCEL-DEPLOY.md</code>.</p>
<p><a class="btn" href="/health">Check /health</a></p></div>`);
}

export function productCard(p: any): string {
  const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
  const off = p.salePrice != null && p.salePrice < p.price ? Math.round(((p.price - p.salePrice) / p.price) * 100) : 0;
  return `<article class="pcard"><a href="/product/${p.id}"><div class="pimg">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="${esc(dispName(p.name))}" loading="lazy">` : `<div class="tile">${esc(p.tile || "🛍")}</div>`}${off ? `<span class="off">−${off}%</span>` : ""}</div>
<h3>${esc(dispName(p.name))}</h3><div class="stars">★ ${p.rating} (${p.reviewsCount})</div>
<div class="price">${formatPkr(price)} ${off ? `<s>${formatPkr(p.price)}</s>` : ""}</div>
<div class="stock">${p.stock <= 0 ? `<span class="oos">Out of stock</span>` : p.stock <= 10 ? `Only ${p.stock} left` : "In stock"}</div></a>
<div class="row"><button class="btn small" onclick="addToCart(${p.id},1)" ${p.stock <= 0 ? "disabled" : ""}>Add to Cart</button>
<button class="btn ghost small" onclick="addToWishlist(${p.id})">♡ Wishlist</button>
<button class="btn ghost small" onclick="toggleCompare(${p.id})">⇄ Compare</button></div>
<p class="soldby">Sold by NEXORA Official Store</p></article>`;
}

export function homepageView(h: any, details?: BusinessDetails): string {
  const secs: any[] = (h.sections || []).filter((x: any) => x.visible).sort((a: any, b: any) => a.sortOrder - b.sortOrder);
  let html = "";
  for (const sec of secs) {
    if (sec.key === "hero") {
      const slides = (h.banners || []).map((b: any, i: number) => `<div class="slide ${i === 0 ? "active" : ""}" data-i="${i}">
${b.imageUrl ? `<img src="${esc(b.imageUrl)}" alt="">` : ""}<div class="slide-text"><${i === 0 ? "h1" : "h2"}>${esc(b.headline)}</${i === 0 ? "h1" : "h2"}><p>${esc(b.subtext)}</p>
<p><a class="btn" href="/shop?category=${encodeURIComponent(safeTarget(b.ctaTarget).category || "")}">${esc(b.ctaLabel || "Shop now")}</a>${(b.cta2Label || "") ? `
<a class="btn ghost" href="/shop?category=${encodeURIComponent(safeTarget(b.cta2Target).category || "")}">${esc(b.cta2Label)}</a>` : ""}</p>
</div></div>`).join("");
      html += `<section class="hero" id="hero">${slides || `<div class="slide active"><div class="slide-text"><h1>NEXORA MARKET</h1><p>Shop Smarter. Live Better.</p></div></div>`}
<div class="dots">${(h.banners || []).map((_: any, i: number) => `<button class="${i === 0 ? "active" : ""}" onclick="heroGo(${i},true)" aria-label="Slide ${i + 1}"></button>`).join("")}<button class="hero-pause" id="heroPauseBtn" onclick="heroPauseToggle()" aria-label="Pause slideshow">Pause</button></div></section>`;
    } else if (sec.key === "categories") {
      html += `<section><h2>Shop by Category</h2><div class="catgrid">${(h.categories || []).map((c: any) => `<a class="catcard" href="/shop?category=${encodeURIComponent(c.category)}">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="">` : ""}<span>${esc(c.category)} (${c.count})</span></a>`).join("")}</div></section>`;
    } else if (sec.key === "flash") {
      const fr = h.flashRow || {};
      html += `<section><h2>⚡ Flash Sale</h2>
<p class="note">Rotating deals — ${fr.poolSize || 0} flash products, ${fr.rowSize || 5} in this set, new set every ${fr.rotateDays || 2} day(s). Next refresh: ${esc(fr.nextRotationAt || "")}. ${h.flashEndsAt ? `<span id="flashCountdown" data-end="${esc(h.flashEndsAt)}">Sale ends ${esc(h.flashEndsAt)}.</span>` : "No countdown — no campaign end is set."}</p>
<div class="flashwrap"><button class="flash-arrow left" onclick="flashScroll(-1)" aria-label="Scroll flash deals left">‹</button><div class="flashrow" id="flashRow">${(fr.products || []).map(productCard).join("")}</div><button class="flash-arrow right" onclick="flashScroll(1)" aria-label="Scroll flash deals right">›</button></div>
<p><a class="btn ghost" href="/shop?flash=1">See all flash deals →</a></p></section>`;
    } else if (sec.key === "collections") {
      html += `<section><h2>Featured Collections</h2><div class="collgrid">${(h.collections || []).map((c: any) => `<a class="collcard" href="/shop?category=${encodeURIComponent(c.category)}"><strong>${esc(c.name)}</strong><span>${esc(c.tagline || "")}</span></a>`).join("")}</div></section>`;
    } else if (sec.key === "bestSellers") {
      const bs = h.bestSellers || {};
      html += `<section><h2>Best Sellers</h2><p class="note">Ranked from real order data (source: sales)${bs.fallback ? ` — ${esc(bs.fallback.label)}` : ""}.</p>
<div class="grid">${(bs.products || []).map(productCard).join("")}${(bs.fallback?.products || []).map(productCard).join("")}</div></section>`;
    } else if (sec.key === "newArrivals") {
      html += `<section><h2>New Arrivals</h2><div class="grid">${(h.newArrivals || []).map(productCard).join("")}</div><p><a class="btn ghost" href="/shop?sort=newest">View All →</a></p></section>`;
    } else if (sec.key === "recommended") {
      html += `<section><h2>Recommended For You</h2><p class="note">${h.recommended?.mode === "own-orders" ? "Based on the categories of your own orders only." : "Featured picks for guests — sign in for recommendations from your own orders."}</p>
<div class="grid">${(h.recommended?.products || []).map(productCard).join("")}</div></section>`;
    } else if (sec.key === "trust") {
      html += `<section><h2>Why Shop With NEXORA</h2><div class="trustgrid">
<div class="trust"><svg viewBox="0 0 24 24" fill="none" stroke="#315EFB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 8h13v8H1z"/><path d="M14 11h4l3 3v2h-7"/><circle cx="6" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg> <strong>Delivery info at checkout</strong><span>Standard, Express, Scheduled and Pickup options with arrival dates.</span></div>
<div class="trust"><svg viewBox="0 0 24 24" fill="none" stroke="#315EFB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg> <strong>Secure checkout</strong><span>Server-recomputed totals — the client never dictates a price.</span></div>
<div class="trust"><svg viewBox="0 0 24 24" fill="none" stroke="#315EFB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg> <strong>14-day return window</strong><span>With a 9-stage refund tracker you can follow.</span></div>
<div class="trust"><svg viewBox="0 0 24 24" fill="none" stroke="#315EFB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg> <strong>12-step order tracking</strong><span>From Pending to Delivered, end to end.</span></div>
<div class="trust"><svg viewBox="0 0 24 24" fill="none" stroke="#315EFB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg> <strong>Help Center &amp; support</strong><span>FAQs, support cases and ticket replies.</span></div></div></section>`;
    } else if (sec.key === "reviews") {
      html += `<section><h2>What Customers Say</h2><div class="revgrid">${(h.reviews || []).map((r: any) => `<div class="review"><strong>${esc(dispName(r.productName || ""))}</strong><div class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</div><p>${esc(cleanText(r.text))}</p><small>— ${esc(dispName(r.customerName))} ${r.verified ? "· Verified purchase" : ""}</small></div>`).join("")}</div></section>`;
    }
  }
  return layout("Home", html, { details });
}

function safeTarget(v: any): any { return v && typeof v === "object" ? v : {}; }

// C1: next Load-more URL — keeps only DEFINED query values (no
// `flash=undefined`), and the next offset is the CURRENT offset plus the
// number of products on this page (never just the page size, never back).
function loadMoreQuery(q: any, data: any): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q || {})) {
    if (k === "offset") continue;
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const cur = Number(q?.offset || 0);
  params.set("offset", String(cur + (data.products || []).length));
  return params.toString();
}

export function shopView(data: any, q: any, details?: BusinessDetails): string {
  const cats: any[] = data.categories || [];
  const top = cats.filter((c: any) => !c.parent && c.active);
  const subs = q.category ? cats.filter((c: any) => c.parent === q.category && c.active) : [];
  const chips = q.category
    ? subs.map((c: any) => `<a class="chip ${q.subcategory === c.name ? "on" : ""}" href="/shop?category=${encodeURIComponent(q.category)}&subcategory=${encodeURIComponent(c.name)}">${esc(c.name)}</a>`).join("")
    : top.map((c: any) => `<a class="chip" href="/shop?category=${encodeURIComponent(c.name)}">${esc(c.name)} (${c.productCount})</a>`).join("");
  const banner = q.category && q.subcategory ? `<p class="strict-banner">Showing only ${esc(q.subcategory)} in ${esc(q.category)} — ${data.total} product(s)</p>` : "";
  return layout("Shop", `<h1>Shop</h1>${banner}
<div class="chips">${chips}</div>
<form class="filters" method="get" action="/shop">
<input type="hidden" name="category" value="${esc(q.category || "")}">
${q.flash ? `<input type="hidden" name="flash" value="1">` : ""}
<label>Subcategory <select name="subcategory"><option value="">All</option>${subs.map((c: any) => `<option ${q.subcategory === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
<label>Search <input name="search" list="sugg" value="${esc(q.search || "")}" placeholder="Search products…"><datalist id="sugg">${(data.suggestions || []).map((s: string) => `<option value="${esc(dispName(s))}">`).join("")}</datalist></label>
<label>Sort <select name="sort"><option value="">Relevance</option><option value="biggest-discount" ${q.sort === "biggest-discount" ? "selected" : ""}>Biggest discount</option><option value="price-asc" ${q.sort === "price-asc" ? "selected" : ""}>Price: low to high</option><option value="price-desc" ${q.sort === "price-desc" ? "selected" : ""}>Price: high to low</option><option value="rating" ${q.sort === "rating" ? "selected" : ""}>Top rated</option><option value="newest" ${q.sort === "newest" ? "selected" : ""}>Newest</option></select></label>
<label>Min price (Rs) <input name="minPrice" type="number" min="0" value="${esc(q.minPrice || "")}" placeholder="0"></label>
<label>Max price (Rs) <input name="maxPrice" type="number" min="0" value="${esc(q.maxPrice || "")}" placeholder="Any"></label>
<label>Min rating <select name="minRating"><option value="">Any</option>${[4.5, 4, 3.5, 3].map((r) => `<option value="${r}" ${String(q.minRating) === String(r) ? "selected" : ""}>${r}★ &amp; up</option>`).join("")}</select></label>
<label><input type="checkbox" name="inStock" value="1" ${q.inStock ? "checked" : ""}> In stock only</label>
<label><input type="checkbox" name="onDiscount" value="1" ${q.onDiscount ? "checked" : ""}> On discount</label>
<button class="btn small">Apply</button> <button type="button" class="btn ghost small" onclick="saveCurrentSearch()">Save this search</button> <a class="btn ghost small" href="/shop">Clear all</a>
${q.category && data.hasSmartwatches ? `<a class="btn ghost small" href="/shop?category=${encodeURIComponent(q.category)}&subcategory=Smartwatches">Smartwatches only →</a>` : ""}
</form>
<p class="note">${data.total} product(s)${q.flash ? " — full flash list" : ""}</p>
<div class="grid">${(data.products || []).map(productCard).join("") || "<p>No products match these filters.</p>"}</div>
${data.total > (Number(q.offset || 0) + (data.products || []).length) ? `<p><a class="btn" href="/shop?${esc(loadMoreQuery(q, data))}">Load more</a></p>` : ""}`, { details });
}

export function productView(p: any, reviews: any[], questions: any[], related: any[] = [], details?: BusinessDetails): string {
  const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
  // C5: omit variant lines with no real value — never a bare "—".
  const variantLines: string[] = [];
  if (p.colors) variantLines.push(`Colours: ${esc(p.colors)}`);
  if (p.sizes) variantLines.push(`Sizes: ${esc(p.sizes)}`);
  if (p.warranty) variantLines.push(`Warranty: ${esc(p.warranty)}`);
  return layout(dispName(p.name), `<div class="pdetail light-panel">
<div class="pgallery">${p.images?.length ? `<div class="mainphoto"><img id="mainPhoto" src="${esc(p.images[0].url)}" alt="${esc(dispName(p.name))}" onclick="this.classList.toggle('zoomed')" title="Tap to zoom"></div><div class="thumbs">${p.images.map((i: any, ix: number) => `<img src="${esc(i.url)}" alt="Photo ${ix + 1} of ${esc(dispName(p.name))}" class="${ix === 0 ? "on" : ""}" onclick="swapMainPhoto('${esc(i.url)}', this)">`).join("")}</div>` : `<div class="tile big">${esc(p.tile || "🛍")}</div><p>No photo yet.</p>`}
</div>
<div class="pinfo"><h1>${esc(dispName(p.name))}</h1><p class="stars">★ ${p.rating} (${p.reviewsCount} reviews) · ${p.sold} sold</p>
<p class="price big">${formatPkr(price)} ${p.salePrice != null && p.salePrice < p.price ? `<s>${formatPkr(p.price)}</s> <span class="off">−${Math.round(((p.price - p.salePrice) / p.price) * 100)}%</span>` : ""}</p>
<p>${esc(dispDesc(p.shortDesc))}</p><p>${esc(dispDesc(p.description))}</p>
<p class="soldby">Sold by NEXORA Official Store · Warehouse: ${esc(p.warehouse)}</p>
<p>${p.stock <= 0 ? '<span class="oos">Out of stock</span>' : `In stock: ${p.stock}`}</p>
<p><button class="btn" onclick="addToCart(${p.id},1)" ${p.stock <= 0 ? "disabled" : ""}>Add to Cart</button>
<button class="btn ghost" onclick="buyNow(${p.id})">Buy Now</button>
<button class="btn ghost" onclick="addToWishlist(${p.id})">♡ Wishlist</button>
<button class="btn ghost" onclick="shareProduct(${p.id}, '${esc(dispName(p.name))}')">Share</button>
<button class="btn ghost" onclick="toggleCompare(${p.id})">⇄ Compare</button></p>
<h3>Specifications</h3><p class="specs">${esc(dispDesc(p.specs || "—"))}</p>
${variantLines.length ? `<p>${variantLines.join(" · ")}</p>` : ""}
${p.category === "Mobile Phones" ? "<p>PTA note: check PTA approval status for this device before use in Pakistan.</p>" : ""}
${(p.subcategory || "").includes("Glasses") ? "<p>Smart-glasses note: frame, lens, camera, audio, Bluetooth, battery and compatibility are listed in the specifications above.</p>" : ""}
</div></div>
<section><h2>Reviews</h2>${reviews.map((r: any) => `<div class="review"><strong>${esc(dispName(r.customerName))}</strong> ${"★".repeat(r.rating)}<p>${esc(cleanText(r.text))}</p>${r.sellerReply ? `<p class="reply">NEXORA reply: ${esc(r.sellerReply)}</p>` : ""}</div>`).join("") || "<p>No reviews yet.</p>"}</section>
<section><h2>Questions &amp; Answers</h2>${questions.map((x: any) => `<div class="review"><p><strong>Q:</strong> ${esc(cleanText(x.question))} — ${esc(dispName(x.customerName))}</p><p><strong>A:</strong> ${esc(cleanText(x.answer || "Not answered yet."))}</p></div>`).join("") || "<p>No questions yet.</p>"}</section>
<section><h2>Write a Review</h2><form class="card light-panel" onsubmit="return doSubmitReview(event, ${p.id})"><p class="note">Sign in to have your review marked "Verified purchase" — the flag is set only when you actually bought this product.</p><label>Rating <select id="rvRating"><option value="5">★★★★★ (5)</option><option value="4">★★★★ (4)</option><option value="3">★★★ (3)</option><option value="2">★★ (2)</option><option value="1">★ (1)</option></select></label><label>Your review <textarea id="rvText" required rows="3" placeholder="What did you think of this product?"></textarea></label><button class="btn">Submit review</button></form><div id="rvMsg"></div></section>
<section><h2>Ask a Question</h2><form class="card light-panel" onsubmit="return doAskQuestion(event, ${p.id})"><label>Your question <input id="qaText" required placeholder="e.g. Is this PTA approved?"></label><button class="btn">Ask</button></form><div id="qaMsg"></div></section>
${related.length ? `<section><h2>You May Also Like</h2><div class="grid">${related.map(productCard).join("")}</div></section>` : ""}`, { details });
}

export function trackView(details?: BusinessDetails): string {
  return layout("Track Order", `<h1>Track Your Order</h1><p class="note">Enter your order and tracking numbers to follow your parcel.</p>
<p class="note"><strong>Educational Project</strong> — no real shipment. Tracking events are recorded for the assignment only.</p>
<form class="card light-panel" onsubmit="return trackOrder(event)"><label>Order number <input id="tOrder" required placeholder="NX-…"></label>
<label>Tracking number <input id="tTrack" required placeholder="TRK-…"></label>
<button class="btn">Track</button></form><div id="trackResult"></div>`, { details });
}

export function accountView(details?: BusinessDetails): string {
  return layout("My Account", `<div class="dash" id="accountRoot"><p>Loading your dashboard…</p></div>
`, { details });
}

// B2: the wishlist page — a real route, not a hidden panel. Filled by
// loadWishlist() in app.js from listWishlist (server-scoped key).
export function wishlistView(details?: BusinessDetails): string {
  return layout("My Wishlist", `<h1>My Wishlist</h1><p class="note">Items you saved — sign in and they follow your account; guests keep them in this browser.</p>
<div id="wishlistRoot"><p>Loading your wishlist…</p></div>
<p><a class="btn ghost" href="/shop">Continue shopping →</a></p>`, { details });
}

export function adminView(details?: BusinessDetails): string {
  const tabs = ["Dashboard", "Products", "Categories", "Inventory", "Orders", "Payments", "Returns / Refunds", "Customers", "Support", "Reviews", "Notifications", "Coupons", "Staff & Permissions", "Reports", "Settings", "Homepage", "Demo Merchants", "Demo Manager", "Phase 2", "Audit Log"];
  return layout("Admin", `<h1>Admin <span class="demo-tag">DEMO / TRIAL MODE</span></h1>
<div id="staffBar"></div>
<p class="note">20 modules (spec §7.7). The Phase 1 lab test observed 21 admin tabs — the extra tab was the Phase 2 tab added later; the actual list below is the 20-module list, with Orders and Tracking kept as one Orders tab (tracking manager inside it). Staff access is by real sign-in (email + password + authenticator code) — the old role dropdown is gone, roles come from the server session, and denials are audit-logged.</p>
<div class="tabs" id="adminTabs" style="display:none">${tabs.map((t, i) => `<button class="tab ${i === 0 ? "on" : ""}" onclick="adminTab(${i},this)">${esc(t)}</button>`).join("")}</div>
<div id="adminRoot" class="card light-panel"><p>Loading…</p></div>
`, { admin: true, details });
}

// Owner first-password setup (/admin/setup). The page is a two-step form:
// step 1 — setup token + new password; step 2 — authenticator secret +
// 6-digit code. Usable ONLY while no owner setup is complete.
export function ownerSetupView(details?: BusinessDetails): string {
  return layout("Owner Setup", `<h1>Owner Setup — NEXORA MARKET</h1>
<div class="card light-panel" id="ownerSetupRoot"><p>Loading setup status…</p></div>
<p class="note">First time here? 1) Pick a secret setup token and set it as the Vercel env var <code>NEXORA_OWNER_SETUP_TOKEN</code> (Production), then redeploy. 2) Come back here, type the token and your new password. 3) Add the authenticator secret to your authenticator app and type the 6-digit code. Never share the token or your password in chat.</p>`, { details });
}

// Staff activation (/staff/setup?email=…&token=…). Same two-step pattern
// as owner setup, with the one-time token the owner sent out of band.
export function staffSetupView(details?: BusinessDetails): string {
  return layout("Staff Setup", `<h1>Staff Setup — NEXORA MARKET</h1>
<div class="card light-panel" id="staffSetupRoot"><p>Loading…</p></div>
<p class="note">Use the one-time setup token the owner sent you (e.g. WhatsApp). It expires in 24 hours. After setup, sign in at /admin with your email, password and authenticator code.</p>`, { details });
}

export function checkoutView(step: number, details?: BusinessDetails): string {
  const steps = ["Cart Review", "Customer Info", "Delivery Address", "Shipping", "Payment", "Summary", "Confirm"];
  return layout(`Checkout — ${steps[step - 1]}`, `<h1>Checkout</h1>
<ol class="steps">${steps.map((s, i) => `<li class="${i + 1 === step ? "on" : i + 1 < step ? "done" : ""}">${i + 1}. ${s}</li>`).join("")}</ol>
<div id="checkoutRoot" class="card light-panel" data-step="${step}"><p>Loading step ${step}…</p></div>
`, { details });
}

export function cartView(details?: BusinessDetails): string {
  return layout("Cart", `<h1>Your Cart</h1><div id="cartRoot"><p>Loading cart…</p></div>`, { details });
}

export function authView(kind: "login" | "register", details?: BusinessDetails): string {
  const isLogin = kind === "login";
  return layout(isLogin ? "Sign In" : "Register", `<h1>${isLogin ? "Sign In" : "Create Account"}</h1>
<div class="card light-panel"><form onsubmit="return ${isLogin ? "doLogin" : "doRegister"}(event)">
<label>Name ${isLogin ? "" : '<input id="aName" required>'} </label>
<label>Email <input id="aEmail" type="email" required></label>
<label>Phone <input id="aPhone" placeholder="03XXXXXXXXX" ${isLogin ? "" : "required"}></label>
<label>Password <span class="pw"><input id="aPass" type="password" required minlength="8"><button type="button" onclick="togglePw('aPass',this)">👁️</button></span></label>
${isLogin ? "" : '<label>Confirm password <input id="aPass2" type="password" required minlength="8"></label><p class="note">Password strength: use 8+ characters with a mix of letters and numbers.</p>'}
<button class="btn">${isLogin ? "Sign In" : "Register"}</button></form>
<p>${isLogin ? `No account? <a href="/register">Register</a> · <a href="#" onclick="forgotPassword(event)">Forgot password?</a>` : `Already have an account? <a href="/login">Sign In</a>`}</p>
<p class="note">Seeded accounts have NO usable password yet (the export contained no hash values). Password reset by email is not available yet — no email provider is connected. Contact the store owner to set a password. Never share a password in chat.</p></div>`, { details });
}

export function policyView(page: string, details?: BusinessDetails): string {
  const titles: Record<string, string> = { privacy: "Privacy Policy", terms: "Terms of Service", shipping: "Shipping Policy", returns: "Returns & Refunds Policy" };
  const bodies: Record<string, string> = {
    privacy: "<p>We collect only what checkout and support need: name, email, phone and delivery address. No payment card numbers are stored — only a •••• last-4 label. Verification emails are not sent yet.</p>",
    terms: "<p>All prices are in PKR. Orders are delivered by NEXORA Express. Cash on Delivery is collected only at delivery.</p>",
    shipping: "<p>Standard Rs. 250 (free at Rs. 5,000+ after discount), Express Rs. 450, Scheduled Rs. 450, Pickup Rs. 0. Delivery times are estimates.</p>",
    returns: "<p>14-day return window. Returns follow a 9-stage tracker (Requested → Refunded); stock is restocked at stage 4.</p>",
  };
  return layout(titles[page] || "Policy", `<h1>${titles[page] || "Policy"}</h1><div class="card light-panel">${bodies[page] || ""}${detailsBlock(details)}</div>`, { details });
}

export function merchantsView(merchants: any[], details?: BusinessDetails): string {
  return layout("Merchants", `<h1>Merchants</h1><p class="note">A directory of the featured stores in NEXORA MARKET.</p>
<div class="grid">${merchants.map((m: any) => `<div class="card light-panel"><h3>${esc(dispName(m.storeName))}</h3><p>${esc(dispName(m.ownerName))} · ${esc(m.city)}</p><p>Focus: ${esc(m.categoryFocus)}</p><p>★ ${m.rating} (${m.reviewsCount} reviews) · ${esc(m.verification)} · Joined ${esc(m.joined)}</p></div>`).join("")}</div>`, { details });
}

export function helpView(details?: BusinessDetails): string {
  // B15: every tile goes to its real destination — nothing points at /track
  // unless it is actually about tracking.
  const tiles: [string, string][] = [
    ["Track my order", "/track"], ["Cancel an order", "/account"], ["Return a product", "/account"], ["Refund status", "/account"],
    ["Payment methods", "/account"], ["Delivery options", "/policies/shipping"], ["Coupons", "/shop?onDiscount=1"],
    ["My account & password", "/account"], ["Addresses", "/account"], ["Wishlist", "/wishlist"],
    ["Product photos", "/shop"], ["Merchants", "/merchants"], ["Contact support", "#support"], ["Give feedback", "#support"],
  ];
  return layout("Help Center", `<h1>Help Center</h1><div class="tiles">${tiles.map(([t, href]) => `<a class="tilecard" href="${esc(href)}">${esc(t)}</a>`).join("")}</div>
<h2>FAQs</h2><div class="card light-panel"><p><strong>How do I pay?</strong> Pay Cash on Delivery, or choose a wallet/card at Step 5 and confirm before placing your order.</p>
<p><strong>Are the product photos final?</strong> The photos are representative images; real product photos will replace them.</p>
<p><strong>How do I track an order?</strong> Use Track with your order number (NX-…) and tracking number (TRK-…).</p></div>
<h2 id="support">Contact support</h2>
<form class="card light-panel" onsubmit="return doCreateTicket(event)"><p class="note">Open a support case — the team replies on your ticket. Sign in first so the reply reaches your account.</p>
<label>Your name <input id="tkName" required></label>
<label>Subject <input id="tkSubject" required placeholder="e.g. My order is late"></label>
<label>Category <select id="tkCategory"><option>General</option><option>Order</option><option>Payment</option><option>Return</option><option>Delivery</option></select></label>
<label>Order number (optional) <input id="tkOrder" placeholder="NX-…"></label>
<label>Describe the problem <textarea id="tkDesc" required rows="4"></textarea></label>
<button class="btn">Open support case</button></form><div id="ticketResult"></div>
<p><a class="btn" href="/track">Track an order</a> <a class="btn ghost" href="/account">Open a support case</a></p>`, { details });
}

export function compareView(products: any[] = [], details?: BusinessDetails): string {
  if (!products.length) {
    return layout("Compare", `<h1>Compare Products</h1><div class="card light-panel"><p>No products selected yet. Add up to 3 products to compare from the Shop or a product page (⇄ Compare button), and they will appear here side by side.</p><p><a class="btn" href="/shop">Browse the Shop</a></p></div>`, { details });
  }
  const eff = (p: any) => (p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price);
  const row = (label: string, fn: (p: any) => string) => `<tr><th>${label}</th>${products.map((p) => `<td>${fn(p)}</td>`).join("")}</tr>`;
  return layout("Compare", `<h1>Compare Products</h1><div class="card light-panel"><div class="tablewrap"><table>
<tr><th></th>${products.map((p) => `<th>${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" style="width:120px;height:90px;object-fit:cover;border-radius:8px">` : ""}<br><a href="/product/${p.id}">${esc(dispName(p.name))}</a><br><button class="btn ghost small" onclick="removeFromCompare(${p.id})">Remove</button></th>`).join("")}</tr>
${row("Price", (p) => formatPkr(eff(p)) + (p.salePrice != null && p.salePrice < p.price ? ` <s>${formatPkr(p.price)}</s>` : ""))}
${row("Rating", (p) => `★ ${p.rating} (${p.reviewsCount} reviews)`)}
${row("Stock", (p) => p.stock <= 0 ? "Out of stock" : String(p.stock))}
${row("Brand", (p) => esc(p.brand || "—"))}
${row("Category", (p) => esc(p.category || "—"))}
${row("Colours", (p) => esc(p.colors || "—"))}
${row("Sizes", (p) => esc(p.sizes || "—"))}
${row("Warranty", (p) => esc(p.warranty || "—"))}
${row("Specifications", (p) => esc(dispDesc(p.specs || "—")))}
</table></div><p><a class="btn ghost" href="/shop">Add more from the Shop</a> <button class="btn ghost" onclick="clearCompare()">Clear all</button></p></div>`, { details });
}

// C7/D6: About + Contact page shells — they render whatever business
// details are configured in settings, and the [OWNER TO SUPPLY]
// placeholder until the owner supplies them. Never invented.
export function aboutView(details?: BusinessDetails): string {
  return layout("About", `<h1>About NEXORA MARKET</h1><div class="card light-panel"><p>NEXORA MARKET is a single-company online store in Pakistan — fashion, phones, wearables, audio, jewelry, beauty and kids' wear, with Cash on Delivery and a 14-day return window.</p>${detailsBlock(details)}</div>`, { details });
}

export function contactView(details?: BusinessDetails): string {
  return layout("Contact", `<h1>Contact Us</h1><div class="card light-panel"><p>Questions about an order, a return or a product? Reach the store below — or open a support case from the <a href="/help">Help Center</a>.</p>${detailsBlock(details)}</div>`, { details });
}

export { REFUND_STAGE_LABELS };
