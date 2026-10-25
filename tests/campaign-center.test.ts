import { describe, expect, it } from "vitest";
import { DRAFT_TOOL, draftSystemPrompt, normalizeDraft, stubDraftRaw, type DraftCoupon } from "@/domain/campaign-draft";
import { EMPTY_FUNNEL, addFunnel, bySuccess, liftOf, metricDefinitions, pctLabel, rate, ratesOf } from "@/domain/campaign-metrics";
import {
  AbSchema,
  abChanges,
  abGroup,
  blastOccasion,
  bucket,
  inHoldout,
  nextOccurrence,
  occurrence,
  occurrencesBetween,
  optimizedSendAt,
  pickWinner,
  recurrenceLabel,
  recurrenceOf,
  usualMinute,
  variantTemplates,
} from "@/domain/campaign-schedule";
import { CouponInput, couponProblem, couponWhenLabel, type CouponLimits } from "@/domain/coupons";
import { marketingEmailHtml } from "@/domain/marketing-email";
import { CLIENT_STAGES, EMPTY_SEGMENT, MarketingSettingsSchema, SKIP_LABEL, STOP_LINE, SegmentSchema, TRIGGERS, TRIGGER_KEYS, defaultTemplates, stageSegment, templatesProblem, triggerSettings } from "@/domain/marketing";
import { BADGES } from "@/domain/badges";

const TZ = "America/Chicago";

describe("recurring blasts", () => {
  const anchor = new Date("2026-11-03T16:00:00Z"); // Tue 10:00 AM Central

  it("keeps the local time across daylight saving", () => {
    const before = new Date("2026-10-27T15:00:00Z"); // Tue 10:00 CDT
    expect(occurrence(before, "weekly", 1, TZ).toISOString()).toBe("2026-11-03T16:00:00.000Z"); // 10:00 CST
  });

  it("weekly, every 2 weeks and monthly, strictly after a time", () => {
    expect(nextOccurrence({ freq: "weekly", endsOn: null }, anchor, anchor, TZ)?.toISOString()).toBe("2026-11-10T16:00:00.000Z");
    expect(nextOccurrence({ freq: "biweekly", endsOn: null }, anchor, anchor, TZ)?.toISOString()).toBe("2026-11-17T16:00:00.000Z");
    expect(nextOccurrence({ freq: "monthly", endsOn: null }, anchor, anchor, TZ)?.toISOString()).toBe("2026-12-03T16:00:00.000Z");
    expect(nextOccurrence({ freq: "weekly", endsOn: null }, anchor, new Date("2026-11-04T00:00:00Z"), TZ)?.toISOString()).toBe("2026-11-10T16:00:00.000Z");
  });

  it("monthly finds the right send far after the anchor", () => {
    const at = nextOccurrence({ freq: "monthly", endsOn: null }, new Date("2026-01-31T16:00:00Z"), new Date("2027-06-01T00:00:00Z"), TZ)!;
    expect(at.toISOString().slice(0, 10)).toBe("2027-06-30");
  });

  it("stops after the end date (inclusive, local calendar)", () => {
    expect(nextOccurrence({ freq: "weekly", endsOn: "2026-11-10" }, anchor, anchor, TZ)).not.toBeNull();
    expect(nextOccurrence({ freq: "weekly", endsOn: "2026-11-09" }, anchor, anchor, TZ)).toBeNull();
  });

  it("lists the sends in a range for the calendar", () => {
    const xs = occurrencesBetween({ freq: "weekly", endsOn: "2026-11-24" }, anchor, new Date("2026-11-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"), TZ);
    expect(xs.map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"]);
  });

  it("each send is its own occasion; one-time blasts keep 'blast'", () => {
    expect(blastOccasion(anchor, true, TZ)).toBe("blast:2026-11-03");
    expect(blastOccasion(anchor, false, TZ)).toBe("blast");
  });

  it("parses and labels", () => {
    expect(recurrenceOf({ freq: "daily" })).toBeNull();
    const r = recurrenceOf({ freq: "weekly", endsOn: "2026-12-31", anchor: anchor.toISOString() })!;
    expect(recurrenceLabel(r, TZ)).toBe("Every week on Tuesday at 10:00 AM, until Dec 31, 2026");
    expect(recurrenceLabel(null, TZ)).toBe("One time");
  });
});

describe("groups: holdout and A/B", () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `c-${i}`);

  it("hashes are stable and spread evenly", () => {
    expect(bucket("x")).toBe(bucket("x"));
    const held = ids.filter((id) => inHoldout("camp", id, 10)).length;
    expect(held / ids.length).toBeGreaterThan(0.08);
    expect(held / ids.length).toBeLessThan(0.12);
    expect(ids.some((id) => inHoldout("camp", id, 0))).toBe(false);
  });

  it("A/B splits the test share in half; everyone else waits for the winner", () => {
    const g = ids.map((id) => abGroup("camp", id, 20));
    const a = g.filter((x) => x === "a").length / ids.length;
    const b = g.filter((x) => x === "b").length / ids.length;
    expect(a).toBeGreaterThan(0.08);
    expect(a).toBeLessThan(0.12);
    expect(b).toBeGreaterThan(0.08);
    expect(b).toBeLessThan(0.12);
    expect(abGroup("camp", "c-1", 20)).toBe(abGroup("camp", "c-1", 20));
  });

  it("the higher rate wins; a tie keeps A", () => {
    expect(pickWinner({ n: 100, hits: 10 }, { n: 100, hits: 12 })).toBe("b");
    expect(pickWinner({ n: 100, hits: 10 }, { n: 50, hits: 5 })).toBe("a");
    expect(pickWinner({ n: 0, hits: 0 }, { n: 0, hits: 0 })).toBe("a");
  });

  it("variant B lays its fields over A and says what changed", () => {
    const a = defaultTemplates("birthday", false);
    const b = variantTemplates(a, { emailSubject: "Happy birthday!", sms: "  " });
    expect(b.emailSubject).toBe("Happy birthday!");
    expect(b.sms).toBe(a.sms);
    expect(abChanges(a, { emailSubject: "Happy birthday!" })).toEqual(["Email subject"]);
    expect(abChanges(a, { emailSubject: a.emailSubject })).toEqual([]);
  });

  it("A/B settings have bounds", () => {
    expect(AbSchema.safeParse({ testPct: 60 }).success).toBe(false);
    expect(AbSchema.parse({}).waitHours).toBe(4);
  });
});

describe("send-time optimization", () => {
  it("the usual minute is the median, from two bookings", () => {
    expect(usualMinute([600])).toBeNull();
    expect(usualMinute([600, 660])).toBe(630);
    expect(usualMinute([1200, 600, 610])).toBe(610);
  });

  it("waits for the next time it's that minute, within a day", () => {
    const now = new Date("2026-11-03T15:00:00Z"); // 9:00 AM Central
    expect(optimizedSendAt(now, TZ, 10 * 60).toISOString()).toBe("2026-11-03T16:00:00.000Z");
    expect(optimizedSendAt(now, TZ, 8 * 60).toISOString()).toBe("2026-11-04T14:00:00.000Z");
    expect(optimizedSendAt(now, TZ, null)).toBe(now);
  });
});

describe("campaign metrics", () => {
  it("rates are unique-based and never pass 100%; nothing to divide by is null, not 0%", () => {
    expect(rate(174, 100)).toBe(1);
    expect(rate(0, 0)).toBeNull();
    expect(pctLabel(null)).toBe("—");
    expect(pctLabel(0.425)).toBe("42.5%");
    const f = addFunnel(EMPTY_FUNNEL, { sent: 10, delivered: 9, emailDelivered: 4, smsDelivered: 5, uniqueOpens: 3, uniqueClicks: 2, bookers: 1, unsubscribes: 1, optOuts: 1, revenueCents: 5000, costCents: 100 });
    const r = ratesOf(f);
    expect(r.openRate).toBe(0.75);
    expect(r.clickRate).toBeCloseTo(2 / 9);
    expect(r.bookingRate).toBeCloseTo(1 / 9);
    expect(r.unsubscribeRate).toBe(0.25);
    expect(r.optOutRate).toBe(0.2);
    expect(r.roi).toBe(49);
    expect(ratesOf(EMPTY_FUNNEL).openRate).toBeNull();
  });

  it("definitions follow the window and its start", () => {
    expect(metricDefinitions(7, "sent").bookingRate.definition).toMatch(/within 7 days after the message/);
    expect(metricDefinitions(3, "engaged").attributedSales.definition).toMatch(/within 3 days after the client opened or clicked/);
    expect(metricDefinitions(7, "sent").attributedSales.definition).toMatch(/already had an appointment/);
  });

  it("most successful: sales, then booking rate", () => {
    const x = (revenueCents: number, bookers: number) => ({ funnel: { ...EMPTY_FUNNEL, delivered: 10, revenueCents, bookers } });
    expect([x(0, 1), x(500, 0), x(0, 3)].sort(bySuccess).map((r) => [r.funnel.revenueCents, r.funnel.bookers])).toEqual([
      [500, 0],
      [0, 3],
      [0, 1],
    ]);
  });

  it("lift is the treated rate less the holdout rate", () => {
    const l = liftOf({ n: 100, booked: 15 }, { n: 20, booked: 2 });
    expect(l.points).toBeCloseTo(0.05);
    expect(l.incremental).toBe(5);
    expect(liftOf({ n: 100, booked: 15 }, { n: 0, booked: 0 }).points).toBeNull();
  });
});

describe("AI drafts", () => {
  const coupons: DraftCoupon[] = [
    { id: "p1", code: "MISSYOU20", summary: "20% off services", usable: true },
    { id: "p2", code: "OLD10", summary: "10% off services", usable: false },
  ];
  const badges = [{ key: "vip", label: "VIP" }];

  it("the keyword drafter reads who, the offer and the channel", () => {
    const d = normalizeDraft(stubDraftRaw("Win back clients we haven't seen in 8 weeks with 20% off, text only", coupons, badges), { coupons, badges: ["vip"] });
    expect(d.segment.lastVisitOverDays).toBe(56);
    expect(d.segment.notBooked).toBe(true);
    expect(d.promoId).toBe("p1");
    expect(d.campaignType).toBe("promotion");
    expect(d.channels).toEqual(["sms"]);
    expect(d.templates.sms.startsWith("{shop}")).toBe(true);
    expect(d.templates.sms).toContain(STOP_LINE);
    expect(templatesProblem(d.templates, d.channels, { hasCoupon: true })).toBeNull();
  });

  it("the keyword drafter doesn't also require a badge that names the same stage", () => {
    const all = [
      { key: "lapsed", label: "Lapsed" },
      { key: "miss_you", label: "We miss you" },
      { key: "new_client", label: "New client" },
      { key: "due", label: "Due" },
      { key: "vip", label: "VIP" },
      { key: "gold", label: "Gold" },
    ];
    const keys = all.map((b) => b.key);
    const seg = (prompt: string) => normalizeDraft(stubDraftRaw(prompt, coupons, all), { coupons, badges: keys }).segment;
    expect(seg("Win back lapsed clients with 20% off")).toMatchObject({ lastVisitOverDays: 42, notBooked: true, badges: [] });
    expect(seg("We miss you note for clients we haven't seen")).toMatchObject({ lastVisitOverDays: 42, badges: [] });
    expect(seg("Welcome offer for new clients")).toMatchObject({ firstVisitWithinDays: 30, badges: [] });
    expect(seg("Nudge clients who are due for a cut")).toMatchObject({ visitStatus: ["due", "overdue"], badges: [] });
    expect(seg("Thank our VIP clients")).toMatchObject({ minVisits: null, badges: ["vip"] });
    expect(seg("Lapsed Gold members, come back")).toMatchObject({ lastVisitOverDays: 42, badges: ["gold"] });
  });

  it("never attaches an unusable or invented coupon, drops unknown fields and badges, adds the opt-out line", () => {
    const d = normalizeDraft(
      {
        name: "X",
        campaignType: "promotion",
        channels: ["sms", "email"],
        templates: { sms: "Hi {first_name} use {coupon_code} {ssn}", emailSubject: "Hi", emailBody: "Body", pushTitle: "", pushBody: "" },
        audience: { badges: ["vip", "secret"], minAvgGapDays: 20 },
        couponCode: "OLD10",
      },
      { coupons, badges: ["vip"] },
    );
    expect(d.promoId).toBeNull();
    expect(d.campaignType).toBe("update");
    expect(d.templates.sms).not.toMatch(/\{ssn\}|\{coupon_code\}/);
    expect(d.templates.sms).toMatch(/^\{shop\}: /);
    expect(d.templates.sms).toContain("{book_link}");
    expect(d.templates.sms).toMatch(/STOP/);
    expect(d.templates.emailBody).toContain("{book_link}");
    expect(d.segment.badges).toEqual(["vip"]);
    expect(d.segment.minAvgGapDays).toBe(20);
    expect(d.notes.join(" ")).toMatch(/OLD10 isn't one of your active coupons/);
    expect(d.notes.join(" ")).toMatch(/Badges/);
  });

  it("a malformed answer becomes a plain starting point", () => {
    const d = normalizeDraft({ nonsense: true }, { coupons, badges: [] });
    expect(d.notes[0]).toMatch(/didn't fit/);
    expect(SegmentSchema.safeParse(d.segment).success).toBe(true);
  });

  it("the model is told coupon codes and badge names only, and the tool's schema", () => {
    const s = draftSystemPrompt({ brand: "Ray'z", shops: ["Coralville"], coupons, badges });
    expect(s).toContain("MISSYOU20");
    expect(s).not.toContain("OLD10");
    expect(s).toContain("vip: VIP");
    expect(DRAFT_TOOL.name).toBe("draft_campaign");
  });
});

describe("marketing email HTML", () => {
  const body = "Hi Jordan,\n\nBook: https://rayz.example/m/abc\n\n--\nRay'z, 1 Main St\nUnsubscribe: https://rayz.example/m/abc/unsubscribe";

  it("links URLs, puts the footer apart, escapes, and loads the pixel", () => {
    const h = marketingEmailHtml({ subject: "<Hi>", body, pixelUrl: "https://rayz.example/m/abc/o.gif" });
    expect(h).toContain('<a href="https://rayz.example/m/abc"');
    expect(h).toContain("&lt;Hi&gt;");
    expect(h).toContain('class="rule muted"');
    expect(h).toContain('src="https://rayz.example/m/abc/o.gif"');
    expect(h).toContain("prefers-color-scheme: dark");
  });

  it("previews force light or dark and carry no pixel", () => {
    const dark = marketingEmailHtml({ subject: "Hi", body, scheme: "dark" });
    expect(dark).toContain("#18181b");
    expect(dark).not.toContain("o.gif");
    expect(dark).not.toContain("prefers-color-scheme");
  });
});

describe("coupon day and time limits", () => {
  const limits = (o: Partial<CouponLimits> = {}): CouponLimits => ({ active: true, code: "TUE", shopId: null, shopIds: [], startsOn: null, endsOn: null, maxRedemptions: null, redemptions: 0, maxPerCustomer: null, firstVisitOnly: false, codeMode: "shared", ...o });
  const check = { today: "2028-02-16", shopId: "cv", customerId: "c1", priorVisits: 0, customerUses: 0 };

  it("labels", () => {
    expect(couponWhenLabel({ daysOfWeek: [2, 3] })).toBe("Tue, Wed");
    expect(couponWhenLabel({ daysOfWeek: [1, 2, 3, 4, 5] })).toBe("Weekdays");
    expect(couponWhenLabel({ daysOfWeek: [2], timeFrom: "10:00", timeTo: "14:30" })).toBe("Tue, 10 AM to 2:30 PM");
    expect(couponWhenLabel({ daysOfWeek: [] })).toBeNull();
  });

  it("checked when the day and time are known, skipped when not", () => {
    const p = limits({ daysOfWeek: [2], timeFrom: "10:00", timeTo: "14:00" });
    expect(couponProblem(p, { ...check, weekday: 2, minutes: 11 * 60 })).toBeNull();
    expect(couponProblem(p, { ...check, weekday: 3, minutes: 11 * 60 })).toMatch(/only works Tue/);
    expect(couponProblem(p, { ...check, weekday: 2, minutes: 14 * 60 })).toMatch(/only works 10 AM to 2 PM/);
    expect(couponProblem(p, check)).toBeNull();
  });

  it("the form wants both times in order", () => {
    const base = { code: "TUE", type: "percent", value: 10 };
    expect(CouponInput.safeParse({ ...base, timeFrom: "10:00" }).success).toBe(false);
    expect(CouponInput.safeParse({ ...base, timeFrom: "14:00", timeTo: "10:00" }).success).toBe(false);
    expect(CouponInput.safeParse({ ...base, timeFrom: "10:00", timeTo: "14:00", daysOfWeek: [2, 4] }).success).toBe(true);
  });
});

describe("new automations, stages and terms", () => {
  it("2nd visit and after every visit are triggers with their own settings", () => {
    expect(TRIGGER_KEYS).toEqual(expect.arrayContaining(["second_visit", "post_visit"]));
    expect(triggerSettings("second_visit", {}).days).toBe(21);
    expect(triggerSettings("post_visit", { delayHours: 999 }).delayHours).toBe(72);
    expect(TRIGGERS.post_visit.when(triggerSettings("post_visit", {}))).toMatch(/but the first/);
    for (const k of ["second_visit", "post_visit"] as const) expect(templatesProblem(defaultTemplates(k, false), ["sms", "email", "push"], { hasCoupon: false })).toBeNull();
  });

  it("stages are starting points the segment builder accepts", () => {
    for (const k of Object.keys(CLIENT_STAGES) as (keyof typeof CLIENT_STAGES)[]) expect(SegmentSchema.safeParse({ ...EMPTY_SEGMENT, ...stageSegment(k) }).success).toBe(true);
    expect(stageSegment("lapsed")).toMatchObject({ notBooked: true });
  });

  it("says Lapsed everywhere, never Lapsing", () => {
    const words = [...Object.values(CLIENT_STAGES).map((s) => `${s.label} ${s.hint}`), ...BADGES.map((b) => `${b.label} ${"hint" in b ? b.hint : ""}`), ...TRIGGER_KEYS.map((k) => TRIGGERS[k].label)].join(" ");
    expect(words).not.toMatch(/lapsing/i);
  });

  it("attribution basis defaults to the send; holdouts have a skip label", () => {
    expect(MarketingSettingsSchema.parse({}).attributeOn).toBe("sent");
    expect(SKIP_LABEL.holdout).toBeTruthy();
  });
});
