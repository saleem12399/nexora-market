# NEXORA MARKET — Portable Rebuild

Single-company retail store (Demo mode). One Node.js service — Express +
Drizzle ORM + Postgres — serving the JSON API and the server-rendered
storefront + admin from one process. Deployable as **one Render free web
service** or **one Vercel Hobby project** on **Supabase free Postgres**.
Render needs a card on file (HTTP 402 without one); Vercel Hobby does not —
see `VERCEL-DEPLOY.md` for the Vercel path, `RENDER-DEPLOY.md` for Render.

Ported from the Muse copy (fullstack artifact slug `nexora-market`) per
`../REBUILD-SPEC.md` (the build contract — read it first). After this
rebuild the two copies diverge: Muse-copy edits do NOT propagate here, and
changes here are made in this GitHub repo and redeployed on Render.

> **Demo mode stays ON.** No live payment gateway, courier, or messaging
> provider is connected. Every payment, shipment and tracking step is
> labelled DEMO / simulated. Never fake a live integration.
> Single-company model: no sellers, no commissions, no payouts, no cash-out
> (formally excluded). `sellers` and `payouts` tables exist for schema parity
> and must stay at 0 rows.

## Quick start

```bash
npm install
npm run build
# Without a database the server still boots and /health answers honestly:
npm start            # PORT=3000 by default
curl localhost:3000/health
```

With a database (see `RENDER-DEPLOY.md` for Render, `VERCEL-DEPLOY.md` for Vercel):

```bash
npm run db:migrate   # applies drizzle/0001_consolidated.sql
npm run db:seed      # idempotent seed from seed/*.json
npm run db:validate  # validate the seed files only (no DB needed)
npm run smoke        # pure-function smoke test (no DB needed)
```

## Environment variables (only four — never put values in the repo)

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string (URI mode). Collected securely, never in chat. |
| `SUPABASE_URL` | `https://rbqigtowumasoopebtyc.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_…`, public by design). Set as a deploy env var. |
| `RUN_MIGRATIONS_ON_BOOT` | `true` only on Vercel: the first request of a cold start runs `db:migrate` + `db:seed`. Leave unset (off) on Render. |

See `.env.example`. No key, token, password or credential value appears
anywhere in this repo.

## Layout

```
src/
  lib/        pure logic: constants (12-step tracking, 9-stage refunds),
              money (integer-PKR totals, coupon rules), flash (rotating
              Flash Sale row), validation (email + Pakistani mobile),
              auth (PBKDF2 210,000 iters, 256-bit session tokens),
              roles (9×11 permission matrix, self-test)
  db/         schema.ts (30 tables, no FKs, epoch-ms, integer PKR)
              index.ts (lazy pool — boots without DATABASE_URL)
              seed.ts (idempotent seed; --validate needs no DB)
              migrate.ts (drizzle migrator)
              boot-migrate.ts (optional Vercel boot migration, advisory-locked)
  server/     index.ts (Express app, pages, /health)
              api.ts (REST endpoints mirroring spec §5 actions)
              views.ts (server-rendered HTML, navy/blue/amber theme)
api/          index.js (Vercel serverless entry — reuses the compiled app)
vercel.json   Vercel build, rewrites and function config
public/       css/style.css, js/app.js
              images/products/ (48 sample product photos, self-contained)
              images/payments/ (Easypaisa, JazzCash, Visa, Mastercard logos)
seed/         28 JSON files — the migration source (copied from the live export)
drizzle/      0001_consolidated.sql — one migration covering the Muse copy's
              migrations 0001–0011 (SQLite → Postgres), plus meta journal
scripts/      smoke-test.cjs
```

## Key rules (from the spec — do not break)

- **Totals are recomputed server-side** (`total = subtotal − discount + shippingFee`);
  the client never dictates a total. Shipping: Standard Rs. 250 (free ≥ Rs. 5,000
  after discount), Express/Scheduled Rs. 450, Pickup Rs. 0, tax Rs. 0 (shown).
- **Checkout is exactly 7 steps** (Cart Review → Customer Info → Delivery
  Address → Shipping → Payment → Summary → Confirm); **tracking is exactly
  12 steps** (Pending → Delivered); **refunds are 9 stages, capped at 8**,
  restock at stage 4.
- **Per-customer scoping:** `listMyOrders` derives identity from the session
  token and matches checkout email EXACTLY (case-insensitive). No session →
  `authenticated: false`, no orders. The earlier one-character-tolerance
  match was rejected by security review and is NOT reproduced.
- **Owner's order NX-DEMO-98524600 (Rs 23,463, COD Pending) is seeded
  unchanged.** Under exact-match scoping it does NOT appear under the owner's
  account (`saleemjan089@gmail.com`) until he approves a one-time correction
  of the order's stored checkout email (totals/items untouched).
- **Customer passwords:** the export contains no hash values. All 3 seeded
  customers have `passwordHash = NULL` and `mustResetPassword = true`. The
  owner sets passwords (owner-assisted reset). Self-service reset by email
  is unavailable: `requestPasswordReset` never returns a token and no email
  provider is connected — Phase 2 must decide owner-assisted reset via admin
  OR self-service reset disabled until an email provider is connected.
  **Never invent or default a password.**
- **Sample photos stay unlabeled** (owner order 2026-11-27: all customer-facing
  DEMO/"Sample image" labels removed) until the owner supplies real photos
  (upload pipeline unchanged; the sample seeder never overwrites a product
  that already has any photo).
- **RBAC:** server-side `requirePermission` per the 9×11 role matrix; denials
  are audit-logged ("PERMISSION DENIED"). `runRoleSelfTest` = 41 allowed /
  58 denied (99 checks).

## Open items (spec §14 — do not invent; verify during acceptance)

1. **Refund-stage labels 1–7** — stage 0 = Requested, stage 2 = Approved,
   stage 8 = Refunded (Demo) are sourced. Labels 1, 3–7 in
   `src/lib/constants.ts` are honest working labels derived from the 9-stage
   tracker behaviour, marked "to verify against the Muse copy's returns UI".
2. **The 10 payment statuses** — only 5 distinct values appear in the live
   export (`src/lib/constants.ts` `PAYMENT_STATUSES_SOURCED`); the rest are
   open. `updatePaymentStatus` rejects anything outside the sourced list.
3. **Production coupon values** for 000 / WELCOME10 / FLASH500 are unbounded
   (owner decision pending). Only BIGTEST5 is bounded (expires 2026-12-25,
   usage 20, per-customer 3).
4. **Legacy returns RET-DEMO-001 / RET-DEMO-002** — decision pending.
   `getLegacyReview` computes the discrepancies; `correctLegacyReturn` /
   `markLegacyReturns` require `ownerApproved: true`.
5. **Owner's order email correction** (see above) — approval pending.
6. **Admin tab count** — the spec lists 20 modules; the Phase 1 lab test
   observed 21 tabs (the extra tab is the Phase 2 tab added later). This
   build implements the 20 modules; Orders and Tracking share one tab
   (tracking manager inside Orders).
7. **Compare page** — a clearly-marked stub (no flow details in any source).
8. **`saved_searches`** — minimal table only; the feature is unlisted until
   the Muse copy's behaviour is verified.
9. **Dark mode** — unverified on the owner's phone (acceptance item).
10. **Pre-correction backup blob** (`backups/pre-correction-1795597530011.json`)
    is NOT retrievable; it is recorded as a descriptor only in settings.
    The seed files in `seed/` are the migration source.
11. **Action count** — "~91 published actions" could not be verified
    (`artifact.list_actions` was unavailable); reconcile during acceptance.

## Acceptance (spec §12.2)

Re-prove in the rebuilt Postgres: seed counts, the 12-step live journey
(fresh order → Delivered, shipment + 2 ledger rows + 2 payment txns +
validated return, duplicate blocked), money examples, exact-match scoping,
live role enforcement, live analytics, flash rotation, homepage honesty,
48 photos labelled "Sample image", mobile 0px overflow at 390px, demo
labelling everywhere, dark-mode glance on the owner's phone.
