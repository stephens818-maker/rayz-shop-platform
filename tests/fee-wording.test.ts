/**
 * Customer-facing and admin fee copy says credit card fee. A saved notice or footer that still
 * says surcharge is shown as credit card fee. The settings and receipt pages don't say surcharge.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { creditCardFeeWording, feeDisclosure, feeLabel } from "@/domain/checkout";
import { receiptEmail } from "@/domain/receipts";

const PAGES = [
  "src/app/admin/taxes/page.tsx",
  "src/app/admin/card-fee/client.tsx",
  "src/app/admin/card-fee/actions.ts",
  "src/app/admin/settings/card-fee-editor.tsx",
  "src/app/admin/settings/actions.ts",
  "src/app/admin/sales/[id]/page.tsx",
  "src/app/receipt/[token]/page.tsx",
  "src/domain/receipts.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p;
  });
}

function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** String literals and one-line JSX text. Code names such as SURCHARGE_BLOCKED_STATES are not copy. */
function visibleCopy(src: string) {
  const no = stripComments(src);
  const strings = [...no.matchAll(/`(?:\\[\s\S]|[^`])*`|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'/g)].map((m) => m[0]);
  const jsx = [...no.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1]);
  return [...strings, ...jsx].join("\n");
}

describe("credit card fee wording", () => {
  it("shows a saved notice and receipt footer as credit card fee", () => {
    const notice = feeDisclosure({ enabled: true, rate: 0.03, appliesToTip: false, notice: "A {fee} surcharge applies to credit cards." });
    expect(notice).toBe("A 3% credit card fee applies to credit cards.");
    expect(feeLabel({ rate: 0.03, name: "Credit card surcharge" })).toBe("Credit card fee (3%)");
    expect(creditCardFeeWording("Credit card surcharge (3%): $1.20")).toBe("Credit card fee (3%): $1.20");
    const email = receiptEmail({
      title: "Ray'z",
      number: 1,
      when: "Fri",
      barber: null,
      lines: [],
      discounts: [],
      taxCents: 0,
      tipCents: 0,
      fee: { label: "Credit card surcharge (3%)", cents: 120 },
      feeNotice: "A 3% surcharge applies.",
      totalCents: 120,
      tenders: [],
      refunds: [],
      loyalty: null,
      footer: "Credit card surcharge (3%): $1.20",
      url: "https://x",
    });
    const rendered = `${notice}\n${email.body}`;
    expect(rendered).not.toMatch(/surcharge/i);
    expect(rendered).toContain("Credit card fee (3%): $1.20");
  });

  it("the notice, footer, and fee settings pages do not say surcharge", () => {
    const hits = PAGES.filter((f) => /surcharge/i.test(visibleCopy(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
    const app = walk("src/app").filter((f) => /\.(ts|tsx)$/.test(f) && /surcharge/i.test(visibleCopy(readFileSync(f, "utf8"))));
    expect(app).toEqual([]);
  });
});
