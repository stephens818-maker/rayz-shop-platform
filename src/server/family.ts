import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { appointments, brandSettings, clientPhotos, customers, refreshTokens, shops, staff } from "@/db/schema";
import {
  ChildInput,
  ChildInputSchema,
  FamilySettings,
  FamilySettingsSchema,
  ageOn,
  childDates,
  childLimitProblem,
  familySettings,
  splitProblem,
} from "@/domain/family";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import type { CustomerBadge } from "@/domain/customer-badges";
import { localDateOf, todayLocal } from "@/lib/time";
import { Actor, audit } from "./audit";
import { stampRecordNote } from "./record-note";
import { lockIdentity, matchCustomer } from "./customers";
import { AppError, notFound } from "./errors";

export async function loadFamilySettings(tx: DBorTx = db): Promise<FamilySettings> {
  const [b] = await tx.select({ f: brandSettings.family }).from(brandSettings).where(eq(brandSettings.id, 1));
  return familySettings(b?.f);
}

export async function saveFamilySettings(input: unknown, actor: Actor): Promise<FamilySettings> {
  const r = FamilySettingsSchema.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the family settings");
  const before = await loadFamilySettings();
  await db.update(brandSettings).set({ family: { ...r.data }, updatedAt: new Date() }).where(eq(brandSettings.id, 1));
  await audit(actor, "brand.family_settings", "brand_settings", "1", { before, after: r.data }, null);
  return r.data;
}

// ───────────────────────────── Who's in the household ─────────────────────────────

export type Child = typeof customers.$inferSelect;

/** The parent's id for a child, or the client's own id. Unknown ids come back as given. */
export async function householdHead(customerId: string, tx: DBorTx = db): Promise<string> {
  const [c] = await tx.select({ g: customers.guardianId }).from(customers).where(eq(customers.id, customerId));
  return c?.g ?? customerId;
}

/** The parent and their children, the parent first. */
export async function householdIds(customerId: string, tx: DBorTx = db): Promise<string[]> {
  const head = await householdHead(customerId, tx);
  const kids = await tx.select({ id: customers.id }).from(customers).where(eq(customers.guardianId, head)).orderBy(asc(customers.createdAt));
  return [head, ...kids.map((k) => k.id)];
}

export async function childrenOf(guardianId: string, tx: DBorTx = db): Promise<Child[]> {
  return tx.select().from(customers).where(eq(customers.guardianId, guardianId)).orderBy(asc(customers.createdAt), asc(customers.id));
}

/** Both in one household: the same person, a parent and their child, or two children of one parent. */
export async function sameHousehold(a: string, b: string, tx: DBorTx = db): Promise<boolean> {
  if (a === b) return true;
  return (await householdHead(a, tx)) === (await householdHead(b, tx));
}

/** A child of this parent, or not found: nobody edits someone else's child through a parent's account. */
export async function childOf(guardianId: string, childId: string, tx: DBorTx = db): Promise<Child> {
  const [c] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, childId), eq(customers.guardianId, guardianId)));
  if (!c) throw notFound("Child");
  return c;
}

/** Row lock on the parent, so two people adding children at once can't pass the limit. */
async function lockGuardian(tx: DBorTx, guardianId: string) {
  const [g] = await tx.select().from(customers).where(eq(customers.id, guardianId)).for("update");
  if (!g) throw notFound("Client");
  if (g.guardianId) throw new AppError("bad_request", "That's a child profile: add children to their parent's account");
  return g;
}

async function checkBarber(tx: DBorTx, staffId: string | null | undefined) {
  if (staffId && !(await tx.query.staff.findFirst({ where: eq(staff.id, staffId), columns: { id: true } }))) throw new AppError("bad_request", "Unknown barber");
}

async function setPhoto(tx: DBorTx, customerId: string, photo: string | null | undefined, by: string | null) {
  if (photo === undefined) return;
  if (photo === null) await tx.delete(clientPhotos).where(eq(clientPhotos.customerId, customerId));
  else
    await tx
      .insert(clientPhotos)
      .values({ customerId, dataUrl: photo, updatedBy: by })
      .onConflictDoUpdate({ target: clientPhotos.customerId, set: { dataUrl: photo, updatedBy: by, updatedAt: new Date() } });
}

/** The Family and Kid badges follow the household. After the change commits; a failure never fails it. */
async function refreshFamilyBadges(ids: (string | null | undefined)[]) {
  const these = [...new Set(ids.filter((x): x is string => !!x))];
  await import("./badges")
    .then((b) => b.refreshBadges(these, new Date()))
    .catch((e: Error) => console.error("badge refresh after a family change failed", e.message));
}

/** Run in the caller's transaction, or in one of our own and then refresh the household's badges. */
async function inTx<T>(tx: DBorTx | undefined, run: (tx: DBorTx) => Promise<T>, touched: (r: T) => (string | null | undefined)[]): Promise<T> {
  if (tx) return run(tx);
  const r = await db.transaction(run);
  await refreshFamilyBadges(touched(r));
  return r;
}

export interface ChildOptions {
  tx?: DBorTx;
  now?: Date;
  /** Leave out what the person may not enter (the staff portal's per-field rules). */
  allow?: { notes?: boolean; birthday?: boolean; photo?: boolean; preferredBarber?: boolean };
}

const allowed = (o: ChildOptions | undefined, k: keyof NonNullable<ChildOptions["allow"]>) => o?.allow?.[k] ?? true;

/** Add a child to a parent's account, within the brand's limit. Their home shop is the parent's. */
export async function addChild(guardianId: string, raw: unknown, actor: Actor, opts: ChildOptions = {}): Promise<Child> {
  const input = ChildInputSchema.parse(raw);
  const now = opts.now ?? new Date();
  const dates = childDates(input, todayLocal(now));
  if (!dates.ok) throw new AppError("bad_request", dates.message);
  const run = async (tx: DBorTx) => {
    const g = await lockGuardian(tx, guardianId);
    const settings = await loadFamilySettings(tx);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(customers).where(eq(customers.guardianId, guardianId));
    const problem = childLimitProblem(Number(n), settings);
    if (problem) throw new AppError("bad_request", problem);
    const preferredStaffId = allowed(opts, "preferredBarber") ? (input.preferredStaffId ?? null) : null;
    await checkBarber(tx, preferredStaffId);
    const [row] = await tx
      .insert(customers)
      .values({
        firstName: input.firstName,
        lastName: input.lastName || g.lastName || null,
        guardianId,
        birthday: allowed(opts, "birthday") ? (dates.birthday ?? null) : null,
        birthYear: allowed(opts, "birthday") ? (dates.birthYear ?? null) : null,
        notes: allowed(opts, "notes") ? input.notes || null : null,
        preferredStaffId,
        homeShopId: g.homeShopId,
        source: "Family",
      })
      .returning();
    if (allowed(opts, "photo")) await setPhoto(tx, row.id, input.photo ?? undefined, actor.staffId ?? null);
    await stampRecordNote(tx, row.id, actor.staffId, g.homeShopId);
    await audit(actor, "customer.child_add", "customer", row.id, { guardianId, firstName: row.firstName }, null, tx);
    return row;
  };
  return inTx(opts.tx, run, (r) => [guardianId, r.id]);
}

/** Edit a child; fields left out stay as they are. With `guardianId`, only that parent's child. */
export async function updateChild(childId: string, raw: unknown, actor: Actor, opts: ChildOptions & { guardianId?: string } = {}): Promise<Child> {
  const input = ChildInputSchema.partial().extend({ firstName: ChildInputSchema.shape.firstName.optional() }).parse(raw) as Partial<ChildInput>;
  const now = opts.now ?? new Date();
  const dates = childDates({ birthday: input.birthday, age: input.age }, todayLocal(now));
  if (!dates.ok) throw new AppError("bad_request", dates.message);
  const run = async (tx: DBorTx) => {
    const [before] = await tx.select().from(customers).where(eq(customers.id, childId)).for("update");
    if (!before || !before.guardianId || (opts.guardianId && before.guardianId !== opts.guardianId)) throw notFound("Child");
    const patch: Partial<typeof customers.$inferInsert> = {};
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.lastName !== undefined) patch.lastName = input.lastName || null;
    if (allowed(opts, "birthday")) {
      if (dates.birthday !== undefined) patch.birthday = dates.birthday;
      if (dates.birthYear !== undefined) patch.birthYear = dates.birthYear;
    }
    if (input.notes !== undefined && allowed(opts, "notes")) patch.notes = input.notes || null;
    if (input.preferredStaffId !== undefined && allowed(opts, "preferredBarber")) {
      await checkBarber(tx, input.preferredStaffId);
      patch.preferredStaffId = input.preferredStaffId;
    }
    const [row] = Object.keys(patch).length ? await tx.update(customers).set(patch).where(eq(customers.id, childId)).returning() : [before];
    if (allowed(opts, "photo")) await setPhoto(tx, childId, input.photo, actor.staffId ?? null);
    if (patch.notes !== undefined) await stampRecordNote(tx, childId, actor.staffId, null);
    const changed = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { from: before[k as keyof typeof before] ?? null, to: v ?? null }]));
    if (input.photo !== undefined && allowed(opts, "photo")) changed.photo = { from: null, to: input.photo ? "updated" : "removed" };
    await audit(actor, "customer.child_update", "customer", childId, changed, null, tx);
    return row;
  };
  return opts.tx ? run(opts.tx) : db.transaction(run);
}

/**
 * Take a child off a parent's account. The record stays (their visits, badges and notes are the
 * shop's history), now a client with no contact details the desk can find by name.
 */
export async function detachChild(childId: string, actor: Actor, opts: { guardianId?: string; tx?: DBorTx } = {}) {
  const run = async (tx: DBorTx) => {
    const [c] = await tx.select().from(customers).where(eq(customers.id, childId)).for("update");
    if (!c || !c.guardianId || (opts.guardianId && c.guardianId !== opts.guardianId)) throw notFound("Child");
    await tx.update(customers).set({ guardianId: null, formerGuardianId: c.guardianId }).where(eq(customers.id, childId));
    await audit(actor, "customer.child_remove", "customer", childId, { guardianId: c.guardianId }, null, tx);
    return { guardianId: c.guardianId };
  };
  return inTx(opts.tx, run, (r) => [r.guardianId, childId]);
}

/**
 * Put an existing client under a parent's account: a Squire kid record, or a duplicate pair that
 * shares the parent's phone. Their history stays theirs; their own phone, email and consent are
 * cleared (messages go to the parent from now on) and any sign-in they had is ended.
 */
export async function attachChild(guardianId: string, childId: string, actor: Actor, opts: { tx?: DBorTx; ignoreLimit?: boolean } = {}) {
  if (guardianId === childId) throw new AppError("bad_request", "A client can't be their own child");
  const run = async (tx: DBorTx) => {
    await lockGuardian(tx, guardianId);
    const [c] = await tx.select().from(customers).where(eq(customers.id, childId)).for("update");
    if (!c) throw notFound("Client");
    if (c.guardianId === guardianId) return { attached: false as const, reason: "already" as const };
    if (c.guardianId) throw new AppError("conflict", "That client is already on another parent's account");
    const [{ kids }] = await tx.select({ kids: sql<number>`count(*)::int` }).from(customers).where(eq(customers.guardianId, childId));
    if (Number(kids) > 0) throw new AppError("bad_request", "That client has children on their own account, so they can't be a child profile");
    if (!opts.ignoreLimit) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(customers).where(eq(customers.guardianId, guardianId));
      const problem = childLimitProblem(Number(n), await loadFamilySettings(tx));
      if (problem) throw new AppError("bad_request", problem);
    }
    await tx.update(customers).set({ guardianId, phone: null, email: null, smsOptIn: false, emailOptIn: false }).where(eq(customers.id, childId));
    await tx.delete(refreshTokens).where(eq(refreshTokens.customerId, childId));
    await audit(
      actor,
      "customer.child_attach",
      "customer",
      childId,
      { guardianId, cleared: { phone: !!c.phone, email: !!c.email, smsOptIn: c.smsOptIn, emailOptIn: c.emailOptIn } },
      null,
      tx,
    );
    return { attached: true as const };
  };
  return inTx(opts.tx, run, () => [guardianId, childId]);
}

export interface SplitInput {
  phone?: string | null;
  email?: string | null;
  smsOptIn?: boolean;
  emailOptIn?: boolean;
}

/**
 * A child old enough (the brand's split age, 13 by default) gets an account of their own: the same
 * record, so every visit, badge, rating, note and photo stays, now with their own phone or email
 * and consent, and no longer under the parent. Loyalty earned on the household card stays there.
 */
export async function splitChild(childId: string, input: SplitInput, actor: Actor, opts: { guardianId?: string; now?: Date } = {}) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) throw new AppError("bad_request", "Phone number doesn't look like a US number");
  const email = input.email ? normalizeEmail(input.email) : null;
  if (input.email && !email) throw new AppError("bad_request", "Email doesn't look right");
  if (!phone && !email) throw new AppError("bad_request", "Add their own phone number or email for the new account");
  const now = opts.now ?? new Date();
  return inTx(undefined, async (tx) => {
    const [c] = await tx.select().from(customers).where(eq(customers.id, childId)).for("update");
    if (!c || !c.guardianId || (opts.guardianId && c.guardianId !== opts.guardianId)) throw notFound("Child");
    const problem = splitProblem(c, await loadFamilySettings(tx), todayLocal(now));
    if (problem) throw new AppError("bad_request", problem);
    await lockIdentity(tx, [phone, email]);
    const [g] = await tx.select({ phone: customers.phone, email: customers.email }).from(customers).where(eq(customers.id, c.guardianId));
    if ((phone && g?.phone === phone) || (email && g?.email === email))
      throw new AppError("bad_request", "Use the child's own phone number or email, not the parent's: the new account signs in with it");
    const clash = await matchCustomer(tx, { firstName: c.firstName, lastName: c.lastName, phone, email });
    if (clash && clash.customer.id !== childId)
      throw new AppError("conflict", "Another client with that name already has this phone number or email. Merge them from the duplicates page instead.");
    await tx
      .update(customers)
      .set({ guardianId: null, formerGuardianId: c.guardianId, ownAccountAt: now, phone, email, smsOptIn: !!phone && !!input.smsOptIn, emailOptIn: !!email && !!input.emailOptIn })
      .where(eq(customers.id, childId));
    await audit(actor, "customer.child_split", "customer", childId, { guardianId: c.guardianId, phone: !!phone, email: !!email }, null, tx);
    return { id: childId, guardianId: c.guardianId };
  }, (r) => [r.guardianId, childId]);
}

// ───────────────────────────── The parent's view ─────────────────────────────

export interface FamilyMemberView {
  id: string;
  firstName: string;
  lastName: string | null;
  birthday: string | null;
  age: number | null;
  notes: string | null;
  preferredStaffId: string | null;
  preferredBarber: string | null;
  photo: string | null;
  visits: number;
  lastVisit: string | null;
  averageDaysBetween: number | null;
  upcoming: { id: string; startsAt: string; shop: string; barber: string; service: string }[];
  /** The child's own badges, as the brand shows them to customers. */
  badges: CustomerBadge[];
  canSplit: boolean;
}

const UPCOMING_STATUSES = ["booked", "confirmed", "checked_in", "in_service"] as const;

/** A parent's children as the parent sees them (the portal, the app): everything about each child is the parent's to see. */
export async function familyView(guardianId: string, now = new Date(), tx: DBorTx = db): Promise<{ settings: FamilySettings; children: FamilyMemberView[] }> {
  const [settings, kids] = await Promise.all([loadFamilySettings(tx), childrenOf(guardianId, tx)]);
  const ids = kids.map((k) => k.id);
  if (!ids.length) return { settings, children: [] };
  const barberIds = [...new Set(kids.map((k) => k.preferredStaffId).filter((x): x is string => !!x))];
  // Loaded here, not at the top: checkout and refunds import this module outside Next (the worker,
  // scripts), and the badge and cadence modules are server-only and reach back into client records.
  const [{ customerBadges }, { cadenceFor }] = await Promise.all([import("./customer-badges"), import("./visit-cadence")]);
  const [cadence, photos, barbers, stats, upcoming, badges] = await Promise.all([
    cadenceFor(ids, now, tx),
    tx.select({ id: clientPhotos.customerId, url: clientPhotos.dataUrl }).from(clientPhotos).where(inArray(clientPhotos.customerId, ids)),
    barberIds.length ? tx.select({ id: staff.id, name: staff.displayLabel }).from(staff).where(inArray(staff.id, barberIds)) : [],
    tx
      .select({ id: appointments.customerId, n: sql<number>`count(*)::int`, last: sql<string | null>`max(${appointments.startsAt})` })
      .from(appointments)
      .where(and(inArray(appointments.customerId, ids), eq(appointments.status, "completed")))
      .groupBy(appointments.customerId),
    tx
      .select({ id: appointments.id, customerId: appointments.customerId, startsAt: appointments.startsAt, shop: shops.name, barber: staff.displayLabel, service: sql<string>`coalesce((select string_agg(i.name, ' + ' order by i.kind, i.name) from appointment_items i where i.appointment_id = ${appointments.id}), '')` })
      .from(appointments)
      .innerJoin(shops, eq(shops.id, appointments.shopId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .where(and(inArray(appointments.customerId, ids), inArray(appointments.status, [...UPCOMING_STATUSES]), gte(appointments.startsAt, now)))
      .orderBy(asc(appointments.startsAt)),
    Promise.all(ids.map((id) => customerBadges(id, now).then((b) => [id, b.badges] as const))),
  ]);
  const badgesOf = new Map(badges);
  const today = todayLocal(now);
  const photoOf = new Map(photos.map((p) => [p.id, p.url]));
  const barberOf = new Map(barbers.map((b) => [b.id, b.name]));
  const statOf = new Map(stats.map((s) => [s.id, s]));
  return {
    settings,
    children: kids.map((k) => {
      const s = statOf.get(k.id);
      const cd = cadence.get(k.id);
      return {
        id: k.id,
        firstName: k.firstName,
        lastName: k.lastName,
        birthday: k.birthday,
        age: ageOn(k, today),
        notes: k.notes,
        preferredStaffId: k.preferredStaffId,
        preferredBarber: k.preferredStaffId ? (barberOf.get(k.preferredStaffId) ?? null) : null,
        photo: photoOf.get(k.id) ?? null,
        visits: Number(s?.n ?? 0),
        lastVisit: s?.last ? localDateOf(s.last) : null,
        averageDaysBetween: cd?.cadenceDays != null ? Math.round(cd.cadenceDays) : null,
        upcoming: upcoming
          .filter((u) => u.customerId === k.id)
          .slice(0, 5)
          .map((u) => ({ id: u.id, startsAt: u.startsAt.toISOString(), shop: u.shop, barber: u.barber, service: u.service })),
        badges: badgesOf.get(k.id) ?? [],
        canSplit: !splitProblem(k, settings, today),
      };
    }),
  };
}

export const memberOf = (view: { children: FamilyMemberView[] }, id: string) => {
  const m = view.children.find((c) => c.id === id);
  if (!m) throw notFound("Child");
  return m;
};
