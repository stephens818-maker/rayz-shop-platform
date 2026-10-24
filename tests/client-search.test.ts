import { describe, expect, it, vi } from "vitest";
import type { BuiltinField, Level } from "@/domain/client-privacy";
import { decodeFilter, encodeFilter, upcomingBirthdayKeys } from "@/domain/client-filters";
import { allowedProbes, matchLabel, parseDate, parseSearch, Probe, shortName } from "@/domain/client-search";
import { editDistance, namesMatch, pickKeeper, planMerges, scoreDuplicate, typoClose, type DuplicateSide } from "@/domain/duplicates";
import { EMPTY_SEGMENT, segmentProblem, SegmentSchema, type FilterSees } from "@/domain/marketing";

vi.mock("server-only", () => ({}));

const kinds = (t: string) => parseSearch(t, new Date("2026-10-24T12:00:00Z")).map((p) => p.kind);
const levels =
  (o: Partial<Record<BuiltinField, Level>> = {}) =>
  (f: BuiltinField): Level =>
    o[f] ?? "full";

describe("reading a search term", () => {
  it("a name in any order, with punctuation, and a trailing last 4", () => {
    const [name] = parseSearch("Etting, Jordan");
    expect(name).toMatchObject({ kind: "name", tokens: ["etting", "jordan"] });
    expect(parseSearch("jordan e 4321").find((p) => p.kind === "name")).toMatchObject({ tokens: ["jordan", "e"], last4: "4321" });
    expect(kinds("Jordan")).toEqual(expect.arrayContaining(["name", "squire_id", "city", "tag", "notes"]));
  });

  it("phones in any format, the last 4, and partial digits", () => {
    for (const t of ["(319) 555-0100", "319.555.0100", "+1 319 555 0100", "3195550100"])
      expect(parseSearch(t).find((p) => p.kind === "phone"), t).toEqual({ kind: "phone", e164: "+13195550100" });
    expect(kinds("0100")).toEqual(expect.arrayContaining(["phone_last4", "ticket", "squire_id"]));
    expect(kinds("55501")).toEqual(expect.arrayContaining(["phone_part", "zip", "client_number", "ticket"]));
  });

  it("emails, identifiers and codes", () => {
    expect(parseSearch("Jordan@Example.TEST")).toEqual(
      expect.arrayContaining([
        { kind: "email", email: "jordan@example.test" },
        { kind: "email_part", text: "jordan@example.test" },
      ]),
    );
    expect(parseSearch("0f8fad5b-d9cb-469f-a165-70867728950e")).toEqual([{ kind: "client_id", id: "0f8fad5b-d9cb-469f-a165-70867728950e" }]);
    expect(parseSearch("RAYZ1-10001-abcdefghij")).toEqual([{ kind: "loyalty_card", n: 10001, sig: "ABCDEFGHIJ" }]);
    expect(parseSearch("#1234")).toEqual([{ kind: "ticket", n: 1234 }]);
    expect(parseSearch("C10042")).toEqual([{ kind: "client_number", n: 10042 }]);
    const gift = parseSearch("abcd1234efgh5678").find((p) => p.kind === "gift_card");
    expect(gift).toEqual({ kind: "gift_card", codes: ["ABCD1234EFGH5678", "ABCD-1234-EFGH-5678"] });
    expect(kinds("SUMMER25")).toEqual(expect.arrayContaining(["gift_card", "coupon", "squire_id", "name"]));
    expect(kinds("AB12CD34EF")).toContain("appointment");
  });

  it("birthdays, addresses, towns, notes and tags, and prefixes that pick one reading", () => {
    expect(parseSearch("7/14/1994")).toEqual([{ kind: "birthday", iso: "1994-07-14" }]);
    expect(parseSearch("7/14/94")).toEqual([{ kind: "birthday", iso: "1994-07-14" }]);
    expect(parseSearch("07/14")).toEqual([{ kind: "birthday_md", month: 7, day: 14 }]);
    expect(parseDate("2/30/1990")).toBeNull();
    expect(kinds("1701 2nd St")).toEqual(expect.arrayContaining(["address", "address_part"]));
    expect(parseSearch("zip:52241")).toEqual([{ kind: "zip", zip: "52241" }]);
    expect(parseSearch("town: Rock  Island")).toEqual([{ kind: "city", city: "rock island" }]);
    expect(parseSearch("tag:VIP")).toEqual([{ kind: "tag", text: "vip" }]);
    expect(parseSearch("note:fade")).toEqual([{ kind: "notes", text: "fade" }]);
    expect(parseSearch("squire:SQ-77")).toEqual([{ kind: "squire_id", id: "SQ-77" }]);
    expect(parseSearch("x")).toEqual([]);
  });
});

describe("what a person may search by", () => {
  const all = parseSearch("4321").concat(parseSearch("55501"), parseSearch("zip:52241"), parseSearch("note:fade"), parseSearch("07/14"), parseSearch("jordan 4321"));

  it("seen in full: any part", () => {
    expect(allowedProbes(all, levels()).map((p) => p.kind)).toEqual(all.map((p) => p.kind));
  });

  it("masked: only what the mask shows, the last 4 of a phone and an address's zip and town", () => {
    const got = allowedProbes(all, levels({ phone: "masked", address: "masked", notes: "masked", birthday: "masked" })).map((p) => p.kind);
    expect(got).toContain("phone_last4");
    expect(got).toContain("zip");
    expect(got).not.toContain("phone_part");
    expect(got).not.toContain("notes");
    expect(got).not.toContain("birthday_md");
  });

  it("hidden: only the exact whole value, never a part, and a name loses its phone digits", () => {
    const hidden = levels({ phone: "hidden", email: "hidden", address: "hidden", birthday: "hidden" });
    const got = allowedProbes([...all, ...parseSearch("(319) 555-0100"), ...parseSearch("jordan@example.test"), ...parseSearch("7/14/1994")], hidden);
    const k = got.map((p) => p.kind);
    expect(k).toEqual(expect.arrayContaining(["phone", "email", "birthday"]));
    for (const no of ["phone_last4", "phone_part", "email_part", "zip", "birthday_md"]) expect(k).not.toContain(no);
    expect(got.find((p): p is Extract<Probe, { kind: "name" }> => p.kind === "name")?.last4).toBeUndefined();
  });

  it("result labels never repeat a hidden value", () => {
    expect(matchLabel({ kind: "phone", e164: "+13195550100" })).toBe("Phone");
    expect(matchLabel({ kind: "email", email: "a@b.test" })).toBe("Email");
    expect(matchLabel({ kind: "birthday", iso: "1994-07-14" })).toBe("Birthday");
    expect(matchLabel({ kind: "phone_last4", digits: "0100" })).toBe("Phone ends in 0100");
    expect(shortName("Jordan", "etting")).toBe("Jordan E.");
    expect(shortName("Jordan", null)).toBe("Jordan");
  });
});

describe("loyalty card", () => {
  it("is signed: the right card validates, a made-up one for the same number doesn't", async () => {
    const { loyaltyCardValue, loyaltyCardValid, loyaltyCardSvg } = await import("@/server/loyalty-card");
    const c = { id: "0f8fad5b-d9cb-469f-a165-70867728950e", number: 10042 };
    const v = loyaltyCardValue(c);
    expect(v).toMatch(/^RAYZ1-10042-[A-Z2-7]{10}$/);
    const [p] = parseSearch(v);
    expect(p).toMatchObject({ kind: "loyalty_card", n: 10042 });
    expect(loyaltyCardValid(c, (p as Extract<Probe, { kind: "loyalty_card" }>).sig.toLowerCase())).toBe(true);
    expect(loyaltyCardValid(c, "AAAAAAAAAA")).toBe(false);
    expect(loyaltyCardValid({ ...c, id: "1f8fad5b-d9cb-469f-a165-70867728950e" }, v.slice(-10))).toBe(false);
    expect(await loyaltyCardSvg(c)).toMatch(/^<svg/);
  });
});

describe("filters", () => {
  const seg = (o: object) => SegmentSchema.parse(o);
  const sees = (o: Partial<Record<string, Level>> = {}, money = true): FilterSees => ({ birthday: true, ratings: true, level: (f) => o[f] ?? "full", money });

  it("refuses a filter that would read a detail the person can't see", () => {
    expect(segmentProblem(seg({ minAge: 21 }), sees({ birthday: "masked" }))).toMatch(/whole birthdays/);
    expect(segmentProblem(seg({ birthdayMonths: [7] }), sees({ birthday: "masked" }))).toBeNull();
    expect(segmentProblem(seg({ birthdayWithinDays: 14 }), sees({ birthday: "hidden" }))).toMatch(/birthday/);
    expect(segmentProblem(seg({ zips: ["52241"] }), sees({ address: "masked" }))).toBeNull();
    expect(segmentProblem(seg({ cities: ["moline"] }), sees({ address: "hidden" }))).toMatch(/addresses are hidden/);
    expect(segmentProblem(seg({ minTipsCents: 500 }), sees({}, false))).toMatch(/every client/);
    expect(segmentProblem(seg({ giftCard: "has_balance" }), sees({}, false))).toMatch(/every client/);
    expect(segmentProblem(seg({ fieldsSet: ["phone"] }), sees({ phone: "hidden" }))).toMatch(/Phone/i);
    expect(segmentProblem(seg({ fieldsSet: ["phone"] }), sees({ phone: "masked" }))).toBeNull();
    expect(segmentProblem(seg({ minRating: 4 }), sees({ ratings: "hidden" }))).toMatch(/ratings are hidden/);
  });

  it("refuses contradictions", () => {
    expect(segmentProblem(seg({ fieldsSet: ["email"], fieldsEmpty: ["email"] }), sees())).toMatch(/both filled in and empty/);
    expect(segmentProblem(seg({ lastVisitFrom: "2026-10-01", lastVisitTo: "2026-09-01" }), sees())).toMatch(/ends before it starts/);
    expect(segmentProblem(seg({ minNoShows: 3, maxNoShows: 1 }), sees())).toMatch(/lowest/);
    expect(segmentProblem(seg({ minAge: 40, maxAge: 30 }), sees())).toMatch(/lowest/);
    expect(segmentProblem(seg({ minVisits: 2, maxVisits: 5, upcoming: "no" }), sees())).toBeNull();
  });

  it("upcoming birthdays wrap the year, and Feb 29 counts in other years", () => {
    expect(upcomingBirthdayKeys("2026-12-30", 3)).toEqual(["12-30", "12-31", "01-01", "01-02"]);
    expect(upcomingBirthdayKeys("2027-02-27", 2)).toEqual(["02-27", "02-28", "02-29", "03-01"]);
    expect(upcomingBirthdayKeys("2028-02-27", 2)).toEqual(["02-27", "02-28", "02-29"]);
  });

  it("the URL form keeps only what's set and survives a round trip; junk is no filter", () => {
    const s = seg({ tags: ["VIP"], minVisits: 3, cities: ["Rock Island"], near: { shopId: "0f8fad5b-d9cb-469f-a165-70867728950e", miles: 10 }, fieldsEmpty: ["email"] });
    const f = encodeFilter(s);
    expect(f).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilter(f)).toEqual(s);
    expect(encodeFilter(EMPTY_SEGMENT)).toBe("");
    expect(decodeFilter("not base64!")).toEqual(EMPTY_SEGMENT);
    expect(decodeFilter(btoa(JSON.stringify({ minVisits: "lots" })))).toEqual(EMPTY_SEGMENT);
  });
});

describe("duplicates", () => {
  const side = (o: Partial<DuplicateSide>): DuplicateSide => ({ firstName: "Jordan", lastName: "Etting", nickname: null, phone: null, email: null, birthday: null, zip: null, ...o });

  it("typo-close names: one edit from five letters, two from eight; short names one letter apart are different people", () => {
    expect(editDistance("micheal", "michael")).toBe(1);
    expect(typoClose("Jonathon", "Jonathan")).toBe(true);
    expect(typoClose("Minh", "Linh")).toBe(false);
    expect(typoClose("Mike", "Mika")).toBe(false);
    expect(typoClose("Kowalsky", "Kowalski")).toBe(true);
    expect(namesMatch(side({ firstName: "Michael" }), side({ firstName: "Mike" }))).toBe(true);
    expect(namesMatch(side({ firstName: "Marcus", nickname: "Moose" }), side({ firstName: "Moose" }))).toBe(true);
  });

  it("scores contact, names, birthday, zip and last 4, and keeps conflicts out of 'likely'", () => {
    const likely = scoreDuplicate(side({ firstName: "Mike", phone: "+15635559802" }), side({ firstName: "Michael", phone: "+15635559802", email: "m@x.test" }));
    expect(likely).toMatchObject({ kind: "likely", signals: ["phone", "compatible_name"] });
    const typo = scoreDuplicate(side({ firstName: "Jonathon", lastName: "Reyes", birthday: "1991-03-08" }), side({ firstName: "Jonathan", lastName: "Reyes", birthday: "1991-03-08", phone: "+15635559801" }));
    expect(typo).toMatchObject({ kind: "similar_name", signals: ["similar_name", "birthday", "no_contact"], conflicts: [] });
    const family = scoreDuplicate(side({ firstName: "Darnell", phone: "+15635559803", birthday: "1972-09-14" }), side({ firstName: "Darnell", phone: "+15635559803", birthday: "2004-01-30" }));
    expect(family).toMatchObject({ kind: "shared_contact", conflicts: ["birthday"] });
    const siblings = scoreDuplicate(side({ firstName: "Minh", lastName: "Nguyen", phone: "+13095550202" }), side({ firstName: "Linh", lastName: "Nguyen", phone: "+13095550202" }));
    expect(siblings).toMatchObject({ kind: "shared_contact", conflicts: ["first_name"] });
    const sameName = scoreDuplicate(side({ zip: "52241", phone: "+15635554444" }), side({ zip: "52241", phone: "+13195554444" }));
    expect(sameName).toMatchObject({ kind: "same_name", signals: ["same_name", "zip", "phone_last4"] });
    expect(likely.score).toBeGreaterThan(sameName.score);
  });

  it("a bulk merge keeps more visits, then the older record, and chains pairs that share a client", () => {
    const c = (id: string, visits: number, year: number) => ({ id, visits, createdAt: new Date(`${year}-01-01`) });
    const [a, b, d, e] = [c("a", 1, 2020), c("b", 4, 2024), c("d", 0, 2019), c("e", 0, 2023)];
    expect(pickKeeper(a, b)[0].id).toBe("b");
    expect(pickKeeper(d, e)[0].id).toBe("d");
    expect(planMerges([[a, b], [b, d], [a, d], [d, e]])).toEqual([
      { keep: "b", drop: "a" },
      { keep: "b", drop: "d" },
      { keep: "b", drop: "e" },
    ]);
  });
});
