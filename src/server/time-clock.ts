import bcrypt from "bcryptjs";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import {
  appointments,
  clockAlertLog,
  clockDevices,
  ftStatusChanges,
  payrollLockedOt,
  shops,
  staff,
  staffSchedules,
  staffShops,
  timeBlocks,
  timeEntries,
  timePunchEdits,
  timePunchPhotos,
  timePunches,
  timesheetLocks,
  timesheets,
  type PunchMethod,
  type PunchSource,
} from "@/db/schema";
import { payPeriodByIndex, payPeriodFor, type PayPeriod } from "@/domain/payroll";
import { periodOf } from "@/domain/payroll/calendar";
import { dailyHours, overtimeSlices, sliceKey, splitByLocalDay, weekStartOf, type Slice, type TimeEntry } from "@/domain/payroll/overtime";
import type { PayrollSettings } from "@/domain/payroll/calc";
import {
  FLAG_LABEL,
  PIN_LOCK_MINUTES,
  PIN_MAX_FAILURES,
  PROBLEM_LABEL,
  allowedNext,
  forgottenAfter,
  offSchedule,
  pairPunches,
  pinProblem,
  rollingFt,
  scheduledOn,
  shiftWork,
  shopClockSettings,
  verifyPunch,
  type ClockRules,
  type FtLabel,
  type Interval,
  type PairProblem,
  type PunchEvidence,
  type PunchFlag,
  type PunchLike,
  type PunchType,
  type ScheduleRow,
  type Shift,
  type ShopClockSettings,
} from "@/domain/time-clock";
import { appBaseUrl } from "@/lib/deployment";
import { mealCheck, mealPromptDue, rulesFor, workStateOf } from "@/domain/wage-hour";
import { callInHref, clockBlockTitle } from "@/domain/clock-live";
import type { Permission } from "@/domain/permissions";
import { addDays, endOfLocalDay, formatDate, formatTime, isValidLocalDate, localDateOf, localMinutesOf, startOfLocalDay, todayLocal, weekdayOf, type LocalDate } from "@/lib/time";
import { settingAt, settingFor } from "./brand-sync/settings";
import { audit, SYSTEM, type Actor } from "./audit";
import { loadStaffAccess, staffWithAccessTo, workShopIds } from "./auth/access";
import { AppError, forbidden, notFound } from "./errors";
import { clockFallout } from "./clock-live";
import { refreshClockBlocks, syncClockBlocks } from "./clock-blocks";
import { usableReason } from "./block-reasons";
import { enqueueShopEmail } from "./notifications/queue";
import { queueStaffNotice, releaseHeldStaffNotices } from "./staff-alerts";
import { brandCalendar, DEFAULT_CALENDAR, ensurePayGroups, hoursLockedOn, isLockedOn, loadSettings } from "./payroll/groups";
import { randomToken, sha256 } from "./auth/tokens";
import { nfcValid, qrValid } from "./clock-codes";

/**
 * The time clock: punches, the shifts and paid time worked out from them, timesheets with the
 * employee's and a manager's approval, period locks, forgotten clock-outs, full-time tracking and the
 * payroll CSVs. Clock punches become time_entries (source "clock", linked by punch_in_id), so payroll,
 * overtime and reports read one table; they're rewritten whenever a shift's punches change.
 */

const bad = (msg: string) => new AppError("bad_request", msg);
const DAY = 86_400_000;
/** Punches this far either side of a change can belong to the same shift. */
const SHIFT_REACH = 36 * 3600_000;
/** An open shift older than this no longer stops a new clock-in; it waits for a manager instead. */
const STALE_OPEN_MS = 24 * 3600_000;

/** Whether a problem is only someone still at work: an open shift that is their latest, not stale and not flagged forgotten. */
function onTheClock(shifts: readonly Shift[], byId: ReadonlyMap<string, { flags: unknown }>, now: Date) {
  const latest = new Map<string, Shift>();
  for (const s of shifts) if (s.start.getTime() >= (latest.get(s.staffId)?.start.getTime() ?? -Infinity)) latest.set(s.staffId, s);
  return (p: PairProblem) => {
    if (p.kind !== "open_shift") return false;
    const s = latest.get(p.staffId);
    return (
      !!s &&
      s.inId === p.punchId &&
      now.getTime() - s.start.getTime() <= STALE_OPEN_MS &&
      !((byId.get(p.punchId)?.flags as string[] | undefined) ?? []).includes(
        "forgot_out",
      )
    );
  };
}
export const DEVICE_COOKIE = "rayz_clock_device";
const MAX_PHOTO_CHARS = 400_000;

// ───────────────────────────── Settings ─────────────────────────────

/** The time clock rules at a shop (the time_clock setting); no shop, the brand's. They change through the brand change scope. */
export async function loadClockRules(shopId?: string | null, tx: DBorTx = db): Promise<ClockRules> {
  return settingAt<ClockRules>("time_clock", shopId, tx);
}

/** Each shop's time clock rules: a shift follows the rules of the shop it was worked at. */
export const clockRulesAt = (shopIds: readonly string[], tx: DBorTx = db) => settingFor<ClockRules>("time_clock", shopIds, tx);

export interface ShopClock {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  settings: ShopClockSettings;
}

export async function shopClocks(shopIds: readonly string[], tx: DBorTx = db): Promise<ShopClock[]> {
  if (!shopIds.length) return [];
  const rows = await tx
    .select({ id: shops.id, name: shops.name, latitude: shops.latitude, longitude: shops.longitude, timeClock: shops.timeClock })
    .from(shops)
    .where(inArray(shops.id, [...shopIds]))
    .orderBy(asc(shops.name));
  return rows.map((r) => ({ id: r.id, name: r.name, latitude: r.latitude, longitude: r.longitude, settings: shopClockSettings(r.timeClock) }));
}

export async function saveShopClock(shopId: string, v: { settings: ShopClockSettings; latitude: number | null; longitude: number | null }, actor: Actor) {
  const [current] = await db.select({ timeClock: shops.timeClock }).from(shops).where(eq(shops.id, shopId));
  // The NFC tag's version only moves when a manager retires the tag (src/server/clock-codes.ts).
  const s = { ...shopClockSettings(v.settings), nfcTagVersion: shopClockSettings(current?.timeClock).nfcTagVersion };
  if (v.settings.networks.length !== s.networks.length) throw bad("One of the network addresses isn't an IP address or range (like 203.0.113.0/24).");
  const lat = v.latitude;
  const lng = v.longitude;
  if ((lat === null) !== (lng === null)) throw bad("Enter both the latitude and the longitude, or neither.");
  if (lat !== null && (lat < -90 || lat > 90 || lng! < -180 || lng! > 180)) throw bad("That latitude or longitude is out of range.");
  if (s.methods.includes("gps") && lat === null) throw bad("Set the shop's location before turning on the GPS check.");
  if (s.methods.includes("network") && !s.networks.length) throw bad("Add the shop's network address before turning on the network check.");
  await db.update(shops).set({ timeClock: s as unknown as Record<string, unknown>, latitude: lat, longitude: lng }).where(eq(shops.id, shopId));
  await audit(
    actor,
    "timeclock.shop_rules",
    "shop",
    shopId,
    {
      methods: s.methods,
      radiusM: s.radiusM,
      networks: s.networks.length,
      photo: s.photo,
      graceMinutes: s.graceMinutes,
      locationSet: lat !== null,
      blockOnBreak: s.blockOnBreak,
      breakHoldMinutes: s.breakHoldMinutes,
      blockAfterClockOut: s.blockAfterClockOut,
      notInBlock: s.notInBlock,
      openEarly: s.openEarly,
      lateAlertMinutes: s.lateAlertMinutes,
    },
    shopId,
  );
  return s;
}

// ───────────────────────────── Devices ─────────────────────────────

/** The registered device this browser's token belongs to, if it's still in use. Marks it seen. */
export async function deviceFromToken(token: string | null | undefined, now = new Date()) {
  if (!token) return null;
  const [d] = await db
    .select({ id: clockDevices.id, shopId: clockDevices.shopId, label: clockDevices.label, shop: shops.name })
    .from(clockDevices)
    .innerJoin(shops, eq(shops.id, clockDevices.shopId))
    .where(and(eq(clockDevices.tokenHash, sha256(token)), isNull(clockDevices.revokedAt)));
  if (!d) return null;
  await db.update(clockDevices).set({ lastSeenAt: now }).where(eq(clockDevices.id, d.id));
  return d;
}

/** Registers the browser asking as one of the shop's front-desk devices. The caller sets the returned token as a cookie. */
export async function registerDevice(shopId: string, label: string, actor: Actor) {
  const name = label.trim().slice(0, 60);
  if (!name) throw bad("Name the device, e.g. Front desk iPad.");
  const token = randomToken();
  const [row] = await db.insert(clockDevices).values({ shopId, label: name, tokenHash: sha256(token), registeredBy: actor.staffId ?? null }).returning({ id: clockDevices.id });
  await audit(actor, "timeclock.device_register", "clock_device", row.id, { label: name }, shopId);
  return { id: row.id, token };
}

export async function listDevices(shopIds: readonly string[]) {
  if (!shopIds.length) return [];
  return db
    .select({ id: clockDevices.id, shopId: clockDevices.shopId, shop: shops.name, label: clockDevices.label, lastSeenAt: clockDevices.lastSeenAt, createdAt: clockDevices.createdAt, pairedAt: clockDevices.pairedAt })
    .from(clockDevices)
    .innerJoin(shops, eq(shops.id, clockDevices.shopId))
    .where(and(inArray(clockDevices.shopId, [...shopIds]), isNull(clockDevices.revokedAt)))
    .orderBy(asc(shops.name), asc(clockDevices.label));
}

export async function revokeDevice(id: string, shopIds: readonly string[], actor: Actor) {
  const [d] = await db.select().from(clockDevices).where(eq(clockDevices.id, id));
  if (!d || !shopIds.includes(d.shopId)) throw notFound("Device");
  await db.update(clockDevices).set({ revokedAt: new Date() }).where(eq(clockDevices.id, id));
  await audit(actor, "timeclock.device_revoke", "clock_device", id, { label: d.label }, d.shopId);
}

/** Only the shop's own team punches on its front-desk clock; anyone else is not found, so ids can't be probed. */
export async function onShopTeam(shopId: string, staffId: string) {
  const [r] = await db
    .select({ id: staff.id })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), eq(staffShops.staffId, staffId), eq(staff.active, true), eq(staff.kind, "person")))
    .limit(1);
  if (!r) throw notFound("Team member");
}

// ───────────────────────────── PINs ─────────────────────────────

export async function setPin(staffId: string, pin: string, actor: Actor) {
  const p = pinProblem(pin);
  if (p) throw bad(p);
  await db.update(staff).set({ clockPinHash: await bcrypt.hash(pin, 10), clockPinFailures: 0, clockPinLockedUntil: null }).where(eq(staff.id, staffId));
  await audit(actor, "timeclock.pin_set", "staff", staffId, {});
}

/** The barber's own choice: whether clocking in early opens earlier slots that day, where the shop allows it. */
export async function setOpensEarly(staffId: string, on: boolean, actor: Actor) {
  await db.update(staff).set({ clockOpensEarly: on }).where(eq(staff.id, staffId));
  await audit(actor, "timeclock.opens_early", "staff", staffId, { on });
}

export async function clearPin(staffId: string, actor: Actor, shopId: string | null) {
  await db.update(staff).set({ clockPinHash: null, clockPinFailures: 0, clockPinLockedUntil: null }).where(eq(staff.id, staffId));
  await audit(actor, "timeclock.pin_clear", "staff", staffId, {}, shopId);
}

/** A manager lifts a PIN lock early; the PIN stays as it is. */
export async function unlockPin(staffId: string, actor: Actor, shopId: string) {
  const [s] = await db.update(staff).set({ clockPinFailures: 0, clockPinLockedUntil: null }).where(eq(staff.id, staffId)).returning({ lockedUntil: staff.clockPinLockedUntil });
  if (!s) throw notFound("Staff member");
  await audit(actor, "timeclock.pin_unlock", "staff", staffId, {}, shopId);
}

/** Checks a PIN typed on a shop's device. Five wrong tries lock that person's PIN for five minutes. */
export async function checkPin(staffId: string, pin: string, now = new Date()): Promise<void> {
  const s = await db.query.staff.findFirst({ where: and(eq(staff.id, staffId), eq(staff.active, true)) });
  if (!s || s.kind !== "person") throw notFound("Staff member");
  if (!s.clockPinHash) throw bad(`${s.displayLabel} hasn't set a time clock PIN yet. They set one on their Time clock page.`);
  if (s.clockPinLockedUntil && s.clockPinLockedUntil > now) throw new AppError("conflict", `Too many wrong PINs. Try again after ${formatTime(s.clockPinLockedUntil)}, or ask a manager.`);
  if (await bcrypt.compare(pin, s.clockPinHash)) {
    if (s.clockPinFailures) await db.update(staff).set({ clockPinFailures: 0, clockPinLockedUntil: null }).where(eq(staff.id, staffId));
    return;
  }
  const failures = s.clockPinFailures + 1;
  const lock = failures >= PIN_MAX_FAILURES;
  await db
    .update(staff)
    .set({ clockPinFailures: lock ? 0 : failures, clockPinLockedUntil: lock ? new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000) : null })
    .where(eq(staff.id, staffId));
  if (lock) await audit(SYSTEM, "timeclock.pin_locked", "staff", staffId, { failures });
  throw bad(lock ? `Wrong PIN. That was ${PIN_MAX_FAILURES} wrong tries, so this PIN is locked for ${PIN_LOCK_MINUTES} minutes.` : "Wrong PIN.");
}

// ───────────────────────────── Punches and shifts ─────────────────────────────

type PunchRow = typeof timePunches.$inferSelect;
export const asLike = (p: Pick<PunchRow, "id" | "staffId" | "shopId" | "type" | "at">): PunchLike => ({ id: p.id, staffId: p.staffId, shopId: p.shopId, type: p.type, at: p.at });

export async function punchesBetween(staffIds: readonly string[] | null, from: Date, to: Date, tx: DBorTx = db, shopIds?: readonly string[]): Promise<PunchRow[]> {
  if (staffIds && !staffIds.length) return [];
  return tx
    .select()
    .from(timePunches)
    .where(
      and(
        staffIds ? inArray(timePunches.staffId, [...staffIds]) : undefined,
        shopIds ? inArray(timePunches.shopId, shopIds.length ? [...shopIds] : ["00000000-0000-0000-0000-000000000000"]) : undefined,
        gte(timePunches.at, from),
        lt(timePunches.at, to),
        isNull(timePunches.voidedAt),
      ),
    )
    .orderBy(asc(timePunches.at));
}

async function schedulesOf(staffIds: readonly string[], tx: DBorTx = db) {
  if (!staffIds.length) return new Map<string, ScheduleRow[]>();
  const rows = await tx.select().from(staffSchedules).where(inArray(staffSchedules.staffId, [...staffIds]));
  const out = new Map<string, ScheduleRow[]>();
  for (const r of rows) out.set(`${r.staffId}|${r.shopId}`, [...(out.get(`${r.staffId}|${r.shopId}`) ?? []), r]);
  return out;
}

const scheduleFor = (sched: Map<string, ScheduleRow[]>, staffId: string, shopId: string, date: LocalDate): Interval[] => scheduledOn(date, weekdayOf(date), sched.get(`${staffId}|${shopId}`) ?? []);

/**
 * Rewrites the clock time entries for someone's shifts near [from, to] from their punches: each
 * closed shift's paid segments (unpaid breaks taken out). Open shifts, and shifts over 24 hours,
 * have no hours until a manager fixes them.
 */
export async function rederive(staffId: string, from: Date, to: Date, tx: DBorTx = db, rules?: ClockRules) {
  const lo = new Date(from.getTime() - SHIFT_REACH);
  const hi = new Date(to.getTime() + SHIFT_REACH);
  const all = await tx
    .select({ id: timePunches.id, staffId: timePunches.staffId, shopId: timePunches.shopId, type: timePunches.type, at: timePunches.at, voidedAt: timePunches.voidedAt })
    .from(timePunches)
    .where(and(eq(timePunches.staffId, staffId), gte(timePunches.at, lo), lt(timePunches.at, hi)));
  if (all.length) await tx.delete(timeEntries).where(inArray(timeEntries.punchInId, all.map((p) => p.id)));
  const { shifts } = pairPunches(all.filter((p) => !p.voidedAt).map(asLike));
  const at = rules ? () => rules : await clockRulesAt([...new Set(all.map((p) => p.shopId))], tx);
  const rows = shifts
    .filter((s) => s.end && s.end.getTime() - s.start.getTime() <= DAY)
    .flatMap((s) =>
      shiftWork(s, at(s.shopId)).segments.map((seg) => ({ staffId, shopId: s.shopId, kind: "worked" as const, startsAt: seg.start, endsAt: seg.end, source: "clock" as const, punchInId: s.inId })),
    );
  if (rows.length) await tx.insert(timeEntries).values(rows);
}

/** A change to someone's time in a pay period clears that timesheet's approvals; they sign off again. */
async function clearApprovals(staffId: string, shopId: string, dates: LocalDate[], tx: DBorTx): Promise<number> {
  const cal = await brandCalendar(tx);
  const starts = [...new Set(dates.map((d) => payPeriodFor(d, cal).start))];
  const cleared = await tx
    .update(timesheets)
    .set({ employeeApprovedAt: null, managerApprovedAt: null, managerApprovedBy: null, managerNote: null, updatedAt: new Date() })
    .where(
      and(
        eq(timesheets.staffId, staffId),
        eq(timesheets.shopId, shopId),
        inArray(timesheets.periodStart, starts),
        or(isNotNull(timesheets.employeeApprovedAt), isNotNull(timesheets.managerApprovedAt)),
      ),
    )
    .returning({ id: timesheets.id });
  return cleared.length;
}

export interface ClockState {
  state: "off" | "working" | "on_break";
  shift: { shopId: string; shop: string; start: Date; breakStart: Date | null } | null;
  /** An old shift that was never clocked out; it no longer blocks a new clock-in. */
  stale: { shop: string; start: Date } | null;
  next: PunchType[];
}

export async function clockState(staffId: string, now = new Date()): Promise<ClockState> {
  const recent = await punchesBetween([staffId], new Date(now.getTime() - 3 * DAY), new Date(now.getTime() + 60_000));
  const { shifts } = pairPunches(recent.map(asLike));
  const open = [...shifts].reverse().find((s) => s.end === null) ?? null;
  const names = new Map((await db.select({ id: shops.id, name: shops.name }).from(shops)).map((s) => [s.id, s.name]));
  if (!open) return { state: "off", shift: null, stale: null, next: allowedNext("off") };
  if (now.getTime() - open.start.getTime() > STALE_OPEN_MS) return { state: "off", shift: null, stale: { shop: names.get(open.shopId) ?? "", start: open.start }, next: allowedNext("off") };
  const br = open.breaks.find((b) => b.end === null) ?? null;
  const state = br ? "on_break" : "working";
  return { state, shift: { shopId: open.shopId, shop: names.get(open.shopId) ?? "", start: open.start, breakStart: br?.start ?? null }, stale: null, next: allowedNext(state) };
}

/**
 * Paid time so far on shifts still on the clock at these shops, worked out as clock-out will write it
 * (unpaid breaks taken out) with now as the end. Stale shifts and ones flagged as forgotten
 * clock-outs aren't someone at work, so they're left out.
 */
export async function openShiftWork(shopIds: readonly string[], staffIds: readonly string[] | null, now = new Date()): Promise<TimeEntry[]> {
  if (!shopIds.length) return [];
  const punches = await punchesBetween(staffIds, new Date(now.getTime() - STALE_OPEN_MS), new Date(now.getTime() + 60_000), db, shopIds);
  const byId = new Map(punches.map((p) => [p.id, p]));
  const open = pairPunches(punches.map(asLike)).shifts.filter((s) => s.end === null && !byId.get(s.inId)?.forgotFlaggedAt && now.getTime() - s.start.getTime() <= STALE_OPEN_MS);
  if (!open.length) return [];
  const rules = await clockRulesAt([...new Set(open.map((s) => s.shopId))]);
  return open.flatMap((s) => shiftWork(s, rules(s.shopId), now).segments.map((seg) => ({ staffId: s.staffId, shopId: s.shopId, kind: "worked" as const, startsAt: seg.start, endsAt: seg.end })));
}

export interface PunchRequest {
  staffId: string;
  shopId: string;
  type: PunchType;
  source: Exclude<PunchSource, "manager">;
  evidence: PunchEvidence;
  /** P1: the front-desk QR code or NFC tag from the address the phone opened; checked here. */
  proof?: { qr?: string | null; tag?: string | null };
  deviceId: string | null;
  photo: string | null;
  /** Clock in anyway during time off, after the warning. */
  confirmTimeOff?: boolean;
  /** Break start only: the reason (a block reason; none is Break) and planned minutes, for the block it writes. */
  breakReasonId?: string | null;
  plannedMin?: number | null;
  actor: Actor;
  now?: Date;
  /** ST-I18: tapped with no signal and sent later; `now` is when it was tapped. Flagged for the manager. */
  offline?: { receivedAt: Date };
  /** The app's own id for the punch, so a retry never punches twice. */
  clientPunchId?: string | null;
}

/** The longest break length someone can plan at break start. */
export const MAX_PLANNED_BREAK_MIN = 240;

export type PunchResult = { kind: "confirm"; message: string } | { kind: "done"; punchId: string; type: PunchType; at: Date; shop: string; flags: PunchFlag[]; notes: string[] };

function photoProblem(photo: string | null): string | null {
  if (!photo) return null;
  if (photo.length > MAX_PHOTO_CHARS) return "That photo is too big. Try again.";
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return "That photo couldn't be read. Try again.";
  return null;
}

/**
 * One punch from someone's phone or the shop's front-desk device. Refused when it doesn't follow
 * from where they stand, the shop's verification rule isn't met, or the period is locked. Clocking in
 * during time off asks first. Late, early and off-schedule punches are flagged, never refused.
 */
export async function punch(req: PunchRequest): Promise<PunchResult> {
  // Kiosk and QR punches go in at the server's time (a UTC instant), never a device's: one queued
  // offline goes in when it arrives, and its QR code has to be good then.
  const serverTime = req.source === "kiosk" || !!req.proof?.qr;
  const offline = serverTime ? undefined : req.offline;
  const deviceAt = serverTime && req.offline ? req.now : undefined;
  const now = serverTime && req.offline ? req.offline.receivedAt : (req.now ?? new Date());
  const who = await db.query.staff.findFirst({ where: and(eq(staff.id, req.staffId), eq(staff.active, true)) });
  if (!who || who.kind !== "person") throw forbidden("Shop logins can't punch. Use the front-desk clock with your own PIN.");
  const access = await loadStaffAccess(req.staffId);
  const mine = new Set([...(await workShopIds(req.staffId)), ...(access?.shopIds ?? [])]);
  if (!mine.has(req.shopId)) throw forbidden("You aren't on that shop's team.");
  const [clock] = await shopClocks([req.shopId]);
  const [shopRow] = await db.select({ status: shops.status }).from(shops).where(eq(shops.id, req.shopId));
  if (!clock || shopRow?.status === "archived") throw notFound("Shop");

  const state = await clockState(req.staffId, now);
  if (!state.next.includes(req.type)) {
    const where = state.shift ? ` at ${state.shift.shop}` : "";
    throw bad(
      state.state === "off"
        ? "You're not clocked in."
        : state.state === "on_break"
          ? `You're on a break${where}. End the break or clock out.`
          : `You're already clocked in${where}.`,
    );
  }
  if (state.shift && state.shift.shopId !== req.shopId) throw bad(`You're clocked in at ${state.shift.shop}. Punch there.`);
  if (offline) {
    const [later] = await db
      .select({ id: timePunches.id })
      .from(timePunches)
      .where(and(eq(timePunches.staffId, req.staffId), gt(timePunches.at, now), isNull(timePunches.voidedAt)))
      .limit(1);
    if (later) throw new AppError("conflict", "A later punch is already on your timecard, so this one can't go in before it. Ask a manager to add it.", { offline: true });
  }

  let method: PunchMethod;
  let distanceM: number | null = null;
  if (req.source === "kiosk") {
    if (req.evidence.deviceShopId !== req.shopId) throw forbidden(`This isn't one of ${clock.name}'s registered time clock devices.`);
    method = "device";
  } else {
    const evidence: PunchEvidence = {
      ...req.evidence,
      qrShopId: qrValid(req.shopId, req.proof?.qr, now) ? req.shopId : null,
      nfcShopId: nfcValid(req.shopId, clock.settings.nfcTagVersion, req.proof?.tag) ? req.shopId : null,
    };
    const v = verifyPunch(req.shopId, clock, clock.settings, evidence);
    distanceM = v.distanceM;
    if (!v.ok) throw forbidden(v.problem);
    method = v.method;
  }
  const pp = photoProblem(req.photo);
  if (pp) throw bad(pp);
  if (clock.settings.photo === "required" && !req.photo) throw bad("This shop needs a photo with every punch. Take one and try again.");

  const date = localDateOf(now);
  if (await hoursLockedOn(req.shopId, date)) throw new AppError("conflict", "This pay period is locked, so no more punches can go into it. Ask a manager.");

  const flags: PunchFlag[] = offline ? ["offline"] : [];
  const notes: string[] = [];
  if (req.type === "in") {
    const off = await db
      .select({ reason: timeBlocks.reason, startsAt: timeBlocks.startsAt, endsAt: timeBlocks.endsAt })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.staffId, req.staffId),
          eq(timeBlocks.category, "time_off"),
          lte(timeBlocks.startsAt, now),
          gt(timeBlocks.endsAt, now),
          or(isNull(timeBlocks.shopId), eq(timeBlocks.shopId, req.shopId)),
        ),
      )
      .limit(1);
    if (off[0]) {
      if (!req.confirmTimeOff) return { kind: "confirm", message: `You have time off right now (${off[0].reason}, until ${formatTime(off[0].endsAt)}). Clock in anyway? Your manager will see it.` };
      flags.push("during_time_off");
    }
    if (state.stale) notes.push(`Your clock-in at ${state.stale.shop} on ${formatDate(state.stale.start)} was never closed. A manager will fix it.`);
  }
  const rules = await loadClockRules(req.shopId);
  let offScheduleMin: number | null = null;
  if (req.type === "in" || req.type === "out") {
    const sched = await schedulesOf([req.staffId]);
    const day = req.type === "out" && state.shift ? localDateOf(state.shift.start) : date;
    const o = offSchedule(req.type, now, scheduleFor(sched, req.staffId, req.shopId, day), clock.settings.graceMinutes ?? rules.graceMinutes);
    offScheduleMin = o.minutes;
    if (o.flag) flags.push(o.flag);
  }
  if (distanceM !== null && clock.settings.methods.length && method !== "gps" && distanceM > clock.settings.radiusM * 3) flags.push("off_site");

  let breakReasonId: string | null = null;
  let plannedMin: number | null = null;
  if (req.type === "break_start") {
    if (req.breakReasonId)
      breakReasonId = (
        await usableReason(req.breakReasonId, "blocks", undefined, req.shopId)
      ).id;
    if (req.plannedMin !== undefined && req.plannedMin !== null) {
      if (!Number.isInteger(req.plannedMin) || req.plannedMin < 5 || req.plannedMin > MAX_PLANNED_BREAK_MIN) throw bad(`Plan a break of 5 to ${MAX_PLANNED_BREAK_MIN} minutes, or leave the length open.`);
      plannedMin = req.plannedMin;
    }
  }

  const gps = req.evidence.gps;
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(timePunches)
      .values({
        staffId: req.staffId,
        shopId: req.shopId,
        type: req.type,
        at: now,
        originalAt: now,
        source: req.source,
        method,
        deviceId: req.deviceId,
        latitude: gps?.lat ?? null,
        longitude: gps?.lng ?? null,
        accuracyM: gps?.accuracyM ?? null,
        distanceM,
        ip: req.evidence.ip,
        hasPhoto: !!req.photo,
        flags,
        offScheduleMin,
        reasonId: breakReasonId,
        plannedMin,
        clientPunchId: req.clientPunchId ?? null,
        createdBy: req.actor.staffId ?? null,
      })
      .returning({ id: timePunches.id });
    if (req.photo) await tx.insert(timePunchPhotos).values({ punchId: row.id, dataUrl: req.photo });
    await rederive(req.staffId, now, now, tx, rules);
    const cleared = await clearApprovals(req.staffId, req.shopId, [date], tx);
    await audit(
      req.actor,
      "timeclock.punch",
      "time_punch",
      row.id,
      { staffId: req.staffId, type: req.type, source: req.source, method, flags, distanceM, photo: !!req.photo, approvalsCleared: cleared, ...(req.type === "break_start" ? { reasonId: breakReasonId, plannedMin } : {}), ...(offline ? { offline: true, receivedAt: offline.receivedAt.toISOString() } : {}), ...(deviceAt ? { deviceTimeIgnored: deviceAt.toISOString() } : {}) },
      req.shopId,
      tx,
    );
    await syncClockBlocks([req.staffId], { from: now, to: now }, { tx, now, actor: req.actor });
    if (req.type === "in" || req.type === "break_end") await releaseHeldStaffNotices(req.staffId, offline?.receivedAt ?? now, tx);
    return row.id;
  });
  // Clients booked over a break or after an early clock-out: the managers hear now, not at the next cron run.
  if (req.type === "break_start" || req.type === "out") {
    try {
      await sendClockFallout(offline?.receivedAt ?? now, { onlyStaffId: req.staffId, shopIds: [req.shopId] });
    } catch (e) {
      console.error("clock fallout after punch failed", e);
    }
  }
  return { kind: "done", punchId: result, type: req.type, at: now, shop: clock.name, flags, notes };
}

// ───────────────────────────── Manager corrections ─────────────────────────────

export interface Editor {
  actor: Actor;
  staffId: string;
  isOwner: boolean;
  shopIds: readonly string[];
}

const snapshot = (p: Pick<PunchRow, "type" | "at" | "shopId" | "voidedAt">) => ({ type: p.type, at: p.at.toISOString(), shopId: p.shopId, voided: !!p.voidedAt });

function cleanReason(reason: string) {
  const r = reason.trim();
  if (!r) throw bad("Say why the punch is being changed. It goes in the edit log.");
  if (r.length > 300) throw bad("Keep the reason under 300 characters.");
  return r;
}

function assertCanEdit(e: Editor, staffId: string, shopIds: string[]) {
  if (staffId === e.staffId && !e.isOwner) throw forbidden("You can't change your own punches. Ask another manager.");
  for (const s of shopIds) if (!e.shopIds.includes(s)) throw forbidden("That punch is at a shop outside your access.");
}

async function assertOpen(shopId: string, at: Date) {
  if (await hoursLockedOn(shopId, localDateOf(at))) throw new AppError("conflict", "That pay period is locked. Unlock it first to change its punches.");
}

function assertNotFuture(at: Date, now: Date) {
  if (Number.isNaN(at.getTime())) throw bad("Enter a date and time.");
  if (at.getTime() > now.getTime() + 5 * 60_000) throw bad("A punch can't be in the future.");
}

/** Moves a punch's time, type or shop. The before and after go in time_punch_edits and the audit log. */
export async function editPunch(e: Editor, punchId: string, change: { at?: Date; type?: PunchType; shopId?: string }, reason: string, now = new Date()) {
  const why = cleanReason(reason);
  const [p] = await db.select().from(timePunches).where(eq(timePunches.id, punchId));
  if (!p || p.voidedAt) throw notFound("Punch");
  const next = { type: change.type ?? p.type, at: change.at ?? p.at, shopId: change.shopId ?? p.shopId };
  assertCanEdit(e, p.staffId, [p.shopId, next.shopId]);
  assertNotFuture(next.at, now);
  await assertOpen(p.shopId, p.at);
  await assertOpen(next.shopId, next.at);
  const before = snapshot(p);
  const after = snapshot({ ...next, voidedAt: null });
  if (JSON.stringify(before) === JSON.stringify(after)) throw bad("Nothing changed.");
  return db.transaction(async (tx) => {
    await tx.update(timePunches).set({ type: next.type, at: next.at, shopId: next.shopId, editedAt: now }).where(eq(timePunches.id, punchId));
    await tx.insert(timePunchEdits).values({ punchId, action: "edit", before, after, reason: why, editedBy: e.staffId });
    const lo = p.at < next.at ? p.at : next.at;
    const hi = p.at > next.at ? p.at : next.at;
    await rederive(p.staffId, lo, hi, tx);
    const cleared = (await clearApprovals(p.staffId, p.shopId, [localDateOf(p.at)], tx)) + (await clearApprovals(p.staffId, next.shopId, [localDateOf(next.at)], tx));
    await audit(e.actor, "timeclock.punch_edit", "time_punch", punchId, { staffId: p.staffId, before, after, reason: why, approvalsCleared: cleared }, next.shopId, tx);
    await syncClockBlocks([p.staffId], { from: lo, to: hi }, { tx, now, actor: e.actor });
    return punchId;
  });
}

/** A punch someone missed, added by a manager. */
export async function addPunch(e: Editor, v: { staffId: string; shopId: string; type: PunchType; at: Date }, reason: string, now = new Date()) {
  const why = cleanReason(reason);
  assertCanEdit(e, v.staffId, [v.shopId]);
  assertNotFuture(v.at, now);
  await assertOpen(v.shopId, v.at);
  const who = await db.query.staff.findFirst({ where: eq(staff.id, v.staffId) });
  if (!who || who.kind !== "person") throw notFound("Staff member");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(timePunches)
      .values({ staffId: v.staffId, shopId: v.shopId, type: v.type, at: v.at, originalAt: v.at, source: "manager", method: "manager", flags: ["manual"], createdBy: e.staffId, note: why })
      .returning({ id: timePunches.id });
    const after = snapshot({ ...v, voidedAt: null });
    await tx.insert(timePunchEdits).values({ punchId: row.id, action: "add", before: null, after, reason: why, editedBy: e.staffId });
    await rederive(v.staffId, v.at, v.at, tx);
    const cleared = await clearApprovals(v.staffId, v.shopId, [localDateOf(v.at)], tx);
    await audit(e.actor, "timeclock.punch_add", "time_punch", row.id, { staffId: v.staffId, before: null, after, reason: why, approvalsCleared: cleared }, v.shopId, tx);
    await syncClockBlocks([v.staffId], { from: v.at, to: v.at }, { tx, now, actor: e.actor });
    return row.id;
  });
}

/** Takes a punch out of the timesheet. It stays on record, marked void. */
export async function voidPunch(e: Editor, punchId: string, reason: string, now = new Date()) {
  const why = cleanReason(reason);
  const [p] = await db.select().from(timePunches).where(eq(timePunches.id, punchId));
  if (!p || p.voidedAt) throw notFound("Punch");
  assertCanEdit(e, p.staffId, [p.shopId]);
  await assertOpen(p.shopId, p.at);
  const before = snapshot(p);
  const after = { ...before, voided: true };
  await db.transaction(async (tx) => {
    await tx.update(timePunches).set({ voidedAt: now, editedAt: now }).where(eq(timePunches.id, punchId));
    await tx.insert(timePunchEdits).values({ punchId, action: "void", before, after, reason: why, editedBy: e.staffId });
    await rederive(p.staffId, p.at, p.at, tx);
    const cleared = await clearApprovals(p.staffId, p.shopId, [localDateOf(p.at)], tx);
    await audit(e.actor, "timeclock.punch_void", "time_punch", punchId, { staffId: p.staffId, before, after, reason: why, approvalsCleared: cleared }, p.shopId, tx);
    await syncClockBlocks([p.staffId], { from: p.at, to: p.at }, { tx, now, actor: e.actor });
  });
}

export async function punchPhoto(punchId: string, shopIds: readonly string[]) {
  const [r] = await db
    .select({ dataUrl: timePunchPhotos.dataUrl, shopId: timePunches.shopId })
    .from(timePunchPhotos)
    .innerJoin(timePunches, eq(timePunches.id, timePunchPhotos.punchId))
    .where(eq(timePunchPhotos.punchId, punchId));
  if (!r || !shopIds.includes(r.shopId)) return null;
  return r.dataUrl;
}

// ───────────────────────────── Hours ─────────────────────────────

/** A timesheet period: a pay period on the brand's calendar (Payroll setup). */
export const periodFor = async (date: LocalDate, tx: DBorTx = db): Promise<PayPeriod> => payPeriodFor(date, await brandCalendar(tx));

/** The pay period holding `today` and the ones before it. */
export async function recentPeriods(today: LocalDate, count = 8): Promise<PayPeriod[]> {
  const cal = await brandCalendar();
  const cur = payPeriodFor(today, cal);
  return Array.from({ length: count }, (_, i) => payPeriodByIndex(cur.index - i, cal));
}

/** The period a link asks for (?period=<start>), or the current one when it names none. */
export async function chosenPeriod(requested: string | undefined, today: LocalDate): Promise<PayPeriod> {
  const cal = await brandCalendar();
  return payPeriodFor(requested && isValidLocalDate(requested) ? requested : today, cal);
}

/**
 * Overtime slices for everyone's time entries over whole workweeks around [from, to], across every
 * shop (OT adds up across shops of one legal entity), with locked payroll OT kept.
 */
export async function hoursSlices(from: LocalDate, to: LocalDate, staffIds: readonly string[] | null, settings?: PayrollSettings): Promise<{ slices: Slice[]; entries: TimeEntry[]; settings: PayrollSettings }> {
  const s = settings ?? (await loadSettings());
  const groups = await ensurePayGroups();
  const groupOf = new Map(groups.map((g) => [g.shopId, g]));
  const wFrom = weekStartOf(from);
  const wTo = addDays(weekStartOf(to), 6);
  const entries: TimeEntry[] =
    staffIds && !staffIds.length
      ? []
      : await db
          .select({ staffId: timeEntries.staffId, shopId: timeEntries.shopId, kind: timeEntries.kind, startsAt: timeEntries.startsAt, endsAt: timeEntries.endsAt })
          .from(timeEntries)
          .where(and(staffIds ? inArray(timeEntries.staffId, [...staffIds]) : undefined, lt(timeEntries.startsAt, endOfLocalDay(wTo)), gt(timeEntries.endsAt, startOfLocalDay(wFrom))));
  const weeks: string[] = [];
  for (let w = wFrom; w <= wTo; w = addDays(w, 7)) weeks.push(w);
  const lockedRows = await db
    .select({ staffId: payrollLockedOt.staffId, shopId: payrollLockedOt.shopId, periodStart: payrollLockedOt.periodStart, weekStart: payrollLockedOt.weekStart, ot: payrollLockedOt.otCenti })
    .from(payrollLockedOt)
    .where(inArray(payrollLockedOt.weekStart, weeks));
  const days = dailyHours(entries).filter((d) => d.date >= wFrom && d.date <= wTo);
  const slices = overtimeSlices(days, {
    thresholdCenti: Math.round(s.otThresholdHours * 100),
    trainingCountsTowardOt: s.trainingCountsTowardOt,
    dailyThresholdCenti: s.dailyOtHours ? Math.round(s.dailyOtHours * 100) : null,
    entityOf: (shopId) => groupOf.get(shopId)?.legalEntity ?? "",
    periodOf: (shopId, date) => periodOf(groupOf.get(shopId)?.calendar ?? DEFAULT_CALENDAR, date).start,
    locked: new Map(lockedRows.map((l) => [sliceKey(l), l.ot])),
  });
  return { slices, entries, settings: s };
}

export interface ShiftView {
  inId: string;
  outId: string | null;
  shopId: string;
  date: LocalDate;
  start: string;
  end: string | null;
  workedMin: number;
  breakMin: number;
  unpaidBreakMin: number;
  scheduledMin: number;
  breaks: { startId: string; endId: string | null; start: string; end: string | null; paid: boolean }[];
  flags: PunchFlag[];
  methods: string[];
  photos: string[];
  edited: boolean;
}

export interface TimesheetShop {
  shopId: string;
  shop: string;
  days: { date: LocalDate; scheduledMin: number; workedMin: number; otherMin: number; shifts: ShiftView[] }[];
  weeks: { weekStart: LocalDate; workedCenti: number; otCenti: number; scheduledMin: number }[];
  totals: { workedCenti: number; otCenti: number; regularCenti: number; ptoCenti: number; trainingCenti: number; breakMin: number; unpaidBreakMin: number; scheduledMin: number };
  problems: { kind: string; label: string; at: string; punchId: string }[];
  approval: { employeeAt: string | null; managerAt: string | null; managerBy: string | null; note: string | null };
  locked: { at: string } | null;
  payrollLocked: boolean;
}

export interface TimesheetView {
  staffId: string;
  label: string;
  period: { start: LocalDate; end: LocalDate };
  shops: TimesheetShop[];
  /** The punches behind this period's hours: those of shifts that overlap it (an overnight shift's hours split at midnight), unpaired ones dated in it, and voided ones. */
  punchIds: string[];
  edits: { at: string; by: string | null; action: string; reason: string; before: unknown; after: unknown }[];
}

/** Shifts with their paid time, breaks and the flags on their punches. */
function shiftViews(shifts: Shift[], punches: Map<string, PunchRow>, rulesAt: (shopId: string) => ClockRules, sched: Map<string, ScheduleRow[]>): ShiftView[] {
  return shifts.map((s) => {
    const rules = rulesAt(s.shopId);
    const w = s.end ? shiftWork(s, rules) : null;
    const date = localDateOf(s.start);
    const ins = punches.get(s.inId);
    const outs = s.outId ? punches.get(s.outId) : undefined;
    const all = [ins, outs, ...s.breaks.flatMap((b) => [punches.get(b.startId), b.endId ? punches.get(b.endId) : undefined])].filter((x): x is PunchRow => !!x);
    const scheduled = scheduleFor(sched, s.staffId, s.shopId, date);
    return {
      inId: s.inId,
      outId: s.outId,
      shopId: s.shopId,
      date,
      start: s.start.toISOString(),
      end: s.end?.toISOString() ?? null,
      workedMin: Math.round(w?.workedMin ?? 0),
      breakMin: Math.round(w?.breakMin ?? 0),
      unpaidBreakMin: Math.round(w?.unpaidBreakMin ?? 0),
      scheduledMin: Math.round(scheduled.reduce((a, i) => a + (i.end.getTime() - i.start.getTime()) / 60_000, 0)),
      breaks: s.breaks.map((b) => {
        const m = ((b.end ?? s.end ?? b.start).getTime() - b.start.getTime()) / 60_000;
        return { startId: b.startId, endId: b.endId, start: b.start.toISOString(), end: b.end?.toISOString() ?? null, paid: !(rules.unpaidBreakFromMinutes === 0 || m >= rules.unpaidBreakFromMinutes) };
      }),
      flags: [...new Set(all.flatMap((p) => p.flags as PunchFlag[]))].filter((f) => f in FLAG_LABEL),
      methods: [...new Set(all.map((p) => p.method))],
      photos: all.filter((p) => p.hasPhoto).map((p) => p.id),
      edited: all.some((p) => !!p.editedAt || p.source === "manager"),
    };
  });
}

/** One person's timesheet for a period, per shop: day by day, week by week with overtime, and its approvals. */
export async function timesheetView(staffId: string, periodStart: LocalDate, shopIds: readonly string[] | null): Promise<TimesheetView> {
  const period = await periodFor(periodStart);
  const who = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!who) throw notFound("Staff member");
  const [punches, { slices, entries }, sched, sheets, locks, names] = await Promise.all([
    punchesBetween([staffId], new Date(period.startsAt.getTime() - DAY), new Date(period.endsAt.getTime() + DAY)),
    hoursSlices(period.start, period.end, [staffId]),
    schedulesOf([staffId]),
    db.select().from(timesheets).where(and(eq(timesheets.staffId, staffId), eq(timesheets.periodStart, period.start))),
    db.select().from(timesheetLocks).where(eq(timesheetLocks.periodStart, period.start)),
    db.select({ id: shops.id, name: shops.name }).from(shops),
  ]);
  const name = new Map(names.map((s) => [s.id, s.name]));
  const byId = new Map(punches.map((p) => [p.id, p]));
  const { shifts, problems } = pairPunches(punches.map(asLike));
  const working = onTheClock(shifts, byId, new Date());
  const inPeriod = (d: LocalDate) => d >= period.start && d <= period.end;
  const periodShifts = shifts.filter((s) => inPeriod(localDateOf(s.start)));
  const views = shiftViews(periodShifts, byId, await clockRulesAt([...new Set(periodShifts.map((x) => x.shopId))]), sched);
  const overlapping = shifts.filter((s) => inPeriod(localDateOf(s.start)) || (s.end && inPeriod(localDateOf(new Date(s.end.getTime() - 1)))));
  const owned = new Set<string>([
    ...overlapping.flatMap((s) => [s.inId, s.outId, ...s.breaks.flatMap((b) => [b.startId, b.endId])].filter((x): x is string => !!x)),
    ...problems.filter((p) => inPeriod(localDateOf(p.at))).map((p) => p.punchId),
  ]);
  const mySlices = slices.filter((s) => s.staffId === staffId);
  const dayMinutes = new Map<string, { worked: number; other: number }>();
  for (const e of entries) {
    for (const part of splitByLocalDay(e)) {
      if (!inPeriod(part.date)) continue;
      const k = `${e.shopId}|${part.date}`;
      const v = dayMinutes.get(k) ?? { worked: 0, other: 0 };
      if (e.kind === "worked") v.worked += part.minutes;
      else v.other += part.minutes;
      dayMinutes.set(k, v);
    }
  }
  const shopSet = new Set<string>([...views.map((v) => v.shopId), ...[...dayMinutes.keys()].map((k) => k.split("|")[0]), ...sheets.map((s) => s.shopId)]);
  for (const [k] of sched) if (k.startsWith(`${staffId}|`)) shopSet.add(k.split("|")[1]);
  const visible = [...shopSet].filter((s) => !shopIds || shopIds.includes(s));
  const managers = new Map(
    (await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, sheets.map((s) => s.managerApprovedBy).filter((x): x is string => !!x).concat(["00000000-0000-0000-0000-000000000000"])))).map((s) => [s.id, s.label]),
  );
  const groups = await ensurePayGroups();
  const out: TimesheetShop[] = [];
  for (const shopId of visible.sort((a, b) => (name.get(a) ?? "").localeCompare(name.get(b) ?? ""))) {
    const days: TimesheetShop["days"] = [];
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
      const dm = dayMinutes.get(`${shopId}|${d}`) ?? { worked: 0, other: 0 };
      const sh = views.filter((v) => v.shopId === shopId && v.date === d);
      const scheduledMin = Math.round(scheduleFor(sched, staffId, shopId, d).reduce((a, i) => a + (i.end.getTime() - i.start.getTime()) / 60_000, 0));
      days.push({ date: d, scheduledMin, workedMin: Math.round(dm.worked), otherMin: Math.round(dm.other), shifts: sh });
    }
    const here = mySlices.filter((s) => s.shopId === shopId && s.periodStart === period.start);
    const weeks = [...new Set(here.map((s) => s.weekStart))].sort().map((w) => {
      const ws = here.filter((s) => s.weekStart === w);
      return {
        weekStart: w,
        workedCenti: ws.reduce((a, s) => a + s.worked, 0),
        otCenti: ws.reduce((a, s) => a + s.ot, 0),
        scheduledMin: days.filter((d) => d.date >= w && d.date <= addDays(w, 6)).reduce((a, d) => a + d.scheduledMin, 0),
      };
    });
    const shopShifts = views.filter((v) => v.shopId === shopId);
    const worked = here.reduce((a, s) => a + s.worked, 0);
    const ot = here.reduce((a, s) => a + s.ot, 0);
    const sheet = sheets.find((s) => s.shopId === shopId);
    const lock = locks.find((l) => l.shopId === shopId);
    const pg = groups.find((g) => g.shopId === shopId);
    out.push({
      shopId,
      shop: name.get(shopId) ?? "",
      days,
      weeks,
      totals: {
        workedCenti: worked,
        otCenti: ot,
        regularCenti: worked - ot,
        ptoCenti: here.reduce((a, s) => a + s.pto, 0),
        trainingCenti: here.reduce((a, s) => a + s.training, 0),
        breakMin: shopShifts.reduce((a, s) => a + s.breakMin, 0),
        unpaidBreakMin: shopShifts.reduce((a, s) => a + s.unpaidBreakMin, 0),
        scheduledMin: days.reduce((a, d) => a + d.scheduledMin, 0),
      },
      problems: problemsIn(problems.filter((p) => !working(p)), shopId, inPeriod),
      approval: {
        employeeAt: sheet?.employeeApprovedAt?.toISOString() ?? null,
        managerAt: sheet?.managerApprovedAt?.toISOString() ?? null,
        managerBy: sheet?.managerApprovedBy ? (managers.get(sheet.managerApprovedBy) ?? null) : null,
        note: sheet?.managerNote ?? null,
      },
      locked: lock ? { at: lock.lockedAt.toISOString() } : null,
      payrollLocked: pg ? await hoursLockedOnPayroll(shopId, period.start) : false,
    });
  }
  const voided = await db.select({ id: timePunches.id }).from(timePunches).where(and(eq(timePunches.staffId, staffId), isNotNull(timePunches.voidedAt), gte(timePunches.at, period.startsAt), lt(timePunches.at, period.endsAt)));
  const allIds = [...owned, ...voided.map((v) => v.id)];
  const edits = allIds.length
    ? await db
        .select({ at: timePunchEdits.createdAt, by: staff.displayLabel, action: timePunchEdits.action, reason: timePunchEdits.reason, before: timePunchEdits.before, after: timePunchEdits.after })
        .from(timePunchEdits)
        .leftJoin(staff, eq(staff.id, timePunchEdits.editedBy))
        .where(inArray(timePunchEdits.punchId, allIds))
        .orderBy(asc(timePunchEdits.createdAt))
    : [];
  return {
    staffId,
    label: who.displayLabel,
    period: { start: period.start, end: period.end },
    shops: out,
    punchIds: allIds,
    edits: edits.map((e) => ({ ...e, at: e.at.toISOString() })),
  };
}

const hoursLockedOnPayroll = (shopId: string, date: LocalDate) => isLockedOn(shopId, date);

/** Every shift that starts in [from, to] at these shops, with its breaks, flags and whether a manager changed it. */
export async function shiftsBetween(shopIds: readonly string[], from: LocalDate, to: LocalDate, staffIds: readonly string[] | null): Promise<(ShiftView & { staffId: string })[]> {
  if (!shopIds.length) return [];
  const punches = await punchesBetween(staffIds, new Date(startOfLocalDay(from).getTime() - DAY), new Date(endOfLocalDay(to).getTime() + DAY), db, shopIds);
  const byId = new Map(punches.map((p) => [p.id, p]));
  const shifts = pairPunches(punches.map(asLike)).shifts.filter((s) => {
    const d = localDateOf(s.start);
    return d >= from && d <= to;
  });
  const views = shiftViews(shifts, byId, await clockRulesAt([...new Set(shifts.map((s) => s.shopId))]), await schedulesOf([...new Set(shifts.map((s) => s.staffId))]));
  return views.map((v, i) => ({ ...v, staffId: shifts[i].staffId }));
}

export interface PunchEditRow {
  at: Date;
  staffId: string;
  shopId: string;
  punchType: PunchType;
  punchAt: Date;
  action: "edit" | "add" | "void";
  reason: string;
  before: unknown;
  after: unknown;
  by: string | null;
}

/** Manager changes to punches at these shops dated in [from, to], oldest first. */
export async function punchEditsBetween(shopIds: readonly string[], from: LocalDate, to: LocalDate, staffIds: readonly string[] | null): Promise<PunchEditRow[]> {
  if (!shopIds.length || (staffIds && !staffIds.length)) return [];
  return db
    .select({
      at: timePunchEdits.createdAt,
      staffId: timePunches.staffId,
      shopId: timePunches.shopId,
      punchType: timePunches.type,
      punchAt: timePunches.at,
      action: timePunchEdits.action,
      reason: timePunchEdits.reason,
      before: timePunchEdits.before,
      after: timePunchEdits.after,
      by: staff.displayLabel,
    })
    .from(timePunchEdits)
    .innerJoin(timePunches, eq(timePunches.id, timePunchEdits.punchId))
    .leftJoin(staff, eq(staff.id, timePunchEdits.editedBy))
    .where(
      and(
        inArray(timePunches.shopId, [...shopIds]),
        staffIds ? inArray(timePunches.staffId, [...staffIds]) : undefined,
        gte(timePunches.at, startOfLocalDay(from)),
        lt(timePunches.at, endOfLocalDay(to)),
      ),
    )
    .orderBy(asc(timePunchEdits.createdAt));
}

/** Minutes each person is scheduled from `after` to the end of `through`, at any shop: what's left of their week. */
export async function scheduledMinutesLeft(staffIds: readonly string[], after: Date, through: LocalDate): Promise<Map<string, number>> {
  const sched = await schedulesOf(staffIds);
  const out = new Map<string, number>();
  for (const [k] of sched) {
    const [staffId, shopId] = k.split("|");
    let min = 0;
    for (let d = localDateOf(after); d <= through; d = addDays(d, 1))
      for (const i of scheduleFor(sched, staffId, shopId, d)) min += Math.max(0, (i.end.getTime() - Math.max(i.start.getTime(), after.getTime())) / 60_000);
    out.set(staffId, (out.get(staffId) ?? 0) + Math.round(min));
  }
  return out;
}

const problemsIn = (problems: PairProblem[], shopId: string, inPeriod: (d: LocalDate) => boolean) =>
  problems
    .filter((p) => p.shopId === shopId && inPeriod(localDateOf(p.at)))
    .map((p) => ({ kind: p.kind, label: PROBLEM_LABEL[p.kind], at: p.at.toISOString(), punchId: p.punchId }));

export interface TimesheetRow {
  staffId: string;
  label: string;
  shopId: string;
  shop: string;
  scheduledMin: number;
  workedCenti: number;
  otCenti: number;
  breakMin: number;
  problems: number;
  flags: number;
  employeeApprovedAt: string | null;
  managerApprovedAt: string | null;
}

/** Everyone with time, punches or a schedule at these shops in a period, one row per person and shop. */
export async function timesheetList(periodStart: LocalDate, shopIds: readonly string[], staffIds: readonly string[] | null = null): Promise<{ rows: TimesheetRow[]; locks: Record<string, string> }> {
  const period = await periodFor(periodStart);
  if (!shopIds.length) return { rows: [], locks: {} };
  const rules = await clockRulesAt(shopIds);
  const people = await db
    .select({ id: staff.id, label: staff.displayLabel, active: staff.active })
    .from(staff)
    .where(and(eq(staff.kind, "person"), staffIds ? inArray(staff.id, staffIds.length ? [...staffIds] : ["00000000-0000-0000-0000-000000000000"]) : undefined));
  const ids = people.map((p) => p.id);
  const [punches, { slices }, sched, sheets, locks, names] = await Promise.all([
    punchesBetween(ids, new Date(period.startsAt.getTime() - DAY), new Date(period.endsAt.getTime() + DAY)),
    hoursSlices(period.start, period.end, ids),
    schedulesOf(ids),
    db.select().from(timesheets).where(and(eq(timesheets.periodStart, period.start), inArray(timesheets.shopId, [...shopIds]))),
    db.select().from(timesheetLocks).where(and(eq(timesheetLocks.periodStart, period.start), inArray(timesheetLocks.shopId, [...shopIds]))),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, [...shopIds])),
  ]);
  const shopName = new Map(names.map((s) => [s.id, s.name]));
  const byId = new Map(punches.map((p) => [p.id, p]));
  const { shifts, problems } = pairPunches(punches.map(asLike));
  const inPeriod = (d: LocalDate) => d >= period.start && d <= period.end;
  const views = shiftViews(shifts.filter((s) => inPeriod(localDateOf(s.start)) && shopIds.includes(s.shopId)), byId, rules, sched);
  const keys = new Set<string>();
  for (const s of slices) if (s.periodStart === period.start && shopIds.includes(s.shopId) && (s.worked || s.pto || s.training)) keys.add(`${s.staffId}|${s.shopId}`);
  for (const v of views) keys.add(`${punches.find((p) => p.id === v.inId)!.staffId}|${v.shopId}`);
  for (const [k, rows] of sched) {
    const [sid, shopId] = k.split("|");
    if (shopIds.includes(shopId) && rows.length && people.find((p) => p.id === sid)?.active) keys.add(k);
  }
  const label = new Map(people.map((p) => [p.id, p.label]));
  const rows: TimesheetRow[] = [...keys].map((k) => {
    const [sid, shopId] = k.split("|");
    const here = slices.filter((s) => s.staffId === sid && s.shopId === shopId && s.periodStart === period.start);
    const mine = views.filter((v) => v.shopId === shopId && byId.get(v.inId)?.staffId === sid);
    let scheduledMin = 0;
    for (let d = period.start; d <= period.end; d = addDays(d, 1)) scheduledMin += scheduleFor(sched, sid, shopId, d).reduce((a, i) => a + (i.end.getTime() - i.start.getTime()) / 60_000, 0);
    const sheet = sheets.find((s) => s.staffId === sid && s.shopId === shopId);
    return {
      staffId: sid,
      label: label.get(sid) ?? "",
      shopId,
      shop: shopName.get(shopId) ?? "",
      scheduledMin: Math.round(scheduledMin),
      workedCenti: here.reduce((a, s) => a + s.worked, 0),
      otCenti: here.reduce((a, s) => a + s.ot, 0),
      breakMin: mine.reduce((a, s) => a + s.breakMin, 0),
      problems: problems.filter((p) => p.staffId === sid && p.shopId === shopId && inPeriod(localDateOf(p.at))).length,
      flags: mine.reduce((a, s) => a + s.flags.length, 0),
      employeeApprovedAt: sheet?.employeeApprovedAt?.toISOString() ?? null,
      managerApprovedAt: sheet?.managerApprovedAt?.toISOString() ?? null,
    };
  });
  rows.sort((a, b) => a.shop.localeCompare(b.shop) || a.label.localeCompare(b.label));
  return { rows, locks: Object.fromEntries(locks.map((l) => [l.shopId, l.lockedAt.toISOString()])) };
}

// ───────────────────────────── Approvals and locks ─────────────────────────────

/** Missed punches: a timesheet with one can't be approved until a manager adds or fixes the punch. */
const MISSED_PUNCH: readonly PairProblem["kind"][] = ["open_shift", "out_without_in", "double_in"];

async function openProblems(staffId: string, shopId: string, period: PayPeriod) {
  const punches = await punchesBetween([staffId], new Date(period.startsAt.getTime() - DAY), new Date(period.endsAt.getTime() + DAY));
  const { problems } = pairPunches(punches.map(asLike));
  return problems.filter((p) => p.shopId === shopId && localDateOf(p.at) >= period.start && localDateOf(p.at) <= period.end && MISSED_PUNCH.includes(p.kind));
}

/** The employee signs off their own hours at one shop for the period. */
export async function approveOwn(staffId: string, shopId: string, periodStart: LocalDate, actor: Actor, now = new Date()) {
  const period = await periodFor(periodStart);
  if (await hoursLockedOn(shopId, period.start)) throw new AppError("conflict", "This period is already locked.");
  if (localDateOf(now) < period.start) throw bad("This period hasn't started yet.");
  const p = await openProblems(staffId, shopId, period);
  if (p.length) throw bad(`Fix the missed punches first: ${PROBLEM_LABEL[p[0].kind].toLowerCase()} on ${formatDate(localDateOf(p[0].at))}. Ask a manager to add the punch.`);
  await db
    .insert(timesheets)
    .values({ staffId, shopId, periodStart: period.start, periodEnd: period.end, employeeApprovedAt: now })
    .onConflictDoUpdate({ target: [timesheets.staffId, timesheets.shopId, timesheets.periodStart], set: { employeeApprovedAt: now, updatedAt: now } });
  await audit(actor, "timesheet.employee_approve", "staff", staffId, { periodStart: period.start }, shopId);
}

/** A manager approves after the employee. Without the employee's sign-off they have to say why. */
export async function approveAsManager(e: Editor, staffId: string, shopId: string, periodStart: LocalDate, note: string | null, now = new Date()) {
  const period = await periodFor(periodStart);
  if (staffId === e.staffId) throw forbidden("You can't approve your own timesheet. Another manager approves it.");
  if (!e.shopIds.includes(shopId)) throw forbidden("That shop is outside your access.");
  if (await hoursLockedOn(shopId, period.start)) throw new AppError("conflict", "This period is already locked.");
  const p = await openProblems(staffId, shopId, period);
  if (p.length) throw bad(`Fix the missed punches first: ${PROBLEM_LABEL[p[0].kind].toLowerCase()} on ${formatDate(localDateOf(p[0].at))}.`);
  const [sheet] = await db.select().from(timesheets).where(and(eq(timesheets.staffId, staffId), eq(timesheets.shopId, shopId), eq(timesheets.periodStart, period.start)));
  const why = note?.trim() || null;
  if (!sheet?.employeeApprovedAt && !why) throw bad("They haven't signed off yet. Say why you're approving without them.");
  await db
    .insert(timesheets)
    .values({ staffId, shopId, periodStart: period.start, periodEnd: period.end, managerApprovedAt: now, managerApprovedBy: e.staffId, managerNote: sheet?.employeeApprovedAt ? null : why })
    .onConflictDoUpdate({
      target: [timesheets.staffId, timesheets.shopId, timesheets.periodStart],
      set: { managerApprovedAt: now, managerApprovedBy: e.staffId, managerNote: sheet?.employeeApprovedAt ? null : why, updatedAt: now },
    });
  await audit(e.actor, "timesheet.manager_approve", "staff", staffId, { periodStart: period.start, withoutEmployee: !sheet?.employeeApprovedAt, note: sheet?.employeeApprovedAt ? null : why }, shopId);
}

/** Closes a shop's period once every timesheet with time in it is approved by a manager. */
export async function lockPeriod(e: Editor, shopId: string, periodStart: LocalDate, now = new Date()) {
  const period = await periodFor(periodStart);
  if (!e.shopIds.includes(shopId)) throw forbidden("That shop is outside your access.");
  if (localDateOf(now) <= period.end) throw bad(`The period runs through ${formatDate(period.end)}. Lock it after it ends.`);
  const { rows } = await timesheetList(period.start, [shopId]);
  const waiting = rows.filter((r) => (r.workedCenti > 0 || r.problems > 0) && !r.managerApprovedAt);
  if (waiting.length)
    throw bad(
      `${waiting.length} timesheet${waiting.length === 1 ? " still needs" : "s still need"} a manager's approval: ${waiting
        .slice(0, 4)
        .map((r) => r.label)
        .join(", ")}${waiting.length > 4 ? "…" : ""}.`,
    );
  const [row] = await db.insert(timesheetLocks).values({ shopId, periodStart: period.start, periodEnd: period.end, lockedBy: e.staffId }).onConflictDoNothing().returning({ s: timesheetLocks.periodStart });
  if (!row) throw new AppError("conflict", "This period is already locked.");
  await audit(e.actor, "timesheet.lock", "shop", shopId, { periodStart: period.start, periodEnd: period.end, timesheets: rows.length }, shopId);
}

export async function unlockPeriod(e: Editor, shopId: string, periodStart: LocalDate, reason: string) {
  const why = cleanReason(reason);
  const period = await periodFor(periodStart);
  if (!e.shopIds.includes(shopId)) throw forbidden("That shop is outside your access.");
  if (await hoursLockedOnPayroll(shopId, period.start)) throw new AppError("conflict", "Payroll for this period is approved and locked, so its hours can't reopen.");
  const gone = await db.delete(timesheetLocks).where(and(eq(timesheetLocks.shopId, shopId), eq(timesheetLocks.periodStart, period.start))).returning({ s: timesheetLocks.periodStart });
  if (!gone.length) throw bad("This period isn't locked.");
  await audit(e.actor, "timesheet.unlock", "shop", shopId, { periodStart: period.start, reason: why }, shopId);
}

export interface PayrollHoursCheck {
  /** Each shop's timesheet periods (the brand calendar) overlapping the pay period that aren't locked yet. */
  unlocked: { shopId: string; periods: { start: LocalDate; end: LocalDate }[] }[];
  /** Timesheets in those periods, with hours or missed punches, that no manager has approved. */
  waiting: { staffId: string; label: string; shopId: string; periodStart: LocalDate; periodEnd: LocalDate }[];
  /** Missed punches in the pay period itself. */
  missedPunches: { staffId: string; label: string; shopId: string; kind: PairProblem["kind"]; problem: string; at: Date }[];
}

/** Whether the clock's hours at these shops are final for a pay period: locked timesheets, approvals still to give, and missed punches. */
export async function payrollHoursCheck(shopIds: readonly string[], start: LocalDate, end: LocalDate): Promise<PayrollHoursCheck> {
  const out: PayrollHoursCheck = { unlocked: [], waiting: [], missedPunches: [] };
  if (!shopIds.length) return out;
  const periods: PayPeriod[] = [];
  for (let d = start; d <= end; ) {
    const p = await periodFor(d);
    periods.push(p);
    d = addDays(p.end, 1);
  }
  const locks = await db
    .select({ shopId: timesheetLocks.shopId, periodStart: timesheetLocks.periodStart })
    .from(timesheetLocks)
    .where(and(inArray(timesheetLocks.shopId, [...shopIds]), inArray(timesheetLocks.periodStart, periods.map((p) => p.start))));
  const lockedFor = (shopId: string, p: PayPeriod) => locks.some((l) => l.shopId === shopId && l.periodStart === p.start);
  for (const shopId of shopIds) {
    const open = periods.filter((p) => !lockedFor(shopId, p));
    if (open.length) out.unlocked.push({ shopId, periods: open.map((p) => ({ start: p.start, end: p.end })) });
  }
  for (const p of periods) {
    const open = shopIds.filter((s) => !lockedFor(s, p));
    if (!open.length) continue;
    const { rows } = await timesheetList(p.start, open);
    for (const r of rows)
      if ((r.workedCenti > 0 || r.problems > 0) && !r.managerApprovedAt) out.waiting.push({ staffId: r.staffId, label: r.label, shopId: r.shopId, periodStart: p.start, periodEnd: p.end });
  }
  const punches = await punchesBetween(null, new Date(startOfLocalDay(start).getTime() - DAY), new Date(endOfLocalDay(end).getTime() + DAY));
  const missed = pairPunches(punches.map(asLike)).problems.filter((p) => shopIds.includes(p.shopId) && MISSED_PUNCH.includes(p.kind) && localDateOf(p.at) >= start && localDateOf(p.at) <= end);
  if (missed.length) {
    const names = new Map(
      (await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, [...new Set(missed.map((p) => p.staffId))]))).map((s) => [s.id, s.label]),
    );
    out.missedPunches = missed.map((p) => ({ staffId: p.staffId, label: names.get(p.staffId) ?? "", shopId: p.shopId, kind: p.kind, problem: PROBLEM_LABEL[p.kind], at: p.at }));
  }
  return out;
}

// ───────────────────────────── Full time / part time ─────────────────────────────

const basisHours = (s: Pick<Slice, "worked" | "training" | "pto">, settings: PayrollSettings) =>
  (s.worked + (settings.ftBasis !== "worked" ? s.training : 0) + (settings.ftBasis === "paid" ? s.pto : 0)) / 100;

export interface FtRow {
  staffId: string;
  average: number;
  status: FtLabel;
  weeks: { weekStart: LocalDate; hours: number }[];
}

/** Each person's rolling average weekly hours over the `window` full workweeks ending before `asOf`'s week, and FT/PT. */
export async function ftOverview(staffIds: readonly string[], asOf: LocalDate, window: number, settings?: PayrollSettings): Promise<{ rows: FtRow[]; lastWeek: LocalDate; window: number; threshold: number }> {
  const s = settings ?? (await loadSettings());
  const w = Math.min(26, Math.max(1, Math.round(window)));
  const lastWeek = addDays(weekStartOf(asOf), -7);
  const firstWeek = addDays(lastWeek, -7 * (w - 1));
  const { slices } = await hoursSlices(firstWeek, addDays(lastWeek, 6), staffIds, s);
  const rows = staffIds.map((id) => {
    const weeks = Array.from({ length: w }, (_, i) => {
      const ws = addDays(firstWeek, 7 * i);
      return { weekStart: ws, hours: Math.round(slices.filter((x) => x.staffId === id && x.weekStart === ws).reduce((a, x) => a + basisHours(x, s), 0) * 100) / 100 };
    });
    const r = rollingFt(weeks, w, s.ftHoursPerWeek).at(-1)!;
    return { staffId: id, average: r.average, status: r.status, weeks };
  });
  return { rows, lastWeek, window: w, threshold: s.ftHoursPerWeek };
}

async function managersOf(shopIds: string[], perms: Permission[], exclude: string | null) {
  const ids = await staffWithAccessTo(shopIds);
  const people = ids.length ? await db.select({ id: staff.id, email: staff.email, active: staff.active, kind: staff.kind }).from(staff).where(inArray(staff.id, ids)) : [];
  const out: { id: string; email: string }[] = [];
  for (const p of people) {
    if (!p.active || p.kind !== "person" || !p.email || p.id === exclude) continue;
    const a = await loadStaffAccess(p.id);
    if (a && perms.some((x) => a.permissions.has(x))) out.push({ id: p.id, email: p.email });
  }
  return out;
}

/**
 * Records anyone whose status flipped as of the last full workweek and emails their managers. Run
 * from cron; each change is written once.
 */
export async function checkFtCrossings(now = new Date()): Promise<number> {
  const s = await loadSettings();
  const people = await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(and(eq(staff.kind, "person"), eq(staff.active, true)));
  if (!people.length) return 0;
  const lastWeek = addDays(weekStartOf(todayLocal(now)), -7);
  const firstWeek = addDays(lastWeek, -7 * s.ftWindowWeeks);
  const { slices } = await hoursSlices(firstWeek, addDays(lastWeek, 6), people.map((p) => p.id), s);
  let n = 0;
  for (const p of people) {
    const weeks = Array.from({ length: s.ftWindowWeeks + 1 }, (_, i) => {
      const ws = addDays(firstWeek, 7 * i);
      return { weekStart: ws, hours: slices.filter((x) => x.staffId === p.id && x.weekStart === ws).reduce((a, x) => a + basisHours(x, s), 0) };
    });
    if (!weeks.some((w) => w.hours > 0)) continue;
    const r = rollingFt(weeks, s.ftWindowWeeks, s.ftHoursPerWeek);
    if (r.length < 2 || r[0].status === r[1].status) continue;
    const [row] = await db
      .insert(ftStatusChanges)
      .values({ staffId: p.id, weekStart: lastWeek, fromStatus: r[0].status, toStatus: r[1].status, averageHours: r[1].average, windowWeeks: s.ftWindowWeeks })
      .onConflictDoNothing()
      .returning({ id: ftStatusChanges.id });
    if (!row) continue;
    n++;
    const shopIds = await workShopIds(p.id);
    await audit(SYSTEM, "timeclock.ft_change", "staff", p.id, { from: r[0].status, to: r[1].status, averageHours: r[1].average, windowWeeks: s.ftWindowWeeks, weekStart: lastWeek }, shopIds[0] ?? null);
    if (!shopIds.length) continue;
    const to = await managersOf(shopIds, ["timesheet.approve", "payroll.run"], p.id);
    const word = r[1].status === "full_time" ? "full time" : "part time";
    for (const m of to)
      await enqueueShopEmail({
        kind: "ft_status_change",
        to: m.email,
        subject: `${p.label} is now ${word} (${r[1].average} h/week average)`,
        body: [
          `${p.label}'s average over the last ${s.ftWindowWeeks} weeks, through the week of ${formatDate(lastWeek)}, is ${r[1].average} hours a week.`,
          `Full time is more than ${s.ftHoursPerWeek} hours a week on average, so they've moved from ${r[0].status === "full_time" ? "full time" : "part time"} to ${word}.`,
          `See hours: ${appBaseUrl()}/admin/timesheets`,
        ].join("\n\n"),
        shopId: shopIds[0],
      });
  }
  return n;
}

// ───────────────────────────── Forgotten clock-outs ─────────────────────────────

/** Open shifts past their scheduled end (plus the allowance) get flagged once, and the shop's managers are told. */
export async function flagForgottenClockOuts(now = new Date()): Promise<number> {
  const punches = await punchesBetween(null, new Date(now.getTime() - 4 * DAY), new Date(now.getTime() + 60_000));
  const { shifts } = pairPunches(punches.map(asLike));
  const open = shifts.filter((s) => s.end === null);
  if (!open.length) return 0;
  const byId = new Map(punches.map((p) => [p.id, p]));
  const sched = await schedulesOf([...new Set(open.map((s) => s.staffId))]);
  const rules = await clockRulesAt([...new Set(open.map((s) => s.shopId))]);
  const names = new Map((await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, [...new Set(open.map((s) => s.staffId))]))).map((s) => [s.id, s.label]));
  const cal = await brandCalendar();
  let n = 0;
  for (const s of open) {
    const p = byId.get(s.inId)!;
    if (p.forgotFlaggedAt) continue;
    const due = forgottenAfter(s.start, scheduleFor(sched, s.staffId, s.shopId, localDateOf(s.start)), rules(s.shopId));
    if (due > now) continue;
    const flags = [...new Set([...(p.flags as string[]), "forgot_out"])];
    const [hit] = await db
      .update(timePunches)
      .set({ forgotFlaggedAt: now, flags })
      .where(and(eq(timePunches.id, p.id), isNull(timePunches.forgotFlaggedAt)))
      .returning({ id: timePunches.id });
    if (!hit) continue;
    n++;
    await audit(SYSTEM, "timeclock.forgot_out", "time_punch", p.id, { staffId: s.staffId, since: s.start.toISOString() }, s.shopId);
    const label = names.get(s.staffId) ?? "Someone";
    for (const m of await managersOf([s.shopId], ["timesheet.edit"], s.staffId))
      await enqueueShopEmail({
        kind: "clock_forgot_out",
        to: m.email,
        subject: `${label} didn't clock out (in since ${formatTime(s.start)} ${formatDate(localDateOf(s.start))})`,
        body: [
          `${label} clocked in at ${formatTime(s.start)} on ${formatDate(localDateOf(s.start))} and hasn't clocked out.`,
          "Until a clock-out is added, that shift counts no hours. Add the clock-out (with a reason) on their timesheet.",
          `Timesheet: ${appBaseUrl()}/admin/timesheets/${s.staffId}?period=${payPeriodFor(localDateOf(s.start), cal).start}`,
        ].join("\n\n"),
        shopId: s.shopId,
      });
  }
  return n;
}

/** The cron's time clock pass: forgotten clock-outs and live clock alerts every run; the full-time check once a night (3:00–3:15), since weeks close on Saturday. */
export async function timeClockCron(now = new Date()) {
  const clockOutReminders = await remindClockOuts(now);
  const forgottenClockOuts = await flagForgottenClockOuts(now);
  const mealPrompts = await promptMealPeriods(now);
  const mealsMissed = await flagMissedMealPeriods(now);
  const blocks = await refreshClockBlocks(now);
  const clockAlerts = await sendClockFallout(now);
  const m = localMinutesOf(now);
  const ftChanges = m >= 180 && m < 195 ? await checkFtCrossings(now) : 0;
  return { clockOutReminders, forgottenClockOuts, mealPrompts, mealsMissed, clockBlocks: blocks.created + blocks.updated + blocks.removed, clockAlerts, ftChanges };
}

/** Minutes after their scheduled end that someone still clocked in, with no client still to come, is reminded. */
export const CLOCK_OUT_REMINDER_MIN = 10;

/**
 * Reminds someone still clocked in after their scheduled hours, once per shift (clock_alert_log), on
 * their staff app phones: not while a client of theirs there is still in the chair or booked later
 * that day, and not once the shift counts as a forgotten clock-out (their managers hear then).
 */
export async function remindClockOuts(now = new Date()): Promise<number> {
  const punches = await punchesBetween(null, new Date(now.getTime() - DAY), new Date(now.getTime() + 60_000));
  const open = pairPunches(punches.map(asLike)).shifts.filter((x) => x.end === null);
  if (!open.length) return 0;
  const sched = await schedulesOf([...new Set(open.map((x) => x.staffId))]);
  const rules = await clockRulesAt([...new Set(open.map((x) => x.shopId))]);
  let n = 0;
  for (const x of open) {
    const day = localDateOf(x.start);
    const ends = scheduleFor(sched, x.staffId, x.shopId, day)
      .map((i) => i.end)
      .filter((e) => e > x.start);
    if (!ends.length) continue;
    const end = new Date(Math.max(...ends.map((e) => e.getTime())));
    if (now.getTime() < end.getTime() + CLOCK_OUT_REMINDER_MIN * 60_000) continue;
    if (forgottenAfter(x.start, scheduleFor(sched, x.staffId, x.shopId, day), rules(x.shopId)) <= now) continue;
    const [busy] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.staffId, x.staffId),
          eq(appointments.shopId, x.shopId),
          or(eq(appointments.status, "in_service"), and(inArray(appointments.status, ["booked", "confirmed", "checked_in"]), gt(appointments.endsAt, now), lt(appointments.startsAt, endOfLocalDay(day)))),
        ),
      )
      .limit(1);
    if (busy) continue;
    const [first] = await db.insert(clockAlertLog).values({ key: `out_reminder:${x.inId}`, shopId: x.shopId, sentAt: now }).onConflictDoNothing().returning({ key: clockAlertLog.key });
    if (!first) continue;
    n += (await queueStaffNotice("clock_out", x.staffId, { body: `You're still clocked in. Your hours ended at ${formatTime(end)}. Clock out in the Ray'z Team app if you're done.`, shopId: x.shopId, now })) ? 1 : 0;
  }
  return n;
}

// ───────────────────────────── Meal periods (ST-I16) ─────────────────────────────

/** Each shop's meal period rule, from the state it's in (Illinois has one; Iowa doesn't for adults). */
async function mealRulesOf(shopIds: readonly string[]) {
  const rows = shopIds.length ? await db.select({ id: shops.id, state: shops.state }).from(shops).where(inArray(shops.id, [...shopIds])) : [];
  const by = new Map(rows.map((r) => [r.id, rulesFor(workStateOf(r.state)).mealPeriod]));
  return (shopId: string) => by.get(shopId) ?? null;
}

const breaksOf = (s: Shift) => s.breaks.map((b) => ({ start: b.start, end: b.end }));

/**
 * Reminds someone clocked in at a shop with a meal period rule, once per shift (clock_alert_log), half
 * an hour before their meal break has to start: in Illinois, 20 minutes starting by the 5th hour of a
 * shift of 7½ hours or more. Not when they're already on a break, or scheduled for less than 7½ hours.
 */
export async function promptMealPeriods(now = new Date()): Promise<number> {
  const punches = await punchesBetween(null, new Date(now.getTime() - DAY), new Date(now.getTime() + 60_000));
  const open = pairPunches(punches.map(asLike)).shifts.filter((x) => x.end === null);
  if (!open.length) return 0;
  const ruleOf = await mealRulesOf([...new Set(open.map((x) => x.shopId))]);
  const sched = await schedulesOf([...new Set(open.map((x) => x.staffId))]);
  let n = 0;
  for (const x of open) {
    const rule = ruleOf(x.shopId);
    if (!rule || !mealPromptDue(rule, { start: x.start, end: null, breaks: breaksOf(x) }, now)) continue;
    const planned = scheduleFor(sched, x.staffId, x.shopId, localDateOf(x.start)).filter((i) => i.end > x.start);
    if (planned.length && Math.max(...planned.map((i) => i.end.getTime())) - x.start.getTime() < rule.afterHours * 3_600_000) continue;
    const [first] = await db.insert(clockAlertLog).values({ key: `meal_prompt:${x.inId}`, shopId: x.shopId, sentAt: now }).onConflictDoNothing().returning({ key: clockAlertLog.key });
    if (!first) continue;
    const by = new Date(x.start.getTime() + rule.startByHours * 3_600_000);
    n += (await queueStaffNotice("meal_break", x.staffId, {
      body: `Time for your ${rule.minutes}-minute meal break: it needs to start by ${formatTime(by)}. Start a break in the Ray'z Team app.`,
      shopId: x.shopId,
      now,
    }))
      ? 1
      : 0;
  }
  return n;
}

/** Closed shifts of the last two days at a shop with a meal period rule that didn't get it (or got it late): the clock-in is flagged once, for the timesheet and payroll review. */
export async function flagMissedMealPeriods(now = new Date()): Promise<number> {
  const punches = await punchesBetween(null, new Date(now.getTime() - 2 * DAY), new Date(now.getTime() + 60_000));
  const closed = pairPunches(punches.map(asLike)).shifts.filter((x) => x.end !== null);
  if (!closed.length) return 0;
  const ruleOf = await mealRulesOf([...new Set(closed.map((x) => x.shopId))]);
  const byId = new Map(punches.map((p) => [p.id, p]));
  let n = 0;
  for (const x of closed) {
    const rule = ruleOf(x.shopId);
    const p = byId.get(x.inId);
    if (!rule || !p || (p.flags as string[]).includes("meal_missed")) continue;
    const c = mealCheck(rule, { start: x.start, end: x.end, breaks: breaksOf(x) }, now);
    if (!c.missed) continue;
    await db
      .update(timePunches)
      .set({ flags: [...(p.flags as string[]), "meal_missed"] })
      .where(eq(timePunches.id, p.id));
    await audit(SYSTEM, "timeclock.meal_missed", "time_punch", p.id, { staffId: x.staffId, law: rule.law, needed: c.needed, taken: c.taken, dueBy: c.firstDueBy.toISOString() }, x.shopId);
    n++;
  }
  return n;
}

/**
 * Emails the managers who run each live shop's calendar, once each (clock_alert_log): a barber not
 * clocked in `lateAlertMinutes` before their first client, and clients booked inside a clock block
 * (each client once per block), with the call-in link to move or rebook them. `onlyStaffId` limits it to one
 * person, right after they punch.
 */
export async function sendClockFallout(now = new Date(), o: { onlyStaffId?: string; shopIds?: string[] } = {}): Promise<number> {
  const shopIds = o.shopIds ?? (await db.select({ id: shops.id }).from(shops).where(eq(shops.status, "live"))).map((s) => s.id);
  const today = todayLocal(now);
  const base = appBaseUrl();
  let n = 0;
  const firstTime = async (key: string, shopId: string) => !!(await db.insert(clockAlertLog).values({ key, shopId, sentAt: now }).onConflictDoNothing().returning({ key: clockAlertLog.key }))[0];
  const tell = async (kind: "clock_late_in" | "clock_affected", staffId: string, shopId: string, subject: string, body: string, details: Record<string, unknown>) => {
    n++;
    await audit(SYSTEM, `timeclock.${kind}`, "staff", staffId, details, shopId);
    for (const m of await managersOf([shopId], ["calendar.manage"], staffId)) await enqueueShopEmail({ kind, to: m.email, subject, body, shopId });
  };
  for (const f of await clockFallout(shopIds, now)) {
    for (const l of f.late) {
      if (o.onlyStaffId && l.staffId !== o.onlyStaffId) continue;
      const key = `late_in:${l.staffId}:${f.shopId}:${today}`;
      if (!(await firstTime(key, f.shopId))) continue;
      await tell(
        "clock_late_in",
        l.staffId,
        f.shopId,
        `${l.label} isn't clocked in for their ${formatTime(l.appt.startsAt)} client`,
        [
          `${l.label} hasn't clocked in at ${f.shop}, and their first client today${l.appt.first ? `, ${l.appt.first},` : ""} is at ${formatTime(l.appt.startsAt)}.`,
          "Check they're on the way, or move their first clients to another barber.",
          `Calendar: ${base}/admin/calendar?shop=${f.shopId}&appt=${l.appt.id}`,
        ].join("\n\n"),
        { key },
      );
    }
    for (const a of f.affected) {
      if (o.onlyStaffId && a.staffId !== o.onlyStaffId) continue;
      const fresh: typeof a.appts = [];
      for (const x of a.appts) if (await firstTime(`affected:${a.key}:${x.id}`, f.shopId)) fresh.push(x);
      if (!fresh.length) continue;
      const span = `${formatTime(a.start)}–${a.open ? `${formatTime(a.end)} and on until ${a.why === "break" ? "the break ends" : "they clock in"}` : formatTime(a.end)}`;
      await tell(
        "clock_affected",
        a.staffId,
        f.shopId,
        `${clockBlockTitle(a.label, a.why)}: ${fresh.length} ${fresh.length === 1 ? "client" : "clients"} booked`,
        [
          `${clockBlockTitle(a.label, a.why)} at ${f.shop}, so the calendar is blocked ${span}. Booked in that time:`,
          fresh.map((x) => `- ${formatTime(x.startsAt)} ${x.first ?? "Walk-in"} (${x.code})`).join("\n"),
          "Online booking is closed then.",
          `Move or rebook them: ${base}${callInHref(a.blockId)}`,
        ].join("\n\n"),
        { key: `affected:${a.key}`, blockId: a.blockId, appointments: fresh.map((x) => x.code) },
      );
    }
  }
  return n;
}

/** For Today: open shifts already flagged as forgotten clock-outs, and recent full-time changes, at these shops. */
export async function clockAlertFacts(shopIds: readonly string[], now = new Date()) {
  if (!shopIds.length) return { forgotten: [], ftChanges: [] };
  const flagged = await db
    .select({ id: timePunches.id, staffId: timePunches.staffId, shopId: timePunches.shopId, at: timePunches.at, label: staff.displayLabel })
    .from(timePunches)
    .innerJoin(staff, eq(staff.id, timePunches.staffId))
    .where(and(inArray(timePunches.shopId, [...shopIds]), isNotNull(timePunches.forgotFlaggedAt), isNull(timePunches.voidedAt), gte(timePunches.at, new Date(now.getTime() - 14 * DAY))));
  const forgotten: typeof flagged = [];
  if (flagged.length) {
    const from = new Date(Math.min(...flagged.map((f) => f.at.getTime())) - DAY);
    const { shifts } = pairPunches((await punchesBetween([...new Set(flagged.map((f) => f.staffId))], from, new Date(now.getTime() + 60_000))).map(asLike));
    const stillOpen = new Set(shifts.filter((s) => s.end === null).map((s) => s.inId));
    forgotten.push(...flagged.filter((f) => stillOpen.has(f.id)));
  }
  const ftChanges = await db
    .select({ staffId: ftStatusChanges.staffId, label: staff.displayLabel, to: ftStatusChanges.toStatus, average: ftStatusChanges.averageHours, weekStart: ftStatusChanges.weekStart, windowWeeks: ftStatusChanges.windowWeeks })
    .from(ftStatusChanges)
    .innerJoin(staff, eq(staff.id, ftStatusChanges.staffId))
    .where(
      and(
        gte(ftStatusChanges.createdAt, new Date(now.getTime() - 7 * DAY)),
        sql`exists (select 1 from staff_shops ss where ss.staff_id = ${ftStatusChanges.staffId} and ss.shop_id in (${sql.join(
          shopIds.map((s) => sql`${s}::uuid`),
          sql`, `,
        )}))`,
      ),
    );
  return { forgotten, ftChanges };
}

// ───────────────────────────── Attendance ─────────────────────────────

export interface AttendanceRow {
  staffId: string;
  shopId: string;
  date: LocalDate;
  shifts: number;
  late: number;
  lateMin: number;
  earlyOut: number;
  earlyOutMin: number;
  earlyIn: number;
  missed: number;
  forgotOut: number;
  scheduledNoShow: number;
}

/** Per barber, shop and day: late clock-ins, early clock-outs, missed punches and scheduled days with no punch. */
export async function attendanceRows(shopIds: readonly string[], from: LocalDate, to: LocalDate, staffIds: readonly string[] | null, now = new Date()): Promise<AttendanceRow[]> {
  if (!shopIds.length) return [];
  const punches = await punchesBetween(staffIds, new Date(startOfLocalDay(from).getTime() - DAY), new Date(endOfLocalDay(to).getTime() + DAY), db, shopIds);
  const byId = new Map(punches.map((p) => [p.id, p]));
  const { shifts, problems } = pairPunches(punches.map(asLike));
  const out = new Map<string, AttendanceRow>();
  const row = (staffId: string, shopId: string, date: LocalDate) => {
    const k = `${staffId}|${shopId}|${date}`;
    const r = out.get(k) ?? { staffId, shopId, date, shifts: 0, late: 0, lateMin: 0, earlyOut: 0, earlyOutMin: 0, earlyIn: 0, missed: 0, forgotOut: 0, scheduledNoShow: 0 };
    out.set(k, r);
    return r;
  };
  const inRange = (d: LocalDate) => d >= from && d <= to;
  for (const s of shifts) {
    const d = localDateOf(s.start);
    if (!inRange(d)) continue;
    const r = row(s.staffId, s.shopId, d);
    r.shifts++;
    const pin = byId.get(s.inId)!;
    const pout = s.outId ? byId.get(s.outId) : undefined;
    if ((pin.flags as string[]).includes("late")) {
      r.late++;
      r.lateMin += Math.max(0, pin.offScheduleMin ?? 0);
    }
    if ((pin.flags as string[]).includes("early_in")) r.earlyIn++;
    if ((pin.flags as string[]).includes("forgot_out")) r.forgotOut++;
    if (pout && (pout.flags as string[]).includes("early_out")) {
      r.earlyOut++;
      r.earlyOutMin += Math.max(0, -(pout.offScheduleMin ?? 0));
    }
  }
  const working = onTheClock(shifts, byId, now);
  for (const p of problems) {
    const d = localDateOf(p.at);
    if (inRange(d) && p.kind !== "break_not_ended" && !working(p)) row(p.staffId, p.shopId, d).missed++;
  }
  const people = staffIds
    ? [...staffIds]
    : (await db.selectDistinct({ id: staffSchedules.staffId }).from(staffSchedules).where(inArray(staffSchedules.shopId, [...shopIds]))).map((r) => r.id);
  const sched = await schedulesOf(people);
  const active = new Set(
    people.length ? (await db.select({ id: staff.id }).from(staff).where(and(inArray(staff.id, people), eq(staff.active, true), eq(staff.kind, "person")))).map((r) => r.id) : [],
  );
  const off = people.length
    ? await db
        .select({ staffId: timeBlocks.staffId, shopId: timeBlocks.shopId, startsAt: timeBlocks.startsAt, endsAt: timeBlocks.endsAt })
        .from(timeBlocks)
        .where(and(inArray(timeBlocks.staffId, people), eq(timeBlocks.category, "time_off"), lt(timeBlocks.startsAt, endOfLocalDay(to)), gt(timeBlocks.endsAt, startOfLocalDay(from))))
    : [];
  const today = todayLocal(now);
  const anyPunchOn = new Set(shifts.map((s) => `${s.staffId}|${s.shopId}|${localDateOf(s.start)}`));
  for (const sid of people) {
    if (!active.has(sid)) continue;
    for (const shopId of shopIds) {
      for (let d = from; d <= to && d < today; d = addDays(d, 1)) {
        const sc = scheduleFor(sched, sid, shopId, d);
        if (!sc.length || anyPunchOn.has(`${sid}|${shopId}|${d}`)) continue;
        if (off.some((o) => o.staffId === sid && (o.shopId === null || o.shopId === shopId) && o.startsAt < sc[0].end && o.endsAt > sc[0].start)) continue;
        row(sid, shopId, d).scheduledNoShow++;
      }
    }
  }
  return [...out.values()];
}
