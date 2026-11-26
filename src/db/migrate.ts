// Run Drizzle migrations (drizzle/ folder) against DATABASE_URL.
// Usage: npm run db:migrate   (Render: run once after first deploy)
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import path from "node:path";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — migrations cannot run.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../drizzle") });
  console.log("Migrations applied.");
  await pool.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
