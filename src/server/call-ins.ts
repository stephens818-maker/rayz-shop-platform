import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  appointmentItems,
  appointmentOutreach,
  appointments,
  blockReasons,
  brandSettings,
  callIns,
  customers,
  notificationJobs,
  rebookLinks,
  shops,
  staff,
  staffShops,
  timeBlocks,
} from "@/db/schema";
import type { CallInKind, OutreachOption, OutreachStatus } from "@/db/schema";
import { MAX_NOTE, NO_PRIVATE, ReasonViewer } from "@/domain/block-reasons";
import {
  AFFECTED_STATUSES,
  CALL_IN_REASON_KEY,
  Channels,
  OutreachRules,
  OutreachText,
  advance,
  affectedAppointments,
  channelsFor,
  cleanOutreachRules,
  followUpDue,
  isOpen,
  nextFollowUpAt,
  optionProblem,
  outreachEmail,
  outreachRules,
  outreachRulesProblem,
  outreachSms,
  reachable,
  sendTime,
  suggestOption,
  tooLateToSend,
  voiceScript,
} from "@/domain/outreach";
import { TimeOffRange, rangeLabel, timeOffSpan } from "@/domain/staff-time";
import { LocalDate, addDays, existingWallTime, formatDate, formatTime, localDateOf, minutesToLabel, todayLocal } from "@/lib/time";
import { Actor, SYSTEM, audit, customerActor } from "./audit";
import { reasonShower, usableReason } from "./block-reasons";
import { cancelAppointment, createAppointment, getAvailability, messageContext, rescheduleAppointment } from "./booking";
import { AppError, forbidden, notFound } from "./errors";
import { logMessage, optOutKeys, queueShopText, sendDue, threadFor } from "./messaging";
import { cancelPendingReminders, scheduleAppointmentNotifications } from "./notifications/queue";
import { closeLinks, finishOutreach as finish, issueLink } from "./rebook-links";

// ───────────────────────────── Rules ─────────────────────────────

export async function loadOutreachRules(tx: DBorTx = db): Promise<OutreachRules> {
  const [b] = await tx.select({ outreach: brandSettings.outreach }).from(brandSettings).limit(1);
  return outreachRules(b?.outreach ?? {});
}

export async function saveOutreachRules(patch: Record<string, unknown>, actor: Actor) {
  const problem = outreachRulesProblem(patch);
  if (problem) throw new AppError("bad_request", problem);
  const clean = cleanOutreachRules(patch);
  await db.transaction(async (tx) => {
    await tx.update(brandSettings).set({ outreach: clean, updatedAt: new Date() });
    await audit(actor, "callin.rules", "brand_settings", "brand", { rules: clean }, null, tx);
  });
  return outreachRules(clean);
}

// ───────────────────────────── Marking a call-in ─────────────────────────────

export interface CallInInput {
  staffId: string;
  /** null = all of the barber's shops. */
  shopId: string | null;
  kind: CallInKind;
  /** Required for "other": a reason used for time off. Sick and Emergency use theirs. */
  reasonId?: string | null;
  range: TimeOffRange;
  note?: string | null;
}

async function reasonFor(kind: CallInKind, reasonId: string | null | undefined, tx: DBorTx) {
  if (kind === "other") {
    if (!reasonId) throw new AppError("bad_request", "Pick a reason");
    return usableReason(reasonId, "time_off", tx);
  }
  const r = await tx.query.blockReasons.findFirst({ where: and(eq(blockReasons.key, CALL_IN_REASON_KEY[kind]), isNull(blockReasons.archivedAt)) });
  if (r) return usableReason(r.id, "time_off", tx);
  if (reasonId) return usableReason(reasonId, "time_off", tx);
  throw new AppError("conflict", `The ${kind === "sick" ? "Sick" : "Emergency"} reason is archived. Pick another reason.`);
}

function cleanNote(note: string | null | undefined): string | null {
  const n = note?.trim() || null;
  if (n && n.length > MAX_NOTE) throw new AppError("bad_request", `Keep the note to ${MAX_NOTE} characters`);
  return n;
}

function spanOf(range: TimeOffRange) {
  const span = timeOffSpan(range);
  if ("problem" in span) throw new AppError("bad_request", span.problem);
  for (const m of [range.startMin, range.endMin]) {
    if (m !== null && m < 24 * 60 && !existingWallTime(range.fromDate, m)) throw new AppError("bad_request", `${minutesToLabel(m)} doesn't exist on ${range.fromDate}: clocks spring forward that night`);
  }
  return span;
}

/** The barber's booked appointments in the time, as the call-in sees them. */
export async function findAffected(c: { staffId: string; shopId: string | null; startsAt: Date; endsAt: Date }, now: Date, tx: DBorTx = db) {
  const rows = await tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.staffId, c.staffId),
        inArray(appointments.status, [...AFFECTED_STATUSES]),
        lt(appointments.startsAt, c.endsAt),
        sql`${appointments.endsAt} > ${c.startsAt}`,
        c.shopId ? eq(appointments.shopId, c.shopId) : undefined,
      ),
    );
  return affectedAppointments(c, rows, now);
}

/**
 * Marks the barber as called in: writes the time off block (on the calendar, in who's off and in the
 * staffing report), then lists every booked appointment in it for outreach. Nothing is sent yet.
 */
export async function markCallIn(input: CallInInput, o: { actor: Actor; now?: Date }) {
  const now = o.now ?? new Date();
  const span = spanOf(input.range);
  if (span.endsAt <= now) throw new AppError("bad_request", "That time has already passed");
  const note = cleanNote(input.note);
  return db.transaction(async (tx) => {
    const reason = await reasonFor(input.kind, input.reasonId, tx);
    const clash = await tx
      .select({ id: callIns.id })
      .from(callIns)
      .where(and(eq(callIns.staffId, input.staffId), isNull(callIns.cancelledAt), lt(callIns.startsAt, span.endsAt), sql`${callIns.endsAt} > ${span.startsAt}`))
      .limit(1);
    if (clash.length) throw new AppError("conflict", "This barber is already marked as called in for part of that time");
    const [block] = await tx
      .insert(timeBlocks)
      .values({
        staffId: input.staffId,
        shopId: input.shopId,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        kind: span.allDay ? "day_off" : "block",
        category: "time_off",
        reasonId: reason.id,
        reason: reason.label,
        note,
        createdBy: o.actor.staffId ?? null,
      })
      .returning({ id: timeBlocks.id });
    const [ci] = await tx
      .insert(callIns)
      .values({
        staffId: input.staffId,
        shopId: input.shopId,
        kind: input.kind,
        reasonId: reason.id,
        reason: reason.label,
        note,
        fromDate: input.range.fromDate,
        toDate: input.range.toDate,
        startMin: input.range.startMin,
        endMin: input.range.endMin,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        blockId: block.id,
        createdBy: o.actor.staffId ?? null,
        createdAt: now,
      })
      .returning();
    const affected = await findAffected(ci, now, tx);
    if (affected.length) {
      await tx.insert(appointmentOutreach).values(
        affected.map((a) => ({ callInId: ci.id, appointmentId: a.id, shopId: a.shopId, customerId: a.customerId, originalStartsAt: a.startsAt, originalStaffId: a.staffId })),
      );
    }
    const auditShop = input.shopId ?? (await tx.select({ s: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, input.staffId)).orderBy(desc(staffShops.isPrimary)).limit(1))[0]?.s ?? null;
    await audit(
      o.actor,
      "callin.create",
      "call_in",
      ci.id,
      { staffId: input.staffId, kind: input.kind, reasonId: reason.id, reason: reason.label, note, private: reason.private, range: rangeLabel(ci), allShops: input.shopId === null, affected: affected.map((a) => a.code) },
      auditShop,
      tx,
    );
    return { callInId: ci.id, affected: affected.length };
  });
}

/** The barber can come in after all: the time off goes, open links stop working, and anything not yet sent is dropped. */
export async function cancelCallIn(id: string, actor: Actor, now = new Date()) {
  const ci = await db.query.callIns.findFirst({ where: eq(callIns.id, id) });
  if (!ci) throw notFound("Call-in");
  if (ci.cancelledAt) throw new AppError("conflict", "This call-in was already cancelled");
  await db.transaction(async (tx) => {
    await tx.update(callIns).set({ cancelledAt: now, cancelledBy: actor.staffId ?? null }).where(eq(callIns.id, id));
    if (ci.blockId) await tx.delete(timeBlocks).where(eq(timeBlocks.id, ci.blockId));
    const rows = await tx.select({ id: appointmentOutreach.id }).from(appointmentOutreach).where(eq(appointmentOutreach.callInId, id));
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await tx.update(rebookLinks).set({ revokedAt: now }).where(and(inArray(rebookLinks.outreachId, ids), isNull(rebookLinks.usedAt), isNull(rebookLinks.revokedAt)));
      await tx.update(notificationJobs).set({ status: "cancelled" }).where(and(inArray(notificationJobs.outreachId, ids), eq(notificationJobs.status, "pending")));
      await tx
        .update(appointmentOutreach)
        .set({ status: "cancelled", resolution: "Call-in cancelled", nextActionAt: null, updatedAt: now })
        .where(and(eq(appointmentOutreach.callInId, id), inArray(appointmentOutreach.status, ["pending", "notified", "delivered", "no_response", "unreachable"])));
    }
    await audit(actor, "callin.cancel", "call_in", id, { staffId: ci.staffId, range: rangeLabel(ci) }, ci.shopId, tx);
  });
}

// ───────────────────────────── Finding the client a barber or a time ─────────────────────────────

type Appt = typeof appointments.$inferSelect;
type OutreachRow = typeof appointmentOutreach.$inferSelect;

async function itemsOf(appointmentId: string, tx: DBorTx = db) {
  const items = await tx.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, appointmentId));
  const serviceId = items.find((i) => i.kind === "service")?.serviceId ?? null;
  const addonIds = items.filter((i) => i.kind === "addon" && i.serviceId).map((i) => i.serviceId!);
  return { serviceId, addonIds };
}

export interface Reassignment {
  staffId: string;
  shopId: string;
  label: string;
  shopName: string;
  otherShop: boolean;
}

/**
 * A barber free at the same time for the same services: at the same shop first (the client's preferred
 * barber if they're free), then, only if the client allows it, at another of the caller's shops.
 */
export async function freeBarberFor(
  a: Pick<Appt, "id" | "shopId" | "staffId" | "startsAt">,
  o: { allowOtherShop: boolean; preferredStaffId: string | null; shopIds: readonly string[]; absentStaffId: string },
): Promise<Reassignment | null> {
  const { serviceId, addonIds } = await itemsOf(a.id);
  if (!serviceId) return null;
  const date = localDateOf(a.startsAt);
  const tryShop = async (shopId: string): Promise<Reassignment | null> => {
    let avail: Awaited<ReturnType<typeof getAvailability>>;
    try {
      avail = await getAvailability({ shopRef: shopId, date, serviceId, addonIds, barberRef: "any", staffOverride: true, ignoreAppointmentId: a.id });
    } catch (e) {
      if (e instanceof AppError) return null;
      throw e;
    }
    const slot = avail.slots.find((s) => new Date(s.startsAt).getTime() === a.startsAt.getTime());
    const free = (slot?.barberIds ?? []).filter((id) => id !== o.absentStaffId && id !== a.staffId);
    if (!free.length) return null;
    const pick = o.preferredStaffId && free.includes(o.preferredStaffId) ? o.preferredStaffId : (avail.barbers.find((b) => free.includes(b.id))?.id ?? free[0]);
    const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { name: true } });
    return { staffId: pick, shopId, label: avail.barbers.find((b) => b.id === pick)?.displayName ?? "another barber", shopName: shop?.name ?? "", otherShop: shopId !== a.shopId };
  };
  const same = await tryShop(a.shopId);
  if (same || !o.allowOtherShop) return same;
  const others = await db
    .select({ id: shops.id })
    .from(shops)
    .where(and(eq(shops.active, true), ne(shops.id, a.shopId), o.shopIds.length ? inArray(shops.id, [...o.shopIds]) : sql`false`))
    .orderBy(asc(shops.name));
  for (const s of others) {
    const r = await tryShop(s.id);
    if (r) return r;
  }
  return null;
}

/** The earliest time the client could book online at the same shop, within a week: offered with "reply 1". */
export async function earliestOpening(a: Pick<Appt, "id" | "shopId" | "staffId">, absentStaffId: string, preferredStaffId: string | null, now: Date) {
  const { serviceId, addonIds } = await itemsOf(a.id);
  if (!serviceId) return null;
  const today = todayLocal(now);
  for (let d = 0; d < 7; d++) {
    const date: LocalDate = addDays(today, d);
    let avail: Awaited<ReturnType<typeof getAvailability>>;
    try {
      avail = await getAvailability({ shopRef: a.shopId, date, serviceId, addonIds, barberRef: "any", now });
    } catch (e) {
      if (e instanceof AppError) return null;
      throw e;
    }
    const slot = avail.slots.find((s) => new Date(s.startsAt) > now && s.barberIds.some((id) => id !== absentStaffId));
    if (!slot) continue;
    const ids = slot.barberIds.filter((id) => id !== absentStaffId);
    const staffId = ids.includes(a.staffId) ? a.staffId : preferredStaffId && ids.includes(preferredStaffId) ? preferredStaffId : ids[0];
    return { startsAt: new Date(slot.startsAt), staffId, label: avail.barbers.find((b) => b.id === staffId)?.displayName ?? "a barber" };
  }
  return null;
}

// ───────────────────────────── Sending ─────────────────────────────

const whenText = (d: Date) => `${formatDate(d)} at ${formatTime(d)}`;

/** The outreach row's appointment as it is now: a move to another shop booked a new one. */
const currentId = (r: Pick<OutreachRow, "appointmentId" | "newAppointmentId">) => r.newAppointmentId ?? r.appointmentId;

async function contactOf(customerId: string | null) {
  const c = customerId ? await db.query.customers.findFirst({ where: eq(customers.id, customerId) }) : null;
  const keys = await optOutKeys(c?.phone ? [c.phone] : []);
  const facts = {
    phone: c?.phone ?? null,
    email: c?.email ?? null,
    smsOptIn: c?.smsOptIn ?? false,
    emailOptIn: c?.emailOptIn ?? false,
    smsOptedOut: !!c?.phone && keys.has(`sms:${c.phone}`),
    voiceOptedOut: !!c?.phone && keys.has(`voice:${c.phone}`),
  };
  return { customer: c ?? null, channels: channelsFor(facts) };
}

export interface Who {
  actor: Actor;
  staffId: string | null;
  shopIds: readonly string[];
  canOutreach: boolean;
  canVoice: boolean;
}

export interface OutreachChoice {
  appointmentId: string;
  option: OutreachOption;
}

export interface OutreachResult {
  appointmentId: string;
  ok: boolean;
  message: string;
}

interface Delivery {
  jobIds: string[];
  summary: string;
}

/**
 * Queues the message for one option on the channels the client allows, from the shop's number, at the
 * first time quiet hours allow. Updates the row: notified, the try counted, the follow-up scheduled.
 */
async function deliver(
  row: OutreachRow,
  option: OutreachOption,
  appt: Appt,
  contact: Awaited<ReturnType<typeof contactOf>>,
  rules: OutreachRules,
  o: { now: Date; actor: Actor; sentBy: string | null; moved?: Reassignment | null; note?: string | null },
): Promise<Delivery> {
  const { now } = o;
  const { customer, channels } = contact;
  const [shop, absent] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, row.shopId) }),
    db.query.staff.findFirst({ where: eq(staff.id, row.originalStaffId), columns: { displayLabel: true } }),
  ]);
  const runAt = sendTime(now, rules);
  const late = tooLateToSend(runAt, appt.startsAt);
  const suggestion = option === "rebook" && !late ? await earliestOpening(appt, row.originalStaffId, customer?.preferredStaffId ?? null, now) : null;
  const movedTo = o.moved ? { barber: o.moved.label, shop: o.moved.otherShop ? `Ray'z ${o.moved.shopName}` : null, address: o.moved.otherShop ? await shopAddress(o.moved.shopId) : null } : null;

  return db.transaction(async (tx) => {
    const jobIds: string[] = [];
    const sentOn: string[] = [];
    if (!late) {
      const link = option === "voice" ? null : await issueLink({ outreachId: row.id, appointmentId: appt.id }, rules, tx, now);
      const t: OutreachText = {
        shop: `Ray'z ${shop?.name ?? ""}`,
        firstName: customer?.firstName ?? null,
        barber: absent?.displayLabel ?? "your barber",
        when: whenText(row.originalStartsAt),
        link: link?.url ?? "",
        suggestion: suggestion ? { when: whenText(suggestion.startsAt), barber: suggestion.label } : null,
        moved: movedTo,
        shopPhone: shop?.twilioNumber ?? shop?.phone ?? null,
      };
      const base = { appointmentId: appt.id, customerId: customer?.id ?? null, shopId: row.shopId, outreachId: row.id, runAt };
      if (option === "voice") {
        if (channels.voice && customer?.phone) {
          const s = voiceScript(t);
          const [j] = await tx
            .insert(notificationJobs)
            .values({ ...base, kind: "callin_voice", channel: "voice", to: customer.phone, body: `${s.human} ${s.menu}` })
            .returning({ id: notificationJobs.id });
          jobIds.push(j.id);
          sentOn.push("call");
        }
      } else {
        const kind = option === "reassign" ? "callin_reassign" : "callin_rebook";
        const which = option === "reassign" && movedTo ? "reassign" : "rebook";
        if (channels.sms && customer?.phone) {
          jobIds.push(await queueShopText({ ...base, to: customer.phone, body: outreachSms(which, t), kind, auto: true }, tx, now));
          sentOn.push("text");
        }
        if (channels.email && customer?.email) {
          const m = outreachEmail(which, t);
          const [j] = await tx
            .insert(notificationJobs)
            .values({ ...base, kind, channel: "email", to: customer.email, subject: m.subject, body: m.body })
            .returning({ id: notificationJobs.id });
          jobIds.push(j.id);
          sentOn.push("email");
        }
      }
    }
    const awaits = option !== "reassign";
    const patch: Partial<typeof appointmentOutreach.$inferInsert> = {
      option,
      suggestedStartsAt: suggestion?.startsAt ?? null,
      suggestedStaffId: suggestion?.staffId ?? null,
      sentBy: o.sentBy,
      updatedAt: now,
    };
    let summary: string;
    if (jobIds.length) {
      Object.assign(patch, {
        status: advance(row.status, "sent") ?? row.status,
        attempts: row.attempts + 1,
        lastAttemptAt: runAt,
        nextActionAt: awaits ? nextFollowUpAt(runAt, appt.startsAt, rules) : null,
        flaggedAt: null,
        flagReason: null,
      });
      const how = sentOn.join(" and ");
      summary = `${how.charAt(0).toUpperCase()}${how.slice(1)} ${runAt > now ? `queued for ${formatTime(runAt)} (quiet hours)` : "sent"}`;
    } else if (late) {
      Object.assign(patch, { flaggedAt: now, flagReason: `Quiet hours until ${formatTime(runAt)}, too close to the appointment. Phone the client.`, nextActionAt: null });
      summary = "Not sent: quiet hours run too close to the appointment. Flagged for staff to phone.";
    } else {
      Object.assign(patch, { status: advance(row.status, "unreachable") ?? row.status, flaggedAt: now, flagReason: "The client can't be texted, emailed or called automatically", nextActionAt: null });
      summary = "The client can't be reached automatically. Flagged for staff to phone.";
    }
    if (o.moved) {
      Object.assign(patch, { reassignedStaffId: o.moved.staffId, reassignedShopId: o.moved.shopId, resolution: `Moved to ${o.moved.label}${o.moved.otherShop ? ` at ${o.moved.shopName}` : ""}` });
      summary = `Moved to ${o.moved.label}${o.moved.otherShop ? ` at ${o.moved.shopName}` : ""}. ${summary}`;
    }
    if (o.note) summary = `${o.note} ${summary}`;
    await tx.update(appointmentOutreach).set(patch).where(eq(appointmentOutreach.id, row.id));
    await audit(
      o.actor,
      "callin.outreach",
      "appointment",
      row.appointmentId,
      { callInId: row.callInId, outreachId: row.id, option, attempt: row.attempts + 1, channels: sentOn, runAt: runAt.toISOString(), movedTo: o.moved?.staffId ?? null, otherShop: o.moved?.otherShop ?? false },
      row.shopId,
      tx,
    );
    return { jobIds, summary };
  });
}

async function shopAddress(shopId: string) {
  const s = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { address: true, city: true } });
  return s ? [s.address, s.city].filter(Boolean).join(", ") : null;
}

/** Moves the appointment to the barber found: same shop keeps it; another shop books a new one there and cancels this one. */
async function moveTo(a: Appt, r: Reassignment, actor: Actor): Promise<Appt> {
  if (!r.otherShop) {
    await rescheduleAppointment(a.code, { startsAt: a.startsAt, barberRef: r.staffId, actor, byCustomer: false, quiet: true });
    return (await db.query.appointments.findFirst({ where: eq(appointments.id, a.id) }))!;
  }
  const { serviceId, addonIds } = await itemsOf(a.id);
  const created = await createAppointment({
    shopRef: r.shopId,
    serviceId: serviceId!,
    addonIds,
    barberRef: r.staffId,
    startsAt: a.startsAt,
    customerId: a.customerId,
    source: "rebook",
    rebookedFromId: a.id,
    notes: a.notes,
    actor,
    silent: true,
  });
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(appointments).set({ status: "cancelled", cancelledAt: now, cancelledBy: "staff" }).where(eq(appointments.id, a.id));
    await cancelPendingReminders(a.id, tx);
    await audit(actor, "appointment.cancel", "appointment", a.id, { reason: `Moved to ${r.shopName} for a call-in`, byCustomer: false, movedTo: created.id }, a.shopId, tx);
    await scheduleAppointmentNotifications("reminders", await messageContext(created.id, tx), tx, now);
  });
  return (await db.query.appointments.findFirst({ where: eq(appointments.id, created.id) }))!;
}

async function sendOne(ci: typeof callIns.$inferSelect, row: OutreachRow, option: OutreachOption, who: Who, rules: OutreachRules, now: Date): Promise<Delivery> {
  if (!isOpen(row.status)) throw new AppError("conflict", `Already ${row.status === "cancelled" ? "closed" : row.status}`);
  if (option === "voice" ? !who.canVoice : !who.canOutreach) throw forbidden(option === "voice" ? "You can't place automated calls" : "You can't send call-in outreach");
  let appt = (await db.query.appointments.findFirst({ where: eq(appointments.id, currentId(row)) }))!;
  if (!reachable(appt.status)) throw new AppError("conflict", appt.status === "checked_in" || appt.status === "in_service" ? "The client is already in the shop" : `The appointment is ${appt.status}`);
  if (option === "reassign" && row.reassignedStaffId) throw new AppError("conflict", "Already moved to another barber");
  const contact = await contactOf(row.customerId);
  if (option !== "reassign") {
    const p = optionProblem(option, contact.channels);
    if (p) throw new AppError("conflict", p);
    return deliver(row, option, appt, contact, rules, { now, actor: who.actor, sentBy: who.staffId });
  }
  const pick = await freeBarberFor(appt, { allowOtherShop: contact.customer?.allowOtherShop ?? false, preferredStaffId: contact.customer?.preferredStaffId ?? null, shopIds: who.shopIds, absentStaffId: ci.staffId });
  if (!pick) {
    const fallback: OutreachOption | null = contact.channels.sms || contact.channels.email ? "rebook" : contact.channels.voice && who.canVoice ? "voice" : null;
    if (!fallback) throw new AppError("conflict", "No barber is free then, and the client can't be texted, emailed or called automatically. Phone them.");
    return deliver(row, fallback, appt, contact, rules, { now, actor: who.actor, sentBy: who.staffId, note: `No barber is free then, so ${fallback === "rebook" ? "a rebook link went instead" : "an automated call went instead"}.` });
  }
  appt = await moveTo(appt, pick, who.actor);
  if (pick.otherShop) {
    await db.update(appointmentOutreach).set({ newAppointmentId: appt.id }).where(eq(appointmentOutreach.id, row.id));
    row = { ...row, newAppointmentId: appt.id };
  }
  return deliver(row, "reassign", appt, contact, rules, { now, actor: who.actor, sentBy: who.staffId, moved: pick });
}

/** Sends the chosen option for each appointment; each succeeds or fails on its own. */
export async function sendOutreach(callInId: string, choices: readonly OutreachChoice[], who: Who, now = new Date()): Promise<OutreachResult[]> {
  const ci = await db.query.callIns.findFirst({ where: eq(callIns.id, callInId) });
  if (!ci) throw notFound("Call-in");
  if (ci.cancelledAt) throw new AppError("conflict", "This call-in was cancelled");
  const rules = await loadOutreachRules();
  const out: OutreachResult[] = [];
  const jobIds: string[] = [];
  for (const c of choices) {
    const row = await db.query.appointmentOutreach.findFirst({ where: and(eq(appointmentOutreach.callInId, callInId), eq(appointmentOutreach.appointmentId, c.appointmentId)) });
    if (!row) {
      out.push({ appointmentId: c.appointmentId, ok: false, message: "Not part of this call-in" });
      continue;
    }
    if (!who.shopIds.includes(row.shopId)) {
      out.push({ appointmentId: c.appointmentId, ok: false, message: "That shop is outside your access" });
      continue;
    }
    try {
      const d = await sendOne(ci, row, c.option, who, rules, now);
      jobIds.push(...d.jobIds);
      out.push({ appointmentId: c.appointmentId, ok: true, message: d.summary });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      out.push({ appointmentId: c.appointmentId, ok: false, message: e.message });
    }
  }
  await sendDue(jobIds);
  return out;
}

/** Staff phoned the client, or the client walked in: record how it ended and clear the flag. */
export async function closeByStaff(outreachId: string, status: Extract<OutreachStatus, "rebooked" | "declined" | "cancelled">, note: string | null, actor: Actor, now = new Date()) {
  const row = await db.query.appointmentOutreach.findFirst({ where: eq(appointmentOutreach.id, outreachId) });
  if (!row) throw notFound("Appointment");
  if (!isOpen(row.status)) throw new AppError("conflict", "This one is already closed");
  const resolution = note?.trim() || { rebooked: "Rebooked by the shop", declined: "The client cancelled", cancelled: "Closed by the shop" }[status];
  await db.transaction(async (tx) => {
    await tx.update(appointmentOutreach).set({ status, resolution, flaggedAt: null, flagReason: null, nextActionAt: null, respondedAt: now, updatedAt: now }).where(eq(appointmentOutreach.id, outreachId));
    await closeLinks(outreachId, tx, now);
    await tx.update(notificationJobs).set({ status: "cancelled" }).where(and(eq(notificationJobs.outreachId, outreachId), eq(notificationJobs.status, "pending")));
    await audit(actor, "callin.close", "appointment", row.appointmentId, { outreachId, status, resolution }, row.shopId, tx);
  });
}

// ───────────────────────────── The client answers ─────────────────────────────

/** The open outreach a text from this number is answering: the latest one sent from this shop. */
export async function openOutreachFor(phone: string, shopId: string) {
  const [row] = await db
    .select({ o: appointmentOutreach })
    .from(appointmentOutreach)
    .innerJoin(customers, eq(customers.id, appointmentOutreach.customerId))
    .innerJoin(callIns, eq(callIns.id, appointmentOutreach.callInId))
    .where(
      and(
        eq(customers.phone, phone),
        eq(appointmentOutreach.shopId, shopId),
        inArray(appointmentOutreach.status, ["notified", "delivered", "no_response"]),
        isNotNull(appointmentOutreach.option),
        isNull(callIns.cancelledAt),
      ),
    )
    .orderBy(desc(appointmentOutreach.lastAttemptAt))
    .limit(1);
  return row?.o ?? null;
}

export interface Answer {
  /** What to text back, or null when the usual confirmation or cancellation message already says it. */
  reply: string | null;
  /** For the shop's thread. */
  note: string;
}

/**
 * "1" or "2" by text. 1 keeps the new barber, or takes the time offered; 2 cancels. When the time
 * offered was taken meanwhile, they get a fresh link instead.
 */
export async function answerByText(row: OutreachRow, reply: "accept" | "decline", now = new Date()): Promise<Answer> {
  const appt = (await db.query.appointments.findFirst({ where: eq(appointments.id, currentId(row)) }))!;
  const shop = (await db.query.shops.findFirst({ where: eq(shops.id, row.shopId), columns: { name: true } }))!;
  const customer = row.customerId ? await db.query.customers.findFirst({ where: eq(customers.id, row.customerId), columns: { firstName: true } }) : null;
  const actor = customerActor(customer?.firstName ?? "client");
  const shopName = `Ray'z ${shop.name}`;
  if (!reachable(appt.status)) return { reply: `${shopName}: This appointment can't be changed by text any more. We'll get back to you here.`, note: `Replied ${reply === "accept" ? "1" : "2"}, but the appointment is ${appt.status}` };
  if (reply === "decline") {
    await cancelAppointment(appt.code, { actor, byCustomer: true, ignoreCutoff: true, reason: "Declined by text after a call-in", now });
    await finish(row, "declined", "Cancelled by text", now);
    await audit(actor, "callin.declined", "appointment", appt.id, { outreachId: row.id, via: "sms" }, row.shopId);
    return { reply: null, note: "Replied 2: appointment cancelled" };
  }
  if (row.option === "reassign") {
    const barber = await db.query.staff.findFirst({ where: eq(staff.id, appt.staffId), columns: { displayLabel: true } });
    await finish(row, "rebooked", `Kept ${barber?.displayLabel ?? "the new barber"} by text`, now);
    await audit(actor, "callin.accepted", "appointment", appt.id, { outreachId: row.id, via: "sms", kept: true }, row.shopId);
    return { reply: `${shopName}: You're all set with ${barber?.displayLabel ?? "your barber"} on ${whenText(appt.startsAt)}. See you then!`, note: "Replied 1: kept the new barber" };
  }
  const rules = await loadOutreachRules();
  const freshLink = async () => (await issueLink({ outreachId: row.id, appointmentId: appt.id }, rules, db, now)).url;
  if (!row.suggestedStartsAt || row.suggestedStartsAt <= now) return { reply: `${shopName}: Pick a new time with any barber here: ${await freshLink()}`, note: "Replied 1: sent a link to pick a time" };
  try {
    await rescheduleAppointment(appt.code, { startsAt: row.suggestedStartsAt, barberRef: row.suggestedStaffId, actor, byCustomer: true, ignoreCutoff: true, now });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { reply: `${shopName}: Sorry, that time was just taken. Pick another here: ${await freshLink()}`, note: `Replied 1, but ${whenText(row.suggestedStartsAt)} was taken: sent a new link` };
  }
  await finish(row, "rebooked", `Took ${whenText(row.suggestedStartsAt)} by text`, now);
  await audit(actor, "callin.accepted", "appointment", appt.id, { outreachId: row.id, via: "sms", startsAt: row.suggestedStartsAt.toISOString() }, row.shopId);
  return { reply: null, note: `Replied 1: moved to ${whenText(row.suggestedStartsAt)}` };
}

// ───────────────────────────── Follow-ups ─────────────────────────────

/**
 * Run by the cron job: no answer after the wait, one retry on the same channels (a fresh link, a fresh
 * suggestion); no answer after that, the appointment is flagged for staff. Appointments the shop
 * changed or cancelled meanwhile are closed instead.
 */
export async function runFollowUps(now = new Date()) {
  const rules = await loadOutreachRules();
  const rows = await db
    .select({ o: appointmentOutreach })
    .from(appointmentOutreach)
    .innerJoin(callIns, eq(callIns.id, appointmentOutreach.callInId))
    .where(
      and(
        inArray(appointmentOutreach.status, ["notified", "delivered"]),
        inArray(appointmentOutreach.option, ["rebook", "voice"]),
        isNull(callIns.cancelledAt),
        or(lte(appointmentOutreach.nextActionAt, now), lte(appointmentOutreach.originalStartsAt, now)),
      ),
    )
    .limit(200);
  const stats = { retried: 0, flagged: 0, closed: 0 };
  const jobIds: string[] = [];
  for (const { o: row } of rows) {
    const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, currentId(row)) });
    if (!appt) continue;
    if (!reachable(appt.status)) {
      await db.update(appointmentOutreach).set({ status: "cancelled", resolution: `Appointment ${appt.status}`, nextActionAt: null, updatedAt: now }).where(eq(appointmentOutreach.id, row.id));
      stats.closed++;
      continue;
    }
    if (appt.staffId !== row.originalStaffId || appt.startsAt.getTime() !== row.originalStartsAt.getTime()) {
      await finish(row, "rebooked", "Changed by the shop", now);
      stats.closed++;
      continue;
    }
    const due = followUpDue({ option: row.option, status: row.status, attempts: row.attempts, nextActionAt: row.nextActionAt, startsAt: appt.startsAt }, now);
    if (!due) continue;
    if (due.action === "flag") {
      await db.transaction(async (tx) => {
        await tx.update(appointmentOutreach).set({ status: "no_response", flaggedAt: now, flagReason: due.reason, nextActionAt: null, updatedAt: now }).where(eq(appointmentOutreach.id, row.id));
        await audit(SYSTEM, "callin.flag", "appointment", row.appointmentId, { outreachId: row.id, reason: due.reason }, row.shopId, tx);
      });
      stats.flagged++;
      continue;
    }
    const contact = await contactOf(row.customerId);
    const option = row.option === "voice" && contact.channels.voice ? "voice" : contact.channels.sms || contact.channels.email ? "rebook" : null;
    if (!option) {
      await db.update(appointmentOutreach).set({ status: "no_response", flaggedAt: now, flagReason: "Can't retry: the client opted out", nextActionAt: null, updatedAt: now }).where(eq(appointmentOutreach.id, row.id));
      stats.flagged++;
      continue;
    }
    const d = await deliver(row, option, appt, contact, rules, { now, actor: SYSTEM, sentBy: row.sentBy });
    jobIds.push(...d.jobIds);
    stats.retried++;
  }
  await sendDue(jobIds);
  return stats;
}

// ───────────────────────────── Lists ─────────────────────────────

export async function listCallIns(shopIds: readonly string[], o: { since: Date; viewer: ReasonViewer }) {
  if (!shopIds.length) return [];
  const works = await db.select({ staffId: staffShops.staffId, shopId: staffShops.shopId }).from(staffShops).where(inArray(staffShops.shopId, [...shopIds]));
  const staffIds = [...new Set(works.map((w) => w.staffId))];
  if (!staffIds.length) return [];
  const rows = await db
    .select({ c: callIns, staffLabel: staff.displayLabel, shopName: shops.name })
    .from(callIns)
    .innerJoin(staff, eq(staff.id, callIns.staffId))
    .leftJoin(shops, eq(shops.id, callIns.shopId))
    .where(and(inArray(callIns.staffId, staffIds), gte(callIns.endsAt, o.since), or(isNull(callIns.shopId), inArray(callIns.shopId, [...shopIds]))))
    .orderBy(desc(callIns.startsAt))
    .limit(100);
  const ids = rows.map((r) => r.c.id);
  const counts = ids.length
    ? await db
        .select({ callInId: appointmentOutreach.callInId, status: appointmentOutreach.status, flagged: sql<number>`count(*) filter (where ${appointmentOutreach.flaggedAt} is not null)::int`, n: sql<number>`count(*)::int` })
        .from(appointmentOutreach)
        .where(inArray(appointmentOutreach.callInId, ids))
        .groupBy(appointmentOutreach.callInId, appointmentOutreach.status)
    : [];
  const show = await reasonShower(o.viewer);
  return rows.map((r) => {
    const mine = counts.filter((c) => c.callInId === r.c.id);
    const by = Object.fromEntries(mine.map((c) => [c.status, c.n])) as Partial<Record<OutreachStatus, number>>;
    return {
      ...r.c,
      staffLabel: r.staffLabel,
      shopName: r.shopName,
      range: rangeLabel(r.c),
      reasonShown: show({ staffId: r.c.staffId, reasonId: r.c.reasonId, reason: r.c.reason, note: r.c.note }, true),
      total: mine.reduce((a, c) => a + c.n, 0),
      flagged: mine.reduce((a, c) => a + c.flagged, 0),
      by,
    };
  });
}

export async function flaggedCount(shopIds: readonly string[]) {
  if (!shopIds.length) return 0;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(appointmentOutreach)
    .innerJoin(callIns, eq(callIns.id, appointmentOutreach.callInId))
    .where(and(inArray(appointmentOutreach.shopId, [...shopIds]), isNotNull(appointmentOutreach.flaggedAt), isNull(callIns.cancelledAt), inArray(appointmentOutreach.status, ["pending", "notified", "delivered", "no_response", "unreachable"])));
  return r?.n ?? 0;
}

export interface OutreachView {
  id: string;
  appointmentId: string;
  currentAppointmentId: string;
  code: string;
  shopId: string;
  shopName: string;
  customerId: string | null;
  customerName: string;
  services: string;
  originalStartsAt: string;
  startsAt: string;
  apptStatus: string;
  barberNow: string;
  option: OutreachOption | null;
  status: OutreachStatus;
  resolution: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextActionAt: string | null;
  flaggedAt: string | null;
  flagReason: string | null;
  suggestion: string | null;
  channels: Channels;
  allowOtherShop: boolean;
  suggested: OutreachOption | null;
  freeBarber: string | null;
  jobs: { id: string; channel: string; status: string; runAt: string; deliveredAt: string | null; lastError: string | null }[];
  link: { expiresAt: string; usedAt: string | null; revokedAt: string | null } | null;
}

/** The call-in and every appointment in it, with what each client can be sent and what's happened so far. */
export async function callInDetail(id: string, viewer: ReasonViewer = NO_PRIVATE, o: { shopIds: readonly string[]; checkFree?: boolean } = { shopIds: [] }) {
  const [row] = await db
    .select({ c: callIns, staffLabel: staff.displayLabel, shopName: shops.name })
    .from(callIns)
    .innerJoin(staff, eq(staff.id, callIns.staffId))
    .leftJoin(shops, eq(shops.id, callIns.shopId))
    .where(eq(callIns.id, id));
  if (!row) throw notFound("Call-in");
  const show = await reasonShower(viewer);
  const outreach = await db
    .select({ o: appointmentOutreach, shopName: shops.name })
    .from(appointmentOutreach)
    .innerJoin(shops, eq(shops.id, appointmentOutreach.shopId))
    .where(eq(appointmentOutreach.callInId, id))
    .orderBy(asc(appointmentOutreach.originalStartsAt));
  const apptIds = outreach.map((r) => currentId(r.o));
  const outreachIds = outreach.map((r) => r.o.id);
  const [appts, items, jobs, links] = await Promise.all([
    apptIds.length
      ? db
          .select({ a: appointments, barber: staff.displayLabel, firstName: customers.firstName, lastName: customers.lastName, phone: customers.phone, email: customers.email, smsOptIn: customers.smsOptIn, emailOptIn: customers.emailOptIn, allowOtherShop: customers.allowOtherShop, preferredStaffId: customers.preferredStaffId })
          .from(appointments)
          .innerJoin(staff, eq(staff.id, appointments.staffId))
          .leftJoin(customers, eq(customers.id, appointments.customerId))
          .where(inArray(appointments.id, apptIds))
      : [],
    apptIds.length ? db.select().from(appointmentItems).where(inArray(appointmentItems.appointmentId, apptIds)) : [],
    outreachIds.length ? db.select().from(notificationJobs).where(inArray(notificationJobs.outreachId, outreachIds)).orderBy(desc(notificationJobs.createdAt)) : [],
    outreachIds.length ? db.select().from(rebookLinks).where(inArray(rebookLinks.outreachId, outreachIds)).orderBy(desc(rebookLinks.createdAt)) : [],
  ]);
  const byAppt = new Map(appts.map((a) => [a.a.id, a]));
  const keys = await optOutKeys(appts.map((a) => a.phone).filter((p): p is string => !!p));
  const staffLabels = new Map(
    (outreach.some((r) => r.o.suggestedStaffId)
      ? await db.select({ id: staff.id, l: staff.displayLabel }).from(staff).where(inArray(staff.id, outreach.map((r) => r.o.suggestedStaffId).filter((x): x is string => !!x)))
      : []
    ).map((s) => [s.id, s.l]),
  );
  const views: OutreachView[] = [];
  for (const { o: r, shopName } of outreach) {
    const a = byAppt.get(currentId(r))!;
    const channels = channelsFor({
      phone: a.phone,
      email: a.email,
      smsOptIn: a.smsOptIn ?? false,
      emailOptIn: a.emailOptIn ?? false,
      smsOptedOut: !!a.phone && keys.has(`sms:${a.phone}`),
      voiceOptedOut: !!a.phone && keys.has(`voice:${a.phone}`),
    });
    const open = isOpen(r.status) && reachable(a.a.status);
    const free = o.checkFree && open && r.status === "pending" && !r.reassignedStaffId ? await freeBarberFor(a.a, { allowOtherShop: a.allowOtherShop ?? false, preferredStaffId: a.preferredStaffId, shopIds: o.shopIds, absentStaffId: row.c.staffId }) : null;
    const lk = links.find((l) => l.outreachId === r.id);
    views.push({
      id: r.id,
      appointmentId: r.appointmentId,
      currentAppointmentId: a.a.id,
      code: a.a.code,
      shopId: r.shopId,
      shopName,
      customerId: r.customerId,
      customerName: a.firstName ? `${a.firstName}${a.lastName ? ` ${a.lastName.charAt(0)}.` : ""}` : (a.a.notes?.replace(/^Walk-in: /, "") ?? "Walk-in"),
      services: items
        .filter((i) => i.appointmentId === a.a.id)
        .sort((x, y) => x.kind.localeCompare(y.kind) * -1)
        .map((i) => i.name)
        .join(" + "),
      originalStartsAt: r.originalStartsAt.toISOString(),
      startsAt: a.a.startsAt.toISOString(),
      apptStatus: a.a.status,
      barberNow: a.barber,
      option: r.option,
      status: r.status,
      resolution: r.resolution,
      attempts: r.attempts,
      lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
      nextActionAt: r.nextActionAt?.toISOString() ?? null,
      flaggedAt: r.flaggedAt?.toISOString() ?? null,
      flagReason: r.flagReason,
      suggestion: r.suggestedStartsAt ? `${whenText(r.suggestedStartsAt)} with ${staffLabels.get(r.suggestedStaffId ?? "") ?? "a barber"}` : null,
      channels,
      allowOtherShop: a.allowOtherShop ?? false,
      suggested: r.status === "pending" ? suggestOption({ reachable: open, freeBarber: !!free, channels }) : null,
      freeBarber: free ? `${free.label}${free.otherShop ? ` at ${free.shopName}` : ""}` : null,
      jobs: jobs
        .filter((j) => j.outreachId === r.id)
        .map((j) => ({ id: j.id, channel: j.channel, status: j.status, runAt: j.runAt.toISOString(), deliveredAt: j.deliveredAt?.toISOString() ?? null, lastError: j.lastError })),
      link: lk ? { expiresAt: lk.expiresAt.toISOString(), usedAt: lk.usedAt?.toISOString() ?? null, revokedAt: lk.revokedAt?.toISOString() ?? null } : null,
    });
  }
  return {
    callIn: { ...row.c, staffLabel: row.staffLabel, shopName: row.shopName, range: rangeLabel(row.c), reasonShown: show({ staffId: row.c.staffId, reasonId: row.c.reasonId, reason: row.c.reason, note: row.c.note }, true) },
    outreach: views,
  };
}

/** Thread note when a text answer was handled automatically. */
export async function noteInThread(shopId: string, phone: string, note: string, tx: DBorTx = db, now = new Date()) {
  const t = await threadFor(shopId, phone, tx);
  await logMessage(t.id, { direction: "note", body: note, auto: true }, tx, now);
}
