// Smoke test for the pure functions (no DB needed).
// Run: npm run smoke   (after npm run build)
// Exits non-zero on any failure; prints PASS/FAIL per check.
const { computeFlashRow, FLASH_POOL_SKUS } = require("../dist/lib/flash");
const { computeOrderTotals, couponDiscount, validateCouponRules } = require("../dist/lib/money");
const { isValidEmail, isValidPkMobile, normalizePkMobile } = require("../dist/lib/validation");
const { hashPassword, verifyPassword, newSessionToken, hashSessionToken } = require("../dist/lib/auth");
const { runRoleSelfTest, roleCan } = require("../dist/lib/roles");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// --- Flash rotation (spec §8) ---
const cycle0 = computeFlashRow({ poolSkus: FLASH_POOL_SKUS, rowSize: 5, rotateDays: 2, anchor: "2026-11-25", today: "2026-11-25" });
check("flash cycle 0 row", eq(cycle0.skus, ["NX2-WEA-004", "NX2-AUD-001", "NX2-BEA-001", "NX2-MEN-001", "NX2-MEN-006"]), JSON.stringify(cycle0.skus));
check("flash cycle 0 meta", cycle0.poolSize === 11 && cycle0.cycle === 0 && cycle0.nextRotationAt === "2026-11-27", JSON.stringify(cycle0));
const cycle1 = computeFlashRow({ poolSkus: FLASH_POOL_SKUS, rowSize: 5, rotateDays: 2, anchor: "2026-11-25", today: "2026-11-27" });
check("flash anchor+2d different 5", eq(cycle1.skus, ["NX2-WOM-002", "NX2-WOM-004", "NX2-PHN-002", "NX2-ACC-001", "NX2-ACC-004"]), JSON.stringify(cycle1.skus));
check("flash anchor+2d no overlap with cycle 0", cycle1.skus.every((s) => !cycle0.skus.includes(s)));
check("flash row has no repeats", new Set(cycle0.skus).size === 5 && new Set(cycle1.skus).size === 5);
const cycle2 = computeFlashRow({ poolSkus: FLASH_POOL_SKUS, rowSize: 5, rotateDays: 2, anchor: "2026-11-25", today: "2026-11-29" });
check("flash cycle 2 wraps without repeats", new Set(cycle2.skus).size === 5, JSON.stringify(cycle2.skus));

// --- Coupon math (spec §6.5) ---
check("coupon 000 on 44,999 = 2,250 off", couponDiscount({ code: "000", discountType: "percent", value: 5, minOrder: 0, status: "Active", expiresAt: "", usageLimit: 0, uses: 0, perCustomerLimit: 0 }, 44999) === 2250);
const t = computeOrderTotals({ subtotal: 44999, discount: 2250, shippingMethod: "Standard" });
check("VisionX order 44,999 − 2,250 + free shipping = 42,749", t.total === 42749 && t.shippingFee === 0, JSON.stringify(t));
const j = computeOrderTotals({ subtotal: 4748, discount: 237, shippingMethod: "Standard" });
check("journey 4,748 − 237 + 250 = 4,761", j.total === 4761 && j.shippingFee === 250, JSON.stringify(j));
check("order 100001: 8,997 free shipping", computeOrderTotals({ subtotal: 8997, discount: 0, shippingMethod: "Standard" }).total === 8997);
check("order 100002: 164,999 + 450 Express = 165,449", computeOrderTotals({ subtotal: 164999, discount: 0, shippingMethod: "Express" }).total === 165449);
check("owner order 24,698 − 1,235 + 0 = 23,463", computeOrderTotals({ subtotal: 24698, discount: 1235, shippingMethod: "Standard" }).total === 23463);
const expired = validateCouponRules({ code: "BIGTEST5", discountType: "percent", value: 5, minOrder: 0, status: "Active", expiresAt: "2026-12-25", usageLimit: 20, uses: 20, perCustomerLimit: 3 }, 5000, 0, "2026-11-26");
check("coupon usage-limit enforced", expired.ok === false, JSON.stringify(expired));
const paused = validateCouponRules({ code: "FREESHIP", discountType: "fixed", value: 250, minOrder: 1500, status: "Paused", expiresAt: "", usageLimit: 0, uses: 0, perCustomerLimit: 0 }, 5000, 0, "2026-11-26");
check("paused coupon rejected", paused.ok === false);

// --- Validation (spec §5.3/§10) ---
check("email valid", isValidEmail("saleemjan089@gmail.com") === true);
check("email invalid rejected", isValidEmail("not-an-email") === false);
check("mobile 03XXXXXXXXX accepted", isValidPkMobile("03122915779") === true);
check("mobile +92 accepted", isValidPkMobile("+92 312 2915779") === true);
check("mobile normalises +92", normalizePkMobile("+92 3122915779") === "03122915779");
check("legacy gibberish phone rejected", isValidPkMobile("000") === false && isValidPkMobile("123") === false);
check("legacy gibberish email rejected", isValidEmail("test") === false);

// --- Auth (spec §10) ---
const h = hashPassword("correct-horse-battery");
check("PBKDF2 format", h.startsWith("pbkdf2$210000$"));
check("PBKDF2 verify ok", verifyPassword("correct-horse-battery", h) === true);
check("PBKDF2 verify wrong rejected", verifyPassword("wrong-password", h) === false);
check("PBKDF2 salts differ", hashPassword("same") !== hashPassword("same"));
const sess = newSessionToken();
check("session token hashes (never stored raw)", hashSessionToken(sess.token) === sess.tokenHash && sess.token.length >= 32);

// --- Roles (spec §10) ---
const rt = runRoleSelfTest();
check("role self-test 99 checks", rt.checks.length === 99, `${rt.allowed}/${rt.denied}`);
check("role self-test 41 allowed / 58 denied", rt.allowed === 41 && rt.denied === 58, `${rt.allowed}/${rt.denied}`);
check("Warehouse Staff cannot do payments", roleCan("Warehouse Staff", "payments") === false);
check("Finance Officer can do payments", roleCan("Finance Officer", "payments") === true);
check("Super Admin can do everything", ["products", "inventory", "orders", "payments", "refunds", "shipments", "customers", "returns", "staff", "settings", "reports"].every((a) => roleCan("Super Admin", a)));

console.log(failures === 0 ? "\nSMOKE TEST: ALL PASS" : `\nSMOKE TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
