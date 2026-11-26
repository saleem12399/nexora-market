// Money math — integer PKR everywhere. Server recomputes all totals;
// the client never dictates a total (REBUILD-SPEC.md §9).

export const STANDARD_SHIPPING_FEE = 250;
export const EXPRESS_SHIPPING_FEE = 450;
export const SCHEDULED_SHIPPING_FEE = 450;
export const PICKUP_SHIPPING_FEE = 0;
export const FREE_SHIPPING_THRESHOLD = 5000;
export const TAX = 0;

export type ShippingMethod = "Standard" | "Express" | "Scheduled" | "Pickup";

export function shippingFeeFor(method: ShippingMethod, afterDiscountSubtotal: number): number {
  if (method === "Pickup") return 0;
  if (method === "Express" || method === "Scheduled") return 450;
  // Standard: free at Rs. 5,000+ after discount
  return afterDiscountSubtotal >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING_FEE;
}

export interface CouponLike {
  code: string;
  discountType: "percent" | "fixed";
  value: number;
  minOrder: number;
  status: string;
  expiresAt: string;
  usageLimit: number;
  uses: number;
  perCustomerLimit: number;
}

/** Discount in whole PKR. Percent discounts round to the nearest rupee. */
export function couponDiscount(coupon: CouponLike, subtotal: number): number {
  if (coupon.discountType === "percent") return Math.round((subtotal * coupon.value) / 100);
  return Math.min(coupon.value, subtotal);
}

export function validateCouponRules(
  coupon: CouponLike | null,
  subtotal: number,
  customerUses: number,
  todayYmd: string,
): { ok: boolean; error?: string; discount?: number } {
  if (!coupon) return { ok: false, error: "Coupon not found." };
  if (coupon.status !== "Active") return { ok: false, error: "This coupon is not active." };
  if (subtotal < coupon.minOrder) {
    return { ok: false, error: `This coupon needs a minimum order of Rs. ${coupon.minOrder}.` };
  }
  if (coupon.expiresAt && todayYmd > coupon.expiresAt) {
    return { ok: false, error: "This coupon has expired." };
  }
  if (coupon.usageLimit > 0 && coupon.uses >= coupon.usageLimit) {
    return { ok: false, error: "This coupon has reached its usage limit." };
  }
  if (coupon.perCustomerLimit > 0 && customerUses >= coupon.perCustomerLimit) {
    return { ok: false, error: "You have already used this coupon the maximum number of times." };
  }
  return { ok: true, discount: couponDiscount(coupon, subtotal) };
}

export function computeOrderTotals(input: {
  subtotal: number;
  discount: number;
  shippingMethod: ShippingMethod;
}): { subtotal: number; discount: number; shippingFee: number; tax: number; total: number } {
  const afterDiscount = Math.max(0, input.subtotal - input.discount);
  const shippingFee = shippingFeeFor(input.shippingMethod, afterDiscount);
  return {
    subtotal: input.subtotal,
    discount: input.discount,
    shippingFee,
    tax: TAX,
    total: afterDiscount + shippingFee + TAX,
  };
}

/** Effective (sale) price of a product row. */
export function effectivePrice(price: number, salePrice: number | null): number {
  return salePrice != null && salePrice < price ? salePrice : price;
}

export function discountPercent(price: number, salePrice: number | null): number {
  if (salePrice == null || salePrice >= price) return 0;
  return Math.round(((price - salePrice) / price) * 100);
}

export function formatPkr(n: number): string {
  return `Rs. ${Number(n || 0).toLocaleString("en-PK")}`;
}
