// In-memory rate limiting for auth endpoints (login / register / reset /
// staff login / owner setup).
//
// BEST-EFFORT ON SERVERLESS: the counters live in the function's memory,
// so each warm Vercel instance has its own counters. That still stops a
// single-instance brute force and slows a distributed one; a shared store
// (e.g. a DB table) is the Phase 4 hardening step. Limits are enforced
// BEFORE any DB lookup, and counted identically whether or not the account
// exists, so neither the limit nor the timing leaks account existence.

const hits = new Map<string, number[]>();

export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) return true;
  list.push(now);
  hits.set(key, list);
  return false;
}

/** First X-Forwarded-For hop, else the socket address (Express req.ip). */
export function clientIp(req: { headers: Record<string, any>; ip?: string }): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : String(fwd || "")).split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

/** 429 body used by every rate-limited auth endpoint. */
export function rateLimitBody() {
  return { ok: false, error: "Too many attempts. Try again later." };
}
