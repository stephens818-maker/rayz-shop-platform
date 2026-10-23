import { describe, expect, it } from "vitest";
import { ReceiptBrandingSchema, receiptBranding } from "@/domain/connect";
import { receiptConsent } from "@/domain/receipts";
import { ReviewFollowUpSchema, googleReviewLink, isAutomatedOpen, reviewFollowUp, reviewRequestEmail, reviewRequestSms, storedReviewLink, writeReviewUrl } from "@/domain/reviews";

const PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";
const url = (raw: string) => {
  const r = googleReviewLink(raw);
  return r.ok ? r.url : `error: ${r.message}`;
};

describe("Google review link", () => {
  it("takes a g.page share link, with or without /review", () => {
    expect(url("https://g.page/r/CQx1rayzEAE/review")).toBe("https://g.page/r/CQx1rayzEAE/review");
    expect(url("https://g.page/r/CQx1rayzEAE")).toBe("https://g.page/r/CQx1rayzEAE/review");
    expect(url("g.page/r/CQx1rayzEAE/review/")).toBe("https://g.page/r/CQx1rayzEAE/review");
    expect(url("http://www.g.page/r/CQx1rayzEAE?utm_source=x")).toBe("https://g.page/r/CQx1rayzEAE/review");
  });

  it("takes a writereview link and keeps only the Place ID", () => {
    expect(url(`https://search.google.com/local/writereview?placeid=${PLACE}`)).toBe(writeReviewUrl(PLACE));
    expect(url(`search.google.com/local/writereview?hl=en&placeid=${PLACE}&utm_campaign=y`)).toBe(writeReviewUrl(PLACE));
  });

  it("turns a bare Place ID into the write-review link", () => {
    expect(url(`  ${PLACE}  `)).toBe(`https://search.google.com/local/writereview?placeid=${PLACE}`);
  });

  it("blank is no link", () => {
    expect(googleReviewLink("")).toEqual({ ok: true, url: null });
    expect(googleReviewLink("   ")).toEqual({ ok: true, url: null });
    expect(googleReviewLink(null)).toEqual({ ok: true, url: null });
  });

  it("refuses anything that isn't Google's review page", () => {
    for (const bad of [
      "https://www.yelp.com/writeareview/biz/rayz",
      "javascript:alert(1)",
      "https://g.page.evil.com/r/CQx1rayzEAE/review",
      "https://evil.com/?u=https://g.page/r/CQx1rayzEAE",
      "https://g.page/rayz-coralville",
      "https://search.google.com/local/writereview",
      "https://search.google.com/local/writereview?placeid=<script>",
      "https://www.google.com/maps/place/Rayz",
      "ftp://g.page/r/CQx1rayzEAE",
      "short",
    ]) {
      expect(googleReviewLink(bad).ok, bad).toBe(false);
    }
  });

  it("stored settings that aren't a Google link mean no button", () => {
    expect(storedReviewLink("https://example.com/review")).toBeNull();
    expect(receiptBranding({ reviewUrl: "https://example.com/review" }).reviewUrl).toBeNull();
    expect(receiptBranding({ reviewUrl: PLACE }).reviewUrl).toBe(writeReviewUrl(PLACE));
  });

  it("settings save the normalized link", () => {
    expect(ReceiptBrandingSchema.parse({ reviewUrl: "g.page/r/CQx1rayzEAE" }).reviewUrl).toBe("https://g.page/r/CQx1rayzEAE/review");
    expect(() => ReceiptBrandingSchema.parse({ reviewUrl: "https://example.com" })).toThrow(/Google review link/);
  });
});

describe("review follow-up settings", () => {
  it("is off by default: 3 hours after paying, at most every 90 days", () => {
    expect(reviewFollowUp(undefined)).toEqual({ enabled: false, delayHours: 3, repeatDays: 90 });
    expect(receiptBranding({}).reviewFollowUp).toEqual({ enabled: false, delayHours: 3, repeatDays: 90 });
  });

  it("keeps the delay and repeat limit in range", () => {
    expect(ReviewFollowUpSchema.safeParse({ enabled: true, delayHours: 0 }).success).toBe(false);
    expect(ReviewFollowUpSchema.safeParse({ enabled: true, delayHours: 49 }).success).toBe(false);
    expect(ReviewFollowUpSchema.safeParse({ enabled: true, delayHours: 2.5 }).success).toBe(false);
    expect(ReviewFollowUpSchema.safeParse({ enabled: true, repeatDays: 366 }).success).toBe(false);
    expect(ReviewFollowUpSchema.parse({ enabled: true, delayHours: 48, repeatDays: 0 })).toEqual({ enabled: true, delayHours: 48, repeatDays: 0 });
    expect(reviewFollowUp({ enabled: true, delayHours: 500 })).toEqual({ enabled: false, delayHours: 3, repeatDays: 90 });
  });
});

describe("review request wording", () => {
  const link = "https://rayz.example/receipt/tok/review";

  it("asks everyone the same way, for an honest review", () => {
    const sms = reviewRequestSms({ title: "Ray'z Coralville", firstName: "Riley", url: link });
    expect(sms).toBe(`Hi Riley, thanks for visiting Ray'z Coralville. We'd appreciate an honest review on Google: ${link} Reply STOP to opt out.`);
    expect(reviewRequestSms({ title: "Ray'z Coralville", firstName: null, url: link })).toMatch(/^Thanks for visiting/);
    const e = reviewRequestEmail({ title: "Ray'z Coralville", firstName: "Riley", url: link, receiptUrl: "https://rayz.example/receipt/tok", footer: "Ray'z" });
    expect(e.subject).toBe("Review your visit to Ray'z Coralville on Google");
    expect(e.body).toContain(link);
    expect(e.body).toContain("the option to stop these emails: https://rayz.example/receipt/tok");
    // No gating: nothing that filters or steers by how the visit went.
    for (const text of [sms, e.subject, e.body]) {
      expect(text).not.toMatch(/happy|5[- ]?star|five[- ]star|positive|not satisfied|unhappy|let us know first|contact us instead/i);
    }
  });
});

describe("review request consent", () => {
  const base = { channel: "sms" as const, purpose: "review" as const, optedOut: false, optedIn: false, chosenForSale: false };

  it("needs the client to have agreed to texts or emails", () => {
    expect(receiptConsent({ ...base, optedIn: true }).ok).toBe(true);
    expect(receiptConsent(base)).toMatchObject({ ok: false, code: "no_consent" });
  });

  it("choosing a receipt or staff typing a number isn't consent", () => {
    expect(receiptConsent({ ...base, chosenForSale: true }).ok).toBe(false);
    expect(receiptConsent({ ...base, typed: true }).ok).toBe(false);
  });

  it("an opt-out wins over agreeing", () => {
    expect(receiptConsent({ ...base, optedIn: true, optedOut: true })).toMatchObject({ ok: false, code: "opted_out" });
    expect(receiptConsent({ ...base, channel: "email", optedIn: true, optedOut: true })).toMatchObject({ ok: false, code: "opted_out" });
  });
});

describe("automated link opens", () => {
  it("doesn't count previews and scanners as clicks", () => {
    for (const ua of [null, "", "facebookexternalhit/1.1", "WhatsApp/2.23", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.4.0", "Proofpoint URL Defense"]) {
      expect(isAutomatedOpen(ua), String(ua)).toBe(true);
    }
  });

  it("counts a phone or desktop browser", () => {
    expect(isAutomatedOpen("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isAutomatedOpen("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe(false);
  });
});
