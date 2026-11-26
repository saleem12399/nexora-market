// Flash Sale rotating row (REBUILD-SPEC.md §8, DATA-PLAN.md Flash Row Fix).
// Pool = Published + isFlash + genuine salePrice < price (11 products).
// cycle = floor(daysSinceAnchor / rotateDays); the pool is rotated so the
// smartwatch (NX2-WEA-004) leads cycle 0; each window takes rowSize distinct
// products starting at (cycle * rowSize) mod poolSize, wrapping.
// No cron, no code change — the set changes on its own every 1-2 days.

export const FLASH_ANCHOR = "2026-11-25";
export const FLASH_LEAD_SKU = "NX2-WEA-004";
export const FLASH_DEFAULT_ROW_SIZE = 5;
export const FLASH_DEFAULT_ROTATE_DAYS = 2;

export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = Date.parse(fromYmd + "T00:00:00Z");
  const b = Date.parse(toYmd + "T00:00:00Z");
  return Math.floor((b - a) / 86400000);
}

export function todayYmdKarachi(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface FlashRowInput {
  /** Full flash pool SKUs in canonical order (spec §6.1 table order). */
  poolSkus: string[];
  rowSize?: number;
  rotateDays?: number;
  anchor?: string;
  today?: string; // YYYY-MM-DD, Asia/Karachi; defaults to today
}

export interface FlashRow {
  skus: string[];
  poolSize: number;
  cycle: number;
  rowSize: number;
  rotateDays: number;
  anchor: string;
  nextRotationAt: string;
}

export function computeFlashRow(input: FlashRowInput): FlashRow {
  const rowSize = Math.min(5, Math.max(4, input.rowSize ?? FLASH_DEFAULT_ROW_SIZE));
  const rotateDays = input.rotateDays === 1 ? 1 : 2;
  const anchor = input.anchor || FLASH_ANCHOR;
  const today = input.today || todayYmdKarachi();
  // Rotate the pool so the smartwatch leads cycle 0.
  const pool = [...input.poolSkus];
  const leadIdx = pool.indexOf(FLASH_LEAD_SKU);
  if (leadIdx > 0) pool.push(...pool.splice(0, leadIdx));
  const daysSince = Math.max(0, daysBetweenYmd(anchor, today));
  const cycle = Math.floor(daysSince / rotateDays);
  const start = (cycle * rowSize) % pool.length;
  const skus: string[] = [];
  for (let i = 0; i < rowSize; i++) skus.push(pool[(start + i) % pool.length]);
  const nextRotationAt = addDaysYmd(anchor, (cycle + 1) * rotateDays);
  return { skus, poolSize: pool.length, cycle, rowSize, rotateDays, anchor, nextRotationAt };
}

/** Canonical flash-pool order = spec §6.1 table order of the 11 isFlash products. */
export const FLASH_POOL_SKUS = [
  "NX2-MEN-001",
  "NX2-MEN-006",
  "NX2-WOM-002",
  "NX2-WOM-004",
  "NX2-PHN-002",
  "NX2-ACC-001",
  "NX2-ACC-004",
  "NX2-WEA-002",
  "NX2-WEA-004",
  "NX2-AUD-001",
  "NX2-BEA-001",
];
