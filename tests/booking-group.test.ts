import { describe, expect, it } from "vitest";
import {
  BACK_TO_BACK_GAP_MAX_MIN,
  BookingGroupSchema,
  GroupBookingRequestSchema,
  GroupOptionsRequestSchema,
  earliestFinishOptions,
  groupDepositCents,
  groupOptions,
  groupWindow,
  sameBarberOptions,
  sameTimesOption,
  togetherOptions,
  type Opening,
  type PersonOpenings,
} from "@/domain/booking-group";
import { FAMILY_DEFAULT } from "@/domain/family";

const T0 = Date.UTC(2026, 9, 26, 14, 0);
const at = (min: number) => T0 + min * 60_000;
/** A barber's open seats every 30 minutes from `from` to `to` (minutes after T0), `dur` minutes long, with `gap` held after. */
function seats(staffId: string, from: number, to: number, dur: number, gap = 0, step = 30): Opening[] {
  const out: Opening[] = [];
  for (let t = from; t <= to; t += step) out.push({ staffId, start: at(t), end: at(t + dur), holdStart: at(t), holdEnd: at(t + dur + gap) });
  return out;
}
const person = (customerId: string, ...lists: Opening[][]): PersonOpenings => ({ customerId, openings: lists.flat() });
const mins = (t: number) => (t - T0) / 60_000;

describe("family slot finder: back to back with one barber", () => {
  it("chains everyone with one barber in order, each starting when the last one's hold ends", () => {
    const people = [person("mom", seats("ray", 0, 240, 30)), person("kid1", seats("ray", 0, 240, 30)), person("kid2", seats("ray", 0, 240, 30))];
    const [first] = sameBarberOptions(people);
    expect(first.plan).toBe("same_barber");
    expect(first.seats.map((s) => [s.customerId, s.staffId, mins(s.start)])).toEqual([
      ["mom", "ray", 0],
      ["kid1", "ray", 30],
      ["kid2", "ray", 60],
    ]);
    expect(first).toMatchObject({ start: at(0), end: at(90), minutes: 90, barbers: 1 });
  });

  it("respects the barber's cleanup and gap between people", () => {
    const people = [person("mom", seats("ray", 0, 240, 30, 10, 15)), person("kid", seats("ray", 0, 240, 30, 10, 15))];
    const [o] = sameBarberOptions(people);
    expect(o.seats.map((s) => mins(s.start))).toEqual([0, 45]);
  });

  it("only uses a barber everyone can have, and offers nothing when there's none", () => {
    const people = [person("mom", seats("ray", 0, 120, 30)), person("kid", seats("jess", 0, 120, 30))];
    expect(sameBarberOptions(people)).toEqual([]);
    const both = [person("mom", seats("ray", 0, 120, 30), seats("jess", 0, 120, 30)), person("kid", seats("jess", 0, 120, 30))];
    expect(sameBarberOptions(both).every((o) => o.seats.every((s) => s.staffId === "jess"))).toBe(true);
  });

  it("won't leave the next person waiting more than the allowed gap", () => {
    const people = [person("mom", seats("ray", 0, 0, 30)), person("kid", seats("ray", 30 + BACK_TO_BACK_GAP_MAX_MIN + 30, 300, 30))];
    expect(sameBarberOptions(people)).toEqual([]);
  });

  it("offers a few different start times, earliest first, and none before `after`", () => {
    const people = [person("mom", seats("ray", 0, 240, 30)), person("kid", seats("ray", 0, 240, 30))];
    const opts = sameBarberOptions(people, at(60));
    expect(opts).toHaveLength(3);
    expect(opts.map((o) => mins(o.start))).toEqual([60, 90, 120]);
  });
});

describe("family slot finder: together with several barbers", () => {
  it("starts everyone at once on different barbers", () => {
    const all = (id: string) => person(id, seats("ray", 0, 180, 30), seats("jess", 0, 180, 30), seats("max", 0, 180, 30));
    const [o] = togetherOptions([all("mom"), all("kid1"), all("kid2")]);
    expect(o.seats.map((s) => mins(s.start))).toEqual([0, 0, 0]);
    expect(new Set(o.seats.map((s) => s.staffId)).size).toBe(3);
    expect(o).toMatchObject({ minutes: 30, barbers: 3 });
  });

  it("keeps a barber someone asked for", () => {
    const people = [person("mom", seats("jess", 0, 180, 30)), person("kid", seats("ray", 0, 180, 30), seats("jess", 0, 180, 30))];
    const [o] = togetherOptions(people);
    expect(o.seats.find((s) => s.customerId === "mom")!.staffId).toBe("jess");
    expect(o.seats.find((s) => s.customerId === "kid")!.staffId).toBe("ray");
  });

  it("allows starts a few minutes apart when barbers are on different grids (overlapping)", () => {
    const people = [person("mom", seats("ray", 0, 120, 30, 0, 30)), person("kid", seats("jess", 15, 135, 30, 0, 30))];
    const [o] = togetherOptions(people);
    expect(o.seats.map((s) => mins(s.start))).toEqual([0, 15]);
  });

  it("needs as many barbers free as people", () => {
    const people = [person("a", seats("ray", 0, 120, 30)), person("b", seats("ray", 0, 120, 30))];
    expect(togetherOptions(people)).toEqual([]);
  });
});

describe("family slot finder: mixed, everyone done soonest", () => {
  it("mixes one barber back to back with another barber to finish soonest", () => {
    // Ray is free all afternoon; Jess only at the start. Three people: two with Ray back to back, one with Jess.
    const ray = seats("ray", 0, 240, 30);
    const jess = seats("jess", 0, 0, 30);
    const people = [person("mom", ray, jess), person("kid1", ray, jess), person("kid2", ray, jess)];
    const [o] = earliestFinishOptions(people);
    expect(o.end).toBe(at(60));
    expect(o.barbers).toBe(2);
    expect(o.seats.filter((s) => s.staffId === "ray").map((s) => mins(s.start)).sort((x, y) => x - y)).toEqual([0, 30]);
    expect(togetherOptions(people)).toEqual([]);
    expect(sameBarberOptions(people)[0].end).toBe(at(90));
  });

  it("never puts two people in one chair at once", () => {
    const people = ["a", "b", "c", "d", "e", "f", "g"].map((id) => person(id, seats("ray", 0, 480, 30, 5, 15), seats("jess", 0, 480, 45, 0, 15)));
    for (const o of earliestFinishOptions(people)) {
      for (const x of o.seats) for (const y of o.seats) if (x !== y && x.staffId === y.staffId) expect(x.holdEnd <= y.holdStart || y.holdEnd <= x.holdStart).toBe(true);
      expect(o.seats).toHaveLength(7);
    }
  });

  it("is fast enough for a parent and 6 kids on a busy day", () => {
    const barbers = ["a", "b", "c", "d", "e", "f", "g"];
    const people = Array.from({ length: 7 }, (_, i) => person(`p${i}`, ...barbers.map((b) => seats(b, 0, 600, 30 + (i % 3) * 15, 10, 15))));
    const t = performance.now();
    const r = groupOptions(people);
    expect(performance.now() - t).toBeLessThan(500);
    expect(r.every((p) => p.options.length > 0)).toBe(true);
  });
});

describe("family slot finder: all plans and retries", () => {
  it("gives each plan its options or a reason", () => {
    const people = [person("mom", seats("ray", 0, 60, 30)), person("kid", seats("ray", 0, 60, 30))];
    const r = groupOptions(people);
    expect(r.map((x) => x.plan)).toEqual(["same_barber", "together", "earliest_finish"]);
    expect(r[0].options.length).toBeGreaterThan(0);
    expect(r[1]).toMatchObject({ options: [], reason: "There aren't 2 barbers free at the same time that day" });
    const none = groupOptions([person("mom"), person("kid", seats("ray", 0, 60, 30))]);
    expect(none.every((x) => x.options.length === 0 && x.reason)).toBe(true);
  });

  it("the total window runs from the first start to the last finish", () => {
    expect(groupWindow([{ start: at(0), end: at(30) }, { start: at(15), end: at(75) }])).toEqual({ start: at(0), end: at(75), minutes: 75 });
  });

  it("a taken seat can be retried at the same times only, with another barber", () => {
    const people = [person("mom", seats("jess", 0, 60, 30)), person("kid", seats("max", 0, 60, 30))];
    const r = groupOptions(people);
    expect(sameTimesOption([{ customerId: "mom", start: at(0) }, { customerId: "kid", start: at(0) }], r, "together")).not.toBeNull();
    expect(sameTimesOption([{ customerId: "mom", start: at(0) }, { customerId: "kid", start: at(5) }], r, "together")).toBeNull();
  });
});

describe("family booking requests and deposits", () => {
  it("one deposit for the group, from the brand's group size", () => {
    expect(groupDepositCents(FAMILY_DEFAULT, 5)).toBe(0);
    const s = { ...FAMILY_DEFAULT, groupDepositCents: 2500, groupDepositFrom: 3 };
    expect(groupDepositCents(s, 2)).toBe(0);
    expect(groupDepositCents(s, 3)).toBe(2500);
    expect(groupDepositCents(s, 7)).toBe(2500);
  });

  it("takes 2 to 7 people (a parent and 6 kids) and one seat each", () => {
    const p = (i: number) => ({ customerId: `00000000-0000-4000-8000-00000000000${i}`, serviceId: "00000000-0000-4000-8000-000000000100" });
    expect(GroupOptionsRequestSchema.safeParse({ shopId: "moline", date: "2026-10-26", people: [p(1)] }).success).toBe(false);
    expect(GroupOptionsRequestSchema.safeParse({ shopId: "moline", date: "2026-10-26", people: [1, 2, 3, 4, 5, 6, 7].map(p) }).success).toBe(true);
    expect(GroupOptionsRequestSchema.safeParse({ shopId: "moline", date: "2026-10-26", people: [1, 2, 3, 4, 5, 6, 7, 8].map(p) }).success).toBe(false);
    const r = GroupBookingRequestSchema.parse({ shopId: "moline", people: [p(1), p(2)], seats: [1, 2].map((i) => ({ customerId: p(i).customerId, staffId: p(9).customerId, startsAt: "2026-10-26T14:00:00Z" })) });
    expect(r).toMatchObject({ plan: "custom", people: [{ staffId: null, addonIds: [] }, expect.anything()] });
  });

  it("the public group shape carries the group link and each person's own link", () => {
    expect(Object.keys(BookingGroupSchema.shape)).toEqual(expect.arrayContaining(["code", "minutes", "deposit", "members", "canCancel"]));
    expect(Object.keys(BookingGroupSchema.shape.members.element.shape)).toEqual(expect.arrayContaining(["appointmentCode", "canChange", "barber"]));
  });
});
