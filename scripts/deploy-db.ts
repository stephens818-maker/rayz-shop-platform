/**
 * Runs on every Vercel build (`pnpm vercel-build`): applies migrations, then loads the demo data when DEMO_MODE=true
 * and the database has no shops yet, or when DEMO_RESEED=true. It never seeds outside demo mode, so a real deployment
 * only ever gets migrations.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { assertDemoModeAllowed } from "../src/lib/deployment";

function run(script: string) {
  execFileSync(process.execPath, ["--import", "tsx", script], { stdio: "inherit", env: process.env });
}

async function main() {
  assertDemoModeAllowed();
  if (process.env.SKIP_DB_MIGRATE === "true") return console.log("SKIP_DB_MIGRATE=true: leaving the database alone.");
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Add it in Vercel → Settings → Environment Variables (see DEPLOY.md).");
  run("scripts/migrate.ts");
  if (process.env.DEMO_MODE !== "true") return;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from shops`;
  await sql.end();
  if (n > 0 && process.env.DEMO_RESEED !== "true") {
    console.log(`Demo data already loaded (${n} shops). Set DEMO_RESEED=true to reload it.`);
    run("scripts/demo-connect.ts");
  } else {
    console.log(n > 0 ? "DEMO_RESEED=true: reloading the demo data." : "Empty database: loading the demo data.");
    run("scripts/seed.ts");
  }
  run("scripts/demo-consent.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
