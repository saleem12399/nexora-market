// Shared constants — verbatim from REBUILD-SPEC.md / DATA-PLAN.md.
// Do not rename, reorder or merge these lists.

export const TRACKING_STEPS = [
  "Pending",
  "Confirmed",
  "Payment Confirmed",
  "Processing",
  "Packed",
  "Ready for Dispatch",
  "Shipped",
  "In Transit",
  "Arrived at Sorting Facility",
  "Arrived in Destination City",
  "Out for Delivery",
  "Delivered",
] as const;

/** Step-specific simulated tracking event notes (Muse copy wording). */
export const TRACKING_STEP_NOTES: Record<string, string> = {
  Pending: "Order placed (demo simulation).",
  Confirmed: "NEXORA confirmed your order (demo simulation).",
  "Payment Confirmed": "Payment confirmed, or Cash on Delivery selected (demo simulation).",
  Processing: "Order is being prepared by warehouse staff (demo simulation).",
  Packed: "Order packed and labelled (demo simulation).",
  "Ready for Dispatch": "Parcel is ready and waiting for courier pickup (demo simulation).",
  Shipped: "Parcel handed to NEXORA Express (Demo) — simulated shipment, no courier API connected.",
  "In Transit": "Parcel is in transit (demo simulation).",
  "Arrived at Sorting Facility": "Parcel arrived at the sorting facility (demo simulation).",
  "Arrived in Destination City": "Parcel arrived in the destination city (demo simulation).",
  "Out for Delivery": "Parcel is out for delivery (demo simulation).",
  Delivered: "Delivered by NEXORA Express (Demo) (demo simulation).",
};

export const TRACKING_STEP_LOCATIONS: Record<string, string> = {
  Pending: "NEXORA Karachi Central (Demo)",
  Confirmed: "NEXORA Head Office (Demo)",
  "Payment Confirmed": "NEXORA Finance (Demo)",
  Processing: "NEXORA Warehouse (Demo)",
  Packed: "NEXORA Warehouse (Demo)",
  "Ready for Dispatch": "NEXORA Warehouse (Demo)",
  Shipped: "NEXORA Karachi Central (Demo)",
  "In Transit": "NEXORA Express (Demo)",
  "Arrived at Sorting Facility": "NEXORA Sorting Facility (Demo)",
  "Arrived in Destination City": "NEXORA Destination Hub (Demo)",
  "Out for Delivery": "NEXORA Express (Demo)",
  Delivered: "Delivered (Demo)",
};

/**
 * Refund stages 0-8. Stage 0 = Requested, stage 8 = Refunded (Demo) and
 * restock happens at stage 4 — those are sourced. Labels for stages 1-7 are
 * NOT in any source (REBUILD-SPEC.md §14.1): the labels below are honest
 * working labels derived from the 9-stage tracker behaviour and are marked
 * "to verify against the Muse copy's returns UI" in the README and
 * BUILD-REPORT.md. Do not present them as sourced.
 */
export const REFUND_STAGES = [
  { stage: 0, label: "Requested", verified: true },
  { stage: 1, label: "Under Review", verified: false },
  { stage: 2, label: "Approved", verified: true }, // RET-DEMO-001 is Approved at stage 2 (sourced)
  { stage: 3, label: "Pickup Scheduled", verified: false },
  { stage: 4, label: "Item Received — Restocked", verified: false }, // restock at stage 4 (sourced)
  { stage: 5, label: "Refund Processing", verified: false },
  { stage: 6, label: "Refund Approved", verified: false },
  { stage: 7, label: "Refund Sent", verified: false },
  { stage: 8, label: "Refunded (Demo)", verified: true },
] as const;

export const REFUND_STAGE_LABELS: string[] = REFUND_STAGES.map((s) => s.label);

/**
 * Payment statuses. Only 5 distinct values appear in the live export
 * (REBUILD-SPEC.md §14.9); the brief promises 10. These are the 5 sourced
 * ones. The remaining 5 are OPEN — verify against the Muse copy's
 * updatePaymentStatus during acceptance; do not invent them.
 */
export const PAYMENT_STATUSES_SOURCED = [
  "Paid (Demo Simulated)",
  "Pending (COD)",
  "Paid (COD Collected — Demo)",
  "Refund Pending (Demo)",
  "Awaiting Verification (Demo)",
] as const;

export const PAYMENT_METHODS = [
  "JazzCash (Demo)",
  "Easypaisa (Demo)",
  "Debit Card (Demo)",
  "Bank Transfer (Demo)",
  "Cash on Delivery",
  "Digital Wallet (Demo)",
] as const;

export const CHECKOUT_STEPS = [
  "Cart Review",
  "Customer Info",
  "Delivery Address",
  "Shipping",
  "Payment",
  "Summary",
  "Confirm",
] as const;

export const ROLE_AREAS = [
  "products",
  "inventory",
  "orders",
  "payments",
  "refunds",
  "shipments",
  "customers",
  "returns",
  "staff",
  "settings",
  "reports",
] as const;

export const OFFICIAL_STORE_NAME = "NEXORA MARKET — Official Store";
export const SELLER_ID_OFFICIAL_STORE = 0;
export const COURIER_NAME = "NEXORA Express (Demo)";
export const SHIPMENT_STATUS = "Created (Simulated) — no courier API connected";
export const PAYMENT_MODE_DEMO = "Demo Simulation — no gateway connected";
export const BRAND = {
  name: "NEXORA MARKET",
  tagline: "Shop Smarter. Live Better.",
  primaryColor: "#101828",
  secondaryColor: "#315EFB",
  accentColor: "#F59E0B",
  background: "#F8FAFC",
  currency: "PKR",
  currencySymbol: "Rs.",
  timezone: "Asia/Karachi",
};
