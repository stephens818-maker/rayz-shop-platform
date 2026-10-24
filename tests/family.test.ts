import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, deriveBadges, showBadges, type BadgeFacts } from "@/domain/badges";
import {
  ChildInputSchema,
  FAMILY_DEFAULT,
  FAMILY_OPENAPI,
  FamilySettingsSchema,
  ageOn,
  childDates,
  childLabel,
  childLimitProblem,
  familySettings,
  FAMILY_BOOKING_MAX,
  nextSeat,
  selectedIds,
  splitProblem,
  togglePartyMember,
  type PartySelection,
  type Seat,
} from "@/domain/family";
import { groupFamilies, type ClientHit } from "@/domain/client-search";
import { familyColumns, hasFamilyColumns, parseChild, planFamilies, type FamilyRow } from "@/domain/family-import";
import { CUSTOMER_FIELDS } from "@/domain/report-builder";
import { EMPTY_SEGMENT, SegmentSchema, filterCount } from "@/domain/marketing";
import { findSensitive } from "@/lib/sensitive";

const TODAY = "2026-10-24";

describe("family settings", () => {
  it("defaults to 6 children, household loyalty and own accounts from 13", () => {
    expect(FAMILY_DEFAULT).toEqual({ maxChildren: 6, loyalty: "household", splitAge: 13, groupDepositCents: 0, groupDepositFrom: 3, groupNoShowForfeit: true });
    expect(familySettings(null)).toEqual(FAMILY_DEFAULT);
    expect(familySettings({})).toEqual(FAMILY_DEFAULT);
  });

  it("keeps the keys that parse and falls back on the others", () => {
    expect(familySettings({ maxChildren: 3, loyalty: "nonsense", splitAge: 99, groupDepositCents: 99_999 })).toEqual({ ...FAMILY_DEFAULT, maxChildren: 3 });
    expect(familySettings({ groupDepositCents: 2500, groupDepositFrom: 2, groupNoShowForfeit: false })).toMatchObject({ groupDepositCents: 2500, groupDepositFrom: 2, groupNoShowForfeit: false });
    expect(familySettings({ loyalty: "individual" }).loyalty).toBe("individual");
  });

  it("refuses limits outside 0 to 12 and split ages outside 13 to 21", () => {
    expect(FamilySettingsSchema.safeParse({ maxChildren: 13 }).success).toBe(false);
    expect(FamilySettingsSchema.safeParse({ maxChildren: -1 }).success).toBe(false);
    expect(FamilySettingsSchema.safeParse({ splitAge: 12 }).success).toBe(false);
    expect(FamilySettingsSchema.safeParse({ splitAge: 22 }).success).toBe(false);
    expect(FamilySettingsSchema.parse({ maxChildren: 0, splitAge: 16 })).toMatchObject({ maxChildren: 0, splitAge: 16 });
  });

  it("stops the 7th child by default, any child when turned off, and names the limit", () => {
    expect(childLimitProblem(5, FAMILY_DEFAULT)).toBeNull();
    expect(childLimitProblem(6, FAMILY_DEFAULT)).toMatch(/up to 6 children/);
    expect(childLimitProblem(0, { ...FAMILY_DEFAULT, maxChildren: 0 })).toMatch(/turned off/);
    expect(childLimitProblem(1, { ...FAMILY_DEFAULT, maxChildren: 1 })).toMatch(/up to 1 child\./);
  });
});

describe("child age and profile", () => {
  it("works out age from the birthday, else the birth year", () => {
    expect(ageOn({ birthday: "2016-10-24" }, TODAY)).toBe(10);
    expect(ageOn({ birthday: "2016-10-25" }, TODAY)).toBe(9);
    expect(ageOn({ birthYear: 2019 }, TODAY)).toBe(7);
    expect(ageOn({}, TODAY)).toBeNull();
    expect(childLabel({ firstName: "Maya", lastName: "Ray" }, 7)).toBe("Maya Ray, 7");
    expect(childLabel({ firstName: "Maya" }, null)).toBe("Maya");
  });

  it("turns an age into a birth year, and refuses future birthdays and adults", () => {
    expect(childDates({ age: 7 }, TODAY)).toEqual({ ok: true, birthYear: 2019 });
    expect(childDates({ birthday: "2018-03-02" }, TODAY)).toEqual({ ok: true, birthday: "2018-03-02", birthYear: 2018 });
    expect(childDates({ birthday: "2027-01-01" }, TODAY)).toMatchObject({ ok: false });
    expect(childDates({ birthday: "1990-01-01" }, TODAY)).toMatchObject({ ok: false });
    expect(childDates({ birthday: "", age: null }, TODAY)).toEqual({ ok: true, birthday: null, birthYear: null });
  });

  it("takes a first name, an optional last name, notes and a small photo, and no contact details", () => {
    const ok = ChildInputSchema.parse({ firstName: " Maya ", notes: "Loud clippers upset her", photo: "data:image/jpeg;base64,AAAA" });
    expect(ok).toMatchObject({ firstName: "Maya", notes: "Loud clippers upset her" });
    expect(ChildInputSchema.safeParse({ firstName: "" }).success).toBe(false);
    expect(ChildInputSchema.safeParse({ firstName: "Maya", photo: "https://example.com/x.png" }).success).toBe(false);
    expect(Object.keys(ChildInputSchema.shape)).not.toContain("phone");
    expect(Object.keys(ChildInputSchema.shape)).not.toContain("email");
  });

  it("lets a child have their own account from the brand's split age", () => {
    expect(splitProblem({ birthday: "2013-10-24" }, FAMILY_DEFAULT, TODAY)).toBeNull();
    expect(splitProblem({ birthday: "2013-10-25" }, FAMILY_DEFAULT, TODAY)).toMatch(/from 13/);
    expect(splitProblem({}, FAMILY_DEFAULT, TODAY)).toMatch(/birthday first/);
    expect(splitProblem({ birthYear: 2010 }, { ...FAMILY_DEFAULT, splitAge: 18 }, TODAY)).toMatch(/from 18/);
  });
});

describe("seating a family booking", () => {
  const at = (h: number, m = 0) => `2026-10-24T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
  const parent: Seat = { staffId: "ray", startsAt: at(15), endsAt: at(15, 30) };
  const slots = [
    { staffId: "ray", startsAt: at(15) },
    { staffId: "mak", startsAt: at(15) },
    { staffId: "ray", startsAt: at(15, 30) },
    { staffId: "mak", startsAt: at(15, 45) },
    { staffId: "ray", startsAt: at(16) },
  ];

  it("seats the same time with another barber, the one asked for when free", () => {
    expect(nextSeat({ timing: "same_time", staffId: null }, [parent], slots)).toEqual({ staffId: "mak", startsAt: at(15) });
    expect(nextSeat({ timing: "same_time", staffId: "mak" }, [parent], slots)).toEqual({ staffId: "mak", startsAt: at(15) });
    expect(nextSeat({ timing: "same_time", staffId: "ray" }, [parent], slots)).toBeNull();
    // A third person at the same time needs a third barber.
    expect(nextSeat({ timing: "same_time", staffId: null }, [parent, { staffId: "mak", startsAt: at(15), endsAt: at(15, 30) }], slots)).toBeNull();
  });

  it("seats back to back with the same barber, or the one asked for, at or after the last one ends", () => {
    expect(nextSeat({ timing: "after", staffId: null }, [parent], slots)).toEqual({ staffId: "ray", startsAt: at(15, 30) });
    expect(nextSeat({ timing: "after", staffId: "mak" }, [parent], slots)).toEqual({ staffId: "mak", startsAt: at(15, 45) });
    expect(nextSeat({ timing: "after", staffId: "nobody" }, [parent], slots)).toBeNull();
    const kid: Seat = { staffId: "ray", startsAt: at(15, 30), endsAt: at(16) };
    expect(nextSeat({ timing: "after", staffId: null }, [parent, kid], slots)).toEqual({ staffId: "ray", startsAt: at(16) });
  });

  it("can't seat anyone without a first person", () => {
    expect(nextSeat({ timing: "after", staffId: null }, [], slots)).toBeNull();
  });
});

describe("Squire family records", () => {
  it("finds the family columns Squire exports use, case and spacing aside", () => {
    expect(familyColumns(["Client ID", "First Name", "Parent Client ID", "DOB"])).toEqual({ parentId: "Parent Client ID", birthday: "DOB" });
    expect(familyColumns(["client_id", "household id", "Relationship"])).toEqual({ familyId: "household id", isChild: "Relationship" });
    expect(hasFamilyColumns(familyColumns(["Client ID", "Name", "Phone"]))).toBe(false);
    expect(hasFamilyColumns(familyColumns(["Family ID"]))).toBe(false);
    expect(hasFamilyColumns(familyColumns(["Family ID", "Kid"]))).toBe(true);
    expect(hasFamilyColumns(familyColumns(["Guardian Phone"]))).toBe(true);
  });

  it("reads child and parent markers, and nothing from blanks or unknown words", () => {
    for (const v of ["Yes", "child", "Kid", "son", "Daughter", "1", "dependent"]) expect(parseChild(v)).toBe(true);
    for (const v of ["No", "parent", "Guardian", "adult", "Mom", "account holder"]) expect(parseChild(v)).toBe(false);
    expect(parseChild("")).toBeUndefined();
    expect(parseChild("cousin")).toBeUndefined();
  });

  const row = (o: Partial<FamilyRow> & { squireId: string }): FamilyRow => ({ line: 2, name: o.squireId, ...o });

  it("links a kid to the parent their row names, by Squire ID or phone, once", () => {
    const plan = planFamilies([
      row({ squireId: "P1" }),
      row({ squireId: "K1", parentId: "P1", line: 3 }),
      row({ squireId: "K2", parentPhone: "(319) 555-0100", line: 4 }),
      row({ squireId: "K1", parentId: "P9", line: 5 }),
      row({ squireId: "P2", parentId: "P2" }),
      row({ squireId: "A1", parentId: "P1", isChild: false }),
    ]);
    expect(plan.links).toEqual([
      { line: 3, childSquireId: "K1", parent: { squireId: "P1" } },
      { line: 4, childSquireId: "K2", parent: { phone: "(319) 555-0100" } },
    ]);
    expect(plan.problems).toEqual([]);
  });

  it("puts a family's kids under its first adult, and reports kids whose family has no adult", () => {
    const plan = planFamilies([
      row({ squireId: "MOM", familyId: "F1", isChild: false }),
      row({ squireId: "DAD", familyId: "F1", isChild: false }),
      row({ squireId: "KID", familyId: "F1", isChild: true, line: 7 }),
      row({ squireId: "ORPHAN", name: "Lee", familyId: "F2", isChild: true, line: 9 }),
      row({ squireId: "SOLO", familyId: "F3" }),
    ]);
    expect(plan.links).toEqual([{ line: 7, childSquireId: "KID", parent: { squireId: "MOM" } }]);
    expect(plan.problems).toEqual([{ line: 9, message: expect.stringMatching(/^Lee: no parent in their family/) }]);
  });
});

describe("family badges", () => {
  const facts = (o: Partial<BadgeFacts> = {}): BadgeFacts => ({
    visits: [],
    nextBooked: null,
    year: { appointments: 0, noShows: 0, lateCancels: 0, bookings: 0, online: 0 },
    createdOn: "2025-01-01",
    streak: 0,
    birthday: null,
    preferredStaffId: null,
    barbers: {},
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
  const keys = (f: BadgeFacts) => deriveBadges(f, { today: TODAY, t: DEFAULT_THRESHOLDS, vipCutoffCents: null }).map((b) => b.k);

  it("gives a parent with children the Family badge, saying how many", () => {
    expect(keys(facts({ kids: 2 }))).toContain("family");
    expect(keys(facts({ kids: 0 }))).not.toContain("family");
    expect(keys(facts())).not.toContain("family");
    const stored = deriveBadges(facts({ kids: 2 }), { today: TODAY, t: DEFAULT_THRESHOLDS, vipCutoffCents: null });
    const shown = showBadges(stored, { keys: new Set(["family"]), level: () => "full", custom: new Map() });
    expect(shown).toEqual([expect.objectContaining({ key: "family", label: "Family", tip: "2 children on their family account." })]);
  });

  it("marks a child Kid and never Missing info: their contact is the parent's", () => {
    const k = keys(facts({ child: true, hasPhone: false, hasEmail: false, optedIn: false }));
    expect(k).toContain("kid");
    expect(k).not.toContain("missing_info");
    expect(keys(facts({ hasPhone: false }))).toContain("missing_info");
  });
});

describe("family filters, reports and API", () => {
  it("adds has-kids and is-child filters that start at any", () => {
    expect(EMPTY_SEGMENT.hasKids).toBe("any");
    expect(EMPTY_SEGMENT.isChild).toBe("any");
    expect(filterCount(SegmentSchema.parse({ hasKids: "yes" }))).toBe(1);
    expect(SegmentSchema.safeParse({ isChild: "maybe" }).success).toBe(false);
  });

  it("offers the family fields in the report builder", () => {
    const fam = CUSTOMER_FIELDS.filter((f) => f.group === "Family").map((f) => f.key);
    expect(fam).toEqual(["is_child", "parent", "kids"]);
  });

  it("documents every family endpoint, with no sensitive fields", () => {
    expect(Object.keys(FAMILY_OPENAPI.paths).sort()).toEqual([
      "/me/family",
      "/me/family/booking-groups",
      "/me/family/booking-groups/{code}",
      "/me/family/booking-groups/{code}/cancel",
      "/me/family/booking-groups/{code}/options",
      "/me/family/booking-groups/{code}/reschedule",
      "/me/family/booking-options",
      "/me/family/bookings",
      "/me/family/children",
      "/me/family/children/{id}",
      "/me/family/children/{id}/remove",
      "/me/family/children/{id}/split",
    ]);
    expect(findSensitive(JSON.stringify(FAMILY_OPENAPI.paths))).toEqual([]);
  });
});

describe("who the appointment is for (multi-select)", () => {
  const d = { serviceId: "svc", staffId: null };
  const start: PartySelection = { firstWho: "mom", party: [] };
  it("adds people at the same time with the default service, and the first one keeps the picked time", () => {
    const s = togglePartyMember(togglePartyMember(start, "max", d), "ava", { serviceId: "kids", staffId: "ray" });
    expect(selectedIds(s)).toEqual(["mom", "max", "ava"]);
    expect(s.party[1]).toEqual({ customerId: "ava", serviceId: "kids", staffId: "ray", timing: "same_time" });
  });
  it("removing someone from the party drops them; removing the first moves the next one up", () => {
    const s = togglePartyMember(togglePartyMember(start, "max", d), "ava", d);
    expect(selectedIds(togglePartyMember(s, "max", d))).toEqual(["mom", "ava"]);
    const promoted = togglePartyMember(s, "mom", d);
    expect(promoted.firstWho).toBe("max");
    expect(selectedIds(promoted)).toEqual(["max", "ava"]);
  });
  it("keeps the last person selected and stops at the booking limit", () => {
    expect(togglePartyMember(start, "mom", d)).toBe(start);
    let s = start;
    for (let i = 0; i < FAMILY_BOOKING_MAX + 2; i++) s = togglePartyMember(s, `kid${i}`, d);
    expect(selectedIds(s)).toHaveLength(FAMILY_BOOKING_MAX);
  });
  it("lets a child alone be picked: deselect the parent after picking the child", () => {
    expect(selectedIds(togglePartyMember(togglePartyMember(start, "max", d), "mom", d))).toEqual(["max"]);
  });
});

describe("search results as families", () => {
  const hit = (id: string, family?: ClientHit["family"], matched: string[] = ["Name"]): ClientHit => ({
    id,
    number: 1,
    firstName: id,
    lastName: null,
    short: id,
    nickname: null,
    phone: "***-***-4321",
    email: null,
    notes: null,
    lastVisit: null,
    barber: null,
    photo: false,
    rating: null,
    matched,
    ...(family ? { family } : {}),
  });
  const kids = [
    { id: "max", firstName: "Max", age: 7 },
    { id: "ava", firstName: "Ava", age: null },
  ];
  it("lists the parent with the kids underneath (first names, ages as shown)", () => {
    const g = groupFamilies([hit("mom", { guardian: null, kids }), hit("solo")]);
    expect(g.map((x) => x.hit.id)).toEqual(["mom", "solo"]);
    expect(g[0].kids).toEqual([
      { id: "max", firstName: "Max", age: 7, matched: false },
      { id: "ava", firstName: "Ava", age: null, matched: false },
    ]);
    expect(g[0].hit.phone).toBe("***-***-4321");
    expect(g[1].kids).toEqual([]);
  });
  it("folds a matched child under their parent, at the child's place, and marks them", () => {
    const max = hit("max", { guardian: { id: "mom", short: "Mom" }, kids: [] });
    const g = groupFamilies([hit("other"), max, hit("mom", { guardian: null, kids }, ["Child's name"])]);
    expect(g.map((x) => x.hit.id)).toEqual(["other", "mom"]);
    expect(g[1].kids.find((k) => k.id === "max")?.matched).toBe(true);
    expect(g[1].kids.find((k) => k.id === "ava")?.matched).toBe(false);
  });
  it("keeps a child on their own when their parent isn't in the results", () => {
    const g = groupFamilies([hit("max", { guardian: { id: "mom", short: "Mom" }, kids: [] })]);
    expect(g).toHaveLength(1);
    expect(g[0].hit.id).toBe("max");
    expect(g[0].kids).toEqual([]);
  });
});
