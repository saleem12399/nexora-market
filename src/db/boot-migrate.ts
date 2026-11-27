// Optional boot migration for serverless deploys (Vercel).
//
// When RUN_MIGRATIONS_ON_BOOT=true, the first request of a cold start runs
// db:migrate and then db:seed (idempotent) before the app serves anything,
// so a fresh database is ready without a separate shell step. The seed is
// the same data the Render path seeds with npm run db:seed.
//
// Concurrency: Vercel may cold-start several function instances at once.
// A Postgres advisory lock makes exactly one instance the migrator. An
// instance that cannot get the lock waits briefly (up to LOCK_WAIT_MS) for
// the migrator to finish; if the lock is still held it serves anyway without
// migrating, trusting the other instance. The lock is released explicitly.
//
// Off by default: when the flag is unset or anything other than "true",
// this is a no-op, so the Render path is completely unaffected. A failure
// here never crashes the app: the app boots without a database by design
// and reports it honestly on /health.
import { Pool } from "pg";
import { runMigrations } from "./migrate";
import { runSeed } from "./seed";

// Fixed advisory-lock key for the NEXORA boot migration (any int64 works;
// this one is the project start date, 2026-11-26, as a plain integer).
const LOCK_KEY = 20261126;
const LOCK_WAIT_MS = 15000;

let bootPromise: Promise<void> | null = null;

// F8 (Phase 2): surface the boot-migration outcome on /health instead of
// only logging it (function logs are not visible from here). The app still
// never crashes on a migration failure — it serves and reports honestly.
export const bootStatus: { ran: boolean; skipped?: string; error?: string; finishedAt?: string } = { ran: false };

export function getBootStatus() {
  return { ...bootStatus };
}

export function ensureBootMigrated(): Promise<void> {
  if (!bootPromise) {
    bootPromise = runBootMigration().catch((e) => {
      // Never fail the request because the boot migration failed: the app
      // still serves, and /health reports the database state honestly.
      bootStatus.error = (e as Error).message;
      console.error("[boot-migrate] failed — serving without boot migration:", (e as Error).message);
    });
  }
  return bootPromise;
}

async function runBootMigration(): Promise<void> {
  if (process.env.RUN_MIGRATIONS_ON_BOOT !== "true") {
    bootStatus.skipped = "RUN_MIGRATIONS_ON_BOOT is not 'true' — boot migration disabled.";
    return;
  }
  if (!process.env.DATABASE_URL) {
    bootStatus.skipped = "RUN_MIGRATIONS_ON_BOOT=true but DATABASE_URL is not set — skipping.";
    console.log("[boot-migrate] RUN_MIGRATIONS_ON_BOOT=true but DATABASE_URL is not set — skipping.");
    return;
  }
  // Supabase requires SSL; see src/db/index.ts for why this is set here.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    let locked = (await client.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_KEY])).rows[0].locked as boolean;
    if (!locked) {
      console.log("[boot-migrate] another instance is migrating — waiting briefly…");
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        locked = (await client.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_KEY])).rows[0].locked as boolean;
        if (locked) break;
      }
      if (!locked) {
        bootStatus.skipped = "Advisory lock still held after 15s — another instance owns the migration; this instance proceeded without migrating.";
        console.log("[boot-migrate] lock still held after 15s — proceeding without migrating (the other instance owns it).");
        return;
      }
    }
    try {
      await runMigrations();
      await runSeed(false);
      bootStatus.ran = true;
      bootStatus.finishedAt = new Date().toISOString();
      console.log("[boot-migrate] boot migration + seed complete.");
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}
