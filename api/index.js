// Vercel serverless entry — reuses the compiled Express app (dist/server).
// This file is plain JavaScript at the repo root on purpose: the TypeScript
// build only compiles src/ (tsconfig rootDir), and Vercel builds the
// function after `npm run build`, so dist/ already exists when this file is
// bundled. No app code is duplicated here.
//
// Static files in public/ are served directly by Vercel (see vercel.json
// rewrites: static files win over the catch-all rewrite), so the Express
// static middleware in the app only matters on Render.
//
// Boot migration: when RUN_MIGRATIONS_ON_BOOT=true, the first request of a
// cold start migrates + seeds the database (src/db/boot-migrate.ts) before
// the app serves. The promise is cached per instance, so warm invocations
// do not pay for it again.
const app = require("../dist/server/index.js").default;
const { ensureBootMigrated } = require("../dist/db/boot-migrate.js");

module.exports = async (req, res) => {
  await ensureBootMigrated();
  return app(req, res);
};
