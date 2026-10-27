import "server-only";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffShops, timePunches } from "@/db/schema";
import { FLAG_LABEL, METHOD_LABEL, PUNCH_LABEL, type PunchFlag, type PunchType } from "@/domain/time-clock";
import { todayLocal, type LocalDate } from "@/lib/time";
import { can, canAny } from "@/server/auth/staff";
import { forbidden, notFound } from "@/server/errors";
import { narrowShops, requireInTenant } from "@/server/tenant";
import { payrollCsv } from "@/server/time-clock-export";
import { addPunch, approveAsManager, approveOwn, chosenPeriod, editPunch, recentPeriods, timesheetList, timesheetView, voidPunch, type Editor, type TimesheetView } from "@/server/time-clock";
import { shopOf, type StaffAppContext } from "./http";

/**
 * Timecards in the staff app (ST-C5): their own by pay period with the sign-off, and for managers the
 * team's, punch fixes with a reason (in the edit log), approval, and the iSolved file. The same server
 * code as /admin/timesheets. No punch photos, locations or anything biometric ever come back.
 */

const DAY_MS = 86_400_000;
const editor = (ctx: StaffAppContext): Editor => ({ actor: ctx.actor, staffId: ctx.staff.id, isOwner: ctx.isOwner, shopIds: ctx.shopIds });

function periodsOf(today: LocalDate, current: LocalDate) {
  return recentPeriods(today).map((p) => ({ start: p.start, end: p.end, current: p.start <= today && today <= p.end, selected: p.start === current }));
}

/** A timesheet as the app shows it: hours, breaks, flags and approvals, without photos. */
function appSheet(v: TimesheetView) {
  return {
    staffId: v.staffId,
    label: v.label,
    period: v.period,
    shops: v.shops.map((s) => ({
      shopId: s.shopId,
      shop: s.shop,
      totals: s.totals,
      weeks: s.weeks,
      days: s.days
        .filter((d) => d.scheduledMin || d.workedMin || d.otherMin || d.shifts.length)
        .map((d) => ({
          date: d.date,
          scheduledMin: d.scheduledMin,
          workedMin: d.workedMin,
          otherMin: d.otherMin,
          shifts: d.shifts.map((sh) => ({
            inId: sh.inId,
            outId: sh.outId,
            start: sh.start,
            end: sh.end,
            workedMin: sh.workedMin,
            breakMin: sh.breakMin,
            unpaidBreakMin: sh.unpaidBreakMin,
            scheduledMin: sh.scheduledMin,
            breaks: sh.breaks,
            flags: sh.flags.map((f) => ({ key: f, label: FLAG_LABEL[f] })),
            methods: sh.methods.map((m) => METHOD_LABEL[m as keyof typeof METHOD_LABEL] ?? m),
            edited: sh.edited,
          })),
        })),
      problems: s.problems,
      approval: s.approval,
      locked: !!s.locked || s.payrollLocked,
    })),
    edits: v.edits.map((e) => ({ at: e.at, by: e.by, action: e.action, reason: e.reason })),
  };
}

/** GET /me/timecard?period=: their own, every shop they have time at. */
export async function myTimecard(ctx: StaffAppContext, period: string | undefined, today: LocalDate = todayLocal()) {
  const p = chosenPeriod(period, today);
  const sheet = appSheet(await timesheetView(ctx.staff.id, p.start, null));
  return {
    periods: periodsOf(today, p.start),
    ...sheet,
    shops: sheet.shops.map((s) => ({ ...s, canSignOff: can(ctx, "timesheet.own") && !s.locked && !s.approval.employeeAt && today >= p.start })),
  };
}

/** POST /me/timecard/sign-off */
export async function signOffMine(ctx: StaffAppContext, v: { shopId: string; periodStart: LocalDate }) {
  await approveOwn(ctx.staff.id, shopOf(ctx, v.shopId), v.periodStart, ctx.actor);
  return myTimecard(ctx, v.periodStart);
}

/** GET /timecards?period=&shopId=: one row per person and shop the manager can reach. */
export async function teamTimecards(ctx: StaffAppContext, q: { period?: string; shopId?: string }, today: LocalDate = todayLocal()) {
  const p = chosenPeriod(q.period, today);
  const shopIds = narrowShops(ctx, q.shopId ? [shopOf(ctx, q.shopId)] : null);
  const { rows, locks } = await timesheetList(p.start, shopIds);
  return {
    periods: periodsOf(today, p.start),
    period: { start: p.start, end: p.end },
    rows,
    locks,
    canApprove: can(ctx, "timesheet.approve"),
    canEdit: can(ctx, "timesheet.edit"),
    canExport: can(ctx, "payroll.export"),
  };
}

async function reachable(ctx: StaffAppContext, staffId: string) {
  await requireInTenant(ctx, "staff", staffId);
  const [p] = await db.select({ kind: staff.kind }).from(staff).where(eq(staff.id, staffId));
  if (p?.kind !== "person") throw notFound("Staff member");
}

/** GET /timecards/{staffId}?period=: someone's timesheet at the manager's shops, with the punches to fix. */
export async function teamTimecard(ctx: StaffAppContext, staffId: string, period: string | undefined, today: LocalDate = todayLocal()) {
  if (staffId === ctx.staff.id) return myTimecard(ctx, period, today);
  await reachable(ctx, staffId);
  const p = chosenPeriod(period, today);
  const sheet = appSheet(await timesheetView(staffId, p.start, ctx.shopIds));
  const punches = await db
    .select({ id: timePunches.id, shopId: timePunches.shopId, type: timePunches.type, at: timePunches.at, method: timePunches.method, source: timePunches.source, flags: timePunches.flags, voidedAt: timePunches.voidedAt, editedAt: timePunches.editedAt })
    .from(timePunches)
    .where(and(eq(timePunches.staffId, staffId), inArray(timePunches.shopId, [...ctx.shopIds]), gte(timePunches.at, new Date(p.startsAt.getTime() - DAY_MS)), lt(timePunches.at, new Date(p.endsAt.getTime() + DAY_MS))))
    .orderBy(asc(timePunches.at));
  const canEdit = can(ctx, "timesheet.edit");
  const canApprove = can(ctx, "timesheet.approve");
  return {
    periods: periodsOf(today, p.start),
    ...sheet,
    shops: sheet.shops.map((s) => ({ ...s, canApprove: canApprove && !s.locked && !s.approval.managerAt, canEdit: canEdit && !s.locked })),
    punches: punches.map((x) => ({
      id: x.id,
      shopId: x.shopId,
      type: x.type,
      typeLabel: PUNCH_LABEL[x.type as PunchType],
      at: x.at.toISOString(),
      method: METHOD_LABEL[x.method as keyof typeof METHOD_LABEL] ?? x.method,
      frontDesk: x.source === "kiosk",
      flags: (x.flags as PunchFlag[]).filter((f) => f in FLAG_LABEL).map((f) => ({ key: f, label: FLAG_LABEL[f] })),
      voided: !!x.voidedAt,
      edited: !!x.editedAt || x.source === "manager",
    })),
  };
}

/** POST /timecards/{staffId}/approve: after their sign-off, or with a note saying why not. */
export async function approveTimecard(ctx: StaffAppContext, staffId: string, v: { shopId: string; periodStart: LocalDate; note?: string | null }) {
  await reachable(ctx, staffId);
  await approveAsManager(editor(ctx), staffId, shopOf(ctx, v.shopId), v.periodStart, v.note ?? null);
  return teamTimecard(ctx, staffId, v.periodStart);
}

/** POST /timecards/{staffId}/punches: a punch they missed. */
export async function addTeamPunch(ctx: StaffAppContext, staffId: string, v: { shopId: string; type: PunchType; at: string; reason: string }) {
  await reachable(ctx, staffId);
  const shopId = shopOf(ctx, v.shopId);
  const [works] = await db.select({ s: staffShops.shopId }).from(staffShops).where(and(eq(staffShops.staffId, staffId), eq(staffShops.shopId, shopId)));
  if (!works) throw forbidden("They don't work at that shop");
  const id = await addPunch(editor(ctx), { staffId, shopId, type: v.type, at: new Date(v.at) }, v.reason);
  return { id };
}

async function punchHere(ctx: StaffAppContext, punchId: string) {
  const [p] = await db.select({ shopId: timePunches.shopId, staffId: timePunches.staffId }).from(timePunches).where(eq(timePunches.id, punchId));
  if (!p || !ctx.shopIds.includes(p.shopId)) throw notFound("Punch");
  return p;
}

/** PATCH /punches/{id} */
export async function editTeamPunch(ctx: StaffAppContext, punchId: string, v: { at?: string; type?: PunchType; shopId?: string; reason: string }) {
  await punchHere(ctx, punchId);
  if (v.shopId) shopOf(ctx, v.shopId);
  await editPunch(editor(ctx), punchId, { at: v.at ? new Date(v.at) : undefined, type: v.type, shopId: v.shopId }, v.reason);
  return { id: punchId };
}

/** POST /punches/{id}/void: voided, kept on record. */
export async function voidTeamPunch(ctx: StaffAppContext, punchId: string, reason: string) {
  await punchHere(ctx, punchId);
  await voidPunch(editor(ctx), punchId, reason);
}

/** GET /timecards/export?period=&format=&shopId=: the iSolved import (or every field), logged. */
export async function timecardExport(ctx: StaffAppContext, q: { period: LocalDate; format?: "isolved" | "generic"; shopId?: string }) {
  const shopIds = narrowShops(ctx, q.shopId ? [shopOf(ctx, q.shopId)] : null);
  return payrollCsv(q.period, shopIds, q.format ?? "isolved", ctx.actor);
}

export const managesTimecards = (ctx: StaffAppContext) => canAny(ctx, ["timesheet.edit", "timesheet.approve", "payroll.export"]);
