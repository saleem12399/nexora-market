// NEXORA MARKET client JS — session token in localStorage; the cart /
// wishlist key is derived SERVER-side (session email, or a server-set
// HttpOnly guest cookie). The client never sends a cart key anymore —
// the old localStorage guest key is gone (B11).
function token() { return localStorage.getItem("nx_session_token") || ""; }
// Phase 2: staff auth is a server session (HttpOnly cookie nx_staff_token,
// set by loginStaff). The client never asserts a role — there is no
// x-nexora-role header anymore. fetch() sends same-origin cookies by
// default, so staff calls just work once signed in.
async function api(name, body, opts) {
  const headers = { "content-type": "application/json" };
  if (token()) headers["authorization"] = "Bearer " + token();
  // Opt-in timeout (opts.timeoutMs): AbortController so a stalled fetch can
  // never hang a page forever. Callers that pass no timeout keep the old
  // behaviour (long admin calls such as backup/restore are untouched).
  const timeoutMs = opts && opts.timeoutMs;
  let ctrl, timer;
  if (timeoutMs) { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), timeoutMs); }
  try {
    const r = await fetch("/api/" + name, { method: "POST", headers, body: JSON.stringify(body || {}), signal: ctrl ? ctrl.signal : undefined });
    return r.json();
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Request timed out after " + Math.round(timeoutMs / 1000) + "s — please retry.");
    throw e;
  } finally { if (timer) clearTimeout(timer); }
}
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function money(n) { return "Rs. " + Number(n || 0).toLocaleString("en-PK"); }
// Display helpers: strip stored "(Demo)"/"(Demo Simulated)" labels at render
// time (live DB rows keep their stored values). Admin views keep raw values.
function dispName(s) { return String(s == null ? "" : s).replace(/ \(Demo\)$/, ""); }
// POLISH (owner wording, 2026-11-27): the word "demo" is never shown to
// customers. Stored "(Demo Simulated)"-style statuses are REWRITTEN to the
// "(Educational Project)" wording (not stripped) so the honesty label stays.
// These specific rewrites run BEFORE the generic "(Demo)" strip below.
function cleanDemo(s) {
  let t = String(s == null ? "" : s);
  t = t.replace(" (Demo Simulated)", " (Educational Project)").replace(" (COD Collected — Demo)", " (COD Collected — Educational Project)");
  t = t.replace("Refund Pending (Demo)", "Refund Pending (Educational Project)").replace("Awaiting Verification (Demo)", "Awaiting Verification (Educational Project)");
  t = t.replace("Refunded (Demo)", "Refunded (Educational Project)");
  t = t.replace("Demo Simulation — ", "").replace(" (demo simulation)", "").replace(" — demo only, no charge", "").replace(" — Demo", "").replace(" (Demo)", "").replace(" — simulated demo event.", ".").replace(" in demo data.", ".").replace(" in the demo simulation.", ".").replace("demo electronics", "electronics").replace("demo purchase", "purchase").replace("demo use", "use");
  return t;
}

// E2: non-blocking toast (replaces alert() for cart/wishlist feedback),
// with a View cart action and a cart-badge pulse. No modal popups.
function showToast(msg, actionLabel, actionHref) {
  let el = document.getElementById("nxToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "nxToast"; el.className = "toast"; el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.innerHTML = esc(msg) + (actionLabel && actionHref ? ` <a href="${esc(actionHref)}">${esc(actionLabel)}</a>` : "");
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3500);
}
function pulseCartBadge() {
  const el = document.getElementById("cartCount");
  if (!el) return;
  el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
}
async function addToCart(id, qty) {
  const r = await api("addToCart", { productId: id, qty });
  if (r.ok) { showToast(r.note || "Added to cart.", "View cart", "/cart"); pulseCartBadge(); }
  else showToast(r.error || "Could not add to cart.");
  refreshCartCount();
}
async function buyNow(id) { await addToCart(id, 1); location.href = "/checkout?step=1"; }
async function addToWishlist(id) {
  const r = await api("addToWishlist", { productId: id });
  if (r.ok) showToast("Added to wishlist.", "View wishlist", "/wishlist");
  else showToast(r.error || "Could not add.");
}
// D1: gallery thumbnail swap (main photo) — tap the main photo to zoom.
function swapMainPhoto(url, el) {
  const main = document.getElementById("mainPhoto"); if (!main) return;
  main.src = url;
  document.querySelectorAll(".thumbs img").forEach((t) => t.classList.remove("on"));
  if (el) el.classList.add("on");
}
// D3: compare list (up to 3 products, localStorage). The /compare page
// renders ?ids=... server-side; this only tracks the selection.
function getCompareIds() { try { const v = JSON.parse(localStorage.getItem("nx_compare") || "[]"); return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)).slice(0, 3) : []; } catch { return []; } }
function saveCompareIds(ids) { try { localStorage.setItem("nx_compare", JSON.stringify(ids)); } catch {} refreshCompareCount(); }
function refreshCompareCount() { const el = document.getElementById("compareCount"); if (el) el.textContent = String(getCompareIds().length); }
function toggleCompare(id) {
  let ids = getCompareIds();
  if (ids.includes(id)) { ids = ids.filter((x) => x !== id); saveCompareIds(ids); showToast("Removed from compare."); }
  else {
    if (ids.length >= 3) { showToast("Compare holds up to 3 products — remove one first.", "View compare", "/compare"); return; }
    ids.push(id); saveCompareIds(ids); showToast("Added to compare (" + ids.length + "/3).", "View compare", "/compare");
  }
  if (location.pathname === "/compare") location.href = "/compare" + (ids.length ? "?ids=" + ids.join(",") : "");
}
function removeFromCompare(id) { const ids = getCompareIds().filter((x) => x !== id); saveCompareIds(ids); location.href = "/compare" + (ids.length ? "?ids=" + ids.join(",") : ""); }
function clearCompare() { saveCompareIds([]); location.href = "/compare"; }
function shareProduct(id, name) {
  const url = location.origin + "/product/" + id;
  if (navigator.share) navigator.share({ title: name, url }).catch(() => {});
  else { navigator.clipboard && navigator.clipboard.writeText(url); alert("Product link copied: " + url); }
}
async function refreshCartCount() {
  try { const r = await api("getCart", {}); const el = document.getElementById("cartCount"); if (el) el.textContent = (r.items || []).reduce((a, i) => a + i.qty, 0); } catch (e) {}
}
refreshCartCount();

// C6: the active dot is highlighted; auto-rotation pauses on hover /
// focus and for 30 s after a manual dot click. POLISH: a Pause/Resume
// button next to the dots pauses rotation until pressed again.
let heroPausedUntil = 0;
let heroHover = false;
let heroPausedManual = false;
function heroGo(i, manual) {
  document.querySelectorAll(".slide").forEach((s, j) => s.classList.toggle("active", j === i));
  document.querySelectorAll(".dots button").forEach((d, j) => d.classList.toggle("active", j === i));
  if (manual) heroPausedUntil = Date.now() + 30000;
}
function heroPauseToggle() {
  heroPausedManual = !heroPausedManual;
  heroPausedUntil = heroPausedManual ? Date.now() + 3600000 : 0;
  const b = document.getElementById("heroPauseBtn"); if (b) b.textContent = heroPausedManual ? "Resume" : "Pause";
}
// E7: flash-row scroll arrows (desktop affordance; mobile keeps swipe).
function flashScroll(dir) {
  const el = document.getElementById("flashRow"); if (!el) return;
  el.scrollBy({ left: dir * 500, behavior: "smooth" });
}
setInterval(() => {
  const slides = document.querySelectorAll(".slide");
  if (slides.length > 1 && !heroHover && Date.now() > heroPausedUntil) {
    const cur = [...slides].findIndex((s) => s.classList.contains("active"));
    heroGo((cur + 1) % slides.length);
  }
}, 6000);
// D7: live flash-sale countdown — renders ONLY when a real campaign end
// date is set (data-end from settings.flashSaleEndsAt); until then the
// page keeps the honest "no campaign end is set" state.
function updateFlashCountdown() {
  const el = document.getElementById("flashCountdown"); if (!el) return;
  const end = new Date(el.dataset.end);
  if (isNaN(end.getTime())) return;
  const ms = end.getTime() - Date.now();
  if (ms <= 0) { el.textContent = "Sale has ended."; return; }
  const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000), m = Math.floor(ms % 3600000 / 60000), sec = Math.floor(ms % 60000 / 1000);
  el.textContent = "Sale ends in " + d + "d " + h + "h " + m + "m " + sec + "s — ends " + el.dataset.end + ".";
}
setInterval(updateFlashCountdown, 1000);
updateFlashCountdown();
(function () {
  const hero = document.getElementById("hero");
  if (!hero) return;
  hero.addEventListener("mouseenter", () => { heroHover = true; });
  hero.addEventListener("mouseleave", () => { heroHover = false; });
  hero.addEventListener("focusin", () => { heroHover = true; });
  hero.addEventListener("focusout", () => { heroHover = false; });
})();

function togglePw(id, btn) {
  const el = document.getElementById(id);
  el.type = el.type === "password" ? "text" : "password";
  btn.textContent = el.type === "password" ? "👁️" : "🙈";
}

async function doLogin(e) {
  e.preventDefault();
  const r = await api("loginCustomer", { email: document.getElementById("aEmail").value, password: document.getElementById("aPass").value });
  if (!r.ok) { alert(r.error || "Sign-in failed."); return false; }
  localStorage.setItem("nx_session_token", r.sessionToken);
  location.href = "/account"; return false;
}
async function doRegister(e) {
  e.preventDefault();
  const p1 = document.getElementById("aPass").value, p2 = document.getElementById("aPass2").value;
  if (p1 !== p2) { alert("Passwords do not match."); return false; }
  const r = await api("registerCustomer", { name: document.getElementById("aName").value, email: document.getElementById("aEmail").value, phone: document.getElementById("aPhone").value, password: p1, confirmPassword: p2 });
  if (!r.ok) { alert(r.error || JSON.stringify(r.errors || {})); return false; }
  localStorage.setItem("nx_session_token", r.sessionToken);
  location.href = "/account"; return false;
}
async function forgotPassword(e) {
  e.preventDefault();
  const email = prompt("Enter your account email for a password reset:");
  if (!email) return false;
  const r = await api("requestPasswordReset", { email });
  // A2: the API never returns a reset token (no email provider is
  // connected, so a self-service reset cannot deliver one). The response
  // is the same whether or not the account exists.
  alert(r.note || r.error || "If an account exists, a reset was requested.");
  return false;
}
function signOut() {
  if (!confirm("Sign out?")) return;
  api("logoutCustomer", {}).finally(() => { localStorage.removeItem("nx_session_token"); location.href = "/"; });
}

// ---- Cart ----
// A5: a failed load shows a visible error + retry instead of "Loading…" forever.
function loadErrorHtml(msg, retryFn) {
  return `<div class="card light-panel"><p><strong>Couldn't load this page.</strong></p><p>${esc(msg)}</p><p><button class="btn" onclick="${retryFn}">Retry</button> <a class="btn ghost" href="/">Back to Home</a></p></div>`;
}
async function loadCart() {
  const root = document.getElementById("cartRoot"); if (!root) return;
  let r;
  try { r = await api("getCart", {}); } catch (e) { root.innerHTML = loadErrorHtml("Network error: " + (e.message || e), "loadCart()"); return; }
  if (!r.ok) { root.innerHTML = "<p>Cart is unavailable: " + esc(r.error || "") + "</p>"; return; }
  if (!r.items.length) { root.innerHTML = "<p>Your cart is empty.</p><p><a class='btn' href='/shop'>Browse the Shop</a></p>"; return; }
  let total = 0;
  root.innerHTML = r.items.map((i) => {
    const p = i.product; const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
    total += price * i.qty;
    return `<div class="card light-panel"><div class="row" style="align-items:center">${i.imageUrl ? `<img src="${esc(i.imageUrl)}" style="width:72px;height:72px;object-fit:cover;border-radius:8px">` : ""}<div><strong>${esc(dispName(p.name))}</strong><br>${money(price)} × <input type="number" min="0" max="${p.stock}" value="${i.qty}" style="width:64px" onchange="updateQty(${i.id},this.value)"> = <strong>${money(price * i.qty)}</strong></div><button class="btn ghost small" onclick="removeLine(${i.id})">🗑 Remove</button></div></div>`;
  }).join("") + `<p><strong>Subtotal: ${money(total)}</strong> (shipping and discounts are calculated at checkout)</p><p><a class="btn" href="/checkout?step=1">Proceed to Checkout →</a></p>`;
}
async function updateQty(id, qty) { const r = await api("updateCartItem", { id, qty: Number(qty) }); if (r.note) alert(r.note); loadCart(); refreshCartCount(); }
async function removeLine(id) { if (!confirm("Remove this item? Yes / Keep")) return; await api("removeCartItem", { id }); loadCart(); refreshCartCount(); }

// ---- Support ticket (B15) ----
async function doCreateTicket(e) {
  e.preventDefault();
  const r = await api("createTicket", { customerName: document.getElementById("tkName").value, subject: document.getElementById("tkSubject").value, category: document.getElementById("tkCategory").value, orderNumber: document.getElementById("tkOrder").value, description: document.getElementById("tkDesc").value });
  const el = document.getElementById("ticketResult");
  if (!r.ok) { if (el) el.innerHTML = "<p>" + esc(r.error || "Could not open the case.") + "</p>"; return false; }
  if (el) el.innerHTML = "<p><strong>Case opened: " + esc(r.ticket.ticketNumber) + "</strong> — status Open. The team will reply on this ticket.</p>";
  return false;
}

// D6: footer newsletter — the API saves the address and sends nothing
// (no mailing provider exists yet); the note under the form says so.
async function doSubscribeNewsletter(e) {
  e.preventDefault();
  const email = document.getElementById("nlEmail").value.trim();
  const r = await api("subscribeNewsletter", { email });
  const msg = document.getElementById("nlMsg");
  if (msg) msg.textContent = r.ok ? (r.note || "Subscribed.") : (r.error || "Could not subscribe.");
  if (r.ok) showToast(r.note || "Subscribed.");
  return false;
}
// ---- Wishlist page (B2) ----
async function loadWishlist() {
  const root = document.getElementById("wishlistRoot"); if (!root) return;
  let r;
  try { r = await api("listWishlist", {}); } catch (e) { root.innerHTML = loadErrorHtml("Network error: " + (e.message || e), "loadWishlist()"); return; }
  if (!r.ok) { root.innerHTML = "<p>Wishlist is unavailable: " + esc(r.error || "") + "</p>"; return; }
  if (!r.items.length) { root.innerHTML = "<p>Your wishlist is empty. Tap ♡ Wishlist on any product to save it here.</p><p><a class='btn' href='/shop'>Browse the Shop</a></p>"; return; }
  root.innerHTML = `<div class="grid">${r.items.map((p) => {
    const price = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price;
    return `<div class="card light-panel"><a href="/product/${p.id}">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" style="width:100%;height:150px;object-fit:cover;border-radius:8px">` : ""}<h3>${esc(dispName(p.name))}</h3></a><p class="stars">★ ${p.rating} (${p.reviewsCount})</p><p><strong>${money(price)}</strong>${p.salePrice != null && p.salePrice < p.price ? ` <s>${money(p.price)}</s>` : ""}</p><button class="btn small" onclick="addToCart(${p.id},1)">Add to Cart</button> <button class="btn ghost small" onclick="removeFromWishlist(${p.id})">Remove</button></div>`;
  }).join("")}</div>`;
}
async function removeFromWishlist(id) { await api("removeFromWishlist", { productId: id }); loadWishlist(); }

// ---- Checkout (7 steps) ----
// B4: checkout state persists across the full-page step navigations in
// sessionStorage (per browser tab session). Rehydrated on every step load;
// cleared after a successful order. Nothing here is a price or a charge —
// totals are recomputed server-side at order time.
const CHECKOUT_KEY = "nx_checkout";
function loadCheckoutData() {
  try { const raw = sessionStorage.getItem(CHECKOUT_KEY); if (raw) { const d = JSON.parse(raw); if (d && typeof d === "object") return d; } } catch {}
  return {};
}
function saveCheckoutData() {
  try { sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify(checkoutData)); } catch {}
}
function clearCheckoutData() {
  try { sessionStorage.removeItem(CHECKOUT_KEY); } catch {}
  checkoutData = {};
}
let checkoutData = loadCheckoutData();
async function loadCheckout(step) {
  const root = document.getElementById("checkoutRoot"); if (!root) return;
  let cart;
  try { cart = await api("getCart", {}); } catch (e) { root.innerHTML = loadErrorHtml("Network error: " + (e.message || e), "loadCheckout(" + step + ")"); return; }
  const items = cart.items || [];
  if (!items.length && step === 1) { root.innerHTML = "<p>Your cart is empty.</p><p><a class='btn' href='/shop'>Browse the Shop</a></p>"; return; }
  const lines = items.map((i) => { const p = i.product; const pr = p.salePrice != null && p.salePrice < p.price ? p.salePrice : p.price; return { productId: p.id, qty: i.qty, price: pr, name: p.name, imageUrl: i.imageUrl }; });
  const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);
  const stepHtml = {
    1: `<h2>Step 1 — Cart Review</h2>${lines.map((l) => `<p>${l.imageUrl ? `<img src="${esc(l.imageUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;vertical-align:middle">` : ""} ${esc(dispName(l.name))} — ${money(l.price)} × ${l.qty} = <strong>${money(l.price * l.qty)}</strong></p>`).join("")}
<p>Subtotal: <strong>${money(subtotal)}</strong></p>
<label>Coupon code <input id="coCoupon" placeholder="e.g. 000" value="${esc(checkoutData.couponCode || "")}"></label>
<button class="btn ghost" onclick="applyCoupon(${subtotal})">Apply</button> <span id="coMsg"></span>
<p class="note">A typed coupon is sent with the order even without pressing Apply. Tax Rs. 0, shown not hidden.</p>
<p><button class="btn" onclick="saveStep1()">Continue to Customer Info →</button></p>`,
    2: `<h2>Step 2 — Customer Info</h2><form onsubmit="saveStep2(event)">
<label>Full name <input id="coName" required value="${esc(checkoutData.customerName || "")}"></label><label>Email <input id="coEmail" type="email" required value="${esc(checkoutData.customerEmail || "")}"></label>
<label>Mobile <input id="coPhone" required placeholder="03XXXXXXXXX" value="${esc(checkoutData.customerPhone || "")}"></label>
<p class="note">Server-side email + Pakistani-mobile validation applies.</p><button class="btn">Continue →</button></form>`,
    3: `<h2>Step 3 — Delivery Address</h2><form onsubmit="saveStep3(event)">
<label>Recipient name <input id="coRecipient" required value="${esc(checkoutData.recipientName || "")}"></label><label>Address <input id="coAddress" required value="${esc(checkoutData.address || "")}"></label>
<label>Area <input id="coArea" value="${esc(checkoutData.area || "")}"></label><label>City <input id="coCity" required value="${esc(checkoutData.city || "")}"></label><label>Province <input id="coProvince" value="${esc(checkoutData.province || "Sindh")}"></label>
<label>Postal code <input id="coPostal" value="${esc(checkoutData.postalCode || "")}"></label><label>Landmark <input id="coLandmark" value="${esc(checkoutData.landmark || "")}"></label>
<label>Delivery instructions <input id="coInstr" value="${esc(checkoutData.deliveryInstructions || "")}"></label>
<p><button class="btn ghost" type="button" onclick="loadSavedAddress()">Use my saved address</button></p>
<button class="btn">Continue →</button></form>`,
    4: `<h2>Step 4 — Shipping</h2><form onsubmit="saveStep4(event)">
<label><input type="radio" name="ship" value="Standard" ${!checkoutData.shippingMethod || checkoutData.shippingMethod === "Standard" ? "checked" : ""}> Standard — Rs. 250 (free at Rs. 5,000+ after discount)</label><br>
<label><input type="radio" name="ship" value="Express" ${checkoutData.shippingMethod === "Express" ? "checked" : ""}> Express — Rs. 450</label><br>
<label><input type="radio" name="ship" value="Scheduled" ${checkoutData.shippingMethod === "Scheduled" ? "checked" : ""}> Scheduled — Rs. 450 (pick a date + time window below)</label><br>
<label><input type="radio" name="ship" value="Pickup" ${checkoutData.shippingMethod === "Pickup" ? "checked" : ""}> Pickup — Rs. 0</label><br>
<p class="note"><strong>Educational Project</strong> — no real shipment. Delivery options are recorded for the assignment only; no courier is booked.</p>
<label>Scheduled date <input id="coSlotDate" type="date"></label><label>Time window <select id="coSlotTime"><option>9am–12pm</option><option>12pm–3pm</option><option>3pm–6pm</option><option>6pm–9pm</option></select></label>
<label>Pickup point <select id="coPickup"><option value="">—</option><option>Karachi Central</option><option>Ghotki Store</option></select></label>
<p><button class="btn ghost" type="button" onclick="useGps()">📍 Use my device GPS (permission-based)</button> <span id="gpsOut"></span></p>
<button class="btn">Continue →</button></form>`,
    5: `<h2>Step 5 — Payment</h2><p class="note">Confirm your payment before placing a non-COD order.</p>
<p class="note"><strong>Educational Project</strong> — no real payment is processed. No payment gateway is connected; confirmation is recorded for the assignment only.</p>
<div id="payMethods"></div><p><button class="btn" onclick="simulatePayment()">Confirm Payment</button> <span id="payOut"></span></p>
<p><button class="btn" onclick="saveStep5()">Continue to Summary →</button></p>`,
    6: `<h2>Step 6 — Summary</h2><div id="summaryBox"><p>Loading summary…</p></div><p><a class="btn" href="/checkout?step=7">Continue to Confirm →</a></p>`,
    7: `<h2>Step 7 — Confirm</h2><div id="confirmBox"><p>Review your order and place it. This is idempotent — a duplicate submission creates no second order.</p></div>
<button class="btn" onclick="placeOrder()">Place Order</button><div id="orderOut"></div>`,
  };
  root.innerHTML = stepHtml[step] || "";
  if (step === 5) renderPayMethods();
  if (step === 6) renderSummary(lines, subtotal);
  if (step === 7) renderConfirm(lines, subtotal);
}
function renderPayMethods() {
  const el = document.getElementById("payMethods"); if (!el) return;
  const rows = [
    { name: "JazzCash", logo: "/images/payments/jazzcash-logo.png", line: "Wallet — account number ≥ 10 digits, then a 4-digit PIN (client-side only, never sent or stored)." },
    { name: "Easypaisa", logo: "/images/payments/easypaisa-logo.png", line: "Wallet — account number ≥ 10 digits, then a 4-digit PIN (client-side only, never sent or stored)." },
    { name: "Debit Card", logo: "/images/payments/visa-logo.png", logo2: "/images/payments/mastercard-logo.png", line: "Card — only a •••• last-4 label is stored, never a card number." },
    { name: "Bank Transfer", tile: "BANK", line: "Bank transfer — paid only via recorded finance verification." },
    { name: "Cash on Delivery", tile: "COD", line: "Pay on delivery. COD stays unpaid until delivery collection is recorded." },
    { name: "Digital Wallet", tile: "WALLET", line: "Digital wallet — 3-stage confirmation flow." },
  ];
  el.innerHTML = rows.map((m) => `<label class="payrow"><input type="radio" name="pay" value="${esc(m.name)}" ${m.name === (checkoutData.paymentMethod || "Cash on Delivery") ? "checked" : ""}>
${m.logo ? `<span class="paylogo"><img src="${m.logo}" alt="${esc(m.name)}"></span>${m.logo2 ? `<span class="paylogo"><img src="${m.logo2}" alt="Mastercard"></span>` : ""}` : `<span class="paytile">${m.tile}</span>`}
<span><strong>${esc(m.name)}</strong><br><small>${esc(m.line)}</small></span></label>`).join("");
}
async function applyCoupon(subtotal) {
  const code = document.getElementById("coCoupon").value.trim();
  const r = await api("validateCoupon", { code, subtotal });
  document.getElementById("coMsg").textContent = r.ok ? `Applied: −${money(r.discount)}` : (r.error || "Invalid coupon.");
  if (r.ok) { checkoutData.couponCode = code.toUpperCase(); saveCheckoutData(); }
}
async function simulatePayment() {
  const method = (document.querySelector('input[name="pay"]:checked') || {}).value || "Cash on Delivery";
  checkoutData.paymentMethod = method;
  if (method !== "Cash on Delivery") {
    const acct = prompt("Wallet/card account (never enter a real number):", "03001234567");
    if (!acct || acct.replace(/\D/g, "").length < 10) { alert("Account number must be at least 10 digits."); return; }
    const pin = prompt("Enter any 4-digit PIN to confirm (it is not sent or stored):");
    if (!pin || pin.length !== 4) { alert("A 4-digit PIN is required to confirm the payment."); return; }
    checkoutData.paymentAccount = acct;
    checkoutData.paymentRef = "TXN-" + Math.floor(10000000 + Math.random() * 89999999);
  }
  checkoutData.paymentSimulated = true;
  saveCheckoutData();
  document.getElementById("payOut").textContent = "Payment Confirmed" + (checkoutData.paymentRef ? " — " + checkoutData.paymentRef : "");
}
function useGps() {
  if (!navigator.geolocation) { document.getElementById("gpsOut").textContent = "GPS is not available on this device."; return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    checkoutData.gps = pos.coords.latitude + "," + pos.coords.longitude;
    saveCheckoutData();
    document.getElementById("gpsOut").textContent = "GPS attached: " + checkoutData.gps + ".";
  }, () => { document.getElementById("gpsOut").textContent = "GPS permission was not granted."; });
}
function saveStep1() {
  const el = document.getElementById("coCoupon");
  if (el && el.value.trim()) checkoutData.couponCode = el.value.trim().toUpperCase();
  saveCheckoutData();
  location.href = "/checkout?step=2";
}
function saveStep2(e) {
  e.preventDefault();
  checkoutData.customerName = document.getElementById("coName").value;
  checkoutData.customerEmail = document.getElementById("coEmail").value;
  checkoutData.customerPhone = document.getElementById("coPhone").value;
  saveCheckoutData();
  location.href = "/checkout?step=3"; return false;
}
function saveStep3(e) {
  e.preventDefault();
  Object.assign(checkoutData, { recipientName: document.getElementById("coRecipient").value, address: document.getElementById("coAddress").value, area: document.getElementById("coArea").value, city: document.getElementById("coCity").value, province: document.getElementById("coProvince").value, postalCode: document.getElementById("coPostal").value, landmark: document.getElementById("coLandmark").value, deliveryInstructions: document.getElementById("coInstr").value });
  saveCheckoutData();
  location.href = "/checkout?step=4"; return false;
}
function saveStep4(e) {
  e.preventDefault();
  checkoutData.shippingMethod = (document.querySelector('input[name="ship"]:checked') || {}).value || "Standard";
  const d = document.getElementById("coSlotDate").value, t = document.getElementById("coSlotTime").value;
  checkoutData.deliverySlot = checkoutData.shippingMethod === "Scheduled" && d ? `Scheduled — ${d} ${t}` : checkoutData.shippingMethod + " — arrives in 2–4 days";
  checkoutData.pickupPoint = document.getElementById("coPickup").value || "";
  saveCheckoutData();
  location.href = "/checkout?step=5"; return false;
}
// B4: step 5 Continue saves the selected payment method first. A non-COD
// method still needs the demo payment confirmed before continuing, matching
// the placeOrder guard — otherwise the order would fail at step 7.
function saveStep5() {
  const method = (document.querySelector('input[name="pay"]:checked') || {}).value || "Cash on Delivery";
  if (method !== "Cash on Delivery" && !checkoutData.paymentSimulated) { alert("Payment confirmation is required before placing a non-COD order."); return; }
  checkoutData.paymentMethod = method;
  saveCheckoutData();
  location.href = "/checkout?step=6";
}
async function loadSavedAddress() {
  const r = await api("listAddresses", {});
  const a = (r.addresses || [])[0];
  if (!a) { alert("No saved address yet. Sign in to use your address book."); return; }
  document.getElementById("coRecipient").value = a.recipient || "";
  document.getElementById("coAddress").value = a.address || "";
  document.getElementById("coArea").value = a.area || "";
  document.getElementById("coCity").value = a.city || "";
  document.getElementById("coProvince").value = a.province || "";
  document.getElementById("coPostal").value = a.postalCode || "";
  document.getElementById("coLandmark").value = a.landmark || "";
  document.getElementById("coInstr").value = a.instructions || "";
}
async function renderSummary(lines, subtotal) {
  const code = checkoutData.couponCode || (document.getElementById("coCoupon") ? document.getElementById("coCoupon").value : "");
  let discount = 0;
  if (code) { try { const r = await api("validateCoupon", { code, subtotal }); if (r.ok) discount = r.discount; } catch (e) { /* coupon revalidation failed — continue without discount */ } }
  const ship = checkoutData.shippingMethod === "Pickup" ? 0 : (checkoutData.shippingMethod === "Express" || checkoutData.shippingMethod === "Scheduled") ? 450 : (subtotal - discount >= 5000 ? 0 : 250);
  const total = subtotal - discount + ship;
  const el = document.getElementById("summaryBox"); if (!el) return;
  el.innerHTML = `<p>Coupon: <strong>${esc(code || "—")}</strong> (read-only here — it was entered in Step 1) — discount ${money(discount)}</p>
<p>Subtotal ${money(subtotal)} − discount ${money(discount)} + shipping ${money(ship)} + tax Rs. 0 = <strong>${money(total)}</strong></p>
<p>Deliver to: ${esc(checkoutData.recipientName || "")}, ${esc(checkoutData.address || "")}, ${esc(checkoutData.city || "")} ${esc(checkoutData.postalCode || "")}</p>
<p>Shipping: ${esc(checkoutData.shippingMethod || "Standard")} · ${esc(checkoutData.deliverySlot || "")}</p>
<p>Payment: ${esc(checkoutData.paymentMethod || "Cash on Delivery")} ${checkoutData.paymentSimulated ? "(Confirmed)" : ""}</p>`;
  checkoutData._summary = { subtotal, discount, ship, total };
  saveCheckoutData();
}
function renderConfirm(lines, subtotal) {
  const el = document.getElementById("confirmBox"); if (!el) return;
  el.innerHTML = `<p>${lines.length} item(s) · Subtotal ${money(subtotal)} · Payment: ${esc(checkoutData.paymentMethod || "Cash on Delivery")}</p>`;
}
async function placeOrder() {
  const cart = await api("getCart", {});
  const items = (cart.items || []).map((i) => ({ productId: i.product.id, qty: i.qty }));
  if (!items.length) { alert("Your cart is empty."); return; }
  const method = checkoutData.paymentMethod || "Cash on Delivery";
  if (method !== "Cash on Delivery" && !checkoutData.paymentSimulated) { alert('"Confirm Payment" is required before placing a non-COD order.'); return; }
  if (!checkoutData.idempotencyKey) { checkoutData.idempotencyKey = "key-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); saveCheckoutData(); }
  const r = await api("createOrder", { ...checkoutData, items, couponCode: checkoutData.couponCode || "", idempotencyKey: checkoutData.idempotencyKey });
  const out = document.getElementById("orderOut");
  if (!r.ok) { out.innerHTML = "<p><strong>Order failed:</strong> " + esc(r.error || JSON.stringify(r.errors || {})) + "</p>"; return; }
  if (r.duplicateBlocked) { clearCheckoutData(); out.innerHTML = "<p>Duplicate submission blocked — your original order stands (idempotency).</p>"; return; }
  out.innerHTML = `<div class="card light-panel"><h3>Order placed ✓</h3><p>Order <strong>${esc(r.order.orderNumber)}</strong> · Total <strong>${money(r.order.total)}</strong></p>
<p>Tracking: ${esc(r.order.trackingNumber)} · Courier: ${esc(cleanDemo(r.order.courier))}</p>
<p>${(r.adjustments || []).map(esc).join("<br>")}</p>
<p><a class="btn" href="/track">Track Order</a> <a class="btn ghost" href="/account">My Orders</a></p></div>`;
  clearCheckoutData();
}
async function simulateDelivery(orderId) {
  const r = await api("advanceOrder", { orderId });
  alert(r.ok ? ("Advanced to " + r.advancedTo + ".") : (r.error || "Could not advance."));
  if (r.ok && r.advancedTo !== "Delivered") { /* stay on the page; tap again to advance */ }
}

// ---- Tracking ----
async function trackOrder(e) {
  e.preventDefault();
  const r = await api("getOrderTracking", { orderNumber: document.getElementById("tOrder").value.trim(), trackingNumber: document.getElementById("tTrack").value.trim() });
  const el = document.getElementById("trackResult");
  if (!r.ok) { el.innerHTML = "<p>" + esc(r.error) + "</p>"; return false; }
  const pct = r.stepIndex >= 0 ? Math.round(((r.stepIndex + 1) / r.steps.length) * 100) : 0;
  el.innerHTML = `<div class="card light-panel"><h3>${esc(r.order.orderNumber)} — ${esc(r.order.status)}</h3>
<p>Courier: ${esc(cleanDemo(r.courier))} · Tracking: ${esc(r.order.trackingNumber)} · Total ${money(r.order.total)}</p>
<div style="background:#E2E8F0;border-radius:999px;height:10px"><div style="width:${pct}%;background:#315EFB;height:10px;border-radius:999px"></div></div>
<ol>${r.events.map((ev) => `<li><strong>${esc(cleanDemo(ev.status))}</strong> — ${esc(cleanDemo(ev.note || ""))} <small>(${esc(cleanDemo(ev.location || ""))})</small></li>`).join("")}</ol>
<p class="note">Parcel shown at the last verified event location.</p></div>`;
  return false;
}

// ---- Account ----
async function loadAccount() {
  const root = document.getElementById("accountRoot"); if (!root) return;
  let r;
  try { r = await api("getCustomer", {}, { timeoutMs: 15000 }); } catch (e) { root.innerHTML = loadErrorHtml("Network error: " + (e.message || e), "loadAccount()"); return; }
  if (!r.ok || !r.authenticated) {
    root.innerHTML = `<div class="dash"><h1>Welcome back!</h1><p class="muted">Please sign in to see your own orders — signed-out view shows no orders.</p>
<p><a class="btn" href="/login">Sign In</a> <a class="btn ghost" href="/register">Register</a></p></div>`;
    return;
  }
  const c = r.customer, st = r.stats;
  const initials = c.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const memberSince = new Date(c.createdAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  let my = { orders: [] };
  try { my = await api("listMyOrders", {}); } catch (e) { /* orders list failed — dashboard still renders */ }
  const recent = (my.orders || []).slice(0, 3);
  root.innerHTML = `<div class="dash">
<div style="display:flex;justify-content:space-between;align-items:start;gap:10px">
<div style="display:flex;gap:12px;align-items:center"><div style="width:56px;height:56px;border-radius:50%;background:#F59E0B;color:#101828;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800">${esc(initials)}</div>
<div><h1>Welcome back, ${esc(c.name)}!</h1><p class="muted">Member since ${esc(memberSince)}</p></div></div>
<div style="position:relative"><button class="btn ghost" onclick="document.getElementById('acctMenu').style.display=document.getElementById('acctMenu').style.display==='block'?'none':'block'">⋯</button>
<div id="acctMenu" style="display:none;position:absolute;right:0;top:44px;background:#fff;color:#101828;border-radius:12px;min-width:230px;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:30" class="menu-list">
<a href="/account">My Account</a><a href="/account">Order History</a><a href="/track">Track My Order</a><a href="/account">My Returns</a><a href="/account">My Refunds</a>
<a href="#" onclick="changeName(event)">Change Name</a><a href="#" onclick="changeAddress(event)">Change Address</a><a href="#" onclick="changePayment(event)">Change Payment Method</a>
<a href="#" onclick="changePassword(event)">Change Password</a><a href="#" onclick="notifPrefs(event)">Notification Preferences</a><a href="#" onclick="privacySec(event)">Privacy &amp; Security</a>
<a href="/help">Customer Support</a><a href="#" onclick="signOut();return false" style="color:#DC2626">Sign Out</a></div></div></div>
<p><span class="badge">Signed in</span> <span class="badge">Email: ${c.emailVerified ? "Verified" : "Verification unavailable"}</span> <span class="badge">Phone: ${c.phoneVerified ? "Verified" : "Verification unavailable"}</span> <span class="badge">Email/phone verification needs a provider — none is connected yet</span> <span class="badge">Profile ${r.profileCompletion}% complete</span> <span class="badge">🔔 ${r.unreadNotifications} unread</span></p>
<div class="statgrid">
<div class="stat"><b>${st.totalOrders}</b><span>Total Orders</span></div>
<div class="stat"><b>${st.inProgress}</b><span>Orders In Progress</span></div>
<div class="stat"><b>${st.delivered}</b><span>Delivered Orders</span></div>
<div class="stat"><b>${st.wishlistItems}</b><span><a href="/wishlist" style="color:#fff">Wishlist Items</a></span></div></div>
<h3 style="color:#fff">Recent Orders</h3>
${recent.length ? recent.map((o) => `<p>${esc(o.orderNumber)} — ${esc(o.status)} — ${money(o.total)} <a href="/track" style="color:#fff">Track</a></p>`).join("") : "<p class='muted'>No orders yet.</p>"}
<p><a href="#" onclick="showAllOrders(event)" style="color:#fff">View All →</a></p>
<h3 style="color:#fff">Quick Services</h3><div class="qgrid">
<a class="qcard" href="/shop">🛍 Shop</a><a class="qcard" href="/track">📦 Track Order</a><a class="qcard" href="/cart">🛒 Cart</a>
<a class="qcard" href="#" onclick="showReturns(event)">↩️ My Returns</a><a class="qcard" href="#" onclick="showRefunds(event)">💸 My Refunds</a><a class="qcard" href="#" onclick="showPayments(event)">💳 Payments</a>
<a class="qcard" href="#" onclick="showAddresses(event)">📍 Saved Addresses</a><a class="qcard" href="/help">💬 Help Center</a><a class="qcard" href="#" onclick="showNotifs(event)">🔔 Notifications</a><a class="qcard" href="#" onclick="showSavedSearches(event)">🔖 Saved Searches</a></div>
<div id="acctPanel"></div>
<p class="muted">My Orders status strip — To Pay ${my.buckets?.toPay || 0} · To Ship ${my.buckets?.toShip || 0} · To Receive ${my.buckets?.toReceive || 0} · To Review ${my.buckets?.toReview || 0}</p>
</div>`;
}
function acctPanel(html) { const el = document.getElementById("acctPanel"); if (el) el.innerHTML = html; }
async function showReturns(e) { e.preventDefault(); const r = await api("listReturns", { mine: true }); acctPanel("<h3>My Returns</h3>" + (r.returns || []).map((x) => `<p>${esc(x.returnNumber)} — ${esc(dispName(x.productName))} — ${money(x.refundAmount)} — stage ${x.refundStage}: ${esc(cleanDemo(x.stageLabel))}${x.stageLabelsVerified ? "" : " (PROVISIONAL label — to verify)"}</p>`).join("") || "<p>No returns.</p>"); }
async function showRefunds(e) { e.preventDefault(); const r = await api("listReturns", { mine: true }); acctPanel("<h3>My Refunds — 9-stage tracker</h3>" + (r.returns || []).map((x) => `<p>${esc(x.returnNumber)}: stage ${x.refundStage}/8 — ${esc(cleanDemo(x.stageLabel))}${x.stageLabelsVerified ? "" : " (PROVISIONAL label — to verify)"}</p>`).join("") || "<p>No refunds in progress.</p>"); }
async function showPayments(e) { e.preventDefault(); const r = await api("listPaymentTransactions", { limit: 100 }); const my = await api("listMyOrders", { limit: 100 }); const nums = new Set((my.orders || []).map((o) => o.orderNumber)); acctPanel("<h3>Payment History</h3>" + (r.transactions || []).filter((t) => nums.has(t.orderNumber)).map((t) => `<p>${esc(t.orderNumber)} — ${esc(cleanDemo(t.method))} — ${esc(t.account || "")} — ${esc(t.reference || "")} — ${esc(cleanDemo(t.status))} — ${money(t.amount)}</p>`).join("") || "<p>No payments yet.</p>"); }
async function showAddresses(e) { e.preventDefault(); const r = await api("listAddresses", {}); acctPanel("<h3>Saved Addresses</h3><div id=\"addrForm\"></div><p><button class=\"btn small\" onclick=\"addressForm()\">+ Add address</button></p>" + (r.addresses || []).map((a) => `<p><strong>${esc(a.label)}</strong> — ${esc(a.recipient)}, ${esc(a.address)}, ${esc(a.city)} ${esc(a.postalCode)} ${a.isDefault ? "(Default)" : ""} <button class="btn ghost small" onclick="addressForm(${a.id})">Edit</button> <button class="btn ghost small" onclick="deleteAddress(${a.id})">Delete</button></p>`).join("") || "<p>No saved address yet.</p>"); }
let lastAddresses = [];
async function addressForm(id) {
  const r = await api("listAddresses", {}); lastAddresses = r.addresses || [];
  const a = id ? lastAddresses.find((x) => x.id === id) : null;
  const el = document.getElementById("addrForm"); if (!el) return;
  el.innerHTML = `<form onsubmit="return doSaveAddress(event, ${id || "null"})" class="card" style="padding:12px;margin:10px 0">
<label>Label <input id="adLabel" value="${esc(a?.label || "Home")}" required></label>
<label>Recipient <input id="adRecipient" value="${esc(a?.recipient || "")}" required></label>
<label>Phone <input id="adPhone" value="${esc(a?.phone || "")}" required></label>
<label>Address <input id="adAddress" value="${esc(a?.address || "")}" required></label>
<label>City <input id="adCity" value="${esc(a?.city || "")}"></label>
<label>Province <input id="adProvince" value="${esc(a?.province || "")}"></label>
<label>Postal code <input id="adPostal" value="${esc(a?.postalCode || "")}"></label>
<label><input id="adDefault" type="checkbox" ${a?.isDefault ? "checked" : ""}> Default address</label>
<button class="btn">${id ? "Save changes" : "Add address"}</button></form>`;
}
async function doSaveAddress(e, id) {
  e.preventDefault();
  const r = await api("saveAddress", { id: id || undefined, label: document.getElementById("adLabel").value, recipient: document.getElementById("adRecipient").value, phone: document.getElementById("adPhone").value, address: document.getElementById("adAddress").value, city: document.getElementById("adCity").value, province: document.getElementById("adProvince").value, postalCode: document.getElementById("adPostal").value, isDefault: document.getElementById("adDefault").checked });
  if (!r.ok) { alert(r.error || "Could not save address."); return false; }
  alert("Address saved."); showAddresses(e); return false;
}
async function deleteAddress(id) {
  if (!confirm("Delete this address?")) return;
  await api("deleteAddress", { id }); showAddresses(new Event("submit"));
}
async function showNotifs(e) { e.preventDefault(); const r = await api("listNotifications", {}); await api("markNotificationsRead", {}); acctPanel("<h3>Notifications</h3><p class='note'>Opening notifications marks them all read.</p>" + (r.notifications || []).slice(0, 10).map((n) => `<p><strong>${esc(cleanDemo(n.title))}</strong> — ${esc(cleanDemo(n.body))}</p>`).join("")); }
// D12: save the current shop search; list/delete from My Account.
async function saveCurrentSearch() {
  const input = document.querySelector('input[name="search"]');
  const q = (input ? input.value : "").trim();
  if (!q) { showToast("Type a search first, then save it."); return; }
  const r = await api("saveSearch", { query: q });
  if (!r.ok) { showToast(r.error || "Sign in to save searches."); return; }
  showToast(r.saved ? "Search saved — find it in My Account → Saved Searches." : (r.note || "Already saved."));
}
async function showSavedSearches(e) { if (e) e.preventDefault(); const r = await api("listSavedSearches", {}); if (!r.ok) { acctPanel("<p>" + esc(r.error || "Sign in to see saved searches.") + "</p>"); return; } acctPanel("<h3>Saved Searches</h3>" + ((r.searches || []).map((x) => `<p><a href="/shop?search=${encodeURIComponent(x.query)}">${esc(x.query)}</a> <button class="btn ghost small" onclick="deleteSavedSearch(${x.id})">Delete</button></p>`).join("") || "<p>No saved searches yet. Search the shop, then tap “Save this search”.</p>")); }
async function deleteSavedSearch(id) { await api("deleteSavedSearch", { id }); showSavedSearches(); }
function changeName(e) { e.preventDefault(); const n = prompt("New name:"); if (!n) return; api("updateCustomerProfile", { name: n }).then(() => loadAccount()); }
function changeAddress(e) { e.preventDefault(); showAddresses(e); }
function changePayment(e) { e.preventDefault(); showPayments(e); }
function changePassword(e) {
  e.preventDefault();
  acctPanel(`<h3>Security — Change Password</h3><form onsubmit="return doChangePassword(event)">
<label>Current password <span class="pw"><input id="cpCur" type="password" required><button type="button" onclick="togglePw('cpCur',this)">👁️</button></span></label>
<label>New password <span class="pw"><input id="cpNew" type="password" required minlength="8"><button type="button" onclick="togglePw('cpNew',this)">👁️</button></span></label>
<label>Confirm new password <input id="cpNew2" type="password" required minlength="8"></label>
<p class="note">Password strength: use 8+ characters with a mix of letters and numbers.</p><button class="btn">Change Password</button></form>`);
}
async function doChangePassword(e) {
  e.preventDefault();
  const a = document.getElementById("cpNew").value, b = document.getElementById("cpNew2").value;
  if (a !== b) { alert("New passwords do not match."); return false; }
  const r = await api("changePassword", { currentPassword: document.getElementById("cpCur").value, newPassword: a, confirmNewPassword: b });
  alert(r.ok ? "Password changed." : (r.error || "Could not change password."));
  return false;
}
async function showAllOrders(e) { if (e) e.preventDefault(); const my = await api("listMyOrders", { limit: 100 }); acctPanel("<h3>My Orders (" + (my.orders || []).length + ")</h3>" + (my.orders || []).map((o) => `<p><strong>${esc(o.orderNumber)}</strong> — ${esc(o.status)} — ${money(o.total)} <button class="btn ghost small" onclick="showOrderDetailCust('${esc(o.orderNumber)}','${esc(o.trackingNumber)}',${o.id},'${esc(o.status)}')">Details</button></p>`).join("") || "<p>No orders yet.</p>"); }
async function showOrderDetailCust(orderNumber, trackingNumber, orderId, status) {
  const r = await api("getOrderTracking", { orderNumber, trackingNumber });
  if (!r.ok) { acctPanel("<p>" + esc(r.error || "Not found.") + "</p>"); return; }
  const o = r.order;
  const canCancel = !["Delivered", "Cancelled"].includes(o.status);
  const canReturn = o.status === "Delivered";
  acctPanel(`<h3>${esc(o.orderNumber)} — ${esc(o.status)}</h3>
<p>${esc(o.customerName)} · ${esc(o.address)}, ${esc(o.city)} ${esc(o.province)}</p>
<p>Items: ${(r.items || []).map((it) => esc(it.productName) + " × " + it.qty + " — " + money(it.price * it.qty)).join("; ")}</p>
<p>Total ${money(o.total)} · Payment: ${esc(cleanDemo(o.paymentMethod))} — ${esc(cleanDemo(o.paymentStatus))} · Courier: ${esc(cleanDemo(o.courier))}</p>
<p>Tracking: ${(r.events || []).map((ev) => esc(ev.status)).join(" → ") || "none"}</p>
${canCancel ? `<p><button class="btn ghost" onclick="doCancelOrder(${o.id})">Cancel this order</button></p>` : ""}
${canReturn ? `<div id="returnForm"></div><p><button class="btn ghost" onclick="showReturnForm('${esc(o.orderNumber)}')">Request a return</button></p>` : ""}
<p><a href="#" onclick="showAllOrders(event)">← Back to all orders</a></p>`);
}
async function doCancelOrder(orderId) {
  if (!confirm("Cancel this order? Stock is released and a refund is marked pending if you already paid.")) return;
  const r = await api("cancelOrder", { orderId, reason: "Cancelled by customer from My Orders" });
  if (!r.ok) { alert(r.error || "Could not cancel."); return; }
  alert(r.refused ? r.message : "Order cancelled.");
  loadAccount();
}
async function showReturnForm(orderNumber) {
  const el = document.getElementById("returnForm"); if (!el) return;
  const r = await api("getOrderTracking", { orderNumber, trackingNumber: "" });
  const names = (r.items || []).map((it) => it.productName);
  if (!names.length) { el.innerHTML = "<p>No items on this order.</p>"; return; }
  el.innerHTML = `<form onsubmit="return doCreateReturnCust(event,'${esc(orderNumber)}')" class="card" style="padding:12px;margin:10px 0"><h3>Request a return</h3>
<label>Product <select id="rtProduct">${names.map((n) => `<option>${esc(n)}</option>`).join("")}</select></label>
<label>Quantity <input id="rtQty" type="number" min="1" value="1"></label>
<label>Refund amount (Rs) <input id="rtAmount" type="number" min="1" required></label>
<label>Reason <input id="rtReason" required placeholder="e.g. Wrong size"></label>
<label>Pickup <select id="rtPickup"><option>Home Pickup</option><option>Drop-off</option></select></label>
<button class="btn">Submit return request</button></form>`;
}
async function doCreateReturnCust(e, orderNumber) {
  e.preventDefault();
  const r = await api("createReturn", { orderNumber, productName: document.getElementById("rtProduct").value, qty: Number(document.getElementById("rtQty").value || 1), refundAmount: Number(document.getElementById("rtAmount").value), reason: document.getElementById("rtReason").value, pickupMethod: document.getElementById("rtPickup").value });
  if (!r.ok) { alert(r.error || "Could not request a return."); return false; }
  alert("Return requested: " + r.return.returnNumber + " (stage 0 — Requested).");
  loadAccount(); return false;
}
function notifPrefs(e) { e.preventDefault(); showNotifPrefs(e); }
async function showNotifPrefs(e) {
  const r = await api("getNotifPrefs", {});
  if (!r.ok) { acctPanel("<p>" + esc(r.error || "Sign in to manage preferences.") + "</p>"); return; }
  const p = r.prefs || {};
  acctPanel(`<h3>Notification Preferences</h3><form onsubmit="return doSaveNotifPrefs(event)">
<label><input id="npOrder" type="checkbox" ${p.orderUpdates ? "checked" : ""}> Order updates (placed, shipped, delivered, cancelled)</label>
<label><input id="npPromo" type="checkbox" ${p.promotions ? "checked" : ""}> Promotions and flash-sale alerts</label>
<label><input id="npSupport" type="checkbox" ${p.supportReplies ? "checked" : ""}> Support replies</label>
<button class="btn">Save preferences</button></form><p class="note">Saved on your account — they apply to your notifications only.</p>`);
}
async function doSaveNotifPrefs(e) {
  e.preventDefault();
  const r = await api("saveNotifPrefs", { prefs: { orderUpdates: document.getElementById("npOrder").checked, promotions: document.getElementById("npPromo").checked, supportReplies: document.getElementById("npSupport").checked } });
  if (!r.ok) { alert(r.error || "Could not save."); return false; }
  alert("Preferences saved."); return false;
}
function privacySec(e) { e.preventDefault(); if (confirm("Request account deletion? This only records the request — the owner reviews it first.")) api("requestAccountDeletion", {}).then((r) => alert(r.note || "Requested.")); }

// D16: review form (verified-purchase flag is computed server-side) and
// Q&A ask form on product pages.
async function doSubmitReview(e, productId) {
  e.preventDefault();
  const r = await api("submitReview", { productId, rating: Number(document.getElementById("rvRating").value), text: document.getElementById("rvText").value });
  const el = document.getElementById("rvMsg");
  if (!r.ok) { if (el) el.innerHTML = "<p>" + esc(r.error || "Could not submit.") + "</p>"; return false; }
  if (el) el.innerHTML = "<p><strong>Review submitted" + (r.review.verified ? " — Verified purchase ✓" : "") + ".</strong> It appears below after reload.</p>";
  showToast("Review submitted" + (r.review.verified ? " (Verified purchase)." : "."));
  setTimeout(() => location.reload(), 1200);
  return false;
}
async function doAskQuestion(e, productId) {
  e.preventDefault();
  const r = await api("askQuestion", { productId, question: document.getElementById("qaText").value });
  const el = document.getElementById("qaMsg");
  if (!r.ok) { if (el) el.innerHTML = "<p>" + esc(r.error || "Could not ask.") + "</p>"; return false; }
  if (el) el.innerHTML = "<p><strong>Question posted.</strong> The store will answer it here.</p>";
  showToast("Question posted.");
  setTimeout(() => location.reload(), 1200);
  return false;
}
// ---- Admin ----
const ADMIN_TABS = ["Dashboard", "Products", "Categories", "Inventory", "Orders", "Payments", "Returns / Refunds", "Customers", "Support", "Reviews", "Notifications", "Coupons", "Staff & Permissions", "Reports", "Settings", "Homepage", "Demo Merchants", "Demo Manager", "Phase 2", "Audit Log"];
// ---- Staff activation (owner / Super Admin only) ----
// The one-time setup token is shown ONCE here and must be passed to the
// staff member out of band (e.g. WhatsApp). It is never stored in the
// browser and never appears in logs.
function showOneTimeToken(title, token, note) {
  const el = document.getElementById("tokenPanel"); if (!el) { alert(title + ": " + token); return; }
  el.innerHTML = `<div class="card" style="border:2px solid #F59E0B;padding:12px;margin:10px 0"><h3>${esc(title)}</h3>
<p class="note">${esc(note)}</p><p><input readonly value="${esc(token)}" style="width:100%" onclick="this.select()"></p>
<p><button class="btn small" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(token)}')">Copy token</button></p></div>`;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}
async function doCreateStaff(e) {
  e.preventDefault();
  const r = await api("saveStaff", { name: document.getElementById("nsName").value, email: document.getElementById("nsEmail").value, role: document.getElementById("nsRole").value, department: document.getElementById("nsDept").value, status: "Active" });
  if (!r.ok) { alert(r.error || "Could not add staff."); return false; }
  alert("Staff added with no password. Now issue a setup token so they can activate at /staff/setup.");
  adminTab(12, document.querySelectorAll("#adminTabs .tab")[12]);
  return false;
}
async function issueStaffToken(id, name) {
  const r = await api("createStaffSetupToken", { staffId: id });
  if (!r.ok) { alert(r.error || "Could not issue a token."); return; }
  showOneTimeToken("Setup token for " + name, r.setupToken, "Valid 24 hours, one use. " + name + " opens /staff/setup, types this token, sets a password, then adds the authenticator secret and types the 6-digit code. After that the token is dead.");
}
async function resetStaffPw(id, name) {
  if (!confirm("Reset " + name + "'s password and authenticator? Their old password stops working and all their sessions end.")) return;
  const r = await api("resetStaffPassword", { staffId: id });
  if (!r.ok) { alert(r.error || "Could not reset."); return; }
  showOneTimeToken("New setup token for " + name, r.setupToken, "Valid 24 hours, one use. " + name + " opens /staff/setup and activates again with this token.");
}

// ---- Admin edit forms (B13) ----
let lastProducts = [], lastCategories = [], lastCoupons = [];
function reloadAdminTab(i) { adminTab(i, document.querySelectorAll("#adminTabs .tab")[i]); }
// POLISH: hero banner image upload (Admin → Homepage). Reads the file in
// the browser and sends base64 to uploadHeroBannerImage, which stores it
// as a data URI (no filesystem write — Vercel is read-only).
async function doUploadHeroBanner(bannerId) {
  const input = document.getElementById("hbFile-" + bannerId);
  const msg = document.getElementById("hbMsg-" + bannerId);
  const file = input && input.files && input.files[0];
  if (!file) { if (msg) msg.textContent = "Choose an image first."; return; }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { if (msg) msg.textContent = "Only JPEG/PNG/WebP images are accepted."; return; }
  if (file.size > 2 * 1024 * 1024) { if (msg) msg.textContent = "Image must be 2 MB or less."; return; }
  if (msg) msg.textContent = "Uploading…";
  const dataUrl = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(new Error("Could not read the file.")); fr.readAsDataURL(file); });
  const r = await api("uploadHeroBannerImage", { bannerId, fileName: file.name, dataBase64: dataUrl, mime: file.type });
  if (r.ok) { showToast("Banner image uploaded — it now shows on the homepage slide."); reloadAdminTab(15); }
  else if (msg) msg.textContent = r.error || "Upload failed.";
}
function editProductForm(id) {
  const p = lastProducts.find((x) => x.id === id); if (!p) return;
  const el = document.getElementById("prodForm"); if (!el) return;
  el.innerHTML = `<form onsubmit="return doSaveProduct(event, ${p.id})" class="card" style="border:2px solid #315EFB;padding:12px;margin:10px 0"><h3>Edit ${esc(p.sku)} — ${esc(p.name)}</h3>
<label>Name <input id="epName" value="${esc(p.name)}" required></label>
<label>Price (Rs) <input id="epPrice" type="number" min="0" value="${p.price}" required></label>
<label>Sale price (blank = none) <input id="epSale" type="number" min="0" value="${p.salePrice ?? ""}"></label>
<label>Stock <input id="epStock" type="number" min="0" value="${p.stock}"></label>
<label>Category <input id="epCat" value="${esc(p.category)}"></label>
<label>Subcategory <input id="epSub" value="${esc(p.subcategory || "")}"></label>
<label>Status <select id="epStatus"><option ${p.status === "Published" ? "selected" : ""}>Published</option><option ${p.status === "Draft" ? "selected" : ""}>Draft</option></select></label>
<label><input id="epFlash" type="checkbox" ${p.isFlash ? "checked" : ""}> Flash deal</label>
<label><input id="epFeat" type="checkbox" ${p.isFeatured ? "checked" : ""}> Featured</label>
<button class="btn">Save product</button> <button type="button" class="btn ghost" onclick="document.getElementById('prodForm').innerHTML=''">Cancel</button></form>`;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}
async function doSaveProduct(e, id) {
  e.preventDefault();
  const p = lastProducts.find((x) => x.id === id); if (!p) return false;
  const sale = document.getElementById("epSale").value;
  const r = await api("saveProduct", { ...p, name: document.getElementById("epName").value, price: Number(document.getElementById("epPrice").value), salePrice: sale === "" ? null : Number(sale), stock: Number(document.getElementById("epStock").value), category: document.getElementById("epCat").value, subcategory: document.getElementById("epSub").value, status: document.getElementById("epStatus").value, isFlash: document.getElementById("epFlash").checked, isFeatured: document.getElementById("epFeat").checked });
  if (!r.ok) { alert(r.error || "Could not save."); return false; }
  alert("Product saved."); reloadAdminTab(1); return false;
}
async function doAddProduct(e) {
  e.preventDefault();
  const r = await api("saveProduct", { sku: document.getElementById("npSku").value.trim(), name: document.getElementById("npName").value, category: document.getElementById("npCat").value, price: Number(document.getElementById("npPrice").value), stock: Number(document.getElementById("npStock").value || 0), status: "Published" });
  if (!r.ok) { alert(r.error || "Could not add product."); return false; }
  alert("Product added."); reloadAdminTab(1); return false;
}
function editCategoryForm(id) {
  const c = lastCategories.find((x) => x.id === id); if (!c) return;
  const el = document.getElementById("catForm"); if (!el) return;
  el.innerHTML = `<form onsubmit="return doSaveCategory(event, ${c.id})" class="card" style="border:2px solid #315EFB;padding:12px;margin:10px 0"><h3>Edit category</h3>
<label>Name <input id="ecName" value="${esc(c.name)}" required></label><label>Parent <input id="ecParent" value="${esc(c.parent || "")}"></label>
<label><input id="ecActive" type="checkbox" ${c.active ? "checked" : ""}> Active</label>
<button class="btn">Save category</button> <button type="button" class="btn ghost" onclick="document.getElementById('catForm').innerHTML=''">Cancel</button></form>`;
}
async function doSaveCategory(e, id) {
  e.preventDefault();
  const body = id
    ? { id, name: document.getElementById("ecName").value, parent: document.getElementById("ecParent").value, active: document.getElementById("ecActive").checked }
    : { name: document.getElementById("ncName").value, parent: document.getElementById("ncParent").value, active: document.getElementById("ncActive").checked };
  const r = await api("saveCategory", body);
  if (!r.ok) { alert(r.error || "Could not save category."); return false; }
  alert("Category saved."); reloadAdminTab(2); return false;
}
async function deleteCategory(id, name) {
  if (!confirm("Delete category \"" + name + "\"? Products in it are not deleted.")) return;
  const r = await api("deleteCategory", { id });
  if (!r.ok) { alert(r.error || "Could not delete."); return; }
  reloadAdminTab(2);
}
async function showOrderDetail(orderNumber, trackingNumber) {
  const el = document.getElementById("orderDetail"); if (!el) return;
  const r = await api("getOrderTracking", { orderNumber, trackingNumber });
  if (!r.ok) { el.innerHTML = "<p>" + esc(r.error || "Not found.") + "</p>"; return; }
  const o = r.order;
  el.innerHTML = `<div class="card" style="border:2px solid #315EFB;padding:12px;margin:10px 0"><h3>${esc(o.orderNumber)} — ${esc(o.status)}</h3>
<p>${esc(o.customerName)} · ${esc(o.customerEmail)} · ${esc(o.customerPhone)}<br>${esc(o.address)}, ${esc(o.city)} ${esc(o.province)}</p>
<p>Items: ${(r.items || []).map((it) => esc(it.productName) + " × " + it.qty + " — " + money(it.price * it.qty)).join("; ")}</p>
<p>Payment: ${esc(cleanDemo(o.paymentMethod))} — ${esc(cleanDemo(o.paymentStatus))} · Courier: ${esc(cleanDemo(o.courier))} · Tracking: ${esc(o.trackingNumber)}</p>
<p>Events: ${(r.events || []).map((ev) => esc(ev.status)).join(" → ") || "none"}</p></div>`;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}
async function setReturnStage(id) {
  const sel = document.getElementById("rs-" + id); if (!sel) return;
  const r = await api("updateReturn", { id, refundStage: Number(sel.value) });
  if (!r.ok) { alert(r.error || "Could not update."); return; }
  alert("Return stage set to " + r.stage + " — " + (r.label || "") + ".");
  reloadAdminTab(6);
}
function editCouponForm(code) {
  const c = lastCoupons.find((x) => x.code === code); if (!c) return;
  const el = document.getElementById("couponForm"); if (!el) return;
  el.innerHTML = `<form onsubmit="return doSaveCoupon(event, ${c.id})" class="card" style="border:2px solid #315EFB;padding:12px;margin:10px 0"><h3>Edit ${esc(c.code)}</h3>
<label>Type <select id="ecpType"><option value="percent" ${c.discountType === "percent" ? "selected" : ""}>Percent %</option><option value="fixed" ${c.discountType === "fixed" ? "selected" : ""}>Fixed Rs</option></select></label>
<label>Value <input id="ecpValue" type="number" min="0" value="${c.value}"></label>
<label>Min order (Rs) <input id="ecpMin" type="number" min="0" value="${c.minOrder}"></label>
<label>Status <select id="ecpStatus"><option ${c.status === "Active" ? "selected" : ""}>Active</option><option ${c.status === "Inactive" ? "selected" : ""}>Inactive</option></select></label>
<label>Expires (YYYY-MM-DD, blank = none) <input id="ecpExp" value="${esc(c.expiresAt || "")}"></label>
<label>Usage limit (0 = unlimited) <input id="ecpLimit" type="number" min="0" value="${c.usageLimit}"></label>
<label>Per-customer limit (0 = unlimited) <input id="ecpPerCust" type="number" min="0" value="${c.perCustomerLimit}"></label>
<button class="btn">Save coupon</button> <button type="button" class="btn ghost" onclick="document.getElementById('couponForm').innerHTML=''">Cancel</button></form>`;
}
async function doSaveCoupon(e, id) {
  e.preventDefault();
  const body = id
    ? { id, code: lastCoupons.find((x) => x.id === id).code, discountType: document.getElementById("ecpType").value, value: Number(document.getElementById("ecpValue").value), minOrder: Number(document.getElementById("ecpMin").value || 0), status: document.getElementById("ecpStatus").value, expiresAt: document.getElementById("ecpExp").value, usageLimit: Number(document.getElementById("ecpLimit").value || 0), perCustomerLimit: Number(document.getElementById("ecpPerCust").value || 0) }
    : { code: document.getElementById("ncpCode").value.trim().toUpperCase(), discountType: document.getElementById("ncpType").value, value: Number(document.getElementById("ncpValue").value), minOrder: Number(document.getElementById("ncpMin").value || 0), status: "Active", expiresAt: document.getElementById("ncpExp").value, usageLimit: Number(document.getElementById("ncpLimit").value || 0), perCustomerLimit: Number(document.getElementById("ncpPerCust").value || 0) };
  const r = await api("saveCoupon", body);
  if (!r.ok) { alert(r.error || "Could not save coupon."); return false; }
  alert("Coupon saved."); reloadAdminTab(11); return false;
}
async function toggleCoupon(id, status) {
  const r = await api("setCouponStatus", { id, status });
  if (!r.ok) { alert(r.error || "Could not update."); return; }
  reloadAdminTab(11);
}
async function doSaveSettings(e) {
  e.preventDefault();
  const form = e.target;
  const settings = {};
  for (const el of form.querySelectorAll("input[name]")) settings[el.name] = el.value;
  const r = await api("saveSettings", { settings });
  if (!r.ok) { alert(r.error || "Could not save settings."); return false; }
  alert("Settings saved."); return false;
}

async function adminTab(i, btn) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("on"));
  if (btn) btn.classList.add("on");
  const root = document.getElementById("adminRoot"); if (!root) return;
  root.innerHTML = "<p>Loading " + esc(ADMIN_TABS[i]) + "…</p>";
  try {
    if (i === 0) { const r = await api("getAnalytics", {}); const b = await api("getBootstrap", {}); root.innerHTML = `<h2>Dashboard</h2>
<div class="statgrid"><div class="stat"><b>${b.publishedProductCount}</b><span>Published products</span></div><div class="stat"><b>${b.orderCount}</b><span>Orders${b.legacyTestOrderCount ? ` (${b.legacyTestOrderCount} legacy-test)` : ""}</span></div><div class="stat"><b>${money(r.gmv)}</b><span>GMV — real records only</span></div><div class="stat"><b>${money(r.avgOrderValue)}</b><span>Average order</span></div><div class="stat"><b>${money(r.refundsRequested)}</b><span>Refunds requested</span></div><div class="stat"><b>${money(r.refundsTotal)}</b><span>Refunds completed</span></div></div>
<p>Daily sales — last 30 days (Asia/Karachi, zero days = 0), latest 7 days: ${(r.dailySales || []).slice(-7).map((d) => (d.date || "").slice(5) + " " + money(d.total)).join(" · ")}</p><p>Top products: ${(r.topProducts || []).map((t) => "#" + t.productId + " × " + t.qty).join(", ") || "none"}${r.legacyTopQty ? ` · Legacy unresolved items: ${r.legacyTopQty} sold (productId 0/NULL, excluded from top products)` : ""}</p><p>By status: ${Object.entries(r.byStatus).map(([k, v]) => k + " " + v).join(", ")}</p>`; }
    else if (i === 1) { const r = await api("listProducts", { limit: 100 }); lastProducts = r.products; root.innerHTML = `<h2>Products (${r.total})</h2>
<div id="prodForm"></div>
<form onsubmit="return doAddProduct(event)"><h3>Add product</h3><label>SKU <input id="npSku" required></label><label>Name <input id="npName" required></label><label>Category <input id="npCat" required></label><label>Price (Rs) <input id="npPrice" type="number" min="0" required></label><label>Stock <input id="npStock" type="number" min="0" value="0"></label><button class="btn">Add product</button></form>
<div class="tablewrap"><table><tr><th>SKU</th><th>Name</th><th>Price</th><th>Sale</th><th>Stock</th><th>Flash</th><th>Status</th><th></th></tr>${r.products.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}${p.imageIsSample ? " • Sample" : ""}</td><td>${money(p.price)}</td><td>${p.salePrice ? money(p.salePrice) : "—"}</td><td>${p.stock}</td><td>${p.isFlash ? "✓" : ""}</td><td>${esc(p.status)}</td><td><button class="btn ghost small" onclick="editProductForm(${p.id})">Edit</button></td></tr>`).join("")}</table></div><p class="note">Product Photos manager: every product carries one sample photo ("• Sample" tag). Uploads replace samples via uploadProductImage; the sample seeder never overwrites a product that already has any photo.</p>`; }
    else if (i === 2) { const r = await api("listCategories", { limit: 200 }); lastCategories = r.categories; root.innerHTML = `<h2>Categories (${r.total})</h2><p>9 active top categories + 99 active subcategories + 6 deactivated legacy top categories.</p>
<div id="catForm"></div>
<form onsubmit="return doSaveCategory(event)"><h3>Add category</h3><label>Name <input id="ncName" required></label><label>Parent (blank = top category) <input id="ncParent" placeholder=""></label><label><input id="ncActive" type="checkbox" checked> Active</label><button class="btn">Add category</button></form>
<div class="tablewrap"><table><tr><th>Name</th><th>Parent</th><th>Active</th><th>Products</th><th></th></tr>${r.categories.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.parent || "—")}</td><td>${c.active ? "✓" : "✗"}</td><td>${c.productCount}</td><td><button class="btn ghost small" onclick="editCategoryForm(${c.id})">Edit</button> <button class="btn ghost small" onclick="deleteCategory(${c.id},'${esc(c.name)}')">Delete</button></td></tr>`).join("")}</table></div>`; }
    else if (i === 3) { const r = await api("listInventoryMovements", { limit: 100 }); root.innerHTML = `<h2>Inventory ledger (${r.movements.length})</h2><div class="tablewrap"><table><tr><th>SKU</th><th>Type</th><th>Qty</th><th>Balance</th><th>Reference</th></tr>${r.movements.map((m) => `<tr><td>${esc(m.sku)}</td><td>${esc(m.type)}</td><td>${m.qty}</td><td>${m.balanceAfter}</td><td>${esc(m.reference)}</td></tr>`).join("")}</table></div>`; }
    else if (i === 4) { loadAdminOrders(0, "", ""); }
    else if (i === 5) { const r = await api("listPaymentTransactions", { limit: 100 }); root.innerHTML = `<h2>Payments — ledger (${r.transactions.length})</h2><p class="note">Demo Simulation — no gateway connected. Bank transfers start "Awaiting Verification (Demo)".</p><div class="tablewrap"><table><tr><th>Order</th><th>Method</th><th>Account</th><th>Ref</th><th>Amount</th><th>Status</th></tr>${r.transactions.map((t) => `<tr><td>${esc(t.orderNumber)}</td><td>${esc(t.method)}</td><td>${esc(t.account)}</td><td>${esc(t.reference)}</td><td>${money(t.amount)}</td><td>${esc(t.status)}</td></tr>`).join("")}</table></div>`; }
    else if (i === 6) { const r = await api("listReturns", { limit: 100 }); root.innerHTML = `<h2>Returns / Refunds (${r.returns.length})</h2><p class="note">9-stage tracker (cap 8, restock at stage 4). Stage labels 1–7 are PROVISIONAL working labels, to verify against the original returns UI — they are marked PROVISIONAL wherever shown until the owner verifies them. Set a stage and Apply — the move is validated server-side.</p><div class="tablewrap"><table><tr><th>Return</th><th>Order</th><th>Product</th><th>Refund</th><th>Stage</th><th>Status</th><th>Set stage</th></tr>${r.returns.map((x) => `<tr><td>${esc(x.returnNumber)}</td><td>${esc(x.orderNumber)}</td><td>${esc(x.productName)}</td><td>${money(x.refundAmount)}</td><td>${x.refundStage} — ${esc(x.stageLabel)}${x.stageLabelsVerified ? "" : " (PROVISIONAL)"}</td><td>${esc(x.status)}</td><td><select id="rs-${x.id}">${["Requested", "Under Review", "Approved", "Pickup Scheduled", "Item Received — Restocked", "Refund Processing", "Refund Approved", "Refund Sent", "Refunded (Demo)"].map((l, s) => `<option value="${s}" ${s === x.refundStage ? "selected" : ""}>${s} — ${esc(l)}</option>`).join("")}</select> <button class="btn ghost small" onclick="setReturnStage(${x.id})">Apply</button></td></tr>`).join("")}</table></div>`; }
    else if (i === 7) { const r = await api("listRegisteredCustomers", { limit: 100 }); root.innerHTML = `<h2>Registered customers</h2><div class="tablewrap"><table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Verified</th><th>Password</th></tr>${(r.customers || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td><td>${c.emailVerified ? "Email ✓" : "Email ✗"} / ${c.phoneVerified ? "Phone ✓" : "Phone ✗"}</td><td>${c.mustResetPassword ? "No password yet — ask owner" : "PBKDF2"}</td></tr>`).join("")}</table></div>`; }
    else if (i === 8) { const r = await api("listTickets", { limit: 100 }); root.innerHTML = `<h2>Support tickets</h2><div class="tablewrap"><table><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Agent</th><th>Last reply</th></tr>${r.tickets.map((t) => `<tr><td>${esc(t.ticketNumber)}</td><td>${esc(t.subject)}</td><td>${esc(t.status)}</td><td>${esc(t.agent)}</td><td>${esc(t.lastReply || "—")}</td></tr>`).join("")}</table></div>`; }
    else if (i === 9) { const r = await api("listReviews", { limit: 100 }); root.innerHTML = `<h2>Reviews (${r.reviews.length})</h2>` + r.reviews.map((x) => `<p><strong>${esc(x.productName)}</strong> ${"★".repeat(x.rating)} — ${esc(x.text)} <small>(${esc(x.customerName)})</small></p>`).join(""); }
    else if (i === 10) { const r = await api("listNotifications", { limit: 100 }); root.innerHTML = `<h2>Notifications (${r.notifications.length}, ${r.unread} unread)</h2>` + r.notifications.slice(0, 15).map((n) => `<p><strong>${esc(n.title)}</strong> — ${esc(n.body)} ${n.isRead ? "" : "(unread)"}</p>`).join(""); }
    else if (i === 11) { const r = await api("getBootstrap", {}); lastCoupons = r.coupons; root.innerHTML = `<h2>Coupons / Promotions</h2>
<div id="couponForm"></div>
<form onsubmit="return doSaveCoupon(event)"><h3>Add coupon</h3><label>Code <input id="ncpCode" required placeholder="SAVE10"></label><label>Type <select id="ncpType"><option value="percent">Percent %</option><option value="fixed">Fixed Rs</option></select></label><label>Value <input id="ncpValue" type="number" min="0" required></label><label>Min order (Rs) <input id="ncpMin" type="number" min="0" value="0"></label><label>Expires (YYYY-MM-DD, blank = none) <input id="ncpExp" placeholder="2026-12-31"></label><label>Usage limit (0 = unlimited) <input id="ncpLimit" type="number" min="0" value="0"></label><label>Per-customer limit (0 = unlimited) <input id="ncpPerCust" type="number" min="0" value="0"></label><button class="btn">Add coupon</button></form>
<div class="tablewrap"><table><tr><th>Code</th><th>Type</th><th>Value</th><th>Min</th><th>Status</th><th>Expires</th><th>Limit</th><th>Uses</th><th></th></tr>${r.coupons.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.discountType)}</td><td>${c.value}${c.discountType === "percent" ? "%" : ""}</td><td>${money(c.minOrder)}</td><td>${esc(c.status)}</td><td>${esc(c.expiresAt || "— (unbounded)")}</td><td>${c.usageLimit || "unbounded"}</td><td>${c.uses}</td><td><button class="btn ghost small" onclick="editCouponForm('${esc(c.code)}')">Edit</button> <button class="btn ghost small" onclick="toggleCoupon(${c.id},'${c.status === "Active" ? "Inactive" : "Active"}')">${c.status === "Active" ? "Deactivate" : "Activate"}</button></td></tr>`).join("")}</table></div><p class="note">Production expiry/limit values for 000 / WELCOME10 / FLASH500 are owner inputs — deliberately not invented. BIGTEST5 is a temporary test coupon (expires 2026-12-25, limit 20, per-customer 3).</p>`; }
    else if (i === 12) { const r = await api("listStaff", { limit: 100 }); const m = await api("getRoleMatrix", {}); const t = await api("runRoleSelfTest", {}); root.innerHTML = `<h2>Staff &amp; Permissions</h2>
<form onsubmit="return doCreateStaff(event)"><h3>Add staff member</h3><p class="note">New staff start with NO password — the owner then issues them a one-time setup token (24 h) so they set their own password + authenticator at /staff/setup. Only the Owner can grant the Owner role.</p>
<label>Name <input id="nsName" required></label><label>Email <input id="nsEmail" type="email" required></label>
<label>Role <select id="nsRole">${m.roles.map((x) => `<option>${esc(x.role)}</option>`).join("")}</select></label>
<label>Department <input id="nsDept" placeholder="Management"></label>
<button class="btn">Add staff</button></form>
<div id="tokenPanel"></div>
<div class="tablewrap"><table><tr><th>Name</th><th>Role</th><th>Department</th><th>Email</th><th>Status</th><th>Password</th><th>Authenticator</th><th>Setup</th><th>Actions</th></tr>${r.staff.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.role)}</td><td>${esc(x.department)}</td><td>${esc(x.email)}</td><td>${esc(x.status)}</td><td>${x.hasPassword ? "Set" : "Not set"}</td><td>${x.totpEnabled ? "On" : "Off"}</td><td>${x.setupPending ? "Token issued" : "—"}</td><td><button class="btn ghost small" onclick="issueStaffToken(${x.id},'${esc(x.name)}')">Issue setup token</button> <button class="btn ghost small" onclick="resetStaffPw(${x.id},'${esc(x.name)}')">Reset password</button></td></tr>`).join("")}</table></div><p>Role self-test: <strong>${t.allowed} allowed / ${t.denied} denied</strong> (110 checks; reference 52/58). Live probes: ${t.liveDenied.join("; ")}; ${t.liveAllowed.join("; ")}.</p><p class="note">Matrix: ${m.roles.map((x) => esc(x.role) + " → " + x.permissions.join(", ")).join(" | ")}</p>`; }
    else if (i === 13) { const r = await api("getAnalytics", {}); root.innerHTML = `<h2>Reports / Analytics</h2><p>GMV ${money(r.gmv)} · Avg order ${money(r.avgOrderValue)} · Legacy orders excluded: ${r.legacyOrders}</p><p>CSV export: <button class="btn ghost small" onclick="exportCsv()">Download orders CSV</button></p>`; }
    else if (i === 14) { const r = await api("getBootstrap", {}); const cfg = r.config || {}; const editable = ["brandName", "tagline", "country", "currency", "currencySymbol", "language", "secondaryLanguage", "timezone", "freeShippingThreshold", "standardShippingFee", "expressShippingFee", "flashRowSize", "flashRotateDays", "flashRowAnchor", "flashSaleEndsAt", "supportEmail", "supportPhone"]; root.innerHTML = `<h2>Settings</h2>
<form onsubmit="return doSaveSettings(event)"><p class="note">Only these keys are editable here — reports, snapshots, commission and verification markers are rejected by the server (B22).</p>${editable.map((k) => `<label>${esc(k)} <input name="${esc(k)}" value="${esc(cfg[k] || "")}"></label>`).join("")}<button class="btn">Save settings</button></form>
<p class="note">Brand: NEXORA MARKET — navy #101828, blue #315EFB, amber #F59E0B. Demo mode ON.</p>
<h3>Backup &amp; Restore</h3><p class="note">Export downloads a full JSON snapshot (no passwords, no session tokens). Restore is Owner-only, needs a fresh password + authenticator confirmation, takes a fresh backup first (saved as settings key backupSnapshotAuto), and only runs when you type RESTORE.</p>
<p><button class="btn ghost" onclick="doExportBackup()">Export backup (download JSON)</button></p>
<form onsubmit="return doRestoreBackup(event)"><label>Backup JSON file <input id="bkFile" type="file" accept=".json,application/json" required></label><label>Type RESTORE to confirm <input id="bkConfirm" required placeholder="RESTORE"></label><button class="btn">Restore backup</button></form><div id="bkMsg"></div>`; }
    else if (i === 15) { const r = await api("getHomepageAdmin", {}); root.innerHTML = `<h2>Homepage</h2><p>Flash row: size ${r.flashRowSize} (4–5), new set every ${r.flashRotateDays} day(s), anchor ${r.flashRowAnchor}. Campaign end: ${esc(r.flashEndsAt || "not set — no countdown")}</p><p>Banners: ${r.banners.map((b) => esc(b.headline)).join(" · ")}</p><p>Collections: ${r.collections.map((c) => esc(c.name)).join(" · ")}</p><p>Sections: ${r.sections.map((s) => esc(s.key) + (s.visible ? "" : " (hidden)")).join(", ")}</p><p class="note">Flash Sale countdown: set the campaign end date in Admin → Settings → flashSaleEndsAt (YYYY-MM-DD) — the homepage then shows a live countdown. Until then it honestly says no campaign end is set.</p>
<h3>Hero banner images</h3><p class="note">Each slide shows the linked product's photo unless you upload a banner image here — the upload replaces the slide photo (JPEG/PNG/WebP, max 2 MB).</p>
${r.banners.map((b) => `<div class="card"><strong>${esc(b.headline)}</strong><p class="note">Image now: ${(b.imageKey || "").startsWith("data:image/") ? "Custom uploaded image" : "Linked product photo"}</p><p><input type="file" id="hbFile-${b.id}" accept="image/jpeg,image/png,image/webp"> <button class="btn small" onclick="doUploadHeroBanner(${b.id})">Upload banner image</button> <span id="hbMsg-${b.id}"></span></p></div>`).join("")}`; }
    else if (i === 16) { const r = await api("listDemoMerchants", { limit: 100 }); root.innerHTML = `<h2>Demo Merchants (display only)</h2>` + r.merchants.map((m) => `<p><strong>${esc(m.storeName)}</strong> — ${esc(m.city)} · ★ ${m.rating} · ${esc(m.verification)}</p>`).join(""); }
    else if (i === 17) { root.innerHTML = `<h2>Demo Manager / Reset</h2><p><strong>Browser seeding was removed in Phase 1 (A4).</strong> No public endpoint can reseed or wipe the database anymore — seeding is CLI-only (<code>npm run db:seed</code>, idempotent) or via boot migration on deploy.</p><p><button class="btn ghost" onclick="reauthAndRetry('cleanupInvalidReturns',{}).then(r=>alert(r.ok?('Removed '+r.removed+' invalid returns. Legacy-flagged rows preserved.'):(r.error||'Failed')))">Clean up invalid returns</button> <span class="note">Needs a fresh password + authenticator confirmation.</span></p>`; }
    else if (i === 18) { const r = await api("getPhase2Status", {}); const lg = await api("getLegacyReview", {}); const bt = await api("getBigTestReport", {}); root.innerHTML = `<h2>Phase 2</h2><p><strong>Finance decision:</strong> ${esc(r.financeDecision)}</p><p><strong>Providers:</strong></p><ul>${r.providers.map((p) => `<li>${esc(p.key)} — ${esc(p.status)}</li>`).join("")}</ul><p><strong>Pending owner inputs:</strong></p><ul>${r.pendingOwnerInputs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p><strong>Legacy returns (decision pending):</strong></p><ul>${lg.discrepancies.map((d) => `<li>${esc(d.returnNumber)} — ${esc(d.fault)}. Offered: ${esc(d.offeredCorrection)}</li>`).join("")}</ul><p><strong>Big Test journey:</strong> ${bt.hasReport ? esc(JSON.stringify(bt.report).slice(0, 400)) : "no report stored"}</p>`; }
    else if (i === 19) { loadAdminAudit(0, ""); }
  } catch (e) { root.innerHTML = "<p>Failed to load " + esc(ADMIN_TABS[i]) + ": " + esc(e.message || e) + "</p><p><button class=\"btn\" onclick=\"adminTab(" + i + ")\">Retry</button></p>"; }
}
// D10/D11: admin Orders — server-side search/filter + paging (10/page).
let adminOrdersState = { offset: 0, search: "", status: "" };
async function loadAdminOrders(offset, search, status) {
  if (search === undefined) search = adminOrdersState.search;
  if (status === undefined) status = adminOrdersState.status;
  adminOrdersState = { offset, search, status };
  const root = document.getElementById("adminRoot"); if (!root) return;
  root.innerHTML = "<p>Loading Orders…</p>";
  const r = await api("listOrders", { limit: 10, offset, search: search || undefined, status: status || undefined });
  if (!r.ok) { root.innerHTML = "<p>" + esc(r.error || "Denied.") + "</p>"; return; }
  const total = r.total || 0, limit = r.limit || 10;
  const statuses = ["", "Pending", "Confirmed", "Payment Confirmed", "Processing", "Packed", "Ready for Dispatch", "Shipped", "In Transit", "Arrived at Sorting Facility", "Arrived in Destination City", "Out for Delivery", "Delivered", "Cancelled"];
  root.innerHTML = `<h2>Orders (${total})</h2><p class="note">Tracking manager lives here too (12-step validated — free-text statuses are rejected). Advance moves an order one step forward; Details shows items, payment and tracking events.</p>
<form onsubmit="return doAdminOrderSearch(event)"><label>Search <input id="aoSearch" value="${esc(search)}" placeholder="Order no, email or name"></label><label>Status <select id="aoStatus">${statuses.map((x) => `<option value="${esc(x)}" ${x === status ? "selected" : ""}>${x || "All statuses"}</option>`).join("")}</select></label><button class="btn small">Search</button></form>
<div id="orderDetail"></div><div class="tablewrap"><table><tr><th>Order</th><th>Status</th><th>Total</th><th>Payment</th><th>Legacy</th><th></th></tr>${(r.orders || []).map((o) => `<tr><td>${esc(o.orderNumber)}</td><td>${esc(o.status)}</td><td>${money(o.total)}</td><td>${esc(o.paymentStatus)}</td><td>${o.legacyTest ? "legacy-test" : ""}</td><td><button class="btn ghost small" onclick="showOrderDetail('${esc(o.orderNumber)}','${esc(o.trackingNumber)}')">Details</button> <button class="btn ghost small" onclick="simulateDelivery(${o.id})">Advance (Demo)</button></td></tr>`).join("")}</table></div>
<p>${offset > 0 ? `<button class="btn ghost small" onclick="loadAdminOrders(${Math.max(0, offset - limit)})">← Previous</button> ` : ""}${offset + (r.orders || []).length < total ? `<button class="btn ghost small" onclick="loadAdminOrders(${offset + limit})">Next →</button>` : ""} <span class="note">Showing ${total ? offset + 1 : 0}–${offset + (r.orders || []).length} of ${total}</span></p>`;
}
function doAdminOrderSearch(e) { e.preventDefault(); loadAdminOrders(0, document.getElementById("aoSearch").value.trim(), document.getElementById("aoStatus").value); return false; }
// D11: admin Audit Log — server-side search + paging (50/page).
let adminAuditState = { offset: 0, search: "" };
async function loadAdminAudit(offset, search) {
  if (search === undefined) search = adminAuditState.search;
  adminAuditState = { offset, search };
  const root = document.getElementById("adminRoot"); if (!root) return;
  root.innerHTML = "<p>Loading Audit Log…</p>";
  const r = await api("listAudit", { limit: 50, offset, search: search || undefined });
  if (!r.ok) { root.innerHTML = "<p>" + esc(r.error || "Denied.") + "</p>"; return; }
  const total = r.total || 0, limit = r.limit || 50;
  root.innerHTML = `<h2>Audit Log (${total})</h2><form onsubmit="return doAdminAuditSearch(event)"><label>Search <input id="aaSearch" value="${esc(search)}" placeholder="Action, actor or detail"></label><button class="btn small">Search</button></form><div class="tablewrap"><table><tr><th>#</th><th>Action</th><th>Actor</th><th>Detail</th></tr>${(r.logs || []).map((l) => `<tr><td>${l.id}</td><td>${esc(l.action)}</td><td>${esc(l.actor)}</td><td>${esc(l.detail)}</td></tr>`).join("")}</table></div><p>${offset > 0 ? `<button class="btn ghost small" onclick="loadAdminAudit(${Math.max(0, offset - limit)})">← Previous</button> ` : ""}${offset + (r.logs || []).length < total ? `<button class="btn ghost small" onclick="loadAdminAudit(${offset + limit})">Next →</button>` : ""} <span class="note">Showing ${total ? offset + 1 : 0}–${offset + (r.logs || []).length} of ${total}</span></p>`;
}
function doAdminAuditSearch(e) { e.preventDefault(); loadAdminAudit(0, document.getElementById("aaSearch").value.trim()); return false; }
// D13: backup export (download) + restore (Owner-only, re-auth, type RESTORE).
async function doExportBackup() {
  const r = await reauthAndRetry("exportBackup", {});
  if (!r.ok) { alert(r.error || "Backup failed."); return; }
  const blob = new Blob([JSON.stringify(r.backup, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "nexora-backup-" + String(r.backup.exportedAt || "now").slice(0, 10) + ".json"; a.click();
  showToast("Backup downloaded.");
}
async function doRestoreBackup(e) {
  e.preventDefault();
  const file = document.getElementById("bkFile").files[0];
  if (!file) return false;
  const confirmWord = document.getElementById("bkConfirm").value.trim();
  let snapshot;
  try { snapshot = JSON.parse(await file.text()); } catch { alert("That file is not valid backup JSON."); return false; }
  const msg = document.getElementById("bkMsg");
  if (msg) msg.textContent = "Restoring — a fresh backup is taken first…";
  const r = await reauthAndRetry("restoreBackup", { snapshot, confirm: confirmWord });
  if (msg) msg.textContent = r.ok ? "Restore complete. Pre-restore backup saved as settings key backupSnapshotAuto." : (r.error || "Restore failed.");
  if (!r.ok) alert(r.error || "Restore failed.");
  return false;
}
async function exportCsv() {
  const r = await api("listOrders", { limit: 100 });
  const csv = "orderNumber,status,total,paymentStatus,customerEmail\n" + (r.orders || []).map((o) => [o.orderNumber, o.status, o.total, o.paymentStatus, o.customerEmail].join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "nexora-orders.csv"; a.click();
}

// ---- Page auto-init (A5) ----
// Pages no longer embed inline init calls: the init runs here, after app.js
// has loaded, so loadCart/loadCheckout/loadAccount/adminTab are always
// defined. Works whether this script loads at end of body or deferred in
// <head>; no page depends on script order anymore.
function initPage() {
  refreshCompareCount();
  // D3: /compare with no ids replays the stored selection.
  if (location.pathname === "/compare" && !new URLSearchParams(location.search).get("ids")) {
    const ids = getCompareIds();
    if (ids.length) { location.replace("/compare?ids=" + ids.join(",")); return; }
  }
  if (document.getElementById("cartRoot")) { loadCart(); return; }
  if (document.getElementById("wishlistRoot")) { loadWishlist(); return; }
  const co = document.getElementById("checkoutRoot");
  if (co) { loadCheckout(Number(co.dataset.step || 1)); return; }
  if (document.getElementById("accountRoot")) { loadAccount(); return; }
  if (document.getElementById("adminRoot")) { initAdmin(); return; }
  if (document.getElementById("ownerSetupRoot")) { loadOwnerSetup(); return; }
  if (document.getElementById("staffSetupRoot")) { loadStaffSetup(); return; }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPage);
else initPage();

// ---- Staff sign-in / admin gating (Phase 2) ----
// /admin shows NO data until a staff member signs in (email + password +
// authenticator code). The session is an HttpOnly cookie; the client never
// holds or asserts a role.
let staffSession = null;
async function initAdmin() {
  const root = document.getElementById("adminRoot");
  const tabs = document.getElementById("adminTabs");
  let r;
  try { r = await api("getStaffSession", {}, { timeoutMs: 15000 }); } catch (e) { root.innerHTML = loadErrorHtml("Network error: " + (e.message || e), "initAdmin()"); return; }
  if (!r.authenticated) {
    staffSession = null;
    if (tabs) tabs.style.display = "none";
    root.innerHTML = `<h2>Staff Sign In</h2><p class="note">Admin access needs a staff account — email, password and authenticator code. First time? The owner sets up his account at <a href="/admin/setup">Owner Setup</a>; other staff use the setup token the owner sent them at <a href="/staff/setup">Staff Setup</a>.</p>
<form onsubmit="return doStaffLogin(event)"><label>Email <input id="sEmail" type="email" required></label>
<label>Password <span class="pw"><input id="sPass" type="password" required><button type="button" onclick="togglePw('sPass',this)">👁️</button></span></label>
<div id="staffTotpBox"></div><p id="staffLoginMsg"></p><button class="btn">Sign In</button></form>`;
    return;
  }
  staffSession = r.staff;
  if (tabs) tabs.style.display = "";
  renderStaffBar(r.staff);
  adminTab(0);
}
function renderStaffBar(st) {
  const bar = document.getElementById("staffBar"); if (!bar) return;
  bar.innerHTML = `<p>Signed in as <strong>${esc(st.name)}</strong> (${esc(st.email)} · ${esc(st.role)}) ${st.totpEnabled ? "· Authenticator on" : "· Authenticator OFF"}
<button class="btn ghost small" onclick="staffChangePassword()">Change Password</button>
<button class="btn ghost small" onclick="staffSignOutEverywhere()">Sign Out Everywhere</button>
<button class="btn ghost small" onclick="staffSignOut()">Sign Out</button></p>`;
}
async function doStaffLogin(e) {
  e.preventDefault();
  const msg = document.getElementById("staffLoginMsg");
  const email = document.getElementById("sEmail").value, password = document.getElementById("sPass").value;
  const codeEl = document.getElementById("sTotp");
  const r = await api("loginStaff", { email, password, totpCode: codeEl ? codeEl.value : undefined });
  if (r.ok) { location.reload(); return false; }
  if (r.totpRequired) {
    document.getElementById("staffTotpBox").innerHTML = `<label>Authenticator code <input id="sTotp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="6-digit code"></label>`;
    msg.textContent = "Enter the 6-digit code from your authenticator app, then Sign In again.";
    return false;
  }
  if (r.totpSetupRequired) {
    document.getElementById("staffTotpBox").innerHTML = `<div class="card"><p><strong>Authenticator setup required.</strong> Add this key to your authenticator app (Google/Microsoft Authenticator → add account → enter setup key manually):</p>
<p>Secret: <code>${esc(r.totpSecretDisplay)}</code> <button type="button" class="btn ghost small" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(r.totpSecret)}')">Copy secret</button></p>
<p>Or open this link on your phone: <code>${esc(r.otpauthUrl)}</code></p>
<label>Authenticator code <input id="sTotp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="6-digit code"></label></div>`;
    msg.textContent = "After adding the key, enter the 6-digit code and Sign In — this also verifies your enrolment.";
    // Swap the submit to the enrolment endpoint for this attempt.
    const form = document.querySelector("#adminRoot form");
    if (form) form.onsubmit = (ev) => doStaffTotpVerify(ev, email, password);
    return false;
  }
  msg.textContent = r.error || "Sign-in failed.";
  return false;
}
async function doStaffTotpVerify(e, email, password) {
  e.preventDefault();
  const code = (document.getElementById("sTotp") || {}).value || "";
  const r = await api("staffTotpVerify", { email, password, totpCode: code });
  if (r.ok) { location.reload(); return false; }
  document.getElementById("staffLoginMsg").textContent = r.error || "Verification failed.";
  return false;
}
function staffSignOut() {
  if (!confirm("Sign out of Admin?")) return;
  api("logoutStaff", {}).finally(() => location.reload());
}
function staffSignOutEverywhere() {
  if (!confirm("Sign out on ALL devices (including this one)?")) return;
  api("logoutStaffEverywhere", {}).finally(() => location.reload());
}
function staffChangePassword() {
  const cur = prompt("Current password:");
  if (!cur) return;
  const nw = prompt("New password (8+ characters, letters + numbers):");
  if (!nw) return;
  const nw2 = prompt("Confirm new password:");
  if (nw !== nw2) { alert("New passwords do not match."); return; }
  api("changeStaffPassword", { currentPassword: cur, newPassword: nw, confirmNewPassword: nw2 }).then((r) => alert(r.ok ? "Password changed. Other devices were signed out." : (r.error || "Could not change password.")));
}
// Destructive admin actions need a fresh password + authenticator
// confirmation (10-minute window). Prompts for it, then retries the call once.
async function ensureReauth() {
  const pw = prompt("Confirm your password to continue:");
  if (!pw) return false;
  let code;
  if (staffSession && staffSession.totpEnabled) { code = prompt("Authenticator code (6 digits):"); if (!code) return false; }
  const r = await api("staffReauth", { password: pw, totpCode: code });
  if (!r.ok) { alert(r.error || "Confirmation failed."); return false; }
  return true;
}
async function reauthAndRetry(name, body) {
  let r = await api(name, body);
  if (r.reauthRequired) {
    if (!(await ensureReauth())) return { ok: false, error: "Not confirmed." };
    r = await api(name, body);
  }
  return r;
}

// ---- Owner setup (/admin/setup) ----
// FIX (2026-11-27): loadOwnerSetup used to call getOwnerSetupStatus with no
// try/catch, no timeout and no error UI — if that one call hung (cold start
// right after a deploy, or the single-connection pg pool busy) or threw,
// the promise rejected unhandled and the page stayed on "Loading setup
// status…" forever. Now: 15s timeout + ONE automatic retry, then a visible
// error with a Retry button (same A5 pattern as loadCart/loadCheckout).
let ownerSetupToken = "";
async function loadOwnerSetup() {
  const root = document.getElementById("ownerSetupRoot");
  if (!root) return;
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { r = await api("getOwnerSetupStatus", {}, { timeoutMs: 15000 }); break; }
    catch (e) {
      if (attempt === 1) { root.innerHTML = loadErrorHtml("Could not reach the setup service: " + (e.message || e) + " (tried twice — this can happen on a cold start; please retry.)", "loadOwnerSetup()"); return; }
    }
  }
  if (!r || typeof r.setupAvailable === "undefined") { root.innerHTML = loadErrorHtml("Setup service gave an unexpected reply. Please retry.", "loadOwnerSetup()"); return; }
  if (!r.setupAvailable) {
    root.innerHTML = `<h2>Owner setup is already complete</h2><p>The owner account is active. Sign in at <a href="/admin">Admin</a>.</p>`;
    return;
  }
  root.innerHTML = `<h2>Step 1 — Set your password</h2><p>Owner: <strong>${esc(r.ownerName)}</strong> (${esc(r.ownerEmail)})</p>
${r.hasEnvToken ? "" : `<p><strong>Not configured yet:</strong> set the Vercel env var <code>NEXORA_OWNER_SETUP_TOKEN</code> (Production) to a secret only you know, then redeploy — this page will accept it after the deploy.</p>`}
<form onsubmit="return doOwnerSetup(event)"><label>Setup token <input id="oToken" required autocomplete="off" placeholder="The token you set in Vercel"></label>
<label>New password <span class="pw"><input id="oPass" type="password" required minlength="8"><button type="button" onclick="togglePw('oPass',this)">👁️</button></span></label>
<label>Confirm password <input id="oPass2" type="password" required minlength="8"></label>
<p class="note">Password: 8+ characters with letters and numbers. This password is yours only — never share it in chat.</p>
<p id="oMsg"></p><button class="btn">Continue →</button></form><div id="oStep2"></div>`;
}
async function doOwnerSetup(e) {
  e.preventDefault();
  const token = document.getElementById("oToken").value;
  const p1 = document.getElementById("oPass").value, p2 = document.getElementById("oPass2").value;
  if (p1 !== p2) { document.getElementById("oMsg").textContent = "Passwords do not match."; return false; }
  let r;
  try { r = await api("ownerSetup", { setupToken: token, password: p1, confirmPassword: p2 }, { timeoutMs: 20000 }); }
  catch (err) { document.getElementById("oMsg").textContent = "Network error: " + (err.message || err) + " — please try again."; return false; }
  if (!r.ok) { document.getElementById("oMsg").textContent = r.error || "Setup failed."; return false; }
  ownerSetupToken = token;
  document.getElementById("oStep2").innerHTML = `<h2>Step 2 — Authenticator app</h2>
<p>Add this key to your authenticator app (Google/Microsoft Authenticator → add account → enter setup key manually):</p>
<p>Secret: <code>${esc(r.totpSecretDisplay)}</code> <button type="button" class="btn ghost small" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(r.totpSecret)}')">Copy secret</button></p>
<p>Or open this link on your phone: <code>${esc(r.otpauthUrl)}</code></p>
<form onsubmit="return doOwnerSetupVerify(event)"><label>6-digit code from the app <input id="oCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="123456"></label>
<p id="oMsg2"></p><button class="btn">Finish Setup — Sign Me In</button></form>`;
  return false;
}
async function doOwnerSetupVerify(e) {
  e.preventDefault();
  let r;
  try { r = await api("ownerSetupVerify", { setupToken: ownerSetupToken, totpCode: document.getElementById("oCode").value }, { timeoutMs: 20000 }); }
  catch (err) { document.getElementById("oMsg2").textContent = "Network error: " + (err.message || err) + " — please try again."; return false; }
  if (!r.ok) { document.getElementById("oMsg2").textContent = r.error || "Verification failed."; return false; }
  location.href = "/admin";
  return false;
}

// ---- Staff setup (/staff/setup) ----
async function loadStaffSetup() {
  const root = document.getElementById("staffSetupRoot");
  const q = new URLSearchParams(location.search);
  const email = q.get("email") || "", token = q.get("token") || "";
  root.innerHTML = `<h2>Step 1 — Set your password</h2>
<form onsubmit="return doStaffSetup(event)"><label>Email <input id="stEmail" type="email" required value="${esc(email)}"></label>
<label>Setup token <input id="stToken" required autocomplete="off" value="${esc(token)}"></label>
<label>New password <span class="pw"><input id="stPass" type="password" required minlength="8"><button type="button" onclick="togglePw('stPass',this)">👁️</button></span></label>
<label>Confirm password <input id="stPass2" type="password" required minlength="8"></label>
<p class="note">Password: 8+ characters with letters and numbers.</p>
<p id="stMsg"></p><button class="btn">Continue →</button></form><div id="stStep2"></div>`;
}
async function doStaffSetup(e) {
  e.preventDefault();
  const email = document.getElementById("stEmail").value, token = document.getElementById("stToken").value;
  const p1 = document.getElementById("stPass").value, p2 = document.getElementById("stPass2").value;
  if (p1 !== p2) { document.getElementById("stMsg").textContent = "Passwords do not match."; return false; }
  let r;
  try { r = await api("staffSetup", { email, setupToken: token, password: p1, confirmPassword: p2 }, { timeoutMs: 20000 }); }
  catch (err) { document.getElementById("stMsg").textContent = "Network error: " + (err.message || err) + " — please try again."; return false; }
  if (!r.ok) { document.getElementById("stMsg").textContent = r.error || "Setup failed."; return false; }
  document.getElementById("stStep2").innerHTML = `<h2>Step 2 — Authenticator app</h2>
<p>Add this key to your authenticator app:</p>
<p>Secret: <code>${esc(r.totpSecretDisplay)}</code> <button type="button" class="btn ghost small" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(r.totpSecret)}')">Copy secret</button></p>
<p>Or open this link on your phone: <code>${esc(r.otpauthUrl)}</code></p>
<form onsubmit="return doStaffSetupVerify(event)"><label>6-digit code from the app <input id="stCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="123456"></label>
<p id="stMsg2"></p><button class="btn">Finish Setup — Sign Me In</button></form>`;
  return false;
}
async function doStaffSetupVerify(e) {
  e.preventDefault();
  let r;
  try { r = await api("staffSetupVerify", { email: document.getElementById("stEmail").value, setupToken: document.getElementById("stToken").value, totpCode: document.getElementById("stCode").value }, { timeoutMs: 20000 }); }
  catch (err) { document.getElementById("stMsg2").textContent = "Network error: " + (err.message || err) + " — please try again."; return false; }
  if (!r.ok) { document.getElementById("stMsg2").textContent = r.error || "Verification failed."; return false; }
  location.href = "/admin";
  return false;
}
