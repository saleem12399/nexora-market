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
  // Phase 1: idleTimeoutMillis + connectionTimeoutMillis. The Supabase
  // session pooler kills server connections idle ~10 min, but pg Pool
  // kept handing those dead clients out — getHomepage (the only handler
  // firing concurrent queries via Promise.all) then failed mid-chain on
  // a stale client with "Failed query ... product_images", while fully
  // sequential handlers (listProducts) never saw it. Closing clients
  // idle >10 s makes every checkout open a fresh connection; the 10 s
  // checkout timeout bounds queueing when the pooler is at max clients
  // (seen live as EMAXCONNSESSION). No query logic changes.
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
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
