// NEXORA MARKET client JS — guest cart key + session token in localStorage.
// The token (not a bare email) is what the server uses to scope "my orders".

function guestKey() {
  let k = localStorage.getItem("nx_guest_key");
  if (!k) { k = "guest-" + Math.random().toString(36).slice(2, 10); localStorage.setItem("nx_guest_key", k); }
  return k;
}
function token() { return localStorage.getItem("nx_session_token") || ""; }
function staffRole() { return localStorage.getItem("nx_staff_role") || "Super Admin"; }
async function api(name, body, opts) {
  const headers = { "content-type": "application/json", "x-guest-key": guestKey() };
  if (token()) headers["authorization"] = "Bearer " + token();
  if (opts && opts.role) headers["x-nexora-role"] = staffRole();
  const r = await fetch("/api/" + name, { method: "POST", headers, body: JSON.stringify(body || {}) });
  return r.json();
}
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function money(n) { return "Rs. " + Number(n || 0).toLocaleString("en-PK"); }
// Display helpers: strip stored "(Demo)"/"(Demo Simulated)" labels at render
// time (live DB rows keep their stored values). Admin views keep raw values.
function dispName(s) { return String(s == null ? "" : s).replace(/ \(Demo\)$/, ""); }
function cleanDemo(s) {
  let t = String(s == null ? "" : s);
  t = t.replace("Demo Simulation — ", "").replace(" (Demo Simulated)", "").replace(" (demo simulation)", "").replace(" — demo only, no charge", "").replace(" — Demo", "").replace(" (Demo)", "");
  return t;
}

async function addToCart(id, qty) {
  const r = await api("addToCart", { productId: id, qty });
  alert(r.ok ? (r.note || "Added to cart.") : (r.error || "Could not add to cart."));
  refreshCartCount();
}
async function buyNow(id) { await addToCart(id, 1); location.href = "/checkout?step=1"; }
async function addToWishlist(id) {
  const r = await api("addToWishlist", { productId: id });
  alert(r.ok ? "Added to wishlist." : (r.error || "Could not add."));
}
function shareProduct(id, name) {
  const url = location.origin + "/product/" + id;
  if (navigator.share) navigator.share({ title: name, url }).catch(() => {});
  else { navigator.clipboard && navigator.clipboard.writeText(url); alert("Product link copied: " + url); }
}
async function refreshCartCount() {
  try { const r = await api("getCart", {}); const el = document.getElementById("cartCount"); if (el) el.textContent = (r.items || []).reduce((a, i) => a + i.qty, 0); } catch (e) {}
}
refreshCartCount();

function heroGo(i) {
  document.querySelectorAll(".slide").forEach((s, j) => s.classList.toggle("active", j === i));
}
setInterval(() => {
  const slides = document.querySelectorAll(".slide");
  if (slides.length > 1) {
    const cur = [...slides].findIndex((s) => s.classList.contains("active"));
    heroGo((cur + 1) % slides.length);
  }
}, 6000);

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
  if (r.resetToken) {
    const nt = prompt("No email provider is connected yet, so your one-time reset token is shown here (staging only, expires in 30 minutes):\n\n" + r.resetToken + "\n\nEnter a new password:");
    if (!nt) return false;
    const np = prompt("New password (6+ characters):");
    if (!np) return false;
    const r2 = await api("resetPassword", { token: r.resetToken, newPassword: np, confirmNewPassword: np });
    alert(r2.ok ? "Password set. Please sign in." : (r2.error || "Reset failed."));
  } else alert(r.note || "If an account exists, a reset was created.");
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
<label>Scheduled date <input id="coSlotDate" type="date"></label><label>Time window <select id="coSlotTime"><option>9am–12pm</option><option>12pm–3pm</option><option>3pm–6pm</option><option>6pm–9pm</option></select></label>
<label>Pickup point <select id="coPickup"><option value="">—</option><option>Karachi Central</option><option>Ghotki Store</option></select></label>
<p><button class="btn ghost" type="button" onclick="useGps()">📍 Use my device GPS (permission-based)</button> <span id="gpsOut"></span></p>
<button class="btn">Continue →</button></form>`,
    5: `<h2>Step 5 — Payment</h2><p class="note">Confirm your payment before placing a non-COD order.</p>
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
    checkoutData.paymentRef = "TXN-DEMO-" + Math.floor(10000000 + Math.random() * 89999999);
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
<p><button class="btn" onclick="simulateDelivery(${r.order.id})">Advance to Next Step</button> <a class="btn ghost" href="/track">Track Order</a> <a class="btn ghost" href="/account">My Orders</a></p></div>`;
  clearCheckoutData();
}
async function simulateDelivery(orderId) {
  const r = await api("advanceOrder", { orderId }, { role: true });
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
<p class="note">Parcel shown at the last verified event location.</p>
<p><button class="btn" onclick="simulateDelivery(${r.order.id})">Advance to Next Step</button></p></div>`;
  return false;
}

// ---- Account ----
async function loadAccount() {
  const root = document.getElementById("accountRoot"); if (!root) return;
  let r;
  try { r = await api("getCustomer", {}); } catch (e) { root.innerHTML = loadErrorHtml("Network error: " + (e.message || e), "loadAccount()"); return; }
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
<p><span class="badge">Signed in</span> <span class="badge">Email: ${c.emailVerified ? "Verified" : "Not Verified"}</span> <span class="badge">Phone: ${c.phoneVerified ? "Verified" : "Not Verified"}</span> <span class="badge">Profile ${r.profileCompletion}% complete</span> <span class="badge">🔔 ${r.unreadNotifications} unread</span></p>
<div class="statgrid">
<div class="stat"><b>${st.totalOrders}</b><span>Total Orders</span></div>
<div class="stat"><b>${st.inProgress}</b><span>Orders In Progress</span></div>
<div class="stat"><b>${st.delivered}</b><span>Delivered Orders</span></div>
<div class="stat"><b>${st.wishlistItems}</b><span>Wishlist Items</span></div></div>
<h3 style="color:#fff">Recent Orders</h3>
${recent.length ? recent.map((o) => `<p>${esc(o.orderNumber)} — ${esc(o.status)} — ${money(o.total)} <a href="/track" style="color:#fff">Track</a> <button class="btn ghost small" onclick="simulateDelivery(${o.id})">Advance to Next Step</button></p>`).join("") : "<p class='muted'>No orders yet.</p>"}
<p><a href="/account" style="color:#fff">View All →</a></p>
<h3 style="color:#fff">Quick Services</h3><div class="qgrid">
<a class="qcard" href="/shop">🛍 Shop</a><a class="qcard" href="/track">📦 Track Order</a><a class="qcard" href="/cart">🛒 Cart</a>
<a class="qcard" href="#" onclick="showReturns(event)">↩️ My Returns</a><a class="qcard" href="#" onclick="showRefunds(event)">💸 My Refunds</a><a class="qcard" href="#" onclick="showPayments(event)">💳 Payments</a>
<a class="qcard" href="#" onclick="showAddresses(event)">📍 Saved Addresses</a><a class="qcard" href="/help">💬 Help Center</a><a class="qcard" href="#" onclick="showNotifs(event)">🔔 Notifications</a></div>
<div id="acctPanel"></div>
<p class="muted">My Orders status strip — To Pay ${my.buckets?.toPay || 0} · To Ship ${my.buckets?.toShip || 0} · To Receive ${my.buckets?.toReceive || 0} · To Review ${my.buckets?.toReview || 0}</p>
</div>`;
}
function acctPanel(html) { const el = document.getElementById("acctPanel"); if (el) el.innerHTML = html; }
async function showReturns(e) { e.preventDefault(); const r = await api("listReturns", { mine: true }); acctPanel("<h3>My Returns</h3>" + (r.returns || []).map((x) => `<p>${esc(x.returnNumber)} — ${esc(dispName(x.productName))} — ${money(x.refundAmount)} — stage ${x.refundStage}: ${esc(cleanDemo(x.stageLabel))}${x.stageLabelsVerified ? "" : " (label to verify)"}</p>`).join("") || "<p>No returns.</p>"); }
async function showRefunds(e) { e.preventDefault(); const r = await api("listReturns", { mine: true }); acctPanel("<h3>My Refunds — 9-stage tracker</h3>" + (r.returns || []).map((x) => `<p>${esc(x.returnNumber)}: stage ${x.refundStage}/8 — ${esc(cleanDemo(x.stageLabel))}</p>`).join("") || "<p>No refunds in progress.</p>"); }
async function showPayments(e) { e.preventDefault(); const r = await api("listPaymentTransactions", {}); const my = await api("listMyOrders", {}); const nums = new Set((my.orders || []).map((o) => o.orderNumber)); acctPanel("<h3>Payment History</h3>" + (r.transactions || []).filter((t) => nums.has(t.orderNumber)).map((t) => `<p>${esc(t.orderNumber)} — ${esc(cleanDemo(t.method))} — ${esc(t.account || "")} — ${esc(t.reference || "")} — ${esc(cleanDemo(t.status))} — ${money(t.amount)}</p>`).join("") || "<p>No payments yet.</p>"); }
async function showAddresses(e) { e.preventDefault(); const r = await api("listAddresses", {}); acctPanel("<h3>Saved Addresses</h3>" + (r.addresses || []).map((a) => `<p><strong>${esc(a.label)}</strong> — ${esc(a.recipient)}, ${esc(a.address)}, ${esc(a.city)} ${esc(a.postalCode)} ${a.isDefault ? "(Default)" : ""}</p>`).join("") || "<p>No saved address yet.</p>"); }
async function showNotifs(e) { e.preventDefault(); const r = await api("listNotifications", {}); await api("markNotificationsRead", {}); acctPanel("<h3>Notifications</h3><p class='note'>Opening notifications marks them all read.</p>" + (r.notifications || []).slice(0, 10).map((n) => `<p><strong>${esc(n.title)}</strong> — ${esc(n.body)}</p>`).join("")); }
function changeName(e) { e.preventDefault(); const n = prompt("New name:"); if (!n) return; api("updateCustomerProfile", { name: n }).then(() => loadAccount()); }
function changeAddress(e) { e.preventDefault(); showAddresses(e); }
function changePayment(e) { e.preventDefault(); showPayments(e); }
function changePassword(e) {
  e.preventDefault();
  acctPanel(`<h3>Security — Change Password</h3><form onsubmit="return doChangePassword(event)">
<label>Current password <span class="pw"><input id="cpCur" type="password" required><button type="button" onclick="togglePw('cpCur',this)">👁️</button></span></label>
<label>New password <span class="pw"><input id="cpNew" type="password" required minlength="6"><button type="button" onclick="togglePw('cpNew',this)">👁️</button></span></label>
<label>Confirm new password <input id="cpNew2" type="password" required minlength="6"></label>
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
function notifPrefs(e) { e.preventDefault(); alert("Notification preferences: order updates and support replies are on."); }
function privacySec(e) { e.preventDefault(); if (confirm("Request account deletion? This only records the request — the owner reviews it first.")) api("requestAccountDeletion", {}).then((r) => alert(r.note || "Requested.")); }

// ---- Admin ----
const ADMIN_TABS = ["Dashboard", "Products", "Categories", "Inventory", "Orders", "Payments", "Returns / Refunds", "Customers", "Support", "Reviews", "Notifications", "Coupons", "Staff & Permissions", "Reports", "Settings", "Homepage", "Demo Merchants", "Demo Manager", "Phase 2", "Audit Log"];
async function adminTab(i, btn) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("on"));
  if (btn) btn.classList.add("on");
  const root = document.getElementById("adminRoot"); if (!root) return;
  root.innerHTML = "<p>Loading " + esc(ADMIN_TABS[i]) + "…</p>";
  try {
    if (i === 0) { const r = await api("getAnalytics", {}, { role: true }); const b = await api("getBootstrap", {}, { role: true }); root.innerHTML = `<h2>Dashboard</h2><p>Published products: <strong>${b.publishedProductCount}</strong> · Orders: ${b.orderCount} (legacy-test: ${b.legacyTestOrderCount}) · GMV (real records only): <strong>${money(r.gmv)}</strong> · Avg order: ${money(r.avgOrderValue)} · Refunds requested ${money(r.refundsRequested)} · Refunds completed ${money(r.refundsTotal)}</p><p>Daily sales (Asia/Karachi, zero days = 0): ${r.dailySales.map((d) => d.day.slice(0, 3) + " " + money(d.total)).join(" · ")}</p><p>By status: ${Object.entries(r.byStatus).map(([k, v]) => k + " " + v).join(", ")}</p>`; }
    else if (i === 1) { const r = await api("listProducts", { limit: 100 }); root.innerHTML = `<h2>Products (${r.total})</h2><div class="tablewrap"><table><tr><th>SKU</th><th>Name</th><th>Price</th><th>Sale</th><th>Stock</th><th>Flash</th><th>Status</th></tr>${r.products.map((p) => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}${p.imageIsSample ? " • Sample" : ""}</td><td>${money(p.price)}</td><td>${p.salePrice ? money(p.salePrice) : "—"}</td><td>${p.stock}</td><td>${p.isFlash ? "✓" : ""}</td><td>${esc(p.status)}</td></tr>`).join("")}</table></div><p class="note">Product Photos manager: every product carries one sample photo ("• Sample" tag). Uploads replace samples via uploadProductImage; the sample seeder never overwrites a product that already has any photo.</p>`; }
    else if (i === 2) { const r = await api("listCategories", {}); root.innerHTML = `<h2>Categories (${r.categories.length})</h2><p>9 active top categories + 99 active subcategories + 6 deactivated legacy top categories.</p><div class="tablewrap"><table><tr><th>Name</th><th>Parent</th><th>Active</th><th>Products</th></tr>${r.categories.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.parent || "—")}</td><td>${c.active ? "✓" : "✗"}</td><td>${c.productCount}</td></tr>`).join("")}</table></div>`; }
    else if (i === 3) { const r = await api("listInventoryMovements", {}, { role: true }); root.innerHTML = `<h2>Inventory ledger (${r.movements.length})</h2><div class="tablewrap"><table><tr><th>SKU</th><th>Type</th><th>Qty</th><th>Balance</th><th>Reference</th></tr>${r.movements.map((m) => `<tr><td>${esc(m.sku)}</td><td>${esc(m.type)}</td><td>${m.qty}</td><td>${m.balanceAfter}</td><td>${esc(m.reference)}</td></tr>`).join("")}</table></div>`; }
    else if (i === 4) { const r = await api("listOrders", {}, { role: true }); if (!r.ok) { root.innerHTML = "<p>" + esc(r.error || "Denied.") + "</p>"; return; } root.innerHTML = `<h2>Orders (${r.orders.length})</h2><p class="note">Tracking manager lives here too (12-step validated — free-text statuses are rejected).</p><div class="tablewrap"><table><tr><th>Order</th><th>Status</th><th>Total</th><th>Payment</th><th>Legacy</th><th></th></tr>${r.orders.map((o) => `<tr><td>${esc(o.orderNumber)}</td><td>${esc(o.status)}</td><td>${money(o.total)}</td><td>${esc(o.paymentStatus)}</td><td>${o.legacyTest ? "legacy-test" : ""}</td><td><button class="btn ghost small" onclick="simulateDelivery(${o.id})">Advance (Demo)</button></td></tr>`).join("")}</table></div>`; }
    else if (i === 5) { const r = await api("listPaymentTransactions", {}, { role: true }); root.innerHTML = `<h2>Payments — ledger (${r.transactions.length})</h2><p class="note">Demo Simulation — no gateway connected. Bank transfers start "Awaiting Verification (Demo)".</p><div class="tablewrap"><table><tr><th>Order</th><th>Method</th><th>Account</th><th>Ref</th><th>Amount</th><th>Status</th></tr>${r.transactions.map((t) => `<tr><td>${esc(t.orderNumber)}</td><td>${esc(t.method)}</td><td>${esc(t.account)}</td><td>${esc(t.reference)}</td><td>${money(t.amount)}</td><td>${esc(t.status)}</td></tr>`).join("")}</table></div>`; }
    else if (i === 6) { const r = await api("listReturns", {}, { role: true }); root.innerHTML = `<h2>Returns / Refunds (${r.returns.length})</h2><p class="note">9-stage tracker (cap 8, restock at stage 4). Stage labels 1–7 are working labels, to verify against the Muse copy's returns UI.</p><div class="tablewrap"><table><tr><th>Return</th><th>Order</th><th>Product</th><th>Refund</th><th>Stage</th><th>Status</th></tr>${r.returns.map((x) => `<tr><td>${esc(x.returnNumber)}</td><td>${esc(x.orderNumber)}</td><td>${esc(x.productName)}</td><td>${money(x.refundAmount)}</td><td>${x.refundStage} — ${esc(x.stageLabel)}</td><td>${esc(x.status)}</td></tr>`).join("")}</table></div>`; }
    else if (i === 7) { const r = await api("listRegisteredCustomers", {}, { role: true }); root.innerHTML = `<h2>Registered customers</h2><div class="tablewrap"><table><tr><th>Name</th><th>Email</th><th>Phone</th><th>Verified</th><th>Password</th></tr>${(r.customers || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td><td>${c.emailVerified ? "Email ✓" : "Email ✗"} / ${c.phoneVerified ? "Phone ✓" : "Phone ✗"}</td><td>${c.mustResetPassword ? "No password yet — reset flow" : "PBKDF2"}</td></tr>`).join("")}</table></div>`; }
    else if (i === 8) { const r = await api("listTickets", {}, { role: true }); root.innerHTML = `<h2>Support tickets</h2><div class="tablewrap"><table><tr><th>Ticket</th><th>Subject</th><th>Status</th><th>Agent</th><th>Last reply</th></tr>${r.tickets.map((t) => `<tr><td>${esc(t.ticketNumber)}</td><td>${esc(t.subject)}</td><td>${esc(t.status)}</td><td>${esc(t.agent)}</td><td>${esc(t.lastReply || "—")}</td></tr>`).join("")}</table></div>`; }
    else if (i === 9) { const r = await api("listReviews", {}, { role: true }); root.innerHTML = `<h2>Reviews (${r.reviews.length})</h2>` + r.reviews.map((x) => `<p><strong>${esc(x.productName)}</strong> ${"★".repeat(x.rating)} — ${esc(x.text)} <small>(${esc(x.customerName)})</small></p>`).join(""); }
    else if (i === 10) { const r = await api("listNotifications", {}); root.innerHTML = `<h2>Notifications (${r.notifications.length}, ${r.unread} unread)</h2>` + r.notifications.slice(0, 15).map((n) => `<p><strong>${esc(n.title)}</strong> — ${esc(n.body)} ${n.isRead ? "" : "(unread)"}</p>`).join(""); }
    else if (i === 11) { const r = await api("getBootstrap", {}, { role: true }); root.innerHTML = `<h2>Coupons / Promotions</h2><div class="tablewrap"><table><tr><th>Code</th><th>Type</th><th>Value</th><th>Min</th><th>Status</th><th>Expires</th><th>Limit</th><th>Uses</th></tr>${r.coupons.map((c) => `<tr><td>${esc(c.code)}</td><td>${esc(c.discountType)}</td><td>${c.value}${c.discountType === "percent" ? "%" : ""}</td><td>${money(c.minOrder)}</td><td>${esc(c.status)}</td><td>${esc(c.expiresAt || "— (unbounded)")}</td><td>${c.usageLimit || "unbounded"}</td><td>${c.uses}</td></tr>`).join("")}</table></div><p class="note">Production expiry/limit values for 000 / WELCOME10 / FLASH500 are owner inputs — deliberately not invented. BIGTEST5 is a temporary test coupon (expires 2026-12-25, limit 20, per-customer 3).</p>`; }
    else if (i === 12) { const r = await api("listStaff", {}, { role: true }); const m = await api("getRoleMatrix", {}); const t = await api("runRoleSelfTest", {}, { role: true }); root.innerHTML = `<h2>Staff &amp; Permissions</h2><div class="tablewrap"><table><tr><th>Name</th><th>Role</th><th>Department</th><th>Email</th></tr>${r.staff.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.role)}</td><td>${esc(x.department)}</td><td>${esc(x.email)}</td></tr>`).join("")}</table></div><p>Role self-test: <strong>${t.allowed} allowed / ${t.denied} denied</strong> (99 checks; sandbox reference 41/58). Live probes: ${t.liveDenied.join("; ")}; ${t.liveAllowed.join("; ")}.</p><p class="note">Matrix: ${m.roles.map((x) => esc(x.role) + " → " + x.permissions.join(", ")).join(" | ")}</p>`; }
    else if (i === 13) { const r = await api("getAnalytics", {}, { role: true }); root.innerHTML = `<h2>Reports / Analytics</h2><p>GMV ${money(r.gmv)} · Avg order ${money(r.avgOrderValue)} · Legacy orders excluded: ${r.legacyOrders}</p><p>CSV export: <button class="btn ghost small" onclick="exportCsv()">Download orders CSV</button></p>`; }
    else if (i === 14) { const r = await api("getBootstrap", {}, { role: true }); root.innerHTML = `<h2>Settings</h2><pre>${esc(JSON.stringify(r.config, null, 2))}</pre><p class="note">Brand: NEXORA MARKET — navy #101828, blue #315EFB, amber #F59E0B. Demo mode ON.</p>`; }
    else if (i === 15) { const r = await api("getHomepageAdmin", {}, { role: true }); root.innerHTML = `<h2>Homepage</h2><p>Flash row: size ${r.flashRowSize} (4–5), new set every ${r.flashRotateDays} day(s), anchor ${r.flashRowAnchor}. Campaign end: ${esc(r.flashEndsAt || "not set — no countdown")}</p><p>Banners: ${r.banners.map((b) => esc(b.headline)).join(" · ")}</p><p>Collections: ${r.collections.map((c) => esc(c.name)).join(" · ")}</p><p>Sections: ${r.sections.map((s) => esc(s.key) + (s.visible ? "" : " (hidden)")).join(", ")}</p>`; }
    else if (i === 16) { const r = await api("listDemoMerchants", {}); root.innerHTML = `<h2>Demo Merchants (display only)</h2>` + r.merchants.map((m) => `<p><strong>${esc(m.storeName)}</strong> — ${esc(m.city)} · ★ ${m.rating} · ${esc(m.verification)}</p>`).join(""); }
    else if (i === 17) { root.innerHTML = `<h2>Demo Manager / Reset</h2><p><strong>Browser seeding was removed in Phase 1 (A4).</strong> No public endpoint can reseed or wipe the database anymore — seeding is CLI-only (<code>npm run db:seed</code>, idempotent) or via boot migration on deploy.</p><p><button class="btn ghost" onclick="api('cleanupInvalidReturns',{}, {role:true}).then(r=>alert(r.ok?('Removed '+r.removed+' invalid returns. Legacy-flagged rows preserved.'):(r.error||'Failed')))">Clean up invalid returns</button></p>`; }
    else if (i === 18) { const r = await api("getPhase2Status", {}, { role: true }); const lg = await api("getLegacyReview", {}, { role: true }); const bt = await api("getBigTestReport", {}, { role: true }); root.innerHTML = `<h2>Phase 2</h2><p><strong>Finance decision:</strong> ${esc(r.financeDecision)}</p><p><strong>Providers:</strong></p><ul>${r.providers.map((p) => `<li>${esc(p.key)} — ${esc(p.status)}</li>`).join("")}</ul><p><strong>Pending owner inputs:</strong></p><ul>${r.pendingOwnerInputs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p><strong>Legacy returns (decision pending):</strong></p><ul>${lg.discrepancies.map((d) => `<li>${esc(d.returnNumber)} — ${esc(d.fault)}. Offered: ${esc(d.offeredCorrection)}</li>`).join("")}</ul><p><strong>Big Test journey:</strong> ${bt.hasReport ? esc(JSON.stringify(bt.report).slice(0, 400)) : "no report stored"}</p>`; }
    else if (i === 19) { const r = await api("listAudit", {}, { role: true }); root.innerHTML = `<h2>Audit Log (${r.logs.length})</h2><div class="tablewrap"><table><tr><th>#</th><th>Action</th><th>Actor</th><th>Detail</th></tr>${r.logs.slice(0, 50).map((l) => `<tr><td>${l.id}</td><td>${esc(l.action)}</td><td>${esc(l.actor)}</td><td>${esc(l.detail)}</td></tr>`).join("")}</table></div>`; }
  } catch (e) { root.innerHTML = "<p>Failed to load " + esc(ADMIN_TABS[i]) + ": " + esc(e.message || e) + "</p><p><button class=\"btn\" onclick=\"adminTab(" + i + ")\">Retry</button></p>"; }
}
async function exportCsv() {
  const r = await api("listOrders", {}, { role: true });
  const csv = "orderNumber,status,total,paymentStatus,customerEmail\n" + (r.orders || []).map((o) => [o.orderNumber, o.status, o.total, o.paymentStatus, o.customerEmail].join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "nexora-orders.csv"; a.click();
}

// ---- Page auto-init (A5) ----
// Pages no longer embed inline init calls: the init runs here, after app.js
// has loaded, so loadCart/loadCheckout/loadAccount/adminTab are always
// defined. Works whether this script loads at end of body or deferred in
// <head>; no page depends on script order anymore.
function initPage() {
  if (document.getElementById("cartRoot")) { loadCart(); return; }
  const co = document.getElementById("checkoutRoot");
  if (co) { loadCheckout(Number(co.dataset.step || 1)); return; }
  if (document.getElementById("accountRoot")) { loadAccount(); return; }
  if (document.getElementById("adminRoot")) {
    const sel = document.getElementById("staffRole");
    if (sel) sel.value = localStorage.getItem("nx_staff_role") || "Super Admin";
    adminTab(0);
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPage);
else initPage();
