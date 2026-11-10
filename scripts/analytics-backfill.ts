import "dotenv/config";
import { closeDb } from "@/db";
import { BACKFILL_TABLES } from "@/domain/analytics";
import { runBackfill } from "@/server/analytics";

/**
 * Logs the history already on file into the event log: `npm run analytics:backfill`, or name
 * tables (`-- appointments sales`). Safe to run again; add --force to walk tables already done.
 */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const tables = args.filter((a) => !a.startsWith("--"));
  const unknown = tables.filter((t) => !(BACKFILL_TABLES as readonly string[]).includes(t));
  if (unknown.length) throw new Error(`No backfill for ${unknown.join(", ")}. Tables: ${BACKFILL_TABLES.join(", ")}`);
  const r = await runBackfill({ tables: tables.length ? tables : undefined, force });
  for (const [t, n] of Object.entries(r.done)) console.log(`${t.padEnd(20)} ${n} events`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
