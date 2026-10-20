import "dotenv/config";
import { closeDb } from "@/db";
import { processDueJobs } from "@/server/notifications/queue";

/** Local stand-in for Vercel Cron: drains the notification queue every 30 seconds. `--once` for a single pass. */
async function main() {
  const once = process.argv.includes("--once");
  do {
    const stats = await processDueJobs();
    if (stats.sent || stats.suppressed || stats.failed) console.log(new Date().toISOString(), stats);
    if (once) break;
    await new Promise((r) => setTimeout(r, 30_000));
  } while (true);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
