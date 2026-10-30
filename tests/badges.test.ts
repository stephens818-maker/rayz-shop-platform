import { describe, expect, it } from "vitest";
import {
  BADGES,
  BADGE_ICONS,
  DEFAULT_BADGE_SETTINGS,
  DEFAULT_THRESHOLDS,
  actionFirst,
  anniversaryNear,
  badgeOptions,
  badgeSettings,
  customBadgeProblem,
  customKey,
  deriveBadges,
  roleSeesBadge,
  showBadges,
  todayLine,
  visibleBadges,
  type BadgeFacts,
  type BadgeSettings,
  type BadgeViewer,
  type CustomBadge,
  type DeriveContext,
} from "@/domain/badges";
import type { FieldKey, Level } from "@/domain/client-privacy";
import { SegmentSchema, segmentProblem } from "@/domain/marketing";
import { isForbiddenKey } from "@/lib/sensitive";
import { addDays } from "@/lib/time";

const TODAY = "2026-10-24";
const ctx: DeriveContext = { today: TODAY, t: DEFAULT_THRESHOLDS, vipCutoffCents: null };

const facts = (o: Partial<BadgeFacts> = {}): BadgeFacts => ({
  visits: [],
  nextBooked: null,
  year: { appointments: 0, noShows: 0, lateCancels: 0, bookings: 0, online: 0 },
  createdOn: "2025-01-01",
  streak: 0,
  birthday: null,
  preferredStaffId: null,
  barbers: { A: { name: "Ray", active: true }, B: { name: "Makenna", active: true } },
  spendCents: 0,
  products: { year: 0, ever: 1 },
  rewardCents: 0,
  giftCardCents: 0,
  coupons: 0,
  rating: null,
  reviewClicks: 0,
  hasPhone: true,
  hasEmail: true,
  optedIn: true,
  optedOut: [],
  source: null,
  referredBy: false,
  referrals: 0,
  ...o,
});

/** Visit days `gaps` apart ending on `last`, all with `staff`. */
const visits = (last: string, gaps: number[], staff = "A") => {
  const out = [last];
  for (const g of [...gaps].reverse()) out.unshift(addDays(out[0], -g));
  return out.map((day) => ({ day, staffId: staff }));
};

const keys = (f: BadgeFacts, c: DeriveContext = ctx) => deriveBadges(f, c).map((b) => b.k);
const one = (f: BadgeFacts, k: string, c: DeriveContext = ctx) => deriveBadges(f, c).find((b) => b.k === k);

describe("badge rules: visit timing", () => {
  it("is on track, due or overdue against their usual time between visits", () => {
    expect(keys(facts({ visits: visits(addDays(TODAY, -10), [21, 21, 21]) }))).toContain("on_track");
    expect(keys(facts({ visits: visits(addDays(TODAY, -20), [21, 21, 21]) }))).toContain("due");
    expect(keys(facts({ visits: visits(addDays(TODAY, -34), [21, 21, 21]) }))).toContain("overdue");
    // Booked counts as on track, however long it's been.
    expect(keys(facts({ visits: visits(addDays(TODAY, -34), [21, 21, 21]), nextBooked: addDays(TODAY, 2) }))).toContain("on_track");
    expect(one(facts({ visits: visits(addDays(TODAY, -20), [21, 21, 21]) }), "due")!.d).toMatchObject({ every: 21, since: 20, due: addDays(TODAY, 1) });
  });

  it("is lapsed past the lapsed weeks with nothing booked, instead of overdue", () => {
    const f = facts({ visits: visits(addDays(TODAY, -120), [21, 21]) });
    expect(keys(f)).toContain("lapsed");
    expect(keys(f)).not.toContain("overdue");
    expect(keys(f, { ...ctx, t: { ...DEFAULT_THRESHOLDS, lapsedWeeks: 20 } })).toContain("overdue");
  });

  it("is a win-back when a lapsed client books again, and for a while after they're back", () => {
    const booked = facts({ visits: visits(addDays(TODAY, -150), [30]), nextBooked: addDays(TODAY, 3) });
    expect(keys(booked)).toContain("win_back");
    expect(keys(booked)).not.toContain("lapsed");
    const back = facts({ visits: visits(addDays(TODAY, -14), [30, 200]) });
    expect(one(back, "win_back")!.d).toMatchObject({ away: 200, back: addDays(TODAY, -14) });
    expect(keys(facts({ visits: visits(addDays(TODAY, -70), [30, 200]) }))).not.toContain("win_back");
  });

  it("is at risk when the last gap stretched well past their norm", () => {
    const f = facts({ visits: visits(addDays(TODAY, -3), [21, 21, 21, 40]) });
    expect(one(f, "at_risk")!.d).toEqual({ gap: 40, every: 21 });
    expect(keys(facts({ visits: visits(addDays(TODAY, -3), [21, 21, 21, 26]) }))).not.toContain("at_risk");
    // Too few gaps to know their norm.
    expect(keys(facts({ visits: visits(addDays(TODAY, -3), [21, 40]) }))).not.toContain("at_risk");
    // A weekly client four days late isn't at risk: it needs a week more than usual too.
    expect(keys(facts({ visits: visits(addDays(TODAY, -1), [7, 7, 7, 11]) }))).not.toContain("at_risk");
  });
});

describe("badge rules: new and returning", () => {
  it("marks new clients, the 2nd visit, and not old clients who never came", () => {
    expect(keys(facts({ createdOn: addDays(TODAY, -5) }))).toContain("new_client");
    expect(keys(facts({ createdOn: "2024-01-01" }))).not.toContain("new_client");
    expect(one(facts({ createdOn: "2024-01-01", nextBooked: "2026-10-30" }), "new_client")!.d).toEqual({ next: "2026-10-30" });
    expect(one(facts({ visits: [{ day: TODAY, staffId: "A" }] }), "new_client")!.d).toEqual({ first: TODAY });
    expect(keys(facts({ visits: [{ day: "2026-10-01", staffId: "A" }] }))).toContain("second_visit");
    expect(keys(facts({ visits: visits("2026-10-01", [21]) }))).not.toContain("second_visit");
  });
});

describe("badge rules: value, celebrations, booking, feedback, profile", () => {
  it("VIP is at or over the brand's cut-off, never for no spend", () => {
    expect(keys(facts({ spendCents: 50_000 }), { ...ctx, vipCutoffCents: 40_000 })).toContain("vip");
    expect(keys(facts({ spendCents: 30_000 }), { ...ctx, vipCutoffCents: 40_000 })).not.toContain("vip");
    expect(keys(facts({ spendCents: 0 }), { ...ctx, vipCutoffCents: 0 })).not.toContain("vip");
  });

  it("loyal, reward, gift card and coupon", () => {
    const f = facts({ visits: visits(addDays(TODAY, -3), Array(9).fill(14)), rewardCents: 500, giftCardCents: 2500, coupons: 2 });
    expect(keys(f)).toEqual(expect.arrayContaining(["loyal", "reward", "gift_card", "coupon"]));
    expect(keys(facts({ visits: visits(addDays(TODAY, -3), Array(8).fill(14)) }))).not.toContain("loyal");
  });

  it("birthday this week and this month, and the first-visit anniversary", () => {
    expect(keys(facts({ birthday: "10-29" }))).toEqual(expect.arrayContaining(["birthday_week", "birthday_month"]));
    expect(keys(facts({ birthday: "10-02" }))).toContain("birthday_month");
    expect(keys(facts({ birthday: "10-02" }))).not.toContain("birthday_week");
    expect(keys(facts({ birthday: "11-01" }))).not.toContain("birthday_week");
    expect(anniversaryNear("2025-10-26", TODAY)).toEqual({ years: 1, on: "2025-10-26".replace("2025", "2026") });
    expect(anniversaryNear("2026-01-01", TODAY)).toBeNull();
    expect(anniversaryNear("2024-02-29", "2026-02-27")).toEqual({ years: 2, on: "2026-02-28" });
    expect(anniversaryNear("2025-12-30", "2027-01-02")).toEqual({ years: 1, on: "2026-12-30" });
  });

  it("no-shows, late cancels and online booking from the last 12 months", () => {
    const y = (o: Partial<BadgeFacts["year"]>) => facts({ year: { appointments: 10, noShows: 0, lateCancels: 0, bookings: 0, online: 0, ...o } });
    expect(keys(y({ noShows: 2 }))).toContain("no_show_risk");
    expect(keys(y({ noShows: 1 }))).not.toContain("no_show_risk");
    expect(keys(y({ noShows: 1, appointments: 2 }))).toContain("no_show_risk");
    expect(keys(y({ lateCancels: 2 }))).toContain("late_cancels");
    expect(keys(y({ bookings: 4, online: 3 }))).toContain("online_booker");
    expect(keys(y({ bookings: 4, online: 2 }))).not.toContain("online_booker");
  });

  it("always with a barber, switched barbers, and the barber left", () => {
    const loyal = facts({ visits: visits(addDays(TODAY, -3), [21, 21, 21, 21]) });
    expect(one(loyal, "always_with")!.d).toEqual({ staff: "Ray", n: 5, of: 5 });
    const gone = facts({ visits: loyal.visits, barbers: { A: { name: "Ray", active: false } } });
    expect(keys(gone)).not.toContain("always_with");
    expect(one(gone, "barber_left")!.d).toEqual({ staff: "Ray" });
    // Their preferred barber decides, when set.
    expect(keys(facts({ visits: loyal.visits, preferredStaffId: "B", barbers: { A: { name: "Ray", active: false }, B: { name: "Makenna", active: true } } }))).not.toContain("barber_left");
    const moved = facts({ visits: [...visits("2026-08-01", [21, 21], "A"), { day: "2026-09-10", staffId: "B" }, { day: "2026-10-10", staffId: "B" }] });
    expect(one(moved, "switched_barber")!.d).toEqual({ from: "Ray", to: "Makenna", on: "2026-09-10" });
    expect(keys(moved, { ...ctx, t: { ...DEFAULT_THRESHOLDS, switchedDays: 30 } })).not.toContain("switched_barber");
  });

  it("ratings, review clicks and products", () => {
    expect(one(facts({ rating: { avg: 2.5, count: 2 } }), "low_rating")!.d).toEqual({ avg: 2.5, n: 2 });
    expect(keys(facts({ rating: { avg: 3, count: 2 } }))).not.toContain("low_rating");
    expect(keys(facts({ reviewClicks: 1 }))).toContain("review_clicked");
    expect(keys(facts({ products: { year: 2, ever: 4 } }))).toContain("product_buyer");
    expect(keys(facts({ products: { year: 0, ever: 0 }, visits: visits(TODAY, [30]) }))).toContain("no_product");
    expect(keys(facts({ products: { year: 0, ever: 0 }, visits: [{ day: TODAY, staffId: "A" }] }))).not.toContain("no_product");
  });

  it("missing info, opted out, and referrals; an imported Squire source isn't a referral source", () => {
    expect(one(facts({ hasPhone: false, optedIn: false }), "missing_info")!.d).toEqual({ miss: "phone,opt_in" });
    expect(one(facts({ optedOut: ["sms", "email", "sms"] }), "opted_out")!.d).toEqual({ ch: "email,sms" });
    expect(one(facts({ source: "Instagram" }), "referral_source")!.d).toEqual({ src: "Instagram" });
    expect(keys(facts({ source: "Squire import" }))).not.toContain("referral_source");
    expect(one(facts({ referredBy: true }), "referral_source")!.d).toEqual({ by: 1 });
    expect(one(facts({ referrals: 3 }), "referrer")!.d).toEqual({ n: 3 });
  });

  it("caches nothing under a key the sensitive-data rules would remove", () => {
    const rich = facts({
      visits: visits(addDays(TODAY, -3), [21, 21, 21, 40]),
      birthday: "10-29",
      spendCents: 90_000,
      rewardCents: 500,
      giftCardCents: 100,
      coupons: 1,
      rating: { avg: 2, count: 1 },
      hasPhone: false,
      optedOut: ["sms"],
      source: "Walk by",
      referrals: 1,
      year: { appointments: 4, noShows: 2, lateCancels: 2, bookings: 4, online: 4 },
    });
    const out = deriveBadges(rich, { ...ctx, vipCutoffCents: 1 });
    expect(out.length).toBeGreaterThan(10);
    for (const b of out) for (const k of Object.keys(b.d ?? {})) expect(isForbiddenKey(k), k).toBe(false);
  });
});

const viewer = (o: Partial<BadgeViewer> & { lv?: Partial<Record<FieldKey, Level>> } = {}): BadgeViewer => ({
  isOwner: false,
  roles: [{ id: "front", key: "front_desk" }],
  money: true,
  level: (f) => o.lv?.[f] ?? "full",
  ...o,
});
const s = (o: Partial<BadgeSettings> = {}): BadgeSettings => ({ ...DEFAULT_BADGE_SETTINGS, ...o });

describe("who sees which badge", () => {
  it("sensitive badges start shown to brand-level roles only; the brand can change any role", () => {
    expect(roleSeesBadge(s(), "vip", { id: "b", key: "barber" })).toBe(false);
    expect(roleSeesBadge(s(), "vip", { id: "a", key: "brand_admin" })).toBe(true);
    expect(roleSeesBadge(s(), "vip", { id: "c", key: null, brandLevel: true })).toBe(true);
    expect(roleSeesBadge(s({ roles: { vip: { b: true } } }), "vip", { id: "b", key: "barber" })).toBe(true);
    expect(roleSeesBadge(s({ roles: { at_risk: { b: false } } }), "at_risk", { id: "b", key: "barber" })).toBe(false);
    expect(roleSeesBadge(s(), "at_risk", { id: "b", key: "barber" })).toBe(true);
  });

  it("respects the master switch, badges turned off, and every role someone works under", () => {
    expect(visibleBadges(s({ enabled: false }), [], viewer())).toEqual([]);
    expect(visibleBadges(s({ off: ["due"] }), [], viewer())).not.toContain("due");
    const two = viewer({ roles: [{ id: "front", key: "front_desk" }, { id: "barb", key: "barber" }] });
    expect(visibleBadges(s({ roles: { due: { barb: false } } }), [], two)).not.toContain("due");
    // The Brand Owner isn't held back by role settings.
    expect(visibleBadges(s({ roles: { due: { owner: false } } }), [], viewer({ isOwner: true, roles: [{ id: "owner", key: "brand_owner" }] }))).toContain("due");
  });

  it("never gives away a hidden client detail or money", () => {
    const admin = { roles: [{ id: "a", key: "brand_admin" }] };
    expect(visibleBadges(s(), [], viewer({ ...admin, money: false }))).not.toEqual(expect.arrayContaining(["vip"]));
    expect(visibleBadges(s(), [], viewer({ ...admin, money: false }))).not.toContain("gift_card");
    const masked = visibleBadges(s(), [], viewer({ lv: { birthday: "masked" } }));
    expect(masked).toContain("birthday_month");
    expect(masked).not.toContain("birthday_week");
    const hidden = visibleBadges(s(), [], viewer({ lv: { birthday: "hidden", preferred_barber: "hidden", ratings: "hidden", phone: "hidden" } }));
    for (const k of ["birthday_week", "birthday_month", "always_with", "switched_barber", "barber_left", "low_rating", "missing_info"]) expect(hidden).not.toContain(k);
    expect(hidden).toContain("at_risk");
    // Every badge that reads a detail is gated on it.
    for (const b of BADGES)
      if ("reads" in b)
        for (const [f, want] of b.reads as readonly (readonly [FieldKey, string])[]) {
          expect(want).not.toBe("hidden");
          expect(visibleBadges(s(), [], viewer({ lv: { [f]: "hidden" } as Partial<Record<FieldKey, Level>> }))).not.toContain(b.key);
        }
  });

  it("a custom badge shows only to people who could run its filter", () => {
    const c: CustomBadge = { id: "11111111-1111-4111-8111-111111111111", label: "Birthday crew", tooltip: "", icon: "cake", tone: "violet", filter: SegmentSchema.parse({ birthdayMonths: [10] }), active: true };
    expect(visibleBadges(s(), [c], viewer())).toContain(customKey(c.id));
    expect(visibleBadges(s(), [c], viewer({ lv: { birthday: "hidden" } }))).not.toContain(customKey(c.id));
    expect(visibleBadges(s(), [{ ...c, active: false }], viewer())).not.toContain(customKey(c.id));
    expect(visibleBadges(s({ roles: { [customKey(c.id)]: { front: false } } }), [c], viewer())).not.toContain(customKey(c.id));
  });
});

describe("showing badges", () => {
  const all = new Set(visibleBadges(s(), [], viewer({ roles: [{ id: "a", key: "brand_admin" }] })));
  const view = (lv: Partial<Record<FieldKey, Level>> = {}, keys: ReadonlySet<string> = all) => ({ keys, level: (f: FieldKey) => lv[f] ?? "full", custom: new Map() });

  it("names the barber only for people who see preferred barbers in full", () => {
    const stored = [{ k: "always_with", d: { staff: "Ray", n: 5, of: 5 } }];
    expect(showBadges(stored, view())[0]).toMatchObject({ label: "Always with Ray", tip: "5 of their last 5 visits with Ray." });
    const masked = showBadges(stored, view({ preferred_barber: "masked" }))[0];
    expect(masked.label).toBe("Same barber");
    expect(masked.tip).not.toContain("Ray");
    expect(showBadges([{ k: "barber_left", d: { staff: "Ray" } }], view({ preferred_barber: "masked" }))[0].tip).not.toContain("Ray");
  });

  it("shows a masked birthday's month only, and one birthday badge at a time", () => {
    expect(showBadges([{ k: "birthday_month", d: { on: "10-29" } }], view({ birthday: "masked" }))[0].tip).toBe("Birthday in October.");
    const both = showBadges([{ k: "birthday_month", d: { on: "10-29" } }, { k: "birthday_week", d: { on: "10-29" } }], view());
    expect(both.map((b) => b.key)).toEqual(["birthday_week"]);
    expect(both[0].tip).toBe("Birthday October 29.");
  });

  it("leaves out badges the person doesn't see and sorts the rest in catalog order", () => {
    const out = showBadges([{ k: "referrer", d: { n: 2 } }, { k: "at_risk", d: { gap: 40, every: 21 } }, { k: "vip", d: { pct: 10, cents: 1 } }], view({}, new Set(["at_risk", "referrer"])));
    expect(out.map((b) => b.key)).toEqual(["at_risk", "referrer"]);
    expect(out[0]).toMatchObject({ icon: "trend_down", tone: "red", action: true, tip: "Visits are stretching: their last gap was 5.5 weeks against their usual 3 weeks." });
    expect(actionFirst([out[1], out[0]]).map((b) => b.key)).toEqual(["at_risk", "referrer"]);
  });

  it("every built-in badge has an icon, a hint, and a tooltip from what's cached", () => {
    for (const b of BADGES) {
      expect(BADGE_ICONS).toContain(b.icon);
      expect(b.hint.length).toBeGreaterThan(10);
    }
    const stored = deriveBadges(
      facts({
        visits: visits(addDays(TODAY, -3), [21, 21, 21, 40]),
        birthday: "10-29",
        spendCents: 90_000,
        rewardCents: 500,
        giftCardCents: 100,
        coupons: 1,
        rating: { avg: 2, count: 1 },
        reviewClicks: 2,
        products: { year: 1, ever: 1 },
        hasEmail: false,
        optedOut: ["push"],
        source: "Walk by",
        referrals: 1,
        year: { appointments: 4, noShows: 2, lateCancels: 2, bookings: 4, online: 4 },
      }),
      { ...ctx, vipCutoffCents: 1 },
    );
    const shown = showBadges(stored, view());
    expect(shown.length).toBeGreaterThan(12);
    for (const b of shown) expect(b.tip, b.key).not.toMatch(/undefined|NaN|null/);
    expect(shown.find((b) => b.key === "gift_card")!.label).toBe("Gift card $1.00");
    expect(shown.find((b) => b.key === "missing_info")!.tip).toBe("Missing email.");
  });

  it("custom badges show their own name and tooltip", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const v = { keys: new Set([customKey(id)]), level: () => "full" as const, custom: new Map([[id, { label: "Beard regular", tooltip: "Bought beard oil", icon: "tag" as const, tone: "green" as const }]]) };
    expect(showBadges([{ k: customKey(id) }], v)).toEqual([{ key: customKey(id), label: "Beard regular", icon: "tag", tone: "green", tip: "Bought beard oil", action: false }]);
    expect(badgeOptions(["referrer", customKey(id), "at_risk"], v.custom).map((o) => o.name)).toEqual(["At risk", "Referrer", "Beard regular"]);
  });

  it("the Morning Dashboard's lines", () => {
    expect(todayLine("at_risk", 3)).toBe("3 at-risk clients");
    expect(todayLine("second_visit", 1)).toBe("1 client on their 2nd visit");
    expect(todayLine("vip", 2)).toBe("2 VIP clients");
  });
});

describe("badge settings and filters", () => {
  it("keeps good settings when one threshold is out of range", () => {
    const r = badgeSettings({ enabled: false, off: ["vip"], thresholds: { lapsedWeeks: 2, vipTopPct: 5 } });
    expect(r.enabled).toBe(false);
    expect(r.off).toEqual(["vip"]);
    expect(r.thresholds.lapsedWeeks).toBe(16);
    expect(r.thresholds.vipTopPct).toBe(5);
    expect(badgeSettings({ off: ["not_a_badge"] }).off).toEqual([]);
    expect(badgeSettings(null)).toEqual(DEFAULT_BADGE_SETTINGS);
  });

  it("a custom badge needs a filter, and can't be built from badges", () => {
    expect(customBadgeProblem(SegmentSchema.parse({}))).toMatch(/at least one filter/);
    expect(customBadgeProblem(SegmentSchema.parse({ shopIds: ["11111111-1111-4111-8111-111111111111"] }))).toMatch(/at least one filter/);
    expect(customBadgeProblem(SegmentSchema.parse({ badges: ["vip"], minVisits: 2 }))).toMatch(/other badges/);
    expect(customBadgeProblem(SegmentSchema.parse({ minVisits: 5 }))).toBeNull();
  });

  it("badge filters take known keys only, and only badges the person sees", () => {
    expect(SegmentSchema.safeParse({ badges: ["at_risk", customKey("33333333-3333-4333-8333-333333333333")] }).success).toBe(true);
    expect(SegmentSchema.safeParse({ badges: ["x'; drop table customers"] }).success).toBe(false);
    const seg = SegmentSchema.parse({ badges: ["vip"] });
    expect(segmentProblem(seg, { birthday: true, ratings: true, badges: ["at_risk"] })).toMatch(/hidden from you/);
    expect(segmentProblem(seg, { birthday: true, ratings: true })).toMatch(/hidden from you/);
    expect(segmentProblem(seg, { birthday: true, ratings: true, badges: ["vip"] })).toBeNull();
  });
});
