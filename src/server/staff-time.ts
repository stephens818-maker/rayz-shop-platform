import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  BlockCategory,
  TimeOffStatus,
  appointmentItems,
  appointments,
  brandSettings,
  customers,
  notificationJobs,
  shops,
  staff,
  staffSchedules,
  staffShops,
  timeBlockSeries,
  timeBlocks,
  timeOffRequests,
} from "@/db/schema";
import {
  REASON_LABEL,
  SERIES_HORIZON_DAYS,
  SelfBlockCategory,
  StaffDay,
  StaffTimeRules,
  TimeOffRange,
  TimeOffReasonKey,
  cleanRules,
  isTimeOff,
  noticeProblem,
  overlaps,
  rulesProblem,
  seriesOccurrences,
  seriesProblem,
  shopRules,
  staffDay,
  strictestRules,
  timeOffSpan,
} from "@/domain/staff-time";
import { appBaseUrl } from "@/lib/deployment";
import { LocalDate, addDays, endOfLocalDay, existingWallTime, formatDate, localDateOf, minutesToLabel, startOfLocalDay, todayLocal, weekdayOf } from "@/lib/time";
import { Actor, audit } from "./audit";
import { extendSeries, insertOccurrences } from "./block-series";
import { workShopIds } from "./auth/access";
import { Caller, timeOffDecisionDenied } from "./auth/policy";
import { ACTIVE_STATUSES, getAvailability, messageContext, rescheduleAppointment } from "./booking";
import { AppError, forbidden, notFound } from "./errors";
import { enqueueAppointmentMessage, enqueueShopEmail } from "./notifications/queue";

// ───────────────────────────── Booked appointments in the way ─────────────────────────────

export interface BookedConflict {
  id: string;
  code: string;
  startsAt: string;
  endsAt: string;
  status: string;
  shopId: string;
  shopName: string;
  staffId: string;
  customerName: string;
}

/** Active appointments for this barber that overlap any of the spans (at this shop, or anywhere for an all-shop block). */
export async function bookedConflicts(staffId: string, shopId: string | null, spans: readonly { startsAt: Date; endsAt: Date }[], tx: DBorTx = db): Promise<BookedConflict[]> {
  if (!spans.length) return [];
  const from = new Date(Math.min(...spans.map((s) => s.startsAt.getTime())));
  const to = new Date(Math.max(...spans.map((s) => s.endsAt.getTime())));
  const rows = await tx
    .select({
      id: appointments.id,
      code: appointments.code,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
      shopId: appointments.shopId,
      shopName: shops.name,
      staffId: appointments.staffId,
      firstName: customers.firstName,
      lastName: customers.lastName,
      notes: appointments.notes,
    })
    .from(appointments)
    .innerJoin(shops, eq(shops.id, appointments.shopId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      and(
        eq(appointments.staffId, staffId),
        inArray(appointments.status, [...ACTIVE_STATUSES]),
        lt(appointments.startsAt, to),
        gt(appointments.endsAt, from),
        shopId ? eq(appointments.shopId, shopId) : undefined,
      ),
    )
    .orderBy(asc(appointments.startsAt));
  return rows
    .filter((r) => spans.some((s) => overlaps(r, s)))
    .map((r) => ({
      id: r.id,
      code: r.code,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      status: r.status,
      shopId: r.shopId,
      shopName: r.shopName,
      staffId: r.staffId,
      customerName: r.firstName ? `${r.firstName}${r.lastName ? ` ${r.lastName.charAt(0)}.` : ""}` : (r.notes?.replace(/^Walk-in: /, "") ?? "Walk-in"),
    }));
}

/** Not saved yet: these appointments are booked in it. Ask, then send again with confirm. */
export type Confirmable<T> = ({ done: false } | ({ done: true } & T)) & { conflicts: BookedConflict[] };

// ───────────────────────────── Rules ─────────────────────────────

async function brandRaw(tx: DBorTx) {
  const [b] = await tx.select({ staffTime: brandSettings.staffTime }).from(brandSettings).limit(1);
  return b?.staffTime ?? {};
}

/** The rules for time that covers these shops: the strictest of them. */
export async function rulesForShops(shopIds: readonly string[], tx: DBorTx = db): Promise<StaffTimeRules> {
  const brand = await brandRaw(tx);
  if (!shopIds.length) return shopRules(brand, {});
  const rows = await tx.select({ staffTime: shops.staffTime }).from(shops).where(inArray(shops.id, [...shopIds]));
  return strictestRules(rows.map((r) => shopRules(brand, r.staffTime)));
}

/** A block or time off at one shop follows that shop; at every shop, the strictest of the barber's shops. */
export async function rulesFor(staffId: string, shopId: string | null, tx: DBorTx = db) {
  return rulesForShops(shopId ? [shopId] : await workShopIds(staffId, tx), tx);
}

export async function rulesView(shopIds: readonly string[]) {
  const brand = await brandRaw(db);
  const rows = shopIds.length
    ? await db.select({ id: shops.id, name: shops.name, staffTime: shops.staffTime }).from(shops).where(inArray(shops.id, [...shopIds])).orderBy(asc(shops.name))
    : [];
  return {
    brand: shopRules(brand, {}),
    brandOverrides: cleanRules(brand),
    shops: rows.map((r) => ({ id: r.id, name: r.name, overrides: cleanRules(r.staffTime), effective: shopRules(brand, r.staffTime) })),
  };
}

/** Replaces the brand's rules (shopId null) or one shop's changes to them. Keys left out follow the defaults, or the brand. */
export async function saveRules(shopId: string | null, patch: Record<string, unknown>, actor: Actor) {
  const problem = rulesProblem(patch);
  if (problem) throw new AppError("bad_request", problem);
  const clean = cleanRules(patch);
  await db.transaction(async (tx) => {
    if (shopId) await tx.update(shops).set({ staffTime: clean }).where(eq(shops.id, shopId));
    else await tx.update(brandSettings).set({ staffTime: clean, updatedAt: new Date() });
    await audit(actor, "staff_time.rules", shopId ? "shop" : "brand_settings", shopId ?? "brand", { rules: clean }, shopId, tx);
  });
}

// ───────────────────────────── Blocks ─────────────────────────────

/** Where a block or request is logged: its shop, or the barber's main shop for time at every shop. */
async function auditShop(staffId: string, shopId: string | null, tx: DBorTx): Promise<string | null> {
  if (shopId) return shopId;
  const [l] = await tx.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId)).orderBy(desc(staffShops.isPrimary)).limit(1);
  return l?.shopId ?? null;
}

export interface NewBlock {
  staffId: string;
  /** null = all of the barber's shops. */
  shopId: string | null;
  startsAt: Date;
  endsAt: Date;
  category: BlockCategory;
  reason: string;
  kind?: "block" | "day_off";
}

/** Adds a block. With booked appointments in it, nothing is saved unless `confirm`; the appointments always stay booked. */
export async function addBlock(b: NewBlock, o: { actor: Actor; confirm?: boolean; via: string; auditShopId?: string | null }): Promise<Confirmable<{ blockId: string }>> {
  if (b.endsAt <= b.startsAt) throw new AppError("bad_request", "End must be after start");
  if (!b.reason.trim()) throw new AppError("bad_request", "Add a reason for the block");
  const conflicts = await bookedConflicts(b.staffId, b.shopId, [b]);
  if (conflicts.length && !o.confirm) return { done: false, conflicts };
  const blockId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(timeBlocks)
      .values({ staffId: b.staffId, shopId: b.shopId, startsAt: b.startsAt, endsAt: b.endsAt, category: b.category, reason: b.reason.trim(), kind: b.kind ?? "block", createdBy: o.actor.staffId ?? null })
      .returning({ id: timeBlocks.id });
    await audit(
      o.actor,
      "block.create",
      "time_block",
      row.id,
      { staffId: b.staffId, category: b.category, reason: b.reason.trim(), kind: b.kind ?? "block", startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), allShops: b.shopId === null, via: o.via, overlaps: conflicts.map((c) => c.code) },
      o.auditShopId !== undefined ? o.auditShopId : await auditShop(b.staffId, b.shopId, tx),
      tx,
    );
    return row.id;
  });
  return { done: true, conflicts, blockId };
}

export async function removeBlock(id: string, actor: Actor, via: string, auditShopId?: string | null) {
  const b = await db.query.timeBlocks.findFirst({ where: eq(timeBlocks.id, id) });
  if (!b) throw notFound("Block");
  if (b.requestId) throw new AppError("conflict", "This is approved time off. Cancel the request instead, so the barber is told.");
  await db.transaction(async (tx) => {
    await tx.delete(timeBlocks).where(eq(timeBlocks.id, id));
    await audit(
      actor,
      "block.delete",
      "time_block",
      id,
      { staffId: b.staffId, category: b.category, reason: b.reason, startsAt: b.startsAt.toISOString(), seriesId: b.seriesId, via },
      auditShopId !== undefined ? auditShopId : await auditShop(b.staffId, b.shopId, tx),
      tx,
    );
  });
  return b;
}

// ───────────────────────────── Recurring blocks ─────────────────────────────

export interface NewSeries {
  staffId: string;
  shopId: string | null;
  category: SelfBlockCategory;
  reason: string;
  weekdays: number[];
  startMin: number;
  endMin: number;
  startsOn: LocalDate;
  endsOn: LocalDate | null;
}

/** A recurring block, written ahead through the horizon. Booked appointments in any occurrence need `confirm`. */
export async function createSeries(s: NewSeries, o: { actor: Actor; confirm?: boolean; now?: Date }): Promise<Confirmable<{ seriesId: string; occurrences: number }>> {
  const problem = seriesProblem(s);
  if (problem) throw new AppError("bad_request", problem);
  if (!s.reason.trim()) throw new AppError("bad_request", "Add a reason for the block");
  const now = o.now ?? new Date();
  const through = addDays(todayLocal(now), SERIES_HORIZON_DAYS);
  const occ = seriesOccurrences(s, s.startsOn, through).filter((x) => x.endsAt > now);
  if (!occ.length) throw new AppError("bad_request", "None of those days fall between the dates you picked");
  const conflicts = await bookedConflicts(s.staffId, s.shopId, occ);
  if (conflicts.length && !o.confirm) return { done: false, conflicts };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(timeBlockSeries)
      .values({ ...s, reason: s.reason.trim(), weekdays: [...new Set(s.weekdays)].sort((a, b) => a - b), materializedThrough: through, createdBy: o.actor.staffId ?? null })
      .returning();
    await insertOccurrences(tx, row, occ);
    await audit(
      o.actor,
      "block_series.create",
      "time_block_series",
      row.id,
      { staffId: s.staffId, category: s.category, reason: row.reason, weekdays: row.weekdays, startMin: s.startMin, endMin: s.endMin, startsOn: s.startsOn, endsOn: s.endsOn, allShops: s.shopId === null, overlaps: conflicts.map((c) => c.code) },
      await auditShop(s.staffId, s.shopId, tx),
      tx,
    );
    return { done: true as const, conflicts, seriesId: row.id, occurrences: occ.length };
  });
}

export { extendSeries };

/** Ends a recurring block: occurrences that haven't started are removed, past ones stay for the record. */
export async function endSeries(id: string, actor: Actor, now: Date = new Date()) {
  const s = await db.query.timeBlockSeries.findFirst({ where: eq(timeBlockSeries.id, id) });
  if (!s || s.endedAt) throw notFound("Recurring block");
  return db.transaction(async (tx) => {
    await tx.update(timeBlockSeries).set({ endedAt: now, endsOn: todayLocal(now) }).where(eq(timeBlockSeries.id, id));
    const removed = await tx.delete(timeBlocks).where(and(eq(timeBlocks.seriesId, id), gte(timeBlocks.startsAt, now))).returning({ id: timeBlocks.id });
    await audit(actor, "block_series.end", "time_block_series", id, { staffId: s.staffId, category: s.category, reason: s.reason, removed: removed.length }, await auditShop(s.staffId, s.shopId, tx), tx);
    return { series: s, removed: removed.length };
  });
}

// ───────────────────────────── Time off requests ─────────────────────────────

type RequestRow = typeof timeOffRequests.$inferSelect;

export function rangeLabel(r: Pick<RequestRow, "fromDate" | "toDate" | "startMin" | "endMin">) {
  if (r.startMin !== null && r.endMin !== null) return `${formatDate(r.fromDate)}, ${minutesToLabel(r.startMin)}–${minutesToLabel(r.endMin % (24 * 60))}`;
  return r.fromDate === r.toDate ? formatDate(r.fromDate) : `${formatDate(r.fromDate)} – ${formatDate(r.toDate)}`;
}

export interface TimeOffInput {
  staffId: string;
  shopId: string | null;
  range: TimeOffRange;
  reason: TimeOffReasonKey;
  note?: string | null;
}

function spanOf(range: TimeOffRange) {
  const span = timeOffSpan(range);
  if ("problem" in span) throw new AppError("bad_request", span.problem);
  for (const m of [range.startMin, range.endMin]) {
    if (m !== null && m < 24 * 60 && !existingWallTime(range.fromDate, m)) throw new AppError("bad_request", `${minutesToLabel(m)} doesn't exist on ${range.fromDate}: clocks spring forward that night`);
  }
  return span;
}

/** The time off as a block: whole days are a day off, part of a day a block. */
async function writeApprovedBlock(req: RequestRow, tx: DBorTx) {
  await tx.insert(timeBlocks).values({
    staffId: req.staffId,
    shopId: req.shopId,
    startsAt: req.startsAt,
    endsAt: req.endsAt,
    kind: req.startMin === null ? "day_off" : "block",
    category: "time_off",
    reason: REASON_LABEL[req.reason as TimeOffReasonKey] ?? "Time off",
    requestId: req.id,
    createdBy: req.decidedBy ?? req.requestedBy,
  });
}

async function notifyDecision(req: RequestRow, tx: DBorTx) {
  const s = await tx.query.staff.findFirst({ where: eq(staff.id, req.staffId) });
  if (!s?.email) return;
  const shopId = await auditShop(req.staffId, req.shopId, tx);
  if (!shopId) return;
  const verb = req.status === "approved" ? "approved" : "denied";
  const what = rangeLabel(req);
  await enqueueShopEmail(
    {
      kind: "time_off_decision",
      to: s.email,
      subject: `Time off ${verb}: ${what}`,
      body: [
        `Hi ${s.firstName}, your ${REASON_LABEL[req.reason as TimeOffReasonKey]?.toLowerCase() ?? ""} time off for ${what} was ${verb}${req.decidedVia === "auto" ? " automatically" : ""}.`,
        req.decisionNote ? `Note: ${req.decisionNote}` : null,
        `See your time: ${appBaseUrl()}/admin/my-time`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      shopId,
    },
    tx,
  );
}

/**
 * A time off request. Booked appointments in it need `confirm`, and they stay booked: a manager moves
 * them or asks the clients to reschedule. Shops set to approve automatically do so only when nothing is
 * booked in the time; otherwise a manager decides.
 */
export async function requestTimeOff(
  input: TimeOffInput,
  o: { actor: Actor; confirm?: boolean; now?: Date; /** Self-service: the shop's minimum notice applies. */ enforceNotice: boolean },
): Promise<Confirmable<{ requestId: string; status: TimeOffStatus; heldForManager: boolean }>> {
  const now = o.now ?? new Date();
  const span = spanOf(input.range);
  const shopIds = input.shopId ? [input.shopId] : await workShopIds(input.staffId);
  const rules = await rulesForShops(shopIds);
  if (o.enforceNotice) {
    const p = noticeProblem(rules, input.reason, input.range.fromDate, todayLocal(now));
    if (p) throw new AppError("bad_request", p);
  }
  if (span.endsAt <= now) throw new AppError("bad_request", "That time has already passed");
  const clash = await db
    .select({ id: timeOffRequests.id })
    .from(timeOffRequests)
    .where(
      and(
        eq(timeOffRequests.staffId, input.staffId),
        inArray(timeOffRequests.status, ["pending", "approved"]),
        lt(timeOffRequests.startsAt, span.endsAt),
        gt(timeOffRequests.endsAt, span.startsAt),
      ),
    )
    .limit(1);
  if (clash.length) throw new AppError("conflict", "There's already time off requested for part of that time");
  const conflicts = await bookedConflicts(input.staffId, input.shopId, [span]);
  if (conflicts.length && !o.confirm) return { done: false, conflicts };
  const auto = rules.timeOffApproval === "auto" && conflicts.length === 0;
  return db.transaction(async (tx) => {
    const [req] = await tx
      .insert(timeOffRequests)
      .values({
        staffId: input.staffId,
        shopId: input.shopId,
        fromDate: input.range.fromDate,
        toDate: input.range.toDate,
        startMin: input.range.startMin,
        endMin: input.range.endMin,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        reason: input.reason,
        note: input.note?.trim() || null,
        status: auto ? "approved" : "pending",
        decidedVia: auto ? "auto" : null,
        decidedAt: auto ? now : null,
        requestedBy: o.actor.staffId ?? null,
      })
      .returning();
    const shop = await auditShop(input.staffId, input.shopId, tx);
    await audit(
      o.actor,
      "time_off.request",
      "time_off_request",
      req.id,
      { staffId: input.staffId, reason: input.reason, range: rangeLabel(req), allShops: input.shopId === null, status: req.status, overlaps: conflicts.map((c) => c.code) },
      shop,
      tx,
    );
    if (auto) {
      await writeApprovedBlock(req, tx);
      await audit(o.actor, "time_off.approve", "time_off_request", req.id, { staffId: input.staffId, via: "auto" }, shop, tx);
      await notifyDecision(req, tx);
    }
    return { done: true as const, conflicts, requestId: req.id, status: req.status, heldForManager: !auto && rules.timeOffApproval === "auto" };
  });
}

export type Approver = Caller & { canApprove: boolean; isOwner: boolean };

async function loadRequest(id: string, tx: DBorTx = db) {
  const r = await tx.query.timeOffRequests.findFirst({ where: eq(timeOffRequests.id, id) });
  if (!r) throw notFound("Time off request");
  return r;
}

export async function assertCanDecide(who: Approver, req: Pick<RequestRow, "staffId" | "shopId">) {
  const denied = timeOffDecisionDenied(who, req, await workShopIds(req.staffId));
  if (denied) throw forbidden(denied);
}

/** Approve or deny a pending request. Approval returns the booked appointments in it, which stay booked until someone acts on them. */
export async function decideTimeOff(id: string, decision: "approve" | "deny", note: string | null, who: Approver & { actor: Actor }, now: Date = new Date()) {
  const req = await loadRequest(id);
  await assertCanDecide(who, req);
  if (req.status !== "pending") throw new AppError("conflict", `This request was already ${req.status}`);
  const status: TimeOffStatus = decision === "approve" ? "approved" : "denied";
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(timeOffRequests)
      .set({ status, decidedVia: "manager", decidedBy: who.actor.staffId ?? null, decidedAt: now, decisionNote: note?.trim() || null, updatedAt: now })
      .where(and(eq(timeOffRequests.id, id), eq(timeOffRequests.status, "pending")))
      .returning();
    if (!u) throw new AppError("conflict", "Someone else just decided this request");
    if (status === "approved") await writeApprovedBlock(u, tx);
    const affected = status === "approved" ? await bookedConflicts(u.staffId, u.shopId, [u], tx) : [];
    await audit(
      who.actor,
      status === "approved" ? "time_off.approve" : "time_off.deny",
      "time_off_request",
      id,
      { staffId: u.staffId, range: rangeLabel(u), note: u.decisionNote, affected: affected.map((a) => a.code) },
      await auditShop(u.staffId, u.shopId, tx),
      tx,
    );
    await notifyDecision(u, tx);
    return { request: u, affected };
  });
  return updated;
}

/**
 * Withdraw a request. Barbers cancel their own while it's pending or before approved time off starts;
 * approvers can cancel anyone's at their shops. Approved time off goes back on the books.
 */
export async function cancelTimeOff(id: string, who: Approver & { actor: Actor }, now: Date = new Date()) {
  const req = await loadRequest(id);
  if (req.status !== "pending" && req.status !== "approved") throw new AppError("conflict", `This request was already ${req.status}`);
  if (req.staffId === who.staffId) {
    if (req.status === "approved" && req.startsAt <= now) throw new AppError("conflict", "This time off has started. Ask a manager to change it.");
  } else await assertCanDecide(who, req);
  await db.transaction(async (tx) => {
    await tx.update(timeOffRequests).set({ status: "cancelled", updatedAt: now }).where(eq(timeOffRequests.id, id));
    await tx.delete(timeBlocks).where(eq(timeBlocks.requestId, id));
    await audit(who.actor, "time_off.cancel", "time_off_request", id, { staffId: req.staffId, range: rangeLabel(req), was: req.status }, await auditShop(req.staffId, req.shopId, tx), tx);
  });
  return req;
}

// ───────────────────────────── Appointments affected by time off ─────────────────────────────

export interface AffectedAppointment extends BookedConflict {
  /** When the client was last asked to reschedule for time off. */
  askedAt: string | null;
}

/** Booked appointments inside each request, with whether the client has been asked to reschedule. */
export async function affectedByRequests(reqs: readonly Pick<RequestRow, "id" | "staffId" | "shopId" | "startsAt" | "endsAt">[]) {
  const out = new Map<string, AffectedAppointment[]>();
  const all: BookedConflict[][] = await Promise.all(reqs.map((r) => bookedConflicts(r.staffId, r.shopId, [r])));
  const ids = all.flat().map((a) => a.id);
  const asked = ids.length
    ? await db
        .select({ appointmentId: notificationJobs.appointmentId, at: sql<Date>`max(${notificationJobs.createdAt})` })
        .from(notificationJobs)
        .where(and(inArray(notificationJobs.appointmentId, ids), eq(notificationJobs.kind, "time_off_reschedule")))
        .groupBy(notificationJobs.appointmentId)
    : [];
  const askedAt = new Map(asked.map((a) => [a.appointmentId, new Date(a.at).toISOString()]));
  reqs.forEach((r, i) => out.set(r.id, all[i].map((a) => ({ ...a, askedAt: askedAt.get(a.id) ?? null }))));
  return out;
}

async function loadActiveAppointment(id: string) {
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!a) throw notFound("Appointment");
  return a;
}

/** Barbers at the appointment's shop, and whether each is free at the same time for it. */
export async function reassignOptions(appointmentId: string) {
  const a = await loadActiveAppointment(appointmentId);
  const items = await db.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, a.id));
  const service = items.find((i) => i.kind === "service");
  if (!service?.serviceId) return [];
  const avail = await getAvailability({
    shopRef: a.shopId,
    date: localDateOf(a.startsAt),
    serviceId: service.serviceId,
    addonIds: items.filter((i) => i.kind === "addon" && i.serviceId).map((i) => i.serviceId!),
    barberRef: "any",
    staffOverride: true,
    ignoreAppointmentId: a.id,
  });
  const slot = avail.slots.find((s) => new Date(s.startsAt).getTime() === a.startsAt.getTime());
  const free = new Set(slot?.barberIds ?? []);
  return avail.barbers.filter((b) => b.id !== a.staffId).map((b) => ({ staffId: b.id, label: b.displayName, free: free.has(b.id) }));
}

/** Moves the appointment to another barber at the same time; the client gets the usual "appointment moved" message. */
export async function reassignForTimeOff(appointmentId: string, toStaffId: string, actor: Actor) {
  const a = await loadActiveAppointment(appointmentId);
  await rescheduleAppointment(a.code, { startsAt: a.startsAt, barberRef: toStaffId, actor, byCustomer: false });
  await audit(actor, "time_off.reassign", "appointment", a.id, { code: a.code, from: a.staffId, to: toStaffId }, a.shopId);
}

/** Texts or emails the client a link to pick a new time. The appointment stays booked until they do or the shop changes it. */
export async function askToReschedule(appointmentId: string, actor: Actor) {
  const a = await loadActiveAppointment(appointmentId);
  if (!(ACTIVE_STATUSES as readonly string[]).includes(a.status)) throw new AppError("conflict", `This appointment is ${a.status}`);
  const sent = await enqueueAppointmentMessage("time_off_reschedule", await messageContext(a.id));
  await audit(actor, "time_off.ask_reschedule", "appointment", a.id, { code: a.code, messages: sent }, a.shopId);
  return sent;
}

// ───────────────────────────── Who's working, off and blocked ─────────────────────────────

export interface StaffingRow extends StaffDay {
  date: LocalDate;
  shopId: string;
  staffId: string;
  label: string;
  booked: number;
}

const NONE = ["00000000-0000-0000-0000-000000000000"];

/** Per day, shop and barber: hours, time off, blocks and bookings. Days nobody is scheduled or off are left out. */
export async function staffingFor(shopIds: readonly string[], from: LocalDate, to: LocalDate, staffIds?: readonly string[] | null): Promise<StaffingRow[]> {
  if (!shopIds.length || to < from) return [];
  const start = startOfLocalDay(from);
  const end = endOfLocalDay(to);
  const links = await db
    .select({ staffId: staffShops.staffId, shopId: staffShops.shopId, label: staff.displayLabel })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(inArray(staffShops.shopId, [...shopIds]), eq(staff.active, true), eq(staff.kind, "person"), staffIds ? inArray(staffShops.staffId, staffIds.length ? [...staffIds] : NONE) : undefined))
    .orderBy(asc(staff.displayLabel));
  const ids = [...new Set(links.map((l) => l.staffId))];
  if (!ids.length) return [];
  const [scheds, blocks, pending, booked] = await Promise.all([
    db.select().from(staffSchedules).where(and(inArray(staffSchedules.staffId, ids), inArray(staffSchedules.shopId, [...shopIds]))),
    db
      .select()
      .from(timeBlocks)
      .where(and(inArray(timeBlocks.staffId, ids), lt(timeBlocks.startsAt, end), gt(timeBlocks.endsAt, start), or(isNull(timeBlocks.shopId), inArray(timeBlocks.shopId, [...shopIds])))),
    db
      .select()
      .from(timeOffRequests)
      .where(and(inArray(timeOffRequests.staffId, ids), eq(timeOffRequests.status, "pending"), lt(timeOffRequests.startsAt, end), gt(timeOffRequests.endsAt, start))),
    db
      .select({ staffId: appointments.staffId, shopId: appointments.shopId, startsAt: appointments.startsAt })
      .from(appointments)
      .where(
        and(
          inArray(appointments.staffId, ids),
          inArray(appointments.shopId, [...shopIds]),
          inArray(appointments.status, [...ACTIVE_STATUSES, "completed"]),
          gte(appointments.startsAt, start),
          lt(appointments.startsAt, end),
        ),
      ),
  ]);
  const bookedAt = new Map<string, number>();
  for (const b of booked) {
    const k = `${localDateOf(b.startsAt)}|${b.shopId}|${b.staffId}`;
    bookedAt.set(k, (bookedAt.get(k) ?? 0) + 1);
  }
  const rows: StaffingRow[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const wd = weekdayOf(date);
    const ds = startOfLocalDay(date);
    const de = endOfLocalDay(date);
    const inDay = (x: { startsAt: Date; endsAt: Date }) => x.startsAt < de && x.endsAt > ds;
    for (const l of links) {
      const here = (x: { staffId: string; shopId: string | null }) => x.staffId === l.staffId && (x.shopId === null || x.shopId === l.shopId);
      const d = staffDay({
        date,
        spans: scheds.filter((s) => s.staffId === l.staffId && s.shopId === l.shopId && s.weekday === wd),
        blocks: blocks.filter((b) => here(b) && inDay(b)),
        pending: pending.filter((p) => here(p) && inDay(p)),
      });
      const n = bookedAt.get(`${date}|${l.shopId}|${l.staffId}`) ?? 0;
      if (d.status === "not_scheduled" && !d.hasTimeOff && !d.pending && !n) continue;
      rows.push({ ...d, date, shopId: l.shopId, staffId: l.staffId, label: l.label, booked: n });
    }
  }
  return rows;
}

// ───────────────────────────── Time off lists and calendar ─────────────────────────────

export interface OffEntry {
  key: string;
  requestId: string | null;
  staffId: string;
  label: string;
  /** null = every shop the barber works at. */
  shopId: string | null;
  startsAt: string;
  endsAt: string;
  fromDate: LocalDate;
  toDate: LocalDate;
  partial: { startMin: number; endMin: number } | null;
  status: "approved" | "pending";
  reason: string;
}

/** Approved and pending time off at these shops in the range, for the calendar. */
export async function timeOffEntries(shopIds: readonly string[], from: LocalDate, to: LocalDate, staffIds?: readonly string[] | null): Promise<{ entries: OffEntry[]; worksAt: Map<string, string[]> }> {
  const start = startOfLocalDay(from);
  const end = endOfLocalDay(to);
  const links = shopIds.length
    ? await db
        .select({ staffId: staffShops.staffId, shopId: staffShops.shopId, label: staff.displayLabel })
        .from(staffShops)
        .innerJoin(staff, eq(staff.id, staffShops.staffId))
        .where(and(inArray(staffShops.shopId, [...shopIds]), eq(staff.active, true), staffIds ? inArray(staffShops.staffId, staffIds.length ? [...staffIds] : NONE) : undefined))
    : [];
  const ids = [...new Set(links.map((l) => l.staffId))];
  const worksAt = new Map<string, string[]>();
  for (const l of links) worksAt.set(l.staffId, [...(worksAt.get(l.staffId) ?? []), l.shopId]);
  const label = new Map(links.map((l) => [l.staffId, l.label]));
  if (!ids.length) return { entries: [], worksAt };
  const shopMatch = (col: typeof timeBlocks.shopId | typeof timeOffRequests.shopId) => or(isNull(col), inArray(col, [...shopIds]));
  const [blocks, pending] = await Promise.all([
    db
      .select({ b: timeBlocks, reason: timeOffRequests.reason })
      .from(timeBlocks)
      .leftJoin(timeOffRequests, eq(timeOffRequests.id, timeBlocks.requestId))
      .where(
        and(
          inArray(timeBlocks.staffId, ids),
          or(eq(timeBlocks.category, "time_off"), eq(timeBlocks.kind, "day_off")),
          lt(timeBlocks.startsAt, end),
          gt(timeBlocks.endsAt, start),
          shopMatch(timeBlocks.shopId),
        ),
      ),
    db
      .select()
      .from(timeOffRequests)
      .where(and(inArray(timeOffRequests.staffId, ids), eq(timeOffRequests.status, "pending"), lt(timeOffRequests.startsAt, end), gt(timeOffRequests.endsAt, start), shopMatch(timeOffRequests.shopId))),
  ]);
  const toEntry = (x: { key: string; requestId: string | null; staffId: string; shopId: string | null; startsAt: Date; endsAt: Date; status: OffEntry["status"]; reason: string }): OffEntry => {
    const fromDate = localDateOf(x.startsAt);
    const toDate = localDateOf(new Date(x.endsAt.getTime() - 1));
    const whole = x.startsAt.getTime() === startOfLocalDay(fromDate).getTime() && x.endsAt.getTime() === endOfLocalDay(toDate).getTime();
    const mins = (d: Date) => Math.round((d.getTime() - startOfLocalDay(localDateOf(d)).getTime()) / 60_000);
    return {
      ...x,
      label: label.get(x.staffId) ?? "",
      startsAt: x.startsAt.toISOString(),
      endsAt: x.endsAt.toISOString(),
      fromDate,
      toDate,
      partial: whole ? null : { startMin: mins(x.startsAt), endMin: fromDate === toDate ? mins(x.endsAt) || 24 * 60 : 24 * 60 },
    };
  };
  const entries = [
    ...blocks.map(({ b, reason }) =>
      toEntry({ key: `b:${b.id}`, requestId: b.requestId, staffId: b.staffId, shopId: b.shopId, startsAt: b.startsAt, endsAt: b.endsAt, status: "approved", reason: reason ? REASON_LABEL[reason as TimeOffReasonKey] : b.reason }),
    ),
    ...pending.map((p) => toEntry({ key: `r:${p.id}`, requestId: p.id, staffId: p.staffId, shopId: p.shopId, startsAt: p.startsAt, endsAt: p.endsAt, status: "pending", reason: REASON_LABEL[p.reason as TimeOffReasonKey] })),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.label.localeCompare(b.label));
  return { entries, worksAt };
}

export interface RequestView {
  id: string;
  staffId: string;
  staffLabel: string;
  shopId: string | null;
  shopName: string | null;
  range: string;
  fromDate: LocalDate;
  toDate: LocalDate;
  partial: boolean;
  startsAt: string;
  endsAt: string;
  reason: TimeOffReasonKey;
  note: string | null;
  status: TimeOffStatus;
  decidedVia: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

/**
 * Requests someone may see: their own (`staffId`), or for approvers every request at their shops
 * (an all-shop request shows at each shop the barber works at).
 */
export async function listRequests(
  scope: { staffId: string } | { shopIds: readonly string[]; brandWide: boolean },
  opts: { statuses?: TimeOffStatus[]; since?: Date; limit?: number } = {},
): Promise<RequestView[]> {
  const decider = sql<string | null>`(select display_label from staff where id = ${timeOffRequests.decidedBy})`;
  let where;
  if ("staffId" in scope) where = eq(timeOffRequests.staffId, scope.staffId);
  else if (!scope.brandWide) {
    const ids = scope.shopIds.length ? [...scope.shopIds] : NONE;
    where = or(
      inArray(timeOffRequests.shopId, ids),
      and(isNull(timeOffRequests.shopId), inArray(timeOffRequests.staffId, db.select({ id: staffShops.staffId }).from(staffShops).where(inArray(staffShops.shopId, ids)))),
    );
  }
  const rows = await db
    .select({ r: timeOffRequests, staffLabel: staff.displayLabel, shopName: shops.name, decidedByLabel: decider })
    .from(timeOffRequests)
    .innerJoin(staff, eq(staff.id, timeOffRequests.staffId))
    .leftJoin(shops, eq(shops.id, timeOffRequests.shopId))
    .where(and(where, opts.statuses ? inArray(timeOffRequests.status, opts.statuses) : undefined, opts.since ? gt(timeOffRequests.endsAt, opts.since) : undefined))
    .orderBy(sql`case when ${timeOffRequests.status} = 'pending' then 0 else 1 end`, asc(timeOffRequests.startsAt))
    .limit(opts.limit ?? 200);
  return rows.map(({ r, staffLabel, shopName, decidedByLabel }) => ({
    id: r.id,
    staffId: r.staffId,
    staffLabel,
    shopId: r.shopId,
    shopName,
    range: rangeLabel(r),
    fromDate: r.fromDate,
    toDate: r.toDate,
    partial: r.startMin !== null,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    reason: r.reason as TimeOffReasonKey,
    note: r.note,
    status: r.status,
    decidedVia: r.decidedVia,
    decidedBy: decidedByLabel,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** A barber's upcoming one-off blocks and their recurring ones. */
export async function myBlocks(staffId: string, now: Date = new Date(), days = 14) {
  const until = endOfLocalDay(addDays(todayLocal(now), days));
  const [blocks, series] = await Promise.all([
    db
      .select({ b: timeBlocks, shopName: shops.name })
      .from(timeBlocks)
      .leftJoin(shops, eq(shops.id, timeBlocks.shopId))
      .where(and(eq(timeBlocks.staffId, staffId), gt(timeBlocks.endsAt, now), lt(timeBlocks.startsAt, until), isNull(timeBlocks.seriesId), ne(timeBlocks.category, "time_off"), ne(timeBlocks.kind, "day_off")))
      .orderBy(asc(timeBlocks.startsAt)),
    db
      .select({ s: timeBlockSeries, shopName: shops.name })
      .from(timeBlockSeries)
      .leftJoin(shops, eq(shops.id, timeBlockSeries.shopId))
      .where(and(eq(timeBlockSeries.staffId, staffId), isNull(timeBlockSeries.endedAt)))
      .orderBy(asc(timeBlockSeries.startMin)),
  ]);
  const nextOf = series.length
    ? await db
        .select({ seriesId: timeBlocks.seriesId, id: sql<string>`(array_agg(${timeBlocks.id} order by ${timeBlocks.startsAt}))[1]`, startsAt: sql<Date>`min(${timeBlocks.startsAt})` })
        .from(timeBlocks)
        .where(and(inArray(timeBlocks.seriesId, series.map((s) => s.s.id)), gt(timeBlocks.endsAt, now)))
        .groupBy(timeBlocks.seriesId)
    : [];
  return {
    blocks: blocks.map(({ b, shopName }) => ({ id: b.id, category: b.category, reason: b.reason, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), shopName })),
    series: series.map(({ s, shopName }) => {
      const next = nextOf.find((n) => n.seriesId === s.id);
      return {
        id: s.id,
        category: s.category,
        reason: s.reason,
        weekdays: s.weekdays,
        startMin: s.startMin,
        endMin: s.endMin,
        startsOn: s.startsOn,
        endsOn: s.endsOn,
        shopName,
        next: next ? { blockId: next.id, startsAt: new Date(next.startsAt).toISOString() } : null,
      };
    }),
  };
}

/** Pending requests at these shops (for the dashboard count). */
export async function pendingCount(shopIds: readonly string[], brandWide: boolean) {
  return (await listRequests({ shopIds, brandWide }, { statuses: ["pending"], limit: 500 })).length;
}

export { isTimeOff };
