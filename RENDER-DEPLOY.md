# NEXORA MARKET — Render Deploy Guide (test server)

Target: **one Render free web service** + **Supabase free Postgres**
(project "Neoxara Markets", ref `rbqigtowumasoopebtyc`).
This is a **test server, not hosting and not a launch** — a free public link
the owner can share with testers, open from another phone, and show his
teachers and his agent to find glitches.

Status: the codebase is built and verified locally (see `BUILD-REPORT.md`
in `~/workspace/nexora-rebuild/`). The steps below are still to do — they
need the owner's accounts and the Postgres connection string, which must
never be sent in chat.

## Already done by the owner

- [x] Supabase project "Neoxara Markets" created and ACTIVE
      (URL `https://rbqigtowumasoopebtyc.supabase.co`).
- [x] Supabase publishable key received (public by design — set it as a
      Render env var, never in code).
- [x] GitHub account `saleem12399`; repo `saleem12399/nexora-market`
      (public, branch `main`) created.
- [x] Render account confirmed (signed in, same email
      `salemjan089@gmail.com`). Do NOT create a service yet — the service is
      created in step 3 below, once the repo exists.

## Still owed

- [ ] **Postgres connection string (DATABASE_URL)** — Supabase Dashboard →
      Project Settings → Database → Connection string, **URI mode**, with the
      database password the owner sets. Send it **securely** (secure vault /
      Render env var directly), **never in chat**.
- [ ] Push of this repo to `saleem12399/nexora-market` (coordinator's step).

## Step 1 — Push the repo (coordinator)

```bash
cd ~/workspace/nexora-rebuild/nexora-market
git init && git add -A && git commit -m "NEXORA MARKET portable rebuild v1.0"
git branch -M main
git remote add origin https://github.com/saleem12399/nexora-market.git
git push -u origin main
```

(Use the stored GitHub PAT via the `custom.github` connector — never paste
the token in chat or in a file.)

## Step 2 — Create the Supabase database (owner, one time)

The Supabase project already exists. No tables exist yet — the migration
creates them. Nothing to do in Supabase except copy the connection string
(URI mode) for step 3. Do **not** use Render free Postgres — it expires
30 days after creation. Supabase free Postgres (500 MB) pauses after 1 week
idle; one click resumes, no expiry.

## Step 3 — Create the Render web service (owner)

1. Render Dashboard → **New +** → **Web Service** → connect the
   `saleem12399/nexora-market` repo (branch `main`).
2. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
3. Environment variables (exact names):
   - `DATABASE_URL` = the Supabase Postgres connection string (URI mode)
   - `SUPABASE_URL` = `https://rbqigtowumasoopebtyc.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY` = the publishable key received earlier
4. Create the service. First deploy takes a few minutes; the free service
   sleeps after 15 min idle and takes ~30–60 s to wake on first load — that
   is expected on the free tier.

## Step 4 — Migrate + seed (once, after first deploy)

From a machine with the repo and `DATABASE_URL` set (or via Render Shell):

```bash
npm install
npm run db:migrate   # applies drizzle/0001_consolidated.sql
npm run db:seed      # idempotent — skips if products already exist
npm run db:validate  # sanity check of the seed files (no DB needed)
```

Verify:

```bash
curl https://<your-render-url>/health
# expect: {"ok":true,"db":"connected",...}
```

## Step 5 — First checks on the live test server

1. Homepage loads: hero carousel, 9 category cards, Flash Sale row of 5
   (cycle 0 starts with the smartwatch NX2-WEA-004), Best Sellers, reviews.
2. Sign in as the QA customer is NOT possible yet with a password — seeded
   accounts have no password. Use **Forgot password?** on the sign-in page
   to set one via the reset flow (the token is shown once, staging-only,
   because no email provider is connected).
3. After sign-in as `bigtest.qa@nexora.demo`, the dashboard shows only that
   customer's 1 Delivered order + its return. Signing in as the owner
   (`saleemjan089@gmail.com`) shows **no orders** until the NX-DEMO-98524600
   email correction is approved — that is the exact-match rule working, not
   a bug.
4. Admin → Phase 2 shows providers all "Awaiting credentials" and the
   pending owner inputs. Admin header shows DEMO / TRIAL MODE.

## Step 6 — After the rebuild, the copies diverge

Changes to the test server are made in this GitHub repo and redeployed on
Render (auto-deploy if connected). Muse-copy edits do NOT propagate, and
test-server data does not flow back to the Muse copy.

## Rollback

Redeploy the previous build in Render, then restore the last snapshot
(the seed files in `seed/` are the migration source; nightly DB backup +
snapshot retention to be confirmed by the owner once live).

## Free-tier realities (state these to the owner)

- Render free sleeps after 15 min idle (~30–60 s first-load wake).
- Supabase free pauses after 1 week idle (one click resumes, no expiry).
- No external staging URL, Firebase, or PWA is part of this rebuild — the
  test server IS the staging URL.
