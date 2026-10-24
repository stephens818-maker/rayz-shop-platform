/**
 * Family accounts, kept pure: the brand's settings (how many children a parent's account carries,
 * whether a child's visits count toward the household's loyalty or their own, and the age a child
 * can get an account of their own), a child's age, the child profile form, who a family booking
 * seats where, and the public API's shapes.
 *
 * A child is a client record under a parent or guardian (customers.guardian_id): their own visits,
 * badges, ratings, notes and photo, but no login, phone, email or consent. Reminders, receipts and
 * marketing go to the parent, under the parent's consent.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import type { LocalDate } from "@/lib/time";

export const FAMILY_LOYALTY = ["household", "individual"] as const;
export type FamilyLoyalty = (typeof FAMILY_LOYALTY)[number];

export const FAMILY_LIMITS = { maxChildren: 12, minSplitAge: 13, maxSplitAge: 21, maxAge: 25 } as const;

export const FamilySettingsSchema = z.object({
  /** Children one parent's account can carry. 0 turns family accounts off for new children. */
  maxChildren: z.number().int().min(0, "0 to 12 children").max(FAMILY_LIMITS.maxChildren, "0 to 12 children").default(6),
  /** household: a child's visits earn on the parent's loyalty card. individual: each person has their own. */
  loyalty: z.enum(FAMILY_LOYALTY).default("household"),
  /** From this age a child can be split into an account of their own, keeping their history. */
  splitAge: z.number().int().min(FAMILY_LIMITS.minSplitAge, "13 to 21").max(FAMILY_LIMITS.maxSplitAge, "13 to 21").default(13),
  /** One deposit for a family booked together, not one per person. 0 turns it off. */
  groupDepositCents: z.number().int().min(0, "$0 to $200").max(20_000, "$0 to $200").default(0),
  /** The deposit applies to groups of this many people or more. */
  groupDepositFrom: z.number().int().min(2, "2 to 7 people").max(FAMILY_LIMITS.maxChildren + 1, "2 to 7 people").default(3),
  /** A group no-show (or a cancel after the cutoff) keeps the deposit. Off: it stays as credit on the account. */
  groupNoShowForfeit: z.boolean().default(true),
});
export type FamilySettings = z.output<typeof FamilySettingsSchema>;
export const FAMILY_DEFAULT: FamilySettings = { maxChildren: 6, loyalty: "household", splitAge: 13, groupDepositCents: 0, groupDepositFrom: 3, groupNoShowForfeit: true };

/** Stored settings read defensively: a key that doesn't parse falls back to its default, the others stay. */
export function familySettings(raw: unknown): FamilySettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...FAMILY_DEFAULT };
  for (const k of Object.keys(FAMILY_DEFAULT) as (keyof FamilySettings)[]) {
    const r = FamilySettingsSchema.shape[k].safeParse(o[k]);
    if (r.success) (out as Record<string, unknown>)[k] = r.data;
  }
  return out;
}

// ───────────────────────────── Age ─────────────────────────────

/**
 * Whole years on `today`: from the birthday when it's known, otherwise from the birth year (which
 * may be a year high before their birthday comes round). Null when neither is on file.
 */
export function ageOn(c: { birthday?: string | null; birthYear?: number | null }, today: LocalDate): number | null {
  if (c.birthday && /^\d{4}-\d{2}-\d{2}/.test(c.birthday)) {
    const b = DateTime.fromISO(c.birthday.slice(0, 10), { zone: "UTC" });
    const t = DateTime.fromISO(today, { zone: "UTC" });
    if (!b.isValid || !t.isValid) return null;
    if (b > t) return 0;
    let years = t.year - b.year;
    if (t.month < b.month || (t.month === b.month && t.day < b.day)) years -= 1;
    return Math.max(0, years);
  }
  if (c.birthYear) return Math.max(0, Number(today.slice(0, 4)) - c.birthYear);
  return null;
}

/** "Max, 7" / "Max" for the desk and the parent's portal. */
export const childLabel = (c: { firstName: string; lastName?: string | null }, age: number | null) =>
  `${[c.firstName, c.lastName].filter(Boolean).join(" ")}${age != null ? `, ${age}` : ""}`;

// ───────────────────────────── The child profile form ─────────────────────────────

const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
export const PHOTO_MAX_CHARS = 400_000;
export const isPhotoDataUrl = (s: string) => s.length <= PHOTO_MAX_CHARS && PHOTO.test(s);

const Birthday = z
  .string()
  .trim()
  .refine((s) => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid), "Birthday doesn't look right");

/**
 * Add or edit a child. Give a birthday or an age (the birthday wins); an empty string clears a
 * text field. Contact details aren't part of it: a child has none.
 */
export const ChildInputSchema = z.object({
  firstName: z.string().trim().min(1, "Add the child's first name").max(60),
  lastName: z.string().trim().max(60).optional(),
  birthday: Birthday.optional(),
  age: z.number().int().min(0, "Age 0 to 25").max(FAMILY_LIMITS.maxAge, "Age 0 to 25").nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  preferredStaffId: z.uuid().nullable().optional(),
  photo: z
    .string()
    .refine(isPhotoDataUrl, "Use a JPEG, PNG or WebP photo under 300 KB")
    .nullable()
    .optional(),
});
export type ChildInput = z.output<typeof ChildInputSchema>;

/**
 * The stored birthday and birth year a form gives, checked against `today`: a birthday in the
 * future or more than the maximum age ago is refused, and an age sets the birth year.
 * `undefined` keeps what's on file.
 */
export function childDates(
  input: Pick<ChildInput, "birthday" | "age">,
  today: LocalDate,
): { ok: true; birthday?: string | null; birthYear?: number | null } | { ok: false; message: string } {
  if (input.birthday) {
    if (input.birthday > today) return { ok: false, message: "That birthday is in the future" };
    const age = ageOn({ birthday: input.birthday }, today)!;
    if (age > FAMILY_LIMITS.maxAge) return { ok: false, message: `A child profile is for someone ${FAMILY_LIMITS.maxAge} or younger` };
    return { ok: true, birthday: input.birthday, birthYear: Number(input.birthday.slice(0, 4)) };
  }
  const out: { ok: true; birthday?: string | null; birthYear?: number | null } = { ok: true };
  if (input.birthday === "") out.birthday = null;
  if (input.age != null) out.birthYear = Number(today.slice(0, 4)) - input.age;
  else if (input.age === null) out.birthYear = null;
  return out;
}

/** Why another child can't be added, or null when they can. */
export function childLimitProblem(current: number, s: FamilySettings): string | null {
  if (s.maxChildren === 0) return "Family accounts are turned off for this brand";
  if (current >= s.maxChildren) return `An account can have up to ${s.maxChildren} ${s.maxChildren === 1 ? "child" : "children"}. Remove one first, or ask the brand to raise the limit.`;
  return null;
}

/** Why this child can't get their own account yet, or null when they can. */
export function splitProblem(c: { birthday?: string | null; birthYear?: number | null }, s: FamilySettings, today: LocalDate): string | null {
  const age = ageOn(c, today);
  if (age == null) return `Add their birthday first: a child can get their own account from ${s.splitAge}`;
  if (age < s.splitAge) return `A child can get their own account from ${s.splitAge}`;
  return null;
}

// ───────────────────────────── Family booking ─────────────────────────────

/**
 * How each person after the first is seated: `same_time` with another barber at the first person's
 * start, or `after` the person before them (back to back, with the same barber unless one is picked).
 */
export const FAMILY_TIMING = ["same_time", "after"] as const;
export type FamilyTiming = (typeof FAMILY_TIMING)[number];

export const FAMILY_BOOKING_MAX = 1 + FAMILY_LIMITS.maxChildren;

export interface SeatRequest {
  timing: FamilyTiming;
  /** A barber they asked for; null lets the shop pick. */
  staffId: string | null;
}
export interface Seat {
  staffId: string;
  startsAt: string;
  endsAt: string;
}
export interface OpenSlot {
  staffId: string;
  startsAt: string;
}

/**
 * Where the next person sits, given the open slots for their service and who's already seated:
 * - same_time: a slot at the first person's start with a barber nobody in the party has yet
 *   (the barber they asked for, when free);
 * - after: the earliest slot at or after the previous person's end, with the barber they asked for,
 *   or else the previous person's barber, or else anyone.
 * Null when there's no such slot.
 */
export function nextSeat(req: SeatRequest, seated: readonly Seat[], slots: readonly OpenSlot[]): OpenSlot | null {
  const first = seated[0];
  const prev = seated[seated.length - 1];
  if (!first || !prev) return null;
  const ms = (s: string) => new Date(s).getTime();
  if (req.timing === "same_time") {
    const taken = new Set(seated.filter((s) => ms(s.startsAt) < ms(first.endsAt) && ms(s.endsAt) > ms(first.startsAt)).map((s) => s.staffId));
    const at = slots.filter((s) => ms(s.startsAt) === ms(first.startsAt) && !taken.has(s.staffId));
    return (req.staffId ? at.find((s) => s.staffId === req.staffId) : at[0]) ?? null;
  }
  const after = slots.filter((s) => ms(s.startsAt) >= ms(prev.endsAt)).sort((a, b) => ms(a.startsAt) - ms(b.startsAt));
  if (req.staffId) return after.find((s) => s.staffId === req.staffId) ?? null;
  return after.find((s) => s.staffId === prev.staffId) ?? after[0] ?? null;
}

// ───────────────────────────── Who it's for ─────────────────────────────

/** Someone besides the first person in a family booking: their own service, barber and timing. */
export interface PartyMember {
  customerId: string;
  serviceId: string;
  staffId: string | null;
  timing: FamilyTiming;
}
/** Who a booking is for: the first person takes the picked time and service; the party comes along. */
export interface PartySelection {
  firstWho: string;
  party: PartyMember[];
}

export const selectedIds = (sel: PartySelection) => [sel.firstWho, ...sel.party.map((m) => m.customerId)];

/**
 * Tapping someone in the family picker. An unselected person joins the party (same time, the
 * defaults' service and barber); a selected one leaves, and when that's the first person the
 * next one moves up to take the picked time. Nobody is left out: the last person stays selected.
 */
export function togglePartyMember(
  sel: PartySelection,
  id: string,
  defaults: { serviceId: string; staffId?: string | null },
): PartySelection {
  if (id === sel.firstWho) {
    const [next, ...rest] = sel.party;
    return next ? { firstWho: next.customerId, party: rest } : sel;
  }
  if (sel.party.some((m) => m.customerId === id)) return { ...sel, party: sel.party.filter((m) => m.customerId !== id) };
  if (selectedIds(sel).length >= FAMILY_BOOKING_MAX) return sel;
  return { ...sel, party: [...sel.party, { customerId: id, serviceId: defaults.serviceId, staffId: defaults.staffId ?? null, timing: "same_time" }] };
}

// ───────────────────────────── Public API ─────────────────────────────

export const FamilyMemberSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  birthday: z.string().nullable().describe("YYYY-MM-DD, when known"),
  age: z.number().int().nullable(),
  notes: z.string().nullable().describe("Sensory needs, style preferences"),
  preferredStaffId: z.string().nullable(),
  preferredBarber: z.string().nullable(),
  photo: z.string().nullable().describe("data: URL"),
  visits: z.number().int(),
  lastVisit: z.string().nullable().describe("YYYY-MM-DD (shop time)"),
  averageDaysBetween: z.number().int().nullable().describe("Average days between their cuts, from 2 or more visits"),
  upcoming: z.array(z.object({ id: z.string(), startsAt: z.string(), shop: z.string(), barber: z.string(), service: z.string() })),
  badges: z
    .array(z.object({ id: z.string(), name: z.string(), text: z.string(), icon: z.string(), color: z.string(), earnedOn: z.string().nullable() }).loose())
    .describe("The child's badges, as the brand shows them to customers (same shape as /me/badges)"),
  canSplit: z.boolean().describe("Old enough for an account of their own"),
});
export const SplitRequestSchema = z.object({
  phone: z.string().trim().max(30).optional().describe("The child's own phone: they sign in with it"),
  email: z.string().trim().max(200).optional(),
  smsOptIn: z.boolean().default(false),
  emailOptIn: z.boolean().default(false),
});
export const FamilySchema = z.object({
  settings: z.object({
    maxChildren: z.number().int(),
    loyalty: z.enum(FAMILY_LOYALTY),
    splitAge: z.number().int(),
    groupDepositCents: z.number().int().describe("One deposit for a family booked together, from groupDepositFrom people; 0 for none"),
    groupDepositFrom: z.number().int(),
    groupNoShowForfeit: z.boolean().describe("A group no-show or late cancel keeps the deposit"),
  }),
  children: z.array(FamilyMemberSchema),
});
export const FamilyBookingRequestSchema = z.object({
  shopId: z.string().trim().min(1).max(80).describe("The shop's id or slug"),
  people: z
    .array(
      z.object({
        customerId: z.uuid().describe("The signed-in parent, or one of their children"),
        serviceId: z.uuid(),
        addonIds: z.array(z.uuid()).max(10).default([]),
        staffId: z.uuid().nullable().default(null),
        startsAt: z.string().optional().describe("Required for the first person: an open slot from availability"),
        timing: z.enum(FAMILY_TIMING).default("after"),
        notes: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(FAMILY_BOOKING_MAX),
});
export type FamilyBookingRequest = z.output<typeof FamilyBookingRequestSchema>;

const errorRef = { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const ok = (ref: string) => ({ description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } });

/** For openApiDocument (src/server/openapi.ts): the paths and schemas, in that file's shapes. Served by src/server/family-api.ts. */
export const FAMILY_OPENAPI = {
  components: { Family: FamilySchema, FamilyMember: FamilyMemberSchema, ChildInput: ChildInputSchema, FamilyBookingRequest: FamilyBookingRequestSchema, FamilySplitRequest: SplitRequestSchema },
  paths: {
    "/me/family": {
      get: {
        tags: ["Me"],
        summary: "My children: their profile, visit history, cadence and upcoming appointments. Children have no login; everything goes to the parent",
        security: [{ bearerAuth: [] }],
        responses: { 200: ok("Family"), 401: { description: "Sign in required", ...errorRef } },
      },
    },
    "/me/family/children": {
      post: {
        tags: ["Me"],
        summary: "Add a child (up to the brand's limit, 6 by default)",
        security: [{ bearerAuth: [] }],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ChildInput" } } } },
        responses: { 201: ok("FamilyMember"), 400: { description: "Invalid, or at the limit", ...errorRef }, 401: { description: "Sign in required", ...errorRef } },
      },
    },
    "/me/family/children/{id}": {
      patch: {
        tags: ["Me"],
        summary: "Edit a child. Fields left out stay as they are",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ChildInput" } } } },
        responses: { 200: ok("FamilyMember"), 404: { description: "Not one of your children", ...errorRef } },
      },
    },
    "/me/family/children/{id}/remove": {
      post: {
        tags: ["Me"],
        summary: "Take a child off your account. Their history stays on file with the shop",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: ok("Family"), 404: { description: "Not one of your children", ...errorRef } },
      },
    },
    "/me/family/children/{id}/split": {
      post: {
        tags: ["Me"],
        summary: "Give a child old enough (13 by default) an account of their own, with their own phone or email. Every visit, badge and note stays with them",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/FamilySplitRequest" } } } },
        responses: { 200: ok("Family"), 400: { description: "Too young, or no phone or email", ...errorRef }, 404: { description: "Not one of your children", ...errorRef } },
      },
    },
    "/me/family/bookings": {
      post: {
        tags: ["Me"],
        summary: "Book yourself and/or your children in one go: at the same time with different barbers, or back to back. All or nothing",
        security: [{ bearerAuth: [] }],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/FamilyBookingRequest" } } } },
        responses: {
          201: { description: "Booked: one appointment per person, in order" },
          409: { description: "A slot was taken, or nobody is free for someone; nothing was booked", ...errorRef },
        },
      },
    },
  },
} as const;
