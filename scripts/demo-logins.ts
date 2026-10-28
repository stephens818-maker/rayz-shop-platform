/**
 * Demo databases only: adds the launch test plan's accounts (apprentice.test@, bookkeeper.test@,
 * frontdesk2.test@, barber2.test@) to a sandbox seeded before they existed. Adds only the ones that
 * are missing, so it runs on every build. Never run on real data.
 */
import "dotenv/config";
import { closeDb, db } from "@/db";
import { addTestPlanLogins } from "./test-plan-logins";

async function main() {
  if (process.env.DEMO_MODE !== "true") throw new Error("demo-logins only runs with DEMO_MODE=true");
  const added = await addTestPlanLogins(db, process.env.SEED_PASSWORD ?? "rayz2026!");
  console.log(added.length ? `Test plan logins: added ${added.join(", ")}.` : "Test plan logins: all there.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
