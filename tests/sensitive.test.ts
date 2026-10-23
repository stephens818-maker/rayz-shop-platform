/**
 * Card numbers, bank details, SSNs, EINs, birth dates for identity checks and ID documents are
 * collected only by Stripe. These rules remove them from logs, the audit log and free text if they
 * ever turn up, and the schema has nowhere to keep them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { REMOVED, findSensitive, installLogScrubbing, isForbiddenKey, luhn, scrub, scrubText } from "@/lib/sensitive";

describe("scrubText", () => {
  it("removes card numbers that pass the Luhn check, however they're spaced", () => {
    expect(scrubText("card 4242424242424242 ok")).toBe(`card ${REMOVED.card} ok`);
    expect(scrubText("4000 0566 5566 5556")).toBe(REMOVED.card);
    expect(scrubText("5555-5555-5555-4444.")).toBe(`${REMOVED.card}.`);
    expect(scrubText("amex 3782 822463 10005")).toBe(`amex ${REMOVED.card}`);
    expect(scrubText("378282246310005")).toBe(REMOVED.card);
  });

  it("removes SSNs and EINs written with dashes or spaces", () => {
    expect(scrubText("SSN 123-45-6789, alt 123 45 6789")).toBe(`SSN ${REMOVED.ssn}, alt ${REMOVED.ssn}`);
    expect(scrubText("EIN: 12-3456789")).toBe(`EIN: ${REMOVED.ein}`);
  });

  it("leaves everything else alone: prices, dates, phones, timestamps, gift card codes and IDs", () => {
    for (const s of [
      "Paid $45.00 on 2026-10-23 at 14:05",
      "Call +13195550188 or (319) 555-0188",
      "at 1792860000000",
      "order 4000056655665557",
      "gift card AB2C-3456-7892-3456",
      "pi_4242424242424242 and cus_123-45-6789",
      "8b0e6a1c-2345-6789-2345-678901234567",
      "clocked in at 41.5602, -91.53012345678901234",
      "ratio 0.4242424242424242",
      "123-45 6789",
      "x-12-3456789",
      "no digits at all",
    ])
      expect(scrubText(s)).toBe(s);
  });

  it("luhn", () => {
    expect(luhn("4242424242424242")).toBe(true);
    expect(luhn("4242424242424241")).toBe(false);
  });
});

describe("scrub and findSensitive", () => {
  const stripeish = {
    id: "acct_1",
    external_account: { object: "bank_account", routing_number: "110000000", account_number: "000123456789", last4: "6789", bank_name: "STRIPE TEST BANK" },
    individual: { ssn_last_4: "6789", id_number: "987654321", dob: { day: 1, month: 1, year: 1901 }, verification: { document: { front: "file_123" } } },
    company: { tax_id: "000000000", "Tax ID": "x" },
    payment_method: { card: { number: "4242424242424242", cvc: "123", last4: "4242", brand: "visa" } },
    camel: { routingNumber: "1", accountNumber: "2", cardNumber: "3", dateOfBirth: "4", socialSecurityNumber: "5", ein: "6", iban: "7" },
    note: "Client said 4000 0566 5566 5556",
    amounts: [4242424242424242, 4500, 1792860000000],
    birthday: "1990-07-14",
  };

  it("removes forbidden keys wherever they are, keeps last 4, bank and brand names", () => {
    const out = scrub(stripeish);
    expect(out.external_account).toEqual({ object: "bank_account", routing_number: REMOVED.key, account_number: REMOVED.key, last4: "6789", bank_name: "STRIPE TEST BANK" });
    // A Stripe file ID; the ID image itself stays with Stripe.
    expect(out.individual).toEqual({ ssn_last_4: REMOVED.key, id_number: REMOVED.key, dob: REMOVED.key, verification: { document: { front: "file_123" } } });
    expect(scrub({ verificationDocument: "x", document_back: "y" })).toEqual({ verificationDocument: REMOVED.key, document_back: REMOVED.key });
    expect(out.company).toEqual({ tax_id: REMOVED.key, "Tax ID": REMOVED.key });
    expect(out.payment_method.card).toEqual({ number: REMOVED.card, cvc: REMOVED.key, last4: "4242", brand: "visa" });
    expect(Object.values(out.camel)).toEqual(Array(7).fill(REMOVED.key));
    expect(out.note).toBe(`Client said ${REMOVED.card}`);
    expect(out.amounts).toEqual([REMOVED.card, 4500, 1792860000000]);
    expect(out.birthday).toBe("1990-07-14");
    expect(JSON.stringify(out)).not.toMatch(/110000000|000123456789|987654321|1901|4242424242424242|5556/);
    expect(stripeish.external_account.routing_number).toBe("110000000");
  });

  it("reports what it would remove", () => {
    const paths = findSensitive(stripeish).map((f) => `${f.path} ${f.why}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "$.external_account.routing_number forbidden key",
        "$.individual.dob forbidden key",
        "$.company.tax_id forbidden key",
        "$.payment_method.card.number card number",
        "$.note card number",
        "$.amounts.0 card number",
      ]),
    );
    expect(findSensitive(scrub(stripeish)).filter((f) => f.why !== "forbidden key")).toEqual([]);
    expect(findSensitive({ last4: "4242", brand: "visa", bankName: "Chase", stripeAccountId: "acct_1", birthday: "1990-07-14", total: 4500 })).toEqual([]);
  });

  it("scrubs errors, their causes and properties, and survives cycles", () => {
    const e = Object.assign(new Error("Card 4242 4242 4242 4242 declined"), { raw: { routing_number: "110000000" } });
    (e as Error & { cause?: unknown }).cause = new Error("SSN 123-45-6789");
    const out = scrub(e);
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe(`Card ${REMOVED.card} declined`);
    expect(out.stack).not.toMatch(/4242/);
    expect((out as unknown as { raw: object }).raw).toEqual({ routing_number: REMOVED.key });
    expect(((out as Error & { cause: Error }).cause as Error).message).toBe(`SSN ${REMOVED.ssn}`);
    const loop: Record<string, unknown> = { note: "123-45-6789" };
    loop.self = loop;
    const l = scrub(loop);
    expect(l.note).toBe(REMOVED.ssn);
    expect(l.self).toBe(l);
    const d = new Date();
    expect(scrub({ d }).d).toBe(d);
  });
});

describe("log scrubbing", () => {
  it("every console method scrubs its arguments, installed once", () => {
    const lines: unknown[][] = [];
    const fake = Object.fromEntries(["log", "info", "warn", "error", "debug", "trace"].map((k) => [k, (...a: unknown[]) => lines.push([k, ...a])])) as unknown as Console;
    installLogScrubbing(fake);
    installLogScrubbing(fake);
    fake.log("sms body: card 4242424242424242");
    fake.error(new Error("tax 12-3456789"), { bank: { account_number: "000123456789" } });
    fake.warn("ok", 42);
    expect(lines[0]).toEqual(["log", `sms body: card ${REMOVED.card}`]);
    expect((lines[1][1] as Error).message).toBe(`tax ${REMOVED.ein}`);
    expect(lines[1][2]).toEqual({ bank: { account_number: REMOVED.key } });
    expect(lines[2]).toEqual(["warn", "ok", 42]);
    expect(JSON.stringify(lines)).not.toMatch(/4242424242424242|000123456789/);
  });

  it("the server installs it on the real console at startup", async () => {
    const seen: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void seen.push(...a);
    try {
      await (await import("@/instrumentation")).register();
      console.error("SSN 123-45-6789");
    } finally {
      console.error = original;
    }
    expect(seen).toEqual([`SSN ${REMOVED.ssn}`]);
  });

  it("the worker installs it too", () => {
    expect(readFileSync("scripts/worker.ts", "utf8")).toMatch(/installLogScrubbing\(\)/);
  });
});

describe("the schema has nowhere to keep them", () => {
  /** The shop's customer number at a supplier, printed on purchase orders; not a bank account. */
  const ALLOWED = new Set(["vendors.account_number", "shop_vendors.account_number"]);

  function schemaColumns(): string[] {
    const src = readFileSync("src/db/schema.ts", "utf8");
    const tables = [...src.matchAll(/pgTable\(\s*"(\w+)"/g)];
    return tables.flatMap((t, i) => {
      const body = src.slice(t.index, tables[i + 1]?.index ?? src.length);
      return [...body.matchAll(/\b[a-z]\w*\(\s*"(\w+)"/g)].filter((c) => c[0] !== t[0]).map((c) => `${t[1]}.${c[1]}`);
    });
  }

  function migrationColumns(): string[] {
    return readdirSync("drizzle")
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) => {
        const sql = readFileSync(`drizzle/${f}`, "utf8");
        const created = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(\w+)" \(([\s\S]*?)\n\);/g)].flatMap((t) => [...t[2].matchAll(/^\s*"(\w+)" /gm)].map((c) => `${t[1]}.${c[1]}`));
        const added = [...sql.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN (?:IF NOT EXISTS )?"(\w+)"/g)].map((c) => `${c[1]}.${c[2]}`);
        const renamed = [...sql.matchAll(/ALTER TABLE "(\w+)" RENAME COLUMN "\w+" TO "(\w+)"/g)].map((c) => `${c[1]}.${c[2]}`);
        return [...created, ...added, ...renamed];
      });
  }

  it("no column in the schema or any migration is a card, bank, SSN, TIN, EIN, birth date or ID document field", () => {
    const cols = [...schemaColumns(), ...migrationColumns()];
    expect(cols.length).toBeGreaterThan(500);
    expect(cols).toContain("staff_payout_accounts.destination_last4");
    expect(cols.filter((c) => isForbiddenKey(c.split(".")[1]) && !ALLOWED.has(c))).toEqual([]);
  });

  it("no JSON column's type has such a property either", () => {
    const src = readFileSync("src/db/schema.ts", "utf8");
    const props = [...src.matchAll(/\b(\w+)\??:\s/g)].map((p) => p[1]);
    expect(props.filter((p) => isForbiddenKey(p) && p !== "accountNumber")).toEqual([]);
    expect(props.filter((p) => p === "accountNumber")).toHaveLength(2);
  });

  it("the allowed names are what they say: a supplier account number, and a birthday for greetings", () => {
    expect(isForbiddenKey("account_number")).toBe(true);
    expect(isForbiddenKey("birthday")).toBe(false);
    expect(readFileSync("src/app/admin/vendors/forms.tsx", "utf8")).toMatch(/text\("accountNumber", "Our account number"\)/);
  });
});

describe("SAQ-A: card data only in Stripe's own fields", () => {
  it("no page has an input for a card, bank, SSN, EIN or birth-date number", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(`${d}/${f.name}`);
        else if (f.name.endsWith(".tsx")) files.push(`${d}/${f.name}`);
      }
    };
    walk("src/app");
    walk("src/components");
    const offending = files.filter((f) => /<(Input|input)\b[^>]*\b(name|id|autoComplete)="(cc-number|cc-csc|cc-exp|card_?number|routing\w*|account_?number|ssn|tax_?id|ein|dob)"/i.test(readFileSync(f, "utf8")));
    expect(offending).toEqual([]);
    const sim = readFileSync("src/app/admin/setup/panels.tsx", "utf8");
    expect(sim).not.toMatch(/110000000|000123456789|1901-01-01|"000000000"/);
  });

  it("keyed cards go through the Payment Element, cards only, and checkout gets a Stripe-only CSP in production", async () => {
    const card = readFileSync("src/app/admin/checkout/[saleId]/stripe-card.tsx", "utf8");
    expect(card).toMatch(/<PaymentElement/);
    expect(card).toMatch(/allowedPaymentMethodTypes: \["card"\]/);
    const { CHECKOUT_CSP } = await import("../next.config");
    expect(CHECKOUT_CSP).toMatch(/frame-src https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com https:\/\/hooks\.stripe\.com/);
    expect(CHECKOUT_CSP).toMatch(/frame-ancestors 'none'/);
    expect(CHECKOUT_CSP).not.toMatch(/\*(?!\.)|unsafe-eval/);
    vi.stubEnv("NODE_ENV", "production");
    try {
      const cfg = (await import("../next.config")).default;
      expect(await cfg.headers!()).toEqual([{ source: "/admin/checkout/:path*", headers: [{ key: "Content-Security-Policy", value: CHECKOUT_CSP }] }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
