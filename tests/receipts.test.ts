import { describe, expect, it } from "vitest";
import { ReceiptBrandingSchema, receiptBranding } from "@/domain/connect";
import { barberFirstName, cardLabel, receiptConsent, receiptEmail, receiptListSms, receiptSms, tenderLabel } from "@/domain/receipts";

const base = { channel: "sms" as const, optedOut: false, optedIn: false, chosenForSale: false };

describe("receipt consent", () => {
  it("an opt-out always wins, even when the client asks at checkout", () => {
    for (const purpose of ["counter", "handoff", "request", "resend", "refund", "void"] as const) {
      const r = receiptConsent({ ...base, purpose, optedOut: true, optedIn: true, chosenForSale: true, typed: true });
      expect(r).toMatchObject({ ok: false, code: "opted_out" });
    }
    expect(receiptConsent({ ...base, channel: "email", purpose: "counter", optedOut: true })).toMatchObject({ ok: false, message: expect.stringMatching(/receipt emails/) });
  });

  it("the client choosing it is consent for that receipt", () => {
    for (const purpose of ["counter", "handoff", "request"] as const) expect(receiptConsent({ ...base, purpose })).toEqual({ ok: true });
  });

  it("updates and resends go where the client chose for the ticket, or where they agreed to messages", () => {
    expect(receiptConsent({ ...base, purpose: "refund" })).toMatchObject({ ok: false, code: "no_consent" });
    expect(receiptConsent({ ...base, purpose: "refund", chosenForSale: true })).toEqual({ ok: true });
    expect(receiptConsent({ ...base, purpose: "void", optedIn: true })).toEqual({ ok: true });
    expect(receiptConsent({ ...base, purpose: "resend" })).toMatchObject({ ok: false, code: "no_consent" });
    expect(receiptConsent({ ...base, purpose: "resend", typed: true })).toEqual({ ok: true });
    expect(receiptConsent({ ...base, purpose: "refund", typed: true })).toMatchObject({ ok: false });
  });
});

describe("receipt wording", () => {
  it("shows the card's brand and last 4 only", () => {
    expect(cardLabel("visa", "4242")).toBe("Visa •••• 4242");
    expect(cardLabel(null, null)).toBe("Card");
    expect(cardLabel("amex", "4111111111111111")).toBe("Amex");
    expect(tenderLabel({ method: "gift_card" })).toBe("Gift card");
    expect(tenderLabel({ method: "cash" })).toBe("Cash");
  });

  it("uses the barber's first name", () => {
    expect(barberFirstName({ firstName: "Taylor", displayLabel: "Taylor R." })).toBe("Taylor");
    expect(barberFirstName({ displayLabel: "Taylor R." })).toBe("Taylor");
    expect(barberFirstName(null)).toBeNull();
  });

  it("texts a short link, and says what changed on an update", () => {
    const url = `https://rayz.example/receipt/${"a".repeat(43)}`;
    const title = "Ray'z Barber Shop · " + "x".repeat(40);
    const sms = receiptSms({ title, number: 1042, totalCents: 4512, url });
    expect(sms).toContain("$45.12");
    expect(sms).toContain(url);
    expect(sms).toMatch(/Reply STOP/);
    expect(sms.length).toBeLessThanOrEqual(306);
    expect(receiptSms({ title, number: 1042, totalCents: 4512, url, update: { kind: "refund", refundedCents: 500 } })).toMatch(/^Updated receipt.*\$5\.00 was refunded/);
    expect(receiptSms({ title, number: 1042, totalCents: 4512, url, update: { kind: "void" } })).toMatch(/voided/);
    expect(receiptListSms({ title: "Ray'z", items: [{ date: "Oct 3", totalCents: 100, url }] })).toContain(`Oct 3 $1.00: ${url}`);
  });

  it("emails the itemized receipt with the link", () => {
    const e = receiptEmail({
      title: "Ray'z Barber Shop · Coralville",
      number: 7,
      when: "Fri, Oct 23 2:00 PM",
      barber: "Michelle",
      lines: [{ name: "Cut", qty: 1, cents: 3300 }],
      discounts: [{ label: "Promo", cents: 300 }],
      taxCents: 210,
      tipCents: 600,
      fee: { label: "Credit card surcharge (3%)", cents: 120 },
      totalCents: 3930,
      tenders: [{ label: "Visa •••• 4242", cents: 3930 }],
      refunds: [],
      loyalty: "Loyalty: $33.00 of $300.00 toward your next $15.00 reward.",
      footer: "Thanks",
      url: "https://x/receipt/t",
    });
    expect(e.subject).toBe("Your receipt from Ray'z Barber Shop · Coralville");
    for (const line of ["Barber: Michelle", "Promo  -$3.00", "Tax  $2.10", "Tip  $6.00", "Credit card surcharge (3%)  $1.20", "Total  $39.30", "Paid with Visa •••• 4242  $39.30", "Loyalty:", "https://x/receipt/t"]) {
      expect(e.body).toContain(line);
    }
  });
});

describe("receipt settings", () => {
  it("paper is off and there's no review button by default", () => {
    expect(receiptBranding({})).toMatchObject({ allowPrint: false, reviewUrl: null });
    expect(receiptBranding({ reviewUrl: "" }).reviewUrl).toBeNull();
  });

  it("takes only an https review link", () => {
    expect(ReceiptBrandingSchema.parse({ reviewUrl: "https://g.page/r/abc/review" }).reviewUrl).toBe("https://g.page/r/abc/review");
    expect(() => ReceiptBrandingSchema.parse({ reviewUrl: "javascript:alert(1)" })).toThrow();
    expect(() => ReceiptBrandingSchema.parse({ reviewUrl: "http://example.com" })).toThrow();
  });
});
