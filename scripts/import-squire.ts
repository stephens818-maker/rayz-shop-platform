import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { closeDb } from "@/db";
import { ImportKind, runImport } from "@/server/importer";

/**
 * pnpm import:squire <clients|appointments|loyalty|gift_cards> <file.csv> [--commit]
 * Dry run by default: validates every row inside a transaction that is rolled back.
 * Recommended order: clients → appointments → loyalty → gift_cards.
 */
async function main() {
  const [kind, file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const commit = process.argv.includes("--commit");
  if (!kind || !file || !["clients", "appointments", "loyalty", "gift_cards"].includes(kind)) {
    console.error("usage: pnpm import:squire <clients|appointments|loyalty|gift_cards> <file.csv> [--commit]");
    process.exit(2);
  }
  const csv = readFileSync(file, "utf8");
  const r = await runImport(kind as ImportKind, csv, { dryRun: !commit, actor: { label: "cli-import" }, filename: basename(file) });
  console.log(`${commit ? "IMPORTED" : "DRY RUN"} ${kind}: ${r.totalRows} rows → ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped`);
  console.log("Column mapping:", r.headerMap);
  for (const e of r.errors.slice(0, 25)) console.log(`  row ${e.row}: ${e.message}`);
  if (r.errors.length > 25) console.log(`  … ${r.errors.length - 25} more`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
