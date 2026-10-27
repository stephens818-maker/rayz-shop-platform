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

describe("I10: one charge path, so switching to separate charges and transfers is one change", () => {
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

  it("the destination (on_behalf_of, transfer_data) is set only there", () => {
    expect(where(/\b(on_behalf_of|transfer_data)\s*:/)).toEqual(["server/payments/processor.ts"]);
  });

  it("no transfer or payout to a connected account is created outside money-movement", () => {
    expect(where(/\b(transfers|payouts)\.create\w*\(/).filter((p) => p !== "server/payments/money-movement.ts")).toEqual([]);
  });

  describe("FEATURE_TIP_TO_BARBER", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("is off unless exactly true", () => {
      vi.stubEnv("FEATURE_TIP_TO_BARBER", "");
      expect(flags.tipToBarber()).toBe(false);
      for (const v of ["1", "yes", "TRUE", "on"]) {
        vi.stubEnv("FEATURE_TIP_TO_BARBER", v);
        expect(flags.tipToBarber()).toBe(false);
      }
      vi.stubEnv("FEATURE_TIP_TO_BARBER", "true");
      expect(flags.tipToBarber()).toBe(true);
    });

    it("isn't set in .env.example", () => {
      const env = readFileSync(resolve(__dirname, "../.env.example"), "utf8");
      expect(env).toMatch(/^# FEATURE_TIP_TO_BARBER=$/m);
      expect(env).not.toMatch(/^FEATURE_TIP_TO_BARBER=/m);
    });
  });
});
