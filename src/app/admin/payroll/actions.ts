"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "@/db";
import { payrollProfiles, shops, staff } from "@/db/schema";
import {
  OVERRIDABLE,
  type Mismatch,
  type Overridable,
} from "@/domain/payroll/calc";
import { SHOP_TZ } from "@/lib/time";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import {
  addLateCommission,
  addTimeEntries,
  approveAndLock,
  approvePayroll,
  deleteTimeEntry,
  lockPayroll,
  removeLateCommission,
  revokeApproval,
  ensurePayGroups,
  savePayGroup,
  savePeriodDates,
  saveProfile,
  saveRate,
  setOverride,
  type TimeEntryInput,
} from "@/server/payroll/run";
import { parseTimeCsv } from "@/domain/payroll/time-csv";
import { removeEmployerState, saveEmployer, saveEmployerState } from "@/server/payroll/groups";
import { approveFinalPay } from "@/server/payroll/final-pay";
import { addTrainingRate, deleteTrainingRate } from "@/server/payroll/training-rates";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function refresh() {
  revalidatePath("/admin/payroll", "layout");
  revalidatePath("/admin/reports/payroll", "layout");
}

const fail = (msg: string | null) => {
  if (msg) throw new AppError("bad_request", msg);
};

const refusal = (r: { error: string; mismatches?: Mismatch[] }) => {
  const m = r.mismatches ?? [];
  return new AppError(
    "bad_request",
    m.length
      ? `${r.error} ${m.length} mismatch${m.length === 1 ? "" : "es"}: ${m
          .slice(0, 3)
          .map((x) => `${x.detail} (${x.column})`)
          .join("; ")}`
      : r.error,
  );
};

export async function approveAndLockAction(start: string, end: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.approve");
    const r = await approveAndLock(date.parse(start), date.parse(end), ctx.actor);
    if ("error" in r) throw refusal(r);
    refresh();
    return r.locked;
  });
}

export async function approvePayrollAction(start: string, end: string, note: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.approve");
    const r = await approvePayroll(date.parse(start), date.parse(end), ctx.actor, z.string().max(300).parse(note));
    if ("error" in r) throw refusal(r);
    refresh();
    return r.approvalId;
  });
}

/** Final pay off-cycle for someone who left (N9): brand-wide, by someone with Approve and lock. */
export async function approveFinalPayAction(input: { staffId: string; lastDay: string; note: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.approve");
    if (!ctx.brandWide) throw new AppError("forbidden", "Final pay covers every shop they worked at, so it needs access to all shops.");
    const v = z.object({ staffId: z.string().uuid(), lastDay: date, note: z.string().max(300) }).parse(input);
    const r = await approveFinalPay(v.staffId, v.lastDay, v.note, ctx.actor);
    if ("error" in r) throw new AppError("bad_request", r.error);
    refresh();
    return r.id;
  });
}

export async function revokeApprovalAction(start: string, end: string, reason: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.approve");
    fail(await revokeApproval(date.parse(start), date.parse(end), z.string().max(300).parse(reason), ctx.actor));
    refresh();
    return null;
  });
}

export async function lockPayrollAction(start: string, end: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.approve");
    const r = await lockPayroll(date.parse(start), date.parse(end), ctx.actor);
    if ("error" in r) throw refusal(r);
    refresh();
    return r.locked;
  });
}

export async function setOverrideAction(input: { shopId: string; periodStart: string; staffId: string; field: string; value: number | null; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z
      .object({ shopId: z.string().uuid(), periodStart: date, staffId: z.string().uuid(), field: z.enum(OVERRIDABLE as unknown as [Overridable, ...Overridable[]]), value: z.number().nullable(), reason: z.string().max(300) })
      .parse(input);
    fail(await setOverride(v.shopId, v.periodStart, v.staffId, v.field, v.value, v.reason, ctx.actor));
    refresh();
    return null;
  });
}

export async function addLateCommissionAction(input: { shopId: string; periodStart: string; staffId: string; earnedStart: string; amount: number; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z.object({ shopId: z.string().uuid(), periodStart: date, staffId: z.string().uuid(), earnedStart: date, amount: z.number(), reason: z.string().max(300) }).parse(input);
    fail(await addLateCommission(v, ctx.actor));
    refresh();
    return null;
  });
}

export async function removeLateCommissionAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    fail(await removeLateCommission(z.string().uuid().parse(id), ctx.actor));
    refresh();
    return null;
  });
}

export async function savePayGroupAction(input: {
  id: string;
  label: string;
  legalEntity: string;
  exportTab: string;
  code: string;
  anchorStart: string;
  anchorNumber: number;
  periodDays: number;
  checkOffsetDays: number;
  submitOffsetDays: number;
  numberResetsYearly: boolean;
}) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z
      .object({
        id: z.string().uuid(),
        label: z.string().max(80),
        legalEntity: z.string().max(120),
        exportTab: z.string().max(31),
        code: z.string().max(8),
        anchorStart: date,
        anchorNumber: z.number().int(),
        periodDays: z.number().int(),
        checkOffsetDays: z.number().int(),
        submitOffsetDays: z.number().int(),
        numberResetsYearly: z.boolean(),
      })
      .parse(input);
    await ensurePayGroups();
    fail(
      await savePayGroup(
        v.id,
        {
          label: v.label,
          legalEntity: v.legalEntity,
          exportTab: v.exportTab,
          code: v.code,
          calendar: {
            anchorStart: v.anchorStart,
            anchorNumber: v.anchorNumber,
            periodDays: v.periodDays,
            checkOffsetDays: v.checkOffsetDays,
            submitOffsetDays: v.submitOffsetDays,
            numberResetsYearly: v.numberResetsYearly,
          },
        },
        ctx.actor,
      ),
    );
    refresh();
    return null;
  });
}

export async function savePeriodDatesAction(input: { start: string; end: string; checkDate: string; submitBy: string; reason: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z.object({ start: date, end: date, checkDate: date, submitBy: date, reason: z.string().max(300) }).parse(input);
    fail(await savePeriodDates(v.start, v.end, v, ctx.actor));
    refresh();
    return null;
  });
}

export async function saveEmployerAction(input: { id: string; isolvedCompanyCode: string; taxIdLast4: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z.object({ id: z.string().uuid(), isolvedCompanyCode: z.string().max(40), taxIdLast4: z.string().max(4, "Enter only the last 4 digits of the EIN") }).parse(input);
    fail(await saveEmployer(v.id, v, ctx.actor));
    refresh();
    return null;
  });
}

export async function saveEmployerStateAction(input: { employerId: string; state: string; withholdingIdLast4: string; unemploymentIdLast4: string; registeredOn: string | null }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const last4 = z.string().max(4, "Enter only the last 4 digits of the state account number");
    const v = z
      .object({ employerId: z.string().uuid(), state: z.string().max(2), withholdingIdLast4: last4, unemploymentIdLast4: last4, registeredOn: date.nullable() })
      .parse(input);
    fail(await saveEmployerState(v.employerId, v, ctx.actor));
    refresh();
    return null;
  });
}

export async function removeEmployerStateAction(input: { employerId: string; state: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z.object({ employerId: z.string().uuid(), state: z.string().max(2) }).parse(input);
    fail(await removeEmployerState(v.employerId, v.state, ctx.actor));
    refresh();
    return null;
  });
}

export async function saveProfileAction(input: {
  staffId: string;
  employeeNumber: string;
  keyIsText: boolean;
  isolvedName: string;
  exportPosition: number | null;
  tippedOccupationCode?: string;
  zeroHourlyPay?: boolean;
  shopId: string | null;
  hourlyRate: number;
  servicePct: number;
  productPct: number;
  trainingRate: number | null;
}) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z
      .object({
        staffId: z.string().uuid(),
        employeeNumber: z.string().max(32),
        keyIsText: z.boolean(),
        isolvedName: z.string().max(80),
        exportPosition: z.number().int().min(0).max(999).nullable(),
        tippedOccupationCode: z.string().max(8).optional(),
        zeroHourlyPay: z.boolean().optional(),
        shopId: z.string().uuid().nullable(),
        hourlyRate: z.number(),
        servicePct: z.number(),
        productPct: z.number(),
        trainingRate: z.number().nullable(),
      })
      .parse(input);
    fail(await saveProfile(v.staffId, { employeeNumber: v.employeeNumber, keyIsText: v.keyIsText, isolvedName: v.isolvedName, exportPosition: v.exportPosition, tippedOccupationCode: v.tippedOccupationCode, zeroHourlyPay: v.zeroHourlyPay }, ctx.actor));
    fail(await saveRate(v.staffId, v.shopId, { hourlyRate: v.hourlyRate, servicePct: v.servicePct, productPct: v.productPct, trainingRate: v.trainingRate }, ctx.actor));
    refresh();
    return null;
  });
}

/** The iSolved fields from the Staff page: the Key (and whether it's text), the iSolved name and the $0 hourly flag. Row order and rates stay on Payroll setup. */
export async function saveIsolvedProfileAction(input: { staffId: string; employeeNumber: string; keyIsText: boolean; isolvedName: string; zeroHourlyPay: boolean }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    if (!ctx.brandWide) throw new AppError("forbidden", "Payroll profiles are brand-wide, so they need access to all shops.");
    const v = z.object({ staffId: z.string().uuid(), employeeNumber: z.string().max(32), keyIsText: z.boolean(), isolvedName: z.string().max(80), zeroHourlyPay: z.boolean() }).parse(input);
    const [cur] = await db.select({ exportPosition: payrollProfiles.exportPosition }).from(payrollProfiles).where(eq(payrollProfiles.staffId, v.staffId));
    fail(await saveProfile(v.staffId, { employeeNumber: v.employeeNumber, keyIsText: v.keyIsText, isolvedName: v.isolvedName, exportPosition: cur?.exportPosition ?? null, zeroHourlyPay: v.zeroHourlyPay }, ctx.actor));
    refresh();
    revalidatePath(`/admin/staff/${v.staffId}`);
    return null;
  });
}

/** Training rates are pay, brand-wide like payroll profiles, and nobody sets their own. */
async function trainingRateEditor(staffId: string) {
  const ctx = await authorize("payroll.run");
  if (!ctx.brandWide) throw new AppError("forbidden", "Training rates are brand-wide, so they need access to all shops.");
  if (staffId === ctx.staff.id) throw new AppError("forbidden", "Your own training rate is set by another payroll admin.");
  return ctx;
}

export async function addTrainingRateAction(input: { staffId: string; effectiveFrom: string; rateCents: number }) {
  return safe(async () => {
    const v = z.object({ staffId: z.string().uuid(), effectiveFrom: date, rateCents: z.number().int() }).parse(input);
    const ctx = await trainingRateEditor(v.staffId);
    await addTrainingRate(v.staffId, { effectiveFrom: v.effectiveFrom, rateCents: v.rateCents }, ctx.actor);
    refresh();
    revalidatePath(`/admin/staff/${v.staffId}`);
    return null;
  });
}

export async function deleteTrainingRateAction(input: { staffId: string; versionId: string }) {
  return safe(async () => {
    const v = z.object({ staffId: z.string().uuid(), versionId: z.string().uuid() }).parse(input);
    const ctx = await trainingRateEditor(v.staffId);
    await deleteTrainingRate(v.staffId, v.versionId, ctx.actor);
    refresh();
    revalidatePath(`/admin/staff/${v.staffId}`);
    return null;
  });
}

const local = (d: string, t: string) => DateTime.fromISO(`${d}T${t}`, { zone: SHOP_TZ });

export async function addTimeEntryAction(input: { staffId: string; shopId: string; kind: string; date: string; start: string; end: string; note: string }) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z
      .object({ staffId: z.string().uuid(), shopId: z.string().uuid(), kind: z.enum(["worked", "training", "pto"]), date, start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), note: z.string().max(200) })
      .parse(input);
    const s = local(v.date, v.start);
    let e = local(v.date, v.end);
    if (e <= s) e = e.plus({ days: 1 });
    const r = await addTimeEntries([{ staffId: v.staffId, shopId: v.shopId, kind: v.kind, startsAt: s.toJSDate(), endsAt: e.toJSDate(), note: v.note || null, source: "manual" }], ctx.actor);
    if ("error" in r) throw new AppError("bad_request", r.error);
    refresh();
    return r.added;
  });
}

/** CSV of shifts (Squire or a time clock): employee, shop, date, start, end, and optionally kind and note. */
export async function importTimeCsvAction(csv: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const { staffRows, shopRows } = await lookups();
    const parsed = parseTimeCsv(csv, { staff: staffRows, shops: shopRows });
    if (parsed.errors.length) throw new AppError("bad_request", parsed.errors.slice(0, 5).join(" "));
    const list: TimeEntryInput[] = parsed.rows.map((r) => ({ ...r, source: "import" }));
    const res = await addTimeEntries(list, ctx.actor);
    if ("error" in res) throw new AppError("bad_request", res.error);
    refresh();
    return res.added;
  });
}

export async function deleteTimeEntryAction(id: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    fail(await deleteTimeEntry(z.string().uuid().parse(id), ctx.actor));
    refresh();
    return null;
  });
}

async function lookups() {
  const staffRows = await db
    .select({ id: staff.id, label: staff.displayLabel, first: staff.firstName, last: staff.lastName, number: payrollProfiles.employeeNumber, isolvedName: payrollProfiles.isolvedName })
    .from(staff)
    .leftJoin(payrollProfiles, eq(payrollProfiles.staffId, staff.id))
    .where(eq(staff.kind, "person"));
  const shopRows = await db.select({ id: shops.id, name: shops.name, slug: shops.slug }).from(shops);
  return { staffRows, shopRows };
}
