/**
 * Demo databases loaded before Stripe Connect: gives each shop with card history a simulated,
 * onboarded connected account and routes that history to it. Safe to run again. Never run on real data.
 */
import "dotenv/config";
import { closeDb } from "@/db";
import { simulateConnectHistory } from "@/server/payments/connect";

async function main() {
  if (process.env.DEMO_MODE !== "true") throw new Error("demo-connect only runs with DEMO_MODE=true");
  const n = await simulateConnectHistory();
  console.log(n ? `Stripe Connect: gave ${n} demo shops a simulated account.` : "Stripe Connect: every demo shop with card history already has an account.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
