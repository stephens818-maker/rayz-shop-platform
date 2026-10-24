/**
 * Booking a family together, kept pure: given each person's open seats for their own service (and
 * their own barber, when they asked for one), find ways to seat everyone on one day.
 *
 * - same_barber: one barber takes everyone back to back, in the order given.
 * - together: everyone starts at once (or within a few minutes) with several barbers.
 * - earliest_finish: any mix of the two that gets the whole group done soonest.
 *
 * A barber's seats must not touch what their other seats hold (prep, service, cleanup and the gap
 * after), the same rule the database enforces. The server books the option picked in one
 * transaction, so a seat taken in the meantime books nobody.
 */
import { z } from "zod";
import type { FamilySettings } from "./family";

export const GROUP_PLANS = ["same_barber", "together", "earliest_finish"] as const;
export type GroupPlan = (typeof GROUP_PLANS)[number];

export const GROUP_PLAN_LABEL: Record<GroupPlan, string> = {
  same_barber: "Back to back, same barber",
  together: "At the same time, several barbers",
  earliest_finish: "Mixed: everyone done soonest",
};

/** The most a back-to-back chain may idle between one person and the next. */
export const BACK_TO_BACK_GAP_MAX_MIN = 30;
/** "Together" allows starts this far apart, for barbers on different grids. */
export const TOGETHER_STAGGER_MIN = 15;
/** Options offered per plan. */
export const OPTIONS_PER_PLAN = 3;

/** One open seat: a barber at a start, with what it holds before and after the service. */
export interface Opening {
  staffId: string;
  start: number;
  end: number;
  holdStart: number;
  holdEnd: number;
}
export interface PersonOpenings {
  customerId: string;
  openings: Opening[];
}
export interface GroupSeat extends Opening {
  customerId: string;
}
export interface GroupOption {
  plan: GroupPlan;
  /** In the order the people were given. */
  seats: GroupSeat[];
  start: number;
  end: number;
  minutes: number;
  barbers: number;
}
export interface PlanResult {
  plan: GroupPlan;
  options: GroupOption[];
  /** Why there are none, in words for the parent or the desk. */
  reason: string | null;
}

const clash = (a: Opening, b: Opening) => a.staffId === b.staffId && a.holdStart < b.holdEnd && b.holdStart < a.holdEnd;
const fitsWith = (o: Opening, chosen: readonly Opening[]) => !chosen.some((c) => clash(o, c));

export function groupWindow(seats: readonly Pick<Opening, "start" | "end">[]) {
  const start = Math.min(...seats.map((s) => s.start));
  const end = Math.max(...seats.map((s) => s.end));
  return { start, end, minutes: Math.round((end - start) / 60_000) };
}

function option(plan: GroupPlan, people: readonly PersonOpenings[], byPerson: Map<string, Opening>): GroupOption {
  const seats = people.map((p) => ({ customerId: p.customerId, ...byPerson.get(p.customerId)! }));
  return { plan, seats, ...groupWindow(seats), barbers: new Set(seats.map((s) => s.staffId)).size };
}

const key = (o: GroupOption) => o.seats.map((s) => `${s.customerId}:${s.staffId}:${s.start}`).join("|");

/** Keep the first of each distinct option, then the best `limit`, preferring different start times. */
function pick(options: GroupOption[], limit: number, order: (a: GroupOption, b: GroupOption) => number): GroupOption[] {
  const seen = new Set<string>();
  const unique = options
    .filter((o) => {
      if (seen.has(key(o))) return false;
      seen.add(key(o));
      return true;
    })
    .sort(order);
  const out: GroupOption[] = [];
  const starts = new Set<number>();
  for (const o of unique) {
    if (out.length >= limit || starts.has(o.start)) continue;
    out.push(o);
    starts.add(o.start);
  }
  for (const o of unique) if (out.length < limit && !out.includes(o)) out.push(o);
  return out.sort(order);
}

const byStart = (a: GroupOption, b: GroupOption) => a.start - b.start || a.end - b.end;
const byEnd = (a: GroupOption, b: GroupOption) => a.end - b.end || a.start - b.start;

/** One barber, everyone back to back in the order given, each starting soon after the last one's hold ends. */
export function sameBarberOptions(people: readonly PersonOpenings[], after = 0, limit = OPTIONS_PER_PLAN): GroupOption[] {
  if (!people.length) return [];
  const shared = people.map((p) => new Set(p.openings.map((o) => o.staffId))).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  const out: GroupOption[] = [];
  for (const staffId of shared) {
    const lists = people.map((p) => p.openings.filter((o) => o.staffId === staffId).sort((a, b) => a.start - b.start));
    for (const first of lists[0]) {
      if (first.start < after) continue;
      const chain: Opening[] = [first];
      for (let i = 1; i < people.length; i++) {
        const prev = chain[i - 1];
        const next = lists[i].find((o) => o.holdStart >= prev.holdEnd && fitsWith(o, chain));
        if (!next || next.start - prev.end > BACK_TO_BACK_GAP_MAX_MIN * 60_000) break;
        chain.push(next);
      }
      if (chain.length === people.length) out.push(option("same_barber", people, new Map(people.map((p, i) => [p.customerId, chain[i]]))));
      if (out.length >= limit * 4 * shared.size) break;
    }
  }
  return pick(out, limit, byStart);
}

/**
 * Give each person a different barber from their candidates (each person's candidates keyed by
 * barber): a bipartite matching by augmenting paths. Null when not everyone can be seated.
 */
function matchBarbers(cands: Map<string, Opening>[]): Opening[] | null {
  const owner = new Map<string, number>();
  const tryPerson = (i: number, seen: Set<string>): boolean => {
    for (const staffId of cands[i].keys()) {
      if (seen.has(staffId)) continue;
      seen.add(staffId);
      const j = owner.get(staffId);
      if (j === undefined || tryPerson(j, seen)) {
        owner.set(staffId, i);
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < cands.length; i++) if (!tryPerson(i, new Set())) return null;
  const out: Opening[] = new Array(cands.length);
  for (const [staffId, i] of owner) out[i] = cands[i].get(staffId)!;
  return out;
}

/**
 * Everyone starting at once with a barber each, or within TOGETHER_STAGGER_MIN of each other when
 * the barbers' grids differ. Exactly together is preferred; each barber takes one person.
 */
export function togetherOptions(people: readonly PersonOpenings[], after = 0, limit = OPTIONS_PER_PLAN): GroupOption[] {
  if (!people.length) return [];
  const stagger = TOGETHER_STAGGER_MIN * 60_000;
  const times = [...new Set(people.flatMap((p) => p.openings.map((o) => o.start)))].filter((t) => t >= after).sort((a, b) => a - b);
  const earliestPerBarber = (list: Opening[]) => {
    const m = new Map<string, Opening>();
    for (const o of [...list].sort((a, b) => a.start - b.start || a.end - b.end)) if (!m.has(o.staffId)) m.set(o.staffId, o);
    return m;
  };
  const out: GroupOption[] = [];
  for (const t of times) {
    const exact = people.map((p) => earliestPerBarber(p.openings.filter((o) => o.start === t)));
    const near = people.map((p) => earliestPerBarber(p.openings.filter((o) => o.start >= t && o.start <= t + stagger)));
    const seats = (exact.every((c) => c.size) ? matchBarbers(exact) : null) ?? (near.every((c) => c.size) ? matchBarbers(near) : null);
    if (seats && seats.some((o) => o.start === t)) out.push(option("together", people, new Map(people.map((p, i) => [p.customerId, seats[i]]))));
    if (out.length >= limit * 3) break;
  }
  return pick(out, limit, byStart);
}

/**
 * The seating that finishes the whole group soonest, starting no earlier than each candidate start:
 * several barbers, one barber back to back, or a mix. Longest services are placed first; each person
 * tries their few earliest-ending seats, and anything that can't beat the best finish is dropped.
 */
export function earliestFinishOptions(people: readonly PersonOpenings[], after = 0, limit = OPTIONS_PER_PLAN): GroupOption[] {
  if (!people.length) return [];
  const branch = people.length > 4 ? 3 : 4;
  const sorted = people.map((p) => [...p.openings].sort((a, b) => a.end - b.end || a.start - b.start));
  const duration = (i: number) => (sorted[i][0] ? sorted[i][0].end - sorted[i][0].start : 0);
  const order = people.map((_, i) => i).sort((a, b) => duration(b) - duration(a));
  const times = [...new Set(people.flatMap((p) => p.openings.map((o) => o.start)))].filter((t) => t >= after).sort((a, b) => a - b);
  const out: GroupOption[] = [];
  let tries = 0;
  let lastEnd = -1;
  for (const t of times) {
    if (++tries > 48 || out.length >= limit * 2) break;
    let best: Opening[] | null = null;
    let bestEnd = Infinity;
    const chosen: Opening[] = new Array(people.length);
    const placed: Opening[] = [];
    const walk = (k: number, maxEnd: number) => {
      if (k === order.length) {
        if (maxEnd < bestEnd) {
          bestEnd = maxEnd;
          best = [...chosen];
        }
        return;
      }
      const i = order[k];
      let tried = 0;
      for (const o of sorted[i]) {
        if (o.end >= bestEnd) break;
        if (o.start < t || !fitsWith(o, placed)) continue;
        chosen[i] = o;
        placed.push(o);
        walk(k + 1, Math.max(maxEnd, o.end));
        placed.pop();
        if (++tried >= branch) break;
      }
    };
    walk(0, 0);
    if (!best) break;
    const seats: Opening[] = best;
    const o = option("earliest_finish", people, new Map(people.map((p, i) => [p.customerId, seats[i]])));
    if (o.end !== lastEnd) out.push(o);
    lastEnd = o.end;
  }
  return pick(out, limit, byEnd);
}

const NONE: Record<GroupPlan, (n: number) => string> = {
  same_barber: (n) => `No one barber has room for all ${n} back to back that day`,
  together: (n) => `There aren't ${n} barbers free at the same time that day`,
  earliest_finish: () => "There's no room for everyone that day",
};

/** All three plans for one day, best first within each. */
export function groupOptions(people: readonly PersonOpenings[], after = 0, limit = OPTIONS_PER_PLAN): PlanResult[] {
  const make = { same_barber: sameBarberOptions, together: togetherOptions, earliest_finish: earliestFinishOptions };
  return GROUP_PLANS.map((plan) => {
    const options = people.some((p) => !p.openings.length) ? [] : make[plan](people, after, limit);
    return { plan, options, reason: options.length ? null : NONE[plan](people.length) };
  });
}

/**
 * After a seat was taken mid-booking: an option of the same plan where everyone keeps their start
 * time (only who cuts whom may change, for people who didn't ask for a barber). Null when there's none.
 */
export function sameTimesOption(wanted: readonly Pick<GroupSeat, "customerId" | "start">[], results: readonly PlanResult[], plan: GroupPlan): GroupOption | null {
  const at = new Map(wanted.map((s) => [s.customerId, s.start]));
  const r = results.find((x) => x.plan === plan);
  return r?.options.find((o) => o.seats.every((s) => at.get(s.customerId) === s.start)) ?? null;
}

/** The one deposit a group pays under the brand's rule, or 0. */
export function groupDepositCents(s: Pick<FamilySettings, "groupDepositCents" | "groupDepositFrom">, people: number): number {
  return s.groupDepositCents > 0 && people >= s.groupDepositFrom ? s.groupDepositCents : 0;
}

// ───────────────────────────── Requests and the public API ─────────────────────────────

const Person = z.object({
  customerId: z.uuid().describe("The parent, or one of their children"),
  serviceId: z.uuid(),
  addonIds: z.array(z.uuid()).max(10).default([]),
  staffId: z.uuid().nullable().default(null).describe("A barber they asked for; null lets the shop pick"),
  notes: z.string().trim().max(500).optional(),
});
export type GroupPerson = z.output<typeof Person>;
const People = z.array(Person).min(2, "Pick at least two people").max(7, "Up to 7 people: a parent and 6 children");

export const GroupOptionsRequestSchema = z.object({
  shopId: z.string().trim().min(1).max(80).describe("The shop's id or slug"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  people: People,
  after: z.string().optional().describe("Only options starting at or after this ISO time (e.g. the time the parent tapped)"),
});
export type GroupOptionsRequest = z.output<typeof GroupOptionsRequestSchema>;

const SeatInput = z.object({ customerId: z.uuid(), staffId: z.uuid(), startsAt: z.string().min(1) });
export const GroupBookingRequestSchema = z.object({
  shopId: z.string().trim().min(1).max(80),
  people: People,
  plan: z.enum([...GROUP_PLANS, "custom"]).default("custom"),
  seats: z.array(SeatInput).min(2).max(7).describe("The option picked: one seat per person"),
});
export type GroupBookingRequest = z.output<typeof GroupBookingRequestSchema>;

export const GroupRescheduleRequestSchema = z.object({
  plan: z.enum([...GROUP_PLANS, "custom"]).default("custom"),
  seats: z.array(SeatInput).min(1).max(7).describe("A seat for each person still booked"),
});

const SeatOut = z.object({
  customerId: z.string(),
  firstName: z.string().nullable(),
  staffId: z.string(),
  barber: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});
export const GroupOptionSchema = z.object({
  plan: z.enum(GROUP_PLANS),
  label: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  minutes: z.number().int().describe("The whole group's time window, first start to last finish"),
  barbers: z.number().int(),
  seats: z.array(SeatOut),
});
export const GroupOptionsSchema = z.object({
  plans: z.array(z.object({ plan: z.enum(GROUP_PLANS), label: z.string(), options: z.array(GroupOptionSchema), reason: z.string().nullable() })),
  depositCents: z.number().int().describe("The one deposit this group would need under the brand's rule; 0 for none"),
});
export const BookingGroupSchema = z.object({
  code: z.string().describe("The group's link: /g/{code}"),
  plan: z.string(),
  shop: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  startsAt: z.string(),
  endsAt: z.string(),
  minutes: z.number().int(),
  status: z.enum(["booked", "partly_cancelled", "cancelled", "done"]),
  canCancel: z.boolean(),
  canReschedule: z.boolean(),
  cancelCutoffAt: z.string(),
  deposit: z.object({ cents: z.number().int(), status: z.string() }),
  members: z.array(
    z.object({
      appointmentCode: z.string().describe("Change or cancel just this person at /a/{code}"),
      customerId: z.string().nullable(),
      firstName: z.string().nullable(),
      isChild: z.boolean(),
      status: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      barber: z.object({ id: z.string(), displayName: z.string() }),
      services: z.array(z.string()),
      canChange: z.boolean(),
    }),
  ),
});
