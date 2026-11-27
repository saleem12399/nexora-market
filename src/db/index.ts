// Database connection — lazy. The server must boot and serve /health even
// with no DATABASE_URL (REBUILD-SPEC.md §12, task brief): data routes then
// answer honestly with 503 "database not configured" instead of crashing.

import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let pool: Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getDb(): NodePgDatabase<typeof schema> | null {
  if (db) return db;
  if (!process.env.DATABASE_URL) return null;
  // Supabase Postgres (direct and pooler) requires SSL, and the
  // connection string from its dashboard carries no sslmode, so SSL must
  // be enabled here. rejectUnauthorized:false is the standard Supabase
  // pooler setting: the pooler certificate does not verify against the
  // default CA store. Without this, every query fails at connect time.
  // Phase 1: max 1 + idle/connection timeouts. ROOT CAUSE found live
  // (2026-11-27 ~11:40 PKT, via the surfaced driver cause):
  // "(EMAXCONNSESSION) max clients reached in session mode - max
  // clients are limited to pool_size: 15". The Supabase session
  // pooler allows 15 clients TOTAL. With max 5 per Vercel instance,
  // just 3 warm instances filled it; getHomepage's Promise.all
  // sections then failed when the pool tried to open client 2-5
  // (the failing product_images param varied run to run), and once
  // saturated even the first query (settings) failed. max 1 lets up
  // to 15 warm instances coexist; queries serialize per instance
  // (getHomepage stays ~6-8 s, inside the 60 s function limit).
  // idleTimeoutMillis releases the connection 10 s after use, so
  // idle instances stop holding a pooler slot. No query logic changes.
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
  pool.on("error", (err) => console.error("[db] pool error", err.message));
  db = drizzle(pool, { schema });
  return db;
}

export async function checkDb(): Promise<{ ok: boolean; error?: string }> {
  const d = getDb();
  if (!d) return { ok: false, error: "DATABASE_URL is not set — database not configured" };
  try {
    await d.execute("SELECT 1");
    return { ok: true };
  } catch (e) {
    // Drizzle wraps the driver error, so surface the underlying cause:
    // without it /health can only say "Failed query: SELECT 1" and the
    // real reason (auth, SSL, host) stays hidden.
    const cause = (e as { cause?: { message?: string } }).cause;
    return { ok: false, error: cause?.message || (e as Error).message };
  }
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
  db = null;
}
