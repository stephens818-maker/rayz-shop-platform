import "dotenv/config";
import { closeDb } from "@/db";
import { isValidLocalDate, addDays, todayLocal } from "@/lib/time";
import { backfillRollups, runJobs } from "@/server/jobs";

/**
 * Builds the location rollups for past days, for the brand comparison report: after go-live or a
 * Squire import. `npm run rollups:backfill -- 2024-01-01` (to yesterday) or `-- 2024-01-01 2024-12-31`.
 * Safe to run again: days already queued or done are skipped, and the work is the jobs cron's own.
 */
async function main() {
  const [from, to = addDays(todayLocal(), -1)] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!from || !isValidLocalDate(from) || !isValidLocalDate(to) || from > to) throw new Error("Give the first day (and optionally the last), as YYYY-MM-DD");
  console.log(`Queued ${await backfillRollups(from, to)} location-days`);
  for (;;) {
    const r = await runJobs(new Date(), { kinds: ["rollup"], budgetMs: 60_000 });
    console.log(`  ${r.done} done, ${r.failed} failed, ${r.remaining} left`);
    if (!r.remaining || (!r.done && !r.failed)) break;
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
