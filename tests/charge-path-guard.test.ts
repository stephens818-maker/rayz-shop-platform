import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/lib/flags";

const SRC = resolve(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

const files = walk(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }));
const where = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.path);

describe("I10: one charge path, separate charges and transfers", () => {
  it("a PaymentIntent is created in exactly one place, chargeCard", () => {
    expect(where(/paymentIntents\.create\(/)).toEqual(["server/payments/processor.ts"]);
    const text = files.find((f) => f.path === "server/payments/processor.ts")!.text;
    expect(text.match(/paymentIntents\.create\(/g)).toHaveLength(1);
    const start = text.indexOf("export async function chargeCard(");
    const end = text.indexOf("\nexport ", start + 1);
    const at = text.indexOf("paymentIntents.create(");
    expect(start).toBeGreaterThan(-1);
    expect(at > start && (end < 0 || at < end)).toBe(true);
  });

  it("no charge settles to a connected account any more: on_behalf_of, transfer_data and application_fee_amount are set nowhere", () => {
    expect(where(/\b(on_behalf_of|transfer_data|application_fee_amount)\s*:/)).toEqual([]);
  });

  it("a refund never reverses a transfer with the charge: reverse_transfer and refund_application_fee are set nowhere, so a tip is never clawed back", () => {
    expect(where(/\b(reverse_transfer|refund_application_fee)\s*:/)).toEqual([]);
    expect(where(/\breverseTransfer\b/)).toEqual([]);
  });

  it("payment_transfers replaced payments.stripe_transfer_id: nothing reads or writes it", () => {
    expect(where(/payments\.stripeTransferId|stripeTransferId:\s*c\?\.transferId|from payments where stripe_transfer_id/)).toEqual([]);
  });

  it("chargeCard sets the sale's transfer_group, and only money-movement transfers, with source_transaction", () => {
    expect(where(/\btransfer_group\s*:/)).toEqual(["server/payments/money-movement.ts", "server/payments/processor.ts"]);
    expect(where(/\bsource_transaction\s*:/)).toEqual(["server/payments/money-movement.ts"]);
    const text = files.find((f) => f.path === "server/payments/processor.ts")!.text;
    const start = text.indexOf("export async function chargeCard(");
    expect(text.slice(start, text.indexOf("\nexport ", start + 1))).toMatch(/transfer_group: opts\.transferGroup/);
  });

  it("no transfer, reversal or payout is created outside money-movement", () => {
    expect(where(/\b(transfers|payouts)\.create\w*\(/).filter((p) => p !== "server/payments/money-movement.ts")).toEqual([]);
  });

  it("the transfers of a sale and their reversals are sent only by the settlement module", () => {
    expect(where(/\b(createSaleTransfer|reverseShopTransfer)\(/).sort()).toEqual(["server/payments/money-movement.ts", "server/payments/settlement.ts"]);
  });

  it("shops' connected accounts are Express (a dashboard for the transfers they receive); barbers' are recipient accounts with no dashboard, never Express", () => {
    const connect = files.find((f) => f.path === "server/payments/connect.ts")!.text;
    expect(connect.match(/stripe_dashboard: \{ type: "(\w+)" \}/g)).toEqual(['stripe_dashboard: { type: "express" }', 'stripe_dashboard: { type: "express" }']);
    const tips = files.find((f) => f.path === "server/tips/accounts.ts")!.text;
    expect(tips.match(/stripe_dashboard: \{ type: "(\w+)" \}/g)).toEqual(['stripe_dashboard: { type: "none" }']);
    expect(tips).toMatch(/tos_acceptance: \{ service_agreement: "recipient" \}/);
    expect(where(/\baccounts\s*\.create\(/).sort()).toEqual(["server/payments/connect.ts", "server/tips/accounts.ts"]);
    expect(where(/type: "express"/).sort()).toEqual(["server/payments/connect.ts"]);
  });

  describe("FEATURE_TIP_TO_BARBER", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("is on at launch, unset or not, and only false turns it off", () => {
      vi.stubEnv("FEATURE_TIP_TO_BARBER", undefined);
      expect(flags.tipToBarber()).toBe(true);
      for (const v of ["", "true", "1", "no", "off"]) {
        vi.stubEnv("FEATURE_TIP_TO_BARBER", v);
        expect(flags.tipToBarber()).toBe(true);
      }
      for (const v of ["false", "FALSE", " false "]) {
        vi.stubEnv("FEATURE_TIP_TO_BARBER", v);
        expect(flags.tipToBarber()).toBe(false);
      }
    });

    it("is only an example in .env.example, so a copy keeps it on", () => {
      const env = readFileSync(resolve(__dirname, "../.env.example"), "utf8");
      expect(env).toMatch(/^# FEATURE_TIP_TO_BARBER=false$/m);
      expect(env).not.toMatch(/^FEATURE_TIP_TO_BARBER=/m);
    });
  });
});
