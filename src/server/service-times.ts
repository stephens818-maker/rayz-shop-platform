import { eq, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { appointmentTimes, appointments } from "@/db/schema";
import {
  FinishedVia,
  TimesView,
  TimingReview,
  actualMinutes,
  correctionProblem,
  counts,
  formatMinutes,
  timingFlags,
  waitMinutes,
} from "@/domain/service-times";
import { formatTime } from "@/lib/time";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";

/**
 * Capturing actual service times: arrival (check-in), Start and Finish, and checkout, each with
 * who recorded it. Checkout stands in for Finish when nobody tapped it. Managers correct times
 * with a reason (logged) and decide whether a flagged time counts.
 */

type Times = typeof appointmentTimes.$inferSelect;
type Patch = Partial<Omit<Times, "appointmentId" | "updatedAt">>;

const STARTABLE = ["booked", "confirmed", "checked_in", "in_service"];
const STATUS_WORD: Record<string, string> = { completed: "checked out", cancelled: "cancelled", no_show: "a no-show" };

async function current(appointmentId: string, tx: DBorTx): Promise<Times | null> {
  const [t] = await tx.select().from(appointmentTimes).where(eq(appointmentTimes.appointmentId, appointmentId)).for("update");
  return t ?? null;
}

async function write(appointmentId: string, patch: Patch, tx: DBorTx) {
  await tx
    .insert(appointmentTimes)
    .values({ appointmentId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appointmentTimes.appointmentId, set: { ...patch, updatedAt: new Date() } });
}

async function lockAppointment(id: string, tx: DBorTx) {
  const [a] = await tx.select().from(appointments).where(eq(appointments.id, id)).for("update");
  if (!a) throw notFound("Appointment");
  return a;
}

/** The first check-in counts as the arrival; checking in again doesn't move it. */
export async function recordArrival(appointmentId: string, actor: Actor, tx: DBorTx = db, now = new Date()) {
  const t = await current(appointmentId, tx);
  if (t?.arrivedAt) return;
  await write(appointmentId, { arrivedAt: now, arrivedBy: actor.staffId ?? null }, tx);
}

/** Undo check-in: the client hasn't arrived after all. Leaves a started service alone. */
export async function clearArrival(appointmentId: string, tx: DBorTx = db) {
  const t = await current(appointmentId, tx);
  if (!t || t.startedAt) return;
  await write(appointmentId, { arrivedAt: null, arrivedBy: null }, tx);
}

/** Back from "in the chair" to checked in: the start was a mistake. A finished service keeps its times. */
export async function clearStart(appointmentId: string, tx: DBorTx = db) {
  const t = await current(appointmentId, tx);
  if (!t?.startedAt || t.finishedAt) return;
  await write(appointmentId, { startedAt: null, startedBy: null }, tx);
}

export async function startService(appointmentId: string, actor: Actor, now = new Date()) {
  await db.transaction(async (tx) => {
    const a = await lockAppointment(appointmentId, tx);
    if (!STARTABLE.includes(a.status)) throw new AppError("conflict", `This appointment is ${STATUS_WORD[a.status] ?? a.status}, so it can't be started`);
    const t = await current(appointmentId, tx);
    if (t?.finishedAt) throw new AppError("conflict", "This service is already finished. A manager can correct the times.");
    if (t?.startedAt) throw new AppError("conflict", `Already started at ${formatTime(t.startedAt)}`);
    await write(appointmentId, { startedAt: now, startedBy: actor.staffId ?? null }, tx);
    if (a.status !== "in_service") await tx.update(appointments).set({ status: "in_service" }).where(eq(appointments.id, appointmentId));
    await audit(actor, "appointment.service_start", "appointment", appointmentId, { from: a.status, at: now.toISOString() }, a.shopId, tx);
  });
}

export async function finishService(appointmentId: string, actor: Actor, now = new Date()) {
  await db.transaction(async (tx) => {
    const a = await lockAppointment(appointmentId, tx);
    if (a.status === "cancelled" || a.status === "no_show") throw new AppError("conflict", `This appointment is ${STATUS_WORD[a.status]}`);
    const t = await current(appointmentId, tx);
    if (!t?.startedAt) throw new AppError("conflict", "Start the service first");
    if (t.finishedAt) throw new AppError("conflict", `Already finished at ${formatTime(t.finishedAt)}`);
    if (now <= t.startedAt) throw new AppError("bad_request", "The finish must be after the start");
    await write(appointmentId, { finishedAt: now, finishedBy: actor.staffId ?? null, finishedVia: "finish" }, tx);
    const minutes = actualMinutes({ startedAt: t.startedAt, finishedAt: now })!;
    await audit(actor, "appointment.service_finish", "appointment", appointmentId, { via: "finish", minutes: Math.round(minutes * 10) / 10 }, a.shopId, tx);
  });
}

/** At payment: the checkout time, and the end of the service if Finish wasn't tapped. */
export async function recordCheckout(appointmentId: string, actor: Actor, tx: DBorTx, now = new Date()) {
  const t = await current(appointmentId, tx);
  const patch: Patch = { checkedOutAt: now, checkedOutBy: actor.staffId ?? null };
  const standIn = !!t?.startedAt && !t.finishedAt && now > t.startedAt;
  if (standIn) Object.assign(patch, { finishedAt: now, finishedBy: actor.staffId ?? null, finishedVia: "checkout" satisfies FinishedVia });
  await write(appointmentId, patch, tx);
  if (standIn) {
    const [a] = await tx.select({ shopId: appointments.shopId }).from(appointments).where(eq(appointments.id, appointmentId));
    const minutes = actualMinutes({ startedAt: t!.startedAt, finishedAt: now })!;
    await audit(actor, "appointment.service_finish", "appointment", appointmentId, { via: "checkout", minutes: Math.round(minutes * 10) / 10 }, a?.shopId ?? null, tx);
  }
}

export interface Correction {
  /** Undefined leaves a time as it is; null clears it. */
  arrivedAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

const FIELDS = ["arrivedAt", "startedAt", "finishedAt"] as const;
const BY = { arrivedAt: "arrivedBy", startedAt: "startedBy", finishedAt: "finishedBy" } as const;

/** A manager fixes recorded times. Each changed time is put down to them; the log keeps the old one and the reason. */
export async function correctServiceTimes(appointmentId: string, c: Correction, reason: string, actor: Actor, now = new Date()) {
  const why = reason.trim();
  if (why.length < 3) throw new AppError("bad_request", "Say why the times are being corrected");
  await db.transaction(async (tx) => {
    const a = await lockAppointment(appointmentId, tx);
    const t = await current(appointmentId, tx);
    const before = { arrivedAt: t?.arrivedAt ?? null, startedAt: t?.startedAt ?? null, finishedAt: t?.finishedAt ?? null };
    const after = { ...before };
    for (const f of FIELDS) if (c[f] !== undefined) after[f] = c[f]!;
    const changed = FIELDS.filter((f) => (before[f]?.getTime() ?? null) !== (after[f]?.getTime() ?? null));
    if (!changed.length) throw new AppError("bad_request", "Nothing changed");
    const problem = correctionProblem(after, now);
    if (problem) throw new AppError("bad_request", problem);
    const patch: Patch = { correctedAt: now, correctedBy: actor.staffId ?? null };
    for (const f of changed) Object.assign(patch, { [f]: after[f], [BY[f]]: after[f] ? (actor.staffId ?? null) : null });
    if (changed.includes("finishedAt")) patch.finishedVia = after.finishedAt ? "correction" : null;
    await write(appointmentId, patch, tx);
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    await audit(
      actor,
      "service_times.correct",
      "appointment",
      appointmentId,
      {
        reason: why,
        changes: Object.fromEntries(changed.map((f) => [f, { from: iso(before[f]), to: iso(after[f]) }])),
        minutes: { from: actualMinutes(before), to: actualMinutes(after) },
      },
      a.shopId,
      tx,
    );
  });
}

/** Count a flagged time anyway, leave a time out, or go back to the flags (null). */
export async function reviewServiceTime(appointmentId: string, review: TimingReview | null, note: string | null, actor: Actor) {
  await db.transaction(async (tx) => {
    const a = await lockAppointment(appointmentId, tx);
    const t = await current(appointmentId, tx);
    if (!t?.startedAt || !t.finishedAt) throw new AppError("conflict", "Only a started and finished service can be counted or left out");
    if ((t.review ?? null) === review) return;
    await write(appointmentId, { review, reviewNote: note?.trim() || null }, tx);
    await audit(actor, "service_times.review", "appointment", appointmentId, { from: t.review ?? "auto", to: review ?? "auto", note: note?.trim() || null }, a.shopId, tx);
  });
}

// ───────────────────────────── Reading ─────────────────────────────

interface TimesRow {
  id: string;
  booked_min: number;
  arrived_at: Date | null;
  arrived_by: string | null;
  started_at: Date | null;
  started_by: string | null;
  finished_at: Date | null;
  finished_by: string | null;
  finished_via: FinishedVia | null;
  checked_out_at: Date | null;
  checked_out_by: string | null;
  review: TimingReview | null;
  review_note: string | null;
  corrected_at: Date | null;
  corrected_by: string | null;
}

const d = (x: Date | string | null) => (x === null ? null : new Date(x));

/** Times for these appointments, with who recorded each, keyed by appointment. Appointments with nothing recorded get an empty view. */
export async function timesFor(ids: string[], now = new Date(), tx: DBorTx = db): Promise<Map<string, TimesView>> {
  const out = new Map<string, TimesView>();
  if (!ids.length) return out;
  const rows = (await tx.execute(sql`
    select a.id, round(extract(epoch from (a.ends_at - a.starts_at)) / 60)::int booked_min,
      t.arrived_at, ab.display_label arrived_by, t.started_at, sb.display_label started_by,
      t.finished_at, fb.display_label finished_by, t.finished_via, t.checked_out_at, ob.display_label checked_out_by,
      t.review, t.review_note, t.corrected_at, cb.display_label corrected_by
    from appointments a
    left join appointment_times t on t.appointment_id = a.id
    left join staff ab on ab.id = t.arrived_by
    left join staff sb on sb.id = t.started_by
    left join staff fb on fb.id = t.finished_by
    left join staff ob on ob.id = t.checked_out_by
    left join staff cb on cb.id = t.corrected_by
    where a.id in (${sql.join(
      ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    )})`)) as unknown as TimesRow[];
  for (const r of rows) out.set(r.id, toView(r, now));
  return out;
}

function toView(r: TimesRow, now: Date): TimesView {
  const stamp = (at: Date | string | null, by: string | null) => (at ? { at: new Date(at).toISOString(), by } : null);
  const t = { bookedMin: r.booked_min, arrivedAt: d(r.arrived_at), startedAt: d(r.started_at), finishedAt: d(r.finished_at), review: r.review };
  return {
    appointmentId: r.id,
    bookedMin: r.booked_min,
    arrived: stamp(r.arrived_at, r.arrived_by),
    started: stamp(r.started_at, r.started_by),
    finished: r.finished_at ? { at: new Date(r.finished_at).toISOString(), by: r.finished_by, via: r.finished_via ?? "finish" } : null,
    checkedOut: stamp(r.checked_out_at, r.checked_out_by),
    review: r.review,
    reviewNote: r.review_note,
    corrected: stamp(r.corrected_at, r.corrected_by),
    actualMin: actualMinutes(t),
    waitMin: waitMinutes(t),
    flags: timingFlags(t, now),
    counts: counts(t, now),
  };
}

export async function timesOf(appointmentId: string, now = new Date()): Promise<TimesView> {
  const v = (await timesFor([appointmentId], now)).get(appointmentId);
  if (!v) throw notFound("Appointment");
  return v;
}

/** One line for lists: "In the chair 12 min" or "38.0 min (booked 30)". */
export function timesLine(v: TimesView, now = new Date()): string | null {
  if (v.started && !v.finished) return `In the chair ${Math.max(0, Math.floor((now.getTime() - Date.parse(v.started.at)) / 60_000))} min`;
  if (v.actualMin !== null) return `${formatMinutes(v.actualMin)} (booked ${v.bookedMin})`;
  return null;
}

