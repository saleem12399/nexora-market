# NEXORA MARKET — Vercel Deploy Guide (test server)

Target: **one Vercel Hobby project** (no card required) + **Supabase free
Postgres** (project "Neoxara Markets", ref `rbqigtowumasoopebtyc`). This is a
**test server, not hosting and not a launch** — a free public link the owner
can share with testers, open from another phone, and show his teachers and
his agent to find glitches.

Why Vercel: Render refused to create the free web service with HTTP 402 —
"Payment information is required" — because no card is on file, and the
owner has no debit/credit card. Vercel Hobby needs no card. The Render path
is untouched: the same repo still deploys on Render with `npm start` (see
RENDER-DEPLOY.md), and the Render connector (custom.render) is kept for
later if a card ever exists.

## What changed for Vercel (same repo, same app)

- `api/index.js` — the Vercel serverless entry. It reuses the compiled
  Express app (`dist/server/index.js`); no app code is duplicated.
- `vercel.json` — build command `npm run build`, no framework, one
  catch-all rewrite sending every non-static route to the function, and the
  function config (`includeFiles` for the `seed/` and `drizzle/` folders
  the migrator and seeder read at runtime, `maxDuration` 60s for the first
  boot migration). Static files in `public/` are served directly by Vercel.
- `src/db/boot-migrate.ts` — optional boot migration. Only when
  `RUN_MIGRATIONS_ON_BOOT=true`, the first request of a cold start runs
  `db:migrate` then `db:seed`, guarded by a Postgres advisory lock so
  concurrent cold starts do not race. Off by default; the Render path never
  sees it.
- `src/server/api.ts` + `src/server/index.ts` — the homepage (`/`) and shop
  (`/shop`) pages used to fetch their own API over
  `http://127.0.0.1:<PORT>`. A serverless function has no listening socket, so
  those pages would fail on Vercel. They now call the same API handlers
  in-process (`callApiAction`); the payload, routes and rendered pages are
  identical on Render and on Vercel. Staff-only actions can never be called
  this way (the helper refuses any action with a role requirement).
- `src/db/migrate.ts` / `src/db/seed.ts` — the migration and seed steps are
  now reusable functions (`runMigrations()`, `runSeed()`). The CLI commands
  (`npm run db:migrate`, `npm run db:seed`, `npm run db:validate`) behave
  exactly as before.

No product or order data changed. The owner's order NX-DEMO-98524600
(Rs 23,463, COD Pending) is seeded unchanged, as before.

## Step 1 — Create a Vercel account (owner)

1. Open `https://vercel.com/signup` and sign up with GitHub
   (account `saleem12399`). No card is asked for on the Hobby plan.
2. No Vercel API token is needed for this path: the project is created in
   the dashboard and deploys from GitHub automatically.

## Step 2 — Create the project (owner)

1. Vercel dashboard → **Add New… → Project** → **Import** the repository
   `saleem12399/nexora-market`.
2. Framework Preset: **Other**. Root Directory: `./` (the repo root).
   Build Command: `npm run build` (already set in `vercel.json`; if the
   dashboard shows something else, set it to `npm run build`).
   Install Command: `npm install`. Output Directory: leave empty.
3. **Before pressing Deploy**, open **Environment Variables** and add these
   four (all for Production; the values for the first three are the same
   ones prepared for Render):

   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | The Supabase **Session pooler** URI (port 5432, IPv4) with the database password already substituted. Never in chat — paste it only here. |
   | `SUPABASE_URL` | `https://rbqigtowumasoopebtyc.supabase.co` |
   | `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_Y1imy5m7mNzSyDYOt2YxtQ_9fT8kH7J` |
   | `RUN_MIGRATIONS_ON_BOOT` | `true` |

   Do NOT use the Direct connection string (IPv6-only host) and do NOT use
   the paid IPv4 add-on. The Session pooler is free.
4. Press **Deploy**. The build runs `npm run build` and the function is
   created from `api/index.js`.

## Step 3 — First request runs the migration (automatic)

The first visit to the site runs `db:migrate` and then `db:seed` inside the
function (that is what `RUN_MIGRATIONS_ON_BOOT=true` does), so no shell
step is needed. Expect the first load to be slow — up to about 60 seconds.
If it times out, just reload once: the migration is lock-guarded and the
seed is idempotent, so a retry is safe and will not duplicate anything.

## Step 4 — Verify (owner + Muse)

1. Health: open `https://<your-app>.vercel.app/health` — expect
   `{"ok":true,"db":"connected"}` (and `"dbConfigured":true`).
2. Homepage: hero carousel (3 slides), 9 category cards, Flash Sale row of
   exactly 5 deals starting with the smartwatch (NX2-WEA-004), Best Sellers
   from real order data, Recommended, New Arrivals, 5 genuine reviews.
3. Shop + a product page: 48 products, real sample photos, no broken
   images.
4. Register a new test customer, then place a demo order (COD) through
   checkout and check it in **Track Order**.
5. Sign in and open the account dashboard: the 4 stats must be that
   customer's own records only (a fresh customer shows Total 0, not the
   store-wide total).
6. Admin: open `/admin` and confirm the Homepage tab and the order list.
7. Seeded accounts have NO password (by design — the export carries no
   password hashes). To sign in as a seeded customer, use **Forgot
   password?** on the sign-in page and follow the reset flow.

## Free-tier behaviour to expect

- Vercel Hobby: no card, serverless functions (cold start after idle),
  function runs capped at 60 seconds (set in `vercel.json`). The site is a
  test server, so cold starts are acceptable.
- Supabase free Postgres pauses after 1 week idle — one click in the
  Supabase dashboard resumes it.
- After this deploy the two copies diverge: changes made in the Muse
  artifact do NOT reach the Vercel copy. Changes go through the GitHub repo
  (`saleem12399/nexora-market`, branch `main`) — pushing to `main`
  redeploys automatically (`autoDeployTrigger: commit` equivalent on
  Vercel). Data entered on the Vercel copy does not flow back.
- Live payments, courier and messaging stay DEMO/off. No merchant
  credentials are connected; none are invented anywhere in the code.

## If something fails

- `/health` says `db: "not configured"` → `DATABASE_URL` is missing or
  empty in the Vercel env vars. Add it and redeploy (Deployments → ⋯ →
  Redeploy).
- `/health` says `db: "not configured"` with a `dbError` → the connection
  string is wrong (check the pooler host is
  `aws-0-ap-northeast-1.pooler.supabase.com:5432`, the password is
  substituted, and special characters in the password are percent-encoded).
- First load times out repeatedly → open the function logs (Vercel
  dashboard → the deployment → Functions → `api/index`) and look for
  `[boot-migrate]` lines. A slow first seed on a cold database is normal;
  a repeat timeout after 2–3 reloads needs the logs, not more retries.
- Build fails → the build log shows the `tsc` error. The build is verified
  (`npm run build` passes) before every push; do not edit code in the
  dashboard.
