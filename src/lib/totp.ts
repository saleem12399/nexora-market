// TOTP (RFC 6238) — time-based one-time passwords for staff MFA.
// No dependency: HMAC-SHA1 over a base32 secret, 30-second steps,
// 6 digits, verification window of ±1 step (covers clock skew).
// The secret is shown to the owner/staff member ONCE (setup page) for
// manual entry into any authenticator app (Google/Microsoft Authenticator
// etc.); it is stored in the DB, never logged, never returned by any other
// endpoint.

import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

/** Current 6-digit code (for tests/diagnostics only — never expose it). */
export function totpNow(secret: string, atMs = Date.now()): string {
  return hotp(secret, Math.floor(atMs / 30000));
}

/** Verify a code, accepting ±1 step (30 s each side) for clock skew. */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  const clean = String(code || "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  const step = Math.floor(atMs / 30000);
  for (const s of [step - 1, step, step + 1]) {
    const expected = hotp(secret, s);
    const a = Buffer.from(expected);
    const b = Buffer.from(clean);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function totpAuthUrl(secret: string, account: string, issuer = "NEXORA MARKET"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Display form of a secret: groups of 4, for manual entry. */
export function totpSecretDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
