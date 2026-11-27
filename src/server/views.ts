// Server-rendered HTML views (no frontend build step).
// Theme: navy #101828 / blue #315EFB / amber #F59E0B, mobile-first, 0px
// horizontal overflow at 390px. .light-panel pins the light palette inside
// hardcoded light surfaces so text stays dark-on-light in both modes.

import { formatPkr } from "../lib/money";
import { REFUND_STAGE_LABELS } from "../lib/constants";

export function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function layout(title: string, body: string, opts?: { active?: string; noDb?: boolean }): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — NEXORA MARKET</title><link rel="stylesheet" href="/css/style.css"></head>
<body>
<header class="topbar"><a class="brand" href="/">NEXORA <span>MARKET</span></a>
<button class="menu-btn" onclick="document.getElementById('nav').classList.toggle('open')" aria-label="Menu">☰ Menu</button>
<nav id="nav" class="nav">
<a href="/">Home</a><a href="/shop">Shop</a><a href="/merchants">Demo Merchants</a><a href="/help">Help Center</a><a href="/policies/shipping">Policies</a>
<a href="/cart">Cart <span class="badge" id="cartCount">0</span></a><a href="/account">My Account</a><a href="/admin">Admin <span class="demo-tag">DEMO</span></a>
</nav></header>
<div class="demo-banner">DEMO / TRIAL MODE — No live payment gateway, courier or messaging provider is connected. Every payment, shipment and tracking step is a simulation.</div>
<main class="wrap">${body}</main>
<footer class="footer"><p><strong>NEXORA MARKET</strong> — Shop Smarter. Live Better.</p>
<p>Demo store: all products, orders and payments are simulated. Cash on Delivery is collected only at delivery (demo). 14-day demo return window.</p>
<p><a href="/policies/privacy">Privacy</a> · <a href="/policies/terms">Terms</a> · <a href="/policies/shipping">Shipping</a> · <a href="/policies/returns">Returns &amp; Refunds</a></p></footer>
<nav class="bottomnav"><a href="/">Home</a><a href="/shop">Shop</a><a href="/cart">Cart</a><a href="/track">Track</a><a href="/account">Account</a></nav>
<script src="/js/app.js"></script></body></html>`;
}

export function noDbPage(feature: string): string {
  return layout("Database not configured", `<div class="card light-panel"><h1>Database not configured</h1>
<p>The ${esc(feature)} needs a database. This test server has no <code>DATABASE_URL</code> set yet.</p>
<p>To finish setup: create the Supabase Postgres database, set <code>DATABASE_URL</code> (plus <code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code>) in Render, then run <code>npm run db:migrate &amp;&amp; npm run db:seed</code>. See <code>RENDER-DEPLOY.md</code>.</p>
<p><a class="btn" href="/health">Check /health</a></p></div>`);
}

export function productCard(p: any): string {
  const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
  const off = p.salePrice != null && p.salePrice < p.price ? Math.round(((p.price - p.salePrice) / p.price) * 100) : 0;
  return `<article class="pcard"><a href="/product/${p.id}"><div class="pimg">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy">` : `<div class="tile">${esc(p.tile || "🛍")}</div>`}<span class="sample-chip">Sample image</span>${off ? `<span class="off">−${off}%</span>` : ""}</div>
<h3>${esc(p.name)}</h3><div class="stars">★ ${p.rating} (${p.reviewsCount})</div>
<div class="price">${formatPkr(price)} ${off ? `<s>${formatPkr(p.price)}</s>` : ""}</div>
<div class="stock">${p.stock <= 0 ? `<span class="oos">Out of stock</span>` : p.stock <= 10 ? `Only ${p.stock} left` : "In stock"}</div></a>
<div class="row"><button class="btn small" onclick="addToCart(${p.id},1)" ${p.stock <= 0 ? "disabled" : ""}>Add to Cart</button>
<button class="btn ghost small" onclick="addToWishlist(${p.id})">♡ Wishlist</button></div>
<p class="soldby">Sold by NEXORA Official Store</p></article>`;
}

export function homepageView(h: any): string {
  const secs: any[] = (h.sections || []).filter((x: any) => x.visible).sort((a: any, b: any) => a.sortOrder - b.sortOrder);
  let html = "";
  for (const sec of secs) {
    if (sec.key === "hero") {
      const slides = (h.banners || []).map((b: any, i: number) => `<div class="slide ${i === 0 ? "active" : ""}" data-i="${i}">
${b.imageUrl ? `<img src="${esc(b.imageUrl)}" alt="">` : ""}<div class="slide-text"><h2>${esc(b.headline)}</h2><p>${esc(b.subtext)}</p>
<p><a class="btn" href="/shop?category=${encodeURIComponent(safeTarget(b.ctaTarget).category || "")}">${esc(b.ctaLabel || "Shop now")}</a>
<a class="btn ghost" href="/shop?category=${encodeURIComponent(safeTarget(b.cta2Target).category || "")}">${esc(b.cta2Label || "")}</a></p>
<span class="sample-chip">Sample image</span></div></div>`).join("");
      html += `<section class="hero" id="hero">${slides || `<div class="slide active"><div class="slide-text"><h2>NEXORA MARKET</h2><p>Shop Smarter. Live Better.</p></div></div>`}
<div class="dots">${(h.banners || []).map((_: any, i: number) => `<button onclick="heroGo(${i})" aria-label="Slide ${i + 1}">●</button>`).join("")}</div></section>`;
    } else if (sec.key === "categories") {
      html += `<section><h2>Shop by Category</h2><div class="catgrid">${(h.categories || []).map((c: any) => `<a class="catcard" href="/shop?category=${encodeURIComponent(c.category)}">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="">` : ""}<span>${esc(c.category)} (${c.count})</span><span class="sample-chip">Sample image</span></a>`).join("")}</div></section>`;
    } else if (sec.key === "flash") {
      const fr = h.flashRow || {};
      html += `<section><h2>⚡ Flash Sale <span class="demo-tag">DEMO</span></h2>
<p class="note">Rotating deals — ${fr.poolSize || 0} flash products, ${fr.rowSize || 5} in this set, new set every ${fr.rotateDays || 2} day(s). Next refresh: ${esc(fr.nextRotationAt || "")}. ${h.flashEndsAt ? `Sale ends ${esc(h.flashEndsAt)}.` : "No countdown — no campaign end is set."}</p>
<div class="flashrow">${(fr.products || []).map(productCard).join("")}</div>
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
<div class="trust">🚚 <strong>Delivery info at checkout</strong><span>Standard, Express, Scheduled and Pickup options with arrival dates.</span></div>
<div class="trust">🔒 <strong>Secure checkout</strong><span>Server-recomputed totals — the client never dictates a price.</span></div>
<div class="trust">↩️ <strong>14-day demo return window</strong><span>With a 9-stage refund tracker you can follow.</span></div>
<div class="trust">📦 <strong>12-step order tracking</strong><span>From Pending to Delivered, simulated end to end.</span></div>
<div class="trust">💬 <strong>Help Center &amp; support</strong><span>FAQs, support cases and ticket replies.</span></div></div></section>`;
    } else if (sec.key === "reviews") {
      html += `<section><h2>What Customers Say</h2><div class="revgrid">${(h.reviews || []).map((r: any) => `<div class="review"><strong>${esc(r.productName || "")}</strong><div class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</div><p>${esc(r.text)}</p><small>— ${esc(r.customerName)} ${r.verified ? "· Verified purchase" : ""}</small></div>`).join("")}</div></section>`;
    }
  }
  return layout("Home", html + `<p class="note">DEMO notice: every product photo is a representative sample image, labelled "Sample image". Real product photos are still owed by the owner and will replace the samples.</p>`);
}

function safeTarget(v: any): any { return v && typeof v === "object" ? v : {}; }

export function shopView(data: any, q: any): string {
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
<label>Subcategory <select name="subcategory"><option value="">All</option>${subs.map((c: any) => `<option ${q.subcategory === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
<label>Search <input name="search" list="sugg" value="${esc(q.search || "")}" placeholder="Search products…"><datalist id="sugg">${(data.suggestions || []).map((s: string) => `<option value="${esc(s)}">`).join("")}</datalist></label>
<label>Sort <select name="sort"><option value="">Relevance</option><option value="biggest-discount" ${q.sort === "biggest-discount" ? "selected" : ""}>Biggest discount</option><option value="price-asc" ${q.sort === "price-asc" ? "selected" : ""}>Price: low to high</option><option value="price-desc" ${q.sort === "price-desc" ? "selected" : ""}>Price: high to low</option><option value="rating" ${q.sort === "rating" ? "selected" : ""}>Top rated</option><option value="newest" ${q.sort === "newest" ? "selected" : ""}>Newest</option></select></label>
<label><input type="checkbox" name="inStock" value="1" ${q.inStock ? "checked" : ""}> In stock only</label>
<label><input type="checkbox" name="onDiscount" value="1" ${q.onDiscount ? "checked" : ""}> On discount</label>
<button class="btn small">Apply</button> <a class="btn ghost small" href="/shop">Clear all</a>
${q.category ? `<a class="btn ghost small" href="/shop?category=${encodeURIComponent(q.category)}&subcategory=Smartwatches">Smartwatches only →</a>` : ""}
</form>
<p class="note">${data.total} product(s)${q.flash ? " — full flash list" : ""}</p>
<div class="grid">${(data.products || []).map(productCard).join("") || "<p>No products match these filters.</p>"}</div>
${data.total > (data.products || []).length ? `<p><a class="btn" href="/shop?${esc(new URLSearchParams({ ...q, offset: String((data.products || []).length) }).toString())}">Load more</a></p>` : ""}`);
}

export function productView(p: any, reviews: any[], questions: any[]): string {
  const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
  return layout(p.name, `<div class="pdetail light-panel">
<div class="pgallery">${p.images?.length ? p.images.map((i: any) => `<figure><img src="${esc(i.url)}" alt="${esc(p.name)}"><figcaption>Sample image — representative stock photo; the owner's real photo will replace it.</figcaption></figure>`).join("") : `<div class="tile big">${esc(p.tile || "🛍")}</div><p>Demo product visual — no photo yet.</p>`}
<span class="sample-chip">Sample image</span></div>
<div class="pinfo"><h1>${esc(p.name)}</h1><p class="stars">★ ${p.rating} (${p.reviewsCount} reviews) · ${p.sold} sold</p>
<p class="price big">${formatPkr(price)} ${p.salePrice != null && p.salePrice < p.price ? `<s>${formatPkr(p.price)}</s> <span class="off">−${Math.round(((p.price - p.salePrice) / p.price) * 100)}%</span>` : ""}</p>
<p>${esc(p.shortDesc)}</p><p>${esc(p.description)}</p>
<p class="soldby">Sold by NEXORA Official Store · Warehouse: ${esc(p.warehouse)}</p>
<p>${p.stock <= 0 ? '<span class="oos">Out of stock</span>' : `In stock: ${p.stock}`}</p>
<p><button class="btn" onclick="addToCart(${p.id},1)" ${p.stock <= 0 ? "disabled" : ""}>Add to Cart</button>
<button class="btn ghost" onclick="buyNow(${p.id})">Buy Now</button>
<button class="btn ghost" onclick="addToWishlist(${p.id})">♡ Wishlist</button>
<button class="btn ghost" onclick="shareProduct(${p.id}, '${esc(p.name)}')">Share</button></p>
<h3>Specifications</h3><p class="specs">${esc(p.specs || "—")}</p>
<p>Colours: ${esc(p.colors || "—")} · Sizes: ${esc(p.sizes || "—")} · Warranty: ${esc(p.warranty || "—")}</p>
${p.category === "Mobile Phones" ? "<p>PTA note: check PTA approval status for this device before use in Pakistan.</p>" : ""}
${p.category === "Smart Wearables" ? "<p>Smart-glasses note: frame, lens, camera, audio, Bluetooth, battery and compatibility are listed in the specifications above.</p>" : ""}
</div></div>
<section><h2>Reviews</h2>${reviews.map((r: any) => `<div class="review"><strong>${esc(r.customerName)}</strong> ${"★".repeat(r.rating)}<p>${esc(r.text)}</p>${r.sellerReply ? `<p class="reply">NEXORA reply: ${esc(r.sellerReply)}</p>` : ""}</div>`).join("") || "<p>No reviews yet.</p>"}</section>
<section><h2>Questions &amp; Answers</h2>${questions.map((x: any) => `<div class="review"><p><strong>Q:</strong> ${esc(x.question)} — ${esc(x.customerName)}</p><p><strong>A:</strong> ${esc(x.answer || "Not answered yet.")}</p></div>`).join("") || "<p>No questions yet.</p>"}</section>`);
}

export function trackView(): string {
  return layout("Track Order", `<h1>Track Your Order</h1><p class="note">Simulated tracking — no courier API connected. The map preview is a clearly-labelled simulation.</p>
<form class="card light-panel" onsubmit="return trackOrder(event)"><label>Order number <input id="tOrder" required placeholder="NX-DEMO-…"></label>
<label>Tracking number <input id="tTrack" required placeholder="TRK-DEMO-…"></label>
<button class="btn">Track</button></form><div id="trackResult"></div>`);
}

export function accountView(): string {
  return layout("My Account", `<div class="dash" id="accountRoot"><p>Loading your dashboard…</p></div>
`);
}

export function adminView(): string {
  const tabs = ["Dashboard", "Products", "Categories", "Inventory", "Orders", "Payments", "Returns / Refunds", "Customers", "Support", "Reviews", "Notifications", "Coupons", "Staff & Permissions", "Reports", "Settings", "Homepage", "Demo Merchants", "Demo Manager", "Phase 2", "Audit Log"];
  return layout("Admin", `<h1>Admin <span class="demo-tag">DEMO / TRIAL MODE</span></h1>
<p class="note">20 modules (spec §7.7). The Phase 1 lab test observed 21 admin tabs — the extra tab was the Phase 2 tab added later; the actual list below is the 20-module list, with Orders and Tracking kept as one Orders tab (tracking manager inside it). Staff role for this demo session: <select id="staffRole" onchange="localStorage.setItem('nx_staff_role',this.value)"><option>Super Admin</option><option>Admin</option><option>Product Manager</option><option>Inventory Manager</option><option>Order Manager</option><option>Finance Officer</option><option>Customer Support Agent</option><option>Warehouse Staff</option><option>Delivery Manager</option></select> — permissions are enforced server-side and denials are audit-logged.</p>
<div class="tabs">${tabs.map((t, i) => `<button class="tab ${i === 0 ? "on" : ""}" onclick="adminTab(${i},this)">${esc(t)}</button>`).join("")}</div>
<div id="adminRoot" class="card light-panel"><p>Loading…</p></div>
`);
}

export function checkoutView(step: number): string {
  const steps = ["Cart Review", "Customer Info", "Delivery Address", "Shipping", "Payment", "Summary", "Confirm"];
  return layout(`Checkout — ${steps[step - 1]}`, `<h1>Checkout <span class="demo-tag">DEMO</span></h1>
<ol class="steps">${steps.map((s, i) => `<li class="${i + 1 === step ? "on" : i + 1 < step ? "done" : ""}">${i + 1}. ${s}</li>`).join("")}</ol>
<div id="checkoutRoot" class="card light-panel" data-step="${step}"><p>Loading step ${step}…</p></div>
`);
}

export function cartView(): string {
  return layout("Cart", `<h1>Your Cart</h1><div id="cartRoot"><p>Loading cart…</p></div>`);
}

export function authView(kind: "login" | "register"): string {
  const isLogin = kind === "login";
  return layout(isLogin ? "Sign In" : "Register", `<h1>${isLogin ? "Sign In" : "Create Account"}</h1>
<div class="card light-panel"><form onsubmit="return ${isLogin ? "doLogin" : "doRegister"}(event)">
<label>Name ${isLogin ? "" : '<input id="aName" required>'} </label>
<label>Email <input id="aEmail" type="email" required></label>
<label>Phone <input id="aPhone" placeholder="03XXXXXXXXX" ${isLogin ? "" : "required"}></label>
<label>Password <span class="pw"><input id="aPass" type="password" required minlength="6"><button type="button" onclick="togglePw('aPass',this)">👁️</button></span></label>
${isLogin ? "" : '<label>Confirm password <input id="aPass2" type="password" required minlength="6"></label><p class="note">Password strength: use 8+ characters with a mix of letters and numbers.</p>'}
<button class="btn">${isLogin ? "Sign In" : "Register"}</button></form>
<p>${isLogin ? `No account? <a href="/register">Register</a> · <a href="#" onclick="forgotPassword(event)">Forgot password?</a>` : `Already have an account? <a href="/login">Sign In</a>`}</p>
<p class="note">Seeded accounts have NO usable password yet (the export contained no hash values). Use "Forgot password?" to set a password via the reset flow — the owner sets passwords after first deploy. Never share a password in chat.</p></div>`);
}

export function policyView(page: string): string {
  const titles: Record<string, string> = { privacy: "Privacy Policy", terms: "Terms of Service", shipping: "Shipping Policy", returns: "Returns & Refunds Policy" };
  const bodies: Record<string, string> = {
    privacy: "<p>We collect only what checkout and support need: name, email, phone and delivery address. No payment card numbers are stored — demo payments store only a •••• last-4 label. No email/SMS provider is connected yet, so verification emails cannot be sent.</p>",
    terms: "<p>This is a demo store. All products, prices and orders are simulated. No live payment, courier or messaging provider is connected.</p>",
    shipping: "<p>Standard Rs. 250 (free at Rs. 5,000+ after discount), Express Rs. 450, Scheduled Rs. 450, Pickup Rs. 0. Deliveries are simulated — no courier API is connected.</p>",
    returns: "<p>14-day demo return window. Returns follow a 9-stage tracker (Requested → Refunded (Demo)); stock is restocked at stage 4. Refund-stage labels 1–7 are working labels, to verify against the Muse copy's returns UI.</p>",
  };
  return layout(titles[page] || "Policy", `<h1>${titles[page] || "Policy"}</h1><div class="card light-panel">${bodies[page] || ""}<p><strong>[OWNER TO SUPPLY]</strong> — registered business name, NTN, business address, returns warehouse address.</p></div>`);
}

export function merchantsView(merchants: any[]): string {
  return layout("Demo Merchants", `<h1>Demo Merchants</h1><p class="note">Display only — these are demo profiles, NOT sellers. No registration, stores, product ownership, commissions or payouts.</p>
<div class="grid">${merchants.map((m: any) => `<div class="card light-panel"><h3>${esc(m.storeName)}</h3><p>${esc(m.ownerName)} · ${esc(m.city)}</p><p>Focus: ${esc(m.categoryFocus)}</p><p>★ ${m.rating} (${m.reviewsCount} reviews) · ${esc(m.verification)} · Joined ${esc(m.joined)}</p></div>`).join("")}</div>`);
}

export function helpView(): string {
  const tiles = ["Track my order", "Cancel an order", "Return a product", "Refund status", "Payment methods (Demo)", "Delivery options", "Coupons", "My account & password", "Addresses", "Wishlist", "Product photos (Sample)", "Demo Merchants", "Contact support", "Give feedback"];
  return layout("Help Center", `<h1>Help Center</h1><div class="tiles">${tiles.map((t) => `<a class="tilecard" href="/track">${esc(t)}</a>`).join("")}</div>
<h2>FAQs</h2><div class="card light-panel"><p><strong>Are payments real?</strong> No — demo only. "Simulate Demo Payment" is required before placing a non-COD order; nothing is charged.</p>
<p><strong>Why does every photo say "Sample image"?</strong> The products are demo listings with representative stock photos. The owner's real photos will replace them.</p>
<p><strong>How do I track an order?</strong> Use Track with your order number (NX-DEMO-…) and tracking number (TRK-DEMO-…).</p></div>
<p><a class="btn" href="/track">Track an order</a> <a class="btn ghost" href="/account">Open a support case</a></p>`);
}

export function compareView(): string {
  return layout("Compare", `<h1>Compare Products</h1><div class="card light-panel"><p><strong>Clearly-marked stub.</strong> The Compare page exists in the Muse copy (named among its inspected views) but no flow details appear in any source (REBUILD-SPEC.md §14.11), so its contents were not invented here. Add products from the Shop and this page will compare them once the behaviour is verified against the Muse copy during acceptance.</p><p><a class="btn" href="/shop">Browse the Shop</a></p></div>`);
}

export { REFUND_STAGE_LABELS };
