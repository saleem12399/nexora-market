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
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, ssl: { rejectUnauthorized: false } });
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
    return { ok: false, error: (e as Error).message };
  }
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
  db = null;
}
