// Role matrix — verbatim from seed/role_matrix.json (10 roles x 11 areas).
// Server-side enforcement: requirePermission(area, role) throws on denial;
// callers audit-log "PERMISSION DENIED".
// "Owner" is the store owner (Saleem) — the top role, same areas as Super
// Admin. It exists as a distinct role so the owner account is identifiable
// in audit logs and so owner-only actions (staff activation, legacy-return
// confirmation) can require it explicitly.

import { ROLE_AREAS } from "./constants";

export type RoleArea = (typeof ROLE_AREAS)[number];

export const OWNER_ROLE = "Owner";

export const ROLE_MATRIX: Record<string, RoleArea[]> = {
  Owner: ["products", "inventory", "orders", "payments", "refunds", "shipments", "customers", "returns", "staff", "settings", "reports"],
  "Super Admin": ["products", "inventory", "orders", "payments", "refunds", "shipments", "customers", "returns", "staff", "settings", "reports"],
  Admin: ["products", "inventory", "orders", "payments", "refunds", "shipments", "customers", "returns", "staff", "settings", "reports"],
  "Product Manager": ["products", "reports"],
  "Inventory Manager": ["inventory", "reports"],
  "Order Manager": ["orders", "shipments", "returns", "reports"],
  "Finance Officer": ["payments", "refunds", "reports"],
  "Customer Support Agent": ["customers", "returns", "reports"],
  "Warehouse Staff": ["inventory", "shipments"],
  "Delivery Manager": ["orders", "shipments", "reports"],
};

export function roleCan(role: string, area: RoleArea): boolean {
  return (ROLE_MATRIX[role] || []).includes(area);
}

export class PermissionDeniedError extends Error {
  area: string;
  role: string;
  constructor(role: string, area: string) {
    super(`PERMISSION DENIED: role "${role}" may not access "${area}"`);
    this.name = "PermissionDeniedError";
    this.role = role;
    this.area = area;
  }
}

export function requirePermission(role: string, area: RoleArea): void {
  if (!roleCan(role, area)) throw new PermissionDeniedError(role, area);
}

/** Self-test: all 110 role x area checks, as runRoleSelfTest does. */
export function runRoleSelfTest(): { allowed: number; denied: number; checks: { role: string; area: RoleArea; allowed: boolean }[] } {
  const checks: { role: string; area: RoleArea; allowed: boolean }[] = [];
  let allowed = 0;
  for (const role of Object.keys(ROLE_MATRIX)) {
    for (const area of ROLE_AREAS) {
      const ok = roleCan(role, area);
      checks.push({ role, area, allowed: ok });
      if (ok) allowed++;
    }
  }
  return { allowed, denied: checks.length - allowed, checks };
}
