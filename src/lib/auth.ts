// Auth — PBKDF2-HMAC-SHA-256, 210,000 iterations, 16-byte salt
// (REBUILD-SPEC.md §10). Format: pbkdf2$iter$salt$hash (salt+hash base64url).
// Sessions: random 256-bit token, stored only as SHA-256 hash, 30-day expiry.

import crypto from "node:crypto";

export const PBKDF2_ITERATIONS = 210000;
export const PBKDF2_KEYLEN = 32;
export const SALT_BYTES = 16;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, "sha256");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iter = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], "base64url");
    const expected = Buffer.from(parts[3], "base64url");
    const hash = crypto.pbkdf2Sync(password, salt, iter, expected.length, "sha256");
    return crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

/** Legacy SHA-256 hash (pre-PBKDF2 format) — verifies once, then upgrade. */
export function isLegacySha256Hash(stored: string): boolean {
  return /^[0-9a-f]{64}$/i.test(stored || "");
}

export function verifyLegacySha256(password: string, stored: string): boolean {
  const h = crypto.createHash("sha256").update(password).digest("hex");
  const a = Buffer.from(h);
  const b = Buffer.from(stored.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url"); // 256-bit
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newResetToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
