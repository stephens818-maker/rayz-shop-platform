import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { closeDb } from "@/db";
import { errorsCsv } from "@/lib/import-errors";
import { statLines } from "@/lib/import-stats";
import { IMPORT_KINDS, ImportKind, runImport } from "@/server/importer";

/**
 * pnpm import:squire <clients|appointments|transactions|loyalty|gift_cards> <file.csv> [--commit] [--now=ISO] [--errors=out.csv]
 * Dry run by default: validates every row inside a transaction that is rolled back.
 * Recommended order: clients → appointments → transactions → loyalty → gift_cards.
 */
async function main() {
  const [kind, file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const commit = process.argv.includes("--commit");
  if (!kind || !file || !IMPORT_KINDS.includes(kind as ImportKind)) {
    console.error(`usage: pnpm import:squire <${IMPORT_KINDS.join("|")}> <file.csv> [--commit] [--now=ISO] [--errors=out.csv]`);
    process.exit(2);
  }
  const csv = readFileSync(file, "utf8");
  const now = flag("now") ? new Date(flag("now")!) : undefined;
  const r = await runImport(kind as ImportKind, csv, { dryRun: !commit, actor: { label: "cli-import" }, filename: basename(file), now });
  console.log(`${commit ? "IMPORTED" : "DRY RUN"} ${kind}: ${r.totalRows} rows → ${r.inserted} new, ${r.updated} updated, ${r.skipped} skipped`);
  for (const [label, value] of statLines(kind, r.stats)) console.log(`  ${label}: ${value}`);
  for (const [reason, n] of Object.entries(r.skippedByReason)) console.log(`  skipped, ${reason}: ${n}`);
  console.log("Column mapping:", r.headerMap);
  for (const e of r.errors.slice(0, 25)) console.log(`  row ${e.row} (${e.reason}): ${e.message}`);
  if (r.errors.length > 25) console.log(`  … ${r.errors.length - 25} more`);
  const out = flag("errors");
  if (out && r.errors.length) {
    writeFileSync(out, errorsCsv(r.errors));
    console.log(`Skipped rows written to ${out}`);
  }
  if (kind === "clients") {
    const { reconcileSquireClients } = await import("@/server/squire-reconcile");
    const rc = await reconcileSquireClients(csv, { dryRun: !commit, actor: { label: "cli-import" }, now });
    if (rc)
      console.log(
        commit
          ? `One profile per client: ${rc.birthdaysFilled} birthdays filled, ${rc.merged} same name + birthday records merged, ${rc.review} pairs to review on /admin/customers/duplicates?from=squire`
          : `One profile per client: ${rc.inFile} people appear under several Squire IDs with the same name and birthday`,
      );
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
