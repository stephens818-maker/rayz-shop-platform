import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BADGES,
  DEFAULT_BADGE_SETTINGS,
  DEFAULT_THRESHOLDS,
  customKey,
  deriveBadges,
  thresholdsProblem,
  type BadgeFacts,
  type BadgeProgressFacts,
  type BadgeSettings,
  type CustomBadge,
  type DeriveContext,
  type StoredBadge,
} from "@/domain/badges";
import {
  CUSTOMER_BADGES_OPENAPI,
  CustomerBadgesSchema,
  NOTIFY_DEFAULT,
  badgeMessage,
  badgeProgress,
  canNotify,
  customerBadgeKeys,
  customerMayShow,
  customerSetting,
  customerView,
  notifies,
} from "@/domain/customer-badges";
import { EMPTY_SEGMENT, MANUAL_TRIGGERS, TRIGGERS, templatesProblem } from "@/domain/marketing";
import { addDays } from "@/lib/time";

const TODAY = "2026-10-24";
const ctx: DeriveContext = { today: TODAY, t: DEFAULT_THRESHOLDS, vipCutoffCents: null };
const S = (o: Partial<BadgeSettings> = {}): BadgeSettings => ({ ...DEFAULT_BADGE_SETTINGS, ...o });

const facts = (o: Partial<BadgeFacts> = {}): BadgeFacts => ({
  visits: [],
  nextBooked: null,
  year: { appointments: 0, noShows: 0, lateCancels: 0, bookings: 0, online: 0 },
  createdOn: "2025-01-01",
  streak: 0,
  birthday: null,
  preferredStaffId: null,
  barbers: { A: { name: "Ray", active: true } },
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
/** `n` visits three weeks apart, the last `ago` days back. */
const visits = (n: number, ago = 10) => Array.from({ length: n }, (_, i) => ({ day: addDays(TODAY, -ago - (n - 1 - i) * 21), staffId: "A" }));
const keys = (f: BadgeFacts, c: DeriveContext = ctx) => deriveBadges(f, c).map((b) => b.k);

const custom = (o: Partial<CustomBadge> = {}): CustomBadge => ({
  id: "6f1d7a52-0d0b-4a43-9a52-2f5f8a7c1e01",
  label: "Beard regular",
  tooltip: "Bought beard oil",
  icon: "tag",
  tone: "blue",
  filter: { ...EMPTY_SEGMENT },
  active: true,
  ...o,
});

const STAFF_ONLY = ["no_show_risk", "late_cancels", "vip", "low_rating", "missing_info", "at_risk"];
const CUSTOMER_DEFAULT = ["gold", "silver", "bronze", "miss_you", "birthday_week", "birthday_month", "anniversary", "reward", "streak", "referral_champion", "review_clicked", "family"];

describe("customer visibility", () => {
  it("shows the gamified badges to customers by default and keeps staff judgments staff-only", () => {
    const k = customerBadgeKeys(S(), []);
    for (const key of CUSTOMER_DEFAULT) expect(k, key).toContain(key);
    for (const key of STAFF_ONLY) expect(k, key).not.toContain(key);
    expect(k.sort()).toEqual([...CUSTOMER_DEFAULT].sort());
  });

  it("lets the brand show or hide a badge to customers", () => {
    const s = S({ customer: { gold: false, no_show_risk: true, vip: true } });
    const k = customerBadgeKeys(s, []);
    expect(k).not.toContain("gold");
    expect(k).toContain("no_show_risk");
    expect(k).toContain("vip");
    expect(customerSetting(s, "silver")).toBe(true);
  });

  it("never shows ratings, how they found us or no product to customers, whatever the setting", () => {
    const s = S({ customer: { low_rating: true, referral_source: true, no_product: true } });
    for (const key of ["low_rating", "referral_source", "no_product"]) {
      expect(customerMayShow(key)).toBe(false);
      expect(customerSetting(s, key)).toBe(false);
      expect(customerBadgeKeys(s, [])).not.toContain(key);
    }
    expect(BADGES.filter((b) => (b as { customer?: string }).customer === "never").map((b) => b.key).sort()).toEqual(["low_rating", "no_product", "referral_source"]);
  });

  it("hides everything from customers when a badge is off or badges are off", () => {
    expect(customerBadgeKeys(S({ off: ["gold"] }), [])).not.toContain("gold");
    expect(customerBadgeKeys(S({ enabled: false }), [])).toEqual([]);
  });

  it("starts custom badges staff-only, and never shows one built on ratings", () => {
    const c = custom();
    const key = customKey(c.id);
    expect(customerBadgeKeys(S(), [c])).not.toContain(key);
    expect(customerBadgeKeys(S({ customer: { [key]: true } }), [c])).toContain(key);
    const rated = custom({ filter: { ...EMPTY_SEGMENT, minRating: 4 } });
    expect(customerMayShow(key, rated)).toBe(false);
    expect(customerBadgeKeys(S({ customer: { [key]: true } }), [rated])).not.toContain(key);
    expect(customerBadgeKeys(S({ customer: { [key]: true } }), [custom({ active: false })])).not.toContain(key);
  });
});

describe("the customer's view", () => {
  const stored: StoredBadge[] = [
    { k: "gold", d: { visits: 12, at: "2026-06-01" } },
    { k: "low_rating", d: { avg: 2.5, n: 3 } },
    { k: "no_show_risk", d: { n: 2 } },
    { k: "vip", d: { pct: 10, cents: 90000 } },
    { k: "miss_you", d: { weeks: 9, last: "2026-08-20", at: "2026-10-15" } },
    { k: "birthday_week", d: { on: "10-27" } },
    { k: "birthday_month", d: { on: "10-27" } },
  ];
  const progress: BadgeProgressFacts = { visits: 12, noShows: 0, streak: 3, referrals: 1 };
  const view = (s = S(), c: CustomBadge[] = []) =>
    customerView(stored, { since: { gold: "2026-06-01", miss_you: "2026-10-15" }, progress, settings: s, custom: c, bookUrl: "https://rayz.example/book/coralville" });

  it("carries only customer-visible badges, with no staff wording or numbers", () => {
    const v = view();
    expect(v.badges.map((b) => b.id)).toEqual(["gold", "miss_you", "birthday_week"]);
    const text = JSON.stringify(v);
    for (const leak of ["low_rating", "no_show_risk", "vip", "Staff rate", "★", "2.5", "900"]) expect(text).not.toContain(leak);
  });

  it("gives each badge its id, name, icon, colour, earned day and why", () => {
    const gold = view().badges[0];
    expect(gold).toMatchObject({ id: "gold", name: "Gold", icon: "medal", tone: "amber", color: "#d97706", earnedOn: "2026-06-01", action: null });
    expect(gold.text).toContain("12 visits");
    expect(CustomerBadgesSchema.safeParse(view()).success).toBe(true);
  });

  it("puts a Book now on We miss you", () => {
    const m = view().badges.find((b) => b.id === "miss_you")!;
    expect(m).toMatchObject({ name: "We miss you", tone: "red", icon: "frown", action: { label: "Book now", url: "https://rayz.example/book/coralville" } });
    expect(m.text).toContain("9 weeks");
  });

  it("shows staff-only badges only once the brand turns them on for customers, in customer wording", () => {
    const v = view(S({ customer: { no_show_risk: true } }));
    const b = v.badges.find((x) => x.id === "no_show_risk")!;
    expect(b.text).toBe("2 missed appointments in the last year.");
    expect(v.badges.some((x) => x.id === "low_rating")).toBe(false);
  });

  it("uses a custom badge's own name and tooltip", () => {
    const c = custom();
    const v = customerView([{ k: customKey(c.id) }], { since: {}, progress: null, settings: S({ customer: { [customKey(c.id)]: true } }), custom: [c], bookUrl: "/book" });
    expect(v.badges).toEqual([expect.objectContaining({ id: customKey(c.id), name: "Beard regular", text: "Bought beard oil", earnedOn: null })]);
  });
});

describe("progress meters", () => {
  const shows = new Set(customerBadgeKeys(S(), []));
  const p = (o: Partial<BadgeProgressFacts>): BadgeProgressFacts => ({ visits: 0, noShows: 0, streak: 0, referrals: 0, ...o });

  it("counts visits to the next tier", () => {
    expect(badgeProgress(p({ visits: 8 }), new Set(["silver"]), shows, DEFAULT_THRESHOLDS)[0]).toMatchObject({ badge: "gold", current: 8, target: 10, remaining: 2, text: "2 more visits to Gold" });
    expect(badgeProgress(p({ visits: 1 }), new Set(), shows, DEFAULT_THRESHOLDS)[0]).toMatchObject({ badge: "bronze", text: "2 more visits to Bronze" });
    expect(badgeProgress(p({ visits: 5 }), new Set(["bronze"]), shows, DEFAULT_THRESHOLDS)[0].text).toBe("1 more visit to Silver");
    expect(badgeProgress(p({ visits: 12, streak: 9 }), new Set(["gold", "streak"]), shows, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it("has no tier meter while they're over the no-shows allowed", () => {
    expect(badgeProgress(p({ visits: 8, noShows: 1 }), new Set(), shows, DEFAULT_THRESHOLDS).map((x) => x.badge)).not.toContain("gold");
  });

  it("meters the streak and referrals, but only for badges customers see", () => {
    const list = badgeProgress(p({ visits: 12, streak: 2, referrals: 1 }), new Set(["gold"]), shows, DEFAULT_THRESHOLDS);
    expect(list.map((x) => x.text)).toEqual(["3 more on-time appointments to Streak", "2 more referrals to Referral champion"]);
    const hidden = new Set(customerBadgeKeys(S({ customer: { streak: false, gold: false } }), []));
    expect(badgeProgress(p({ visits: 8, streak: 2 }), new Set(["silver"]), hidden, DEFAULT_THRESHOLDS).map((x) => x.badge)).toEqual([]);
    expect(badgeProgress(p({ visits: 8, referrals: 0 }), new Set(["silver"]), shows, DEFAULT_THRESHOLDS).map((x) => x.badge)).not.toContain("referral_champion");
  });
});

describe("gamified badge rules", () => {
  it("awards one tier by visits, with no more no-shows than allowed", () => {
    expect(keys(facts({ visits: visits(10) })).filter((k) => ["gold", "silver", "bronze"].includes(k))).toEqual(["gold"]);
    expect(keys(facts({ visits: visits(6) }))).toContain("silver");
    expect(keys(facts({ visits: visits(3) }))).toContain("bronze");
    expect(keys(facts({ visits: visits(2) }))).not.toContain("bronze");
    const shaky = facts({ visits: visits(10), year: { appointments: 11, noShows: 1, lateCancels: 0, bookings: 11, online: 0 } });
    expect(keys(shaky).some((k) => ["gold", "silver", "bronze"].includes(k))).toBe(false);
    expect(keys(shaky, { ...ctx, t: { ...DEFAULT_THRESHOLDS, tierNoShows: 1 } })).toContain("gold");
    expect(deriveBadges(facts({ visits: visits(10) }), ctx).find((b) => b.k === "gold")!.d).toMatchObject({ visits: 10, at: visits(10)[9].day });
  });

  it("misses them after 8 weeks without a haircut, and clears when they book", () => {
    expect(keys(facts({ visits: visits(3, 56) }))).toContain("miss_you");
    expect(keys(facts({ visits: visits(3, 55) }))).not.toContain("miss_you");
    expect(keys(facts({ visits: visits(3, 70), nextBooked: addDays(TODAY, 3) }))).not.toContain("miss_you");
    expect(keys(facts({ visits: visits(3, 30) }), { ...ctx, t: { ...DEFAULT_THRESHOLDS, missYouWeeks: 4 } })).toContain("miss_you");
    expect(keys(facts())).not.toContain("miss_you");
  });

  it("gives a streak for kept appointments in a row and a champion for referrals", () => {
    expect(keys(facts({ streak: 5 }))).toContain("streak");
    expect(keys(facts({ streak: 4 }))).not.toContain("streak");
    expect(keys(facts({ referrals: 3 }))).toContain("referral_champion");
    expect(keys(facts({ referrals: 2 }))).not.toContain("referral_champion");
  });

  it("insists Bronze < Silver < Gold", () => {
    expect(thresholdsProblem(DEFAULT_THRESHOLDS)).toBeNull();
    expect(thresholdsProblem({ ...DEFAULT_THRESHOLDS, silverVisits: 12 })).toMatch(/Bronze needs fewer/);
  });
});

describe("Badge news", () => {
  it("messages on earning the gamified badges by default, never on losing unless asked", () => {
    for (const k of NOTIFY_DEFAULT) expect(notifies(S(), k, "earned"), k).toBe(true);
    expect(notifies(S(), "gold", "lost")).toBe(false);
    expect(notifies(S({ notify: { gold: { earned: false, lost: true } } }), "gold", "lost")).toBe(true);
    expect(notifies(S({ notify: { gold: { earned: false, lost: true } } }), "gold", "earned")).toBe(false);
    expect(notifies(S(), "reward", "earned")).toBe(false);
  });

  it("never messages about a badge the customer can't see", () => {
    expect(notifies(S({ customer: { gold: false } }), "gold", "earned")).toBe(false);
    expect(notifies(S({ notify: { low_rating: { earned: true, lost: true } } }), "low_rating", "earned")).toBe(false);
    expect(notifies(S({ off: ["gold"] }), "gold", "earned")).toBe(false);
    expect(notifies(S({ enabled: false }), "gold", "earned")).toBe(false);
  });

  it("doesn't message when We miss you clears (they just booked)", () => {
    expect(canNotify("miss_you", "lost")).toBe(false);
    expect(notifies(S({ notify: { miss_you: { earned: true, lost: true } } }), "miss_you", "lost")).toBe(false);
  });

  it("words the message line", () => {
    expect(badgeMessage("gold", "earned", "Gold", "12 visits.")).toBe("you've earned Gold! 12 visits.");
    expect(badgeMessage("miss_you", "earned", "We miss you", "It's been 9 weeks.")).toBe("we miss you! It's been 9 weeks.");
    expect(badgeMessage("streak", "lost", "Streak", "")).toMatch(/on pause/);
  });

  it("is a Campaign Center automation that only the badge engine sends, with its own merge fields", () => {
    expect(MANUAL_TRIGGERS.has("badge_news")).toBe(true);
    const def = TRIGGERS.badge_news;
    expect(templatesProblem(def.templates, ["sms", "email", "push"], { hasCoupon: false, extraFields: Object.keys(def.fields!) })).toBeNull();
    expect(templatesProblem(def.templates, ["sms"], { hasCoupon: false })).toMatch(/\{badge_message\} isn't a merge field/);
  });

  it("documents GET /me/badges for the public API", () => {
    expect(Object.keys(CUSTOMER_BADGES_OPENAPI.paths)).toEqual(["/me/badges"]);
    expect(CUSTOMER_BADGES_OPENAPI.components.CustomerBadges).toBe(CustomerBadgesSchema);
    const js = z.toJSONSchema(CustomerBadgesSchema, { unrepresentable: "any" }) as { properties: Record<string, { items: { required: string[] } }> };
    expect(js.properties.badges.items.required).toEqual(expect.arrayContaining(["id", "name", "icon", "color", "earnedOn"]));
    expect(js.properties.progress.items.required).toEqual(expect.arrayContaining(["badge", "current", "target", "remaining", "text"]));
  });
});
