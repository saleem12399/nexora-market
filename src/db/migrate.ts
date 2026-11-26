// Run Drizzle migrations (drizzle/ folder) against DATABASE_URL.
// Usage: npm run db:migrate   (Render: run once after first deploy)
// The migration step is also reusable as runMigrations() for the optional
// Vercel boot migration (src/db/boot-migrate.ts) — that path never calls
// process.exit, so the library function must not exit either.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import path from "node:path";

export async function runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — migrations cannot run.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  console.log("Migrations applied.");
  await pool.end();
}

async function main() {
  await runMigrations();
  process.exit(0);
}
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
