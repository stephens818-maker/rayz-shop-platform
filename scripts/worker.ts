import "dotenv/config";
import { installLogScrubbing } from "@/lib/sensitive";
import { closeDb } from "@/db";
import { processDueJobs } from "@/server/notifications/queue";
import { extendSeries } from "@/server/block-series";
import { runAbWinners } from "@/server/marketing/engine";
import { sendBadgeNotices } from "@/server/customer-badges";
import { runJobs } from "@/server/jobs";
import { runMilestones } from "@/server/milestones/engine";

/** Local stand-in for Vercel Cron: writes recurring blocks ahead, retries or flags call-in outreach, works background tasks (rollups, campaign triggers and nudges per location, badge slices, blasts and sequences, scheduled reports, tip payout drafts), decides A/B tests, queues Badge news, records staff milestones hourly, and drains the notification queue every 30 seconds. `--once` for a single pass. */
async function main() {
  installLogScrubbing();
  const once = process.argv.includes("--once");
  let milestonesAt = 0;
  do {
    const written = await extendSeries();
    if (written) console.log(new Date().toISOString(), { recurringBlocks: written });
    const abWinners = await runAbWinners(new Date());
    if (abWinners.queued || abWinners.failed) console.log(new Date().toISOString(), { abWinners });
    const jobs = await runJobs(new Date(), { budgetMs: 20_000 });
    if (jobs.done || jobs.failed) console.log(new Date().toISOString(), { jobs });
    const badgeNews = await sendBadgeNotices();
    if (badgeNews.queued) console.log(new Date().toISOString(), { badgeNews });
    if (Date.now() - milestonesAt >= 3_600_000) {
      milestonesAt = Date.now();
      const milestones = await runMilestones(new Date());
      if (milestones.recorded) console.log(new Date().toISOString(), { milestones });
    }
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
