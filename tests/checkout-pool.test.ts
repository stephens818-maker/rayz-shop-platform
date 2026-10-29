import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A card charge used to run inside the pay transaction. On Vercel the pool has one connection,
 * so a stuck Stripe call held it and every admin page on that instance waited until the function
 * timed out. The charge now happens after a short claim and before the recording transaction.
 */
describe("checkout does not hold a database connection during the card charge", () => {
  const text = readFileSync(resolve(__dirname, "../src/server/checkout.ts"), "utf8");
  const fn = text.slice(text.indexOf("export async function finalizeSale"));

  it("charges the card before the recording transaction, which never calls chargeCard", () => {
    const chargeAt = fn.indexOf("l.charge = await chargeCard(");
    const recordAt = fn.lastIndexOf("await db.transaction(async (tx: Tx)");
    expect(chargeAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(chargeAt);
    expect(fn.slice(recordAt)).not.toMatch(/chargeCard\(/);
  });

  it("claims the ticket first so a second pay does not wait on Stripe", () => {
    const claimAt = fn.indexOf("await claimSaleForPay(");
    const chargeAt = fn.indexOf("l.charge = await chargeCard(");
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(chargeAt);
  });
});
