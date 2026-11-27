// Server-side validation — identical rules client-side (REBUILD-SPEC.md §5.3/§10,
// DATA-PLAN.md Phase 2 Finding 2).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Pakistani mobile: 03XXXXXXXXX (11 digits) or +92 3XXXXXXXXX. */
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test((email || "").trim());
}

export function normalizePkMobile(phone: string): string {
  const d = (phone || "").replace(/[\s-]/g, "");
  if (/^\+92\d{10}$/.test(d)) return "0" + d.slice(3);
  return d;
}

export function isValidPkMobile(phone: string): boolean {
  const d = normalizePkMobile(phone);
  return /^03\d{9}$/.test(d);
}

/** C16: ONE password rule in one place — 8+ characters with at least one
 * letter and one number. Used server-side by register / change / reset
 * (customer) and by owner/staff setup; the UI text must match it. */
export function validatePassword(pw: string): { ok: boolean; error?: string } {
  if (!pw || pw.length < 8) return { ok: false, error: "Password must be at least 8 characters with letters and numbers." };
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return { ok: false, error: "Password must include both letters and numbers." };
  return { ok: true };
}

/** Legacy gibberish values from the annotated legacy-test orders (spec §6.4). */
export const LEGACY_INVALID_EMAILS = ["test", "abc", "xyz123"];
export const LEGACY_INVALID_PHONES = ["000", "123", "999"];

export function validateCustomerInfo(input: {
  email?: string;
  phone?: string;
  name?: string;
}): { ok: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!input.name || input.name.trim().length < 2) errors.name = "Please enter your full name.";
  if (!isValidEmail(input.email || "")) errors.email = "Please enter a valid email address.";
  if (!isValidPkMobile(input.phone || "")) {
    errors.phone = "Please enter a valid Pakistani mobile number (03XXXXXXXXX or +92 3XXXXXXXXX).";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}
