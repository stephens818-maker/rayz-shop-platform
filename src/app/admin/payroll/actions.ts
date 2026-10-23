"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { DateTime } from "luxon";
import { z } from "zod";
import { db } from "@/db";
import { payrollProfiles, shops, staff } from "@/db/schema";
import { FT_BASIS_LABEL, OVERRIDABLE, type FtBasis, type Mismatch, type Overridable } from "@/domain/payroll/calc";
import { SHOP_TZ } from "@/lib/time";
import { safe } from "@/server/action";
import { authorize } from "@/server/auth/staff";
import { AppError } from "@/server/errors";
import {
  addTimeEntries,
  approveAndLock,
  deleteTimeEntry,
  ensurePayGroups,
  savePayGroup,
  savePayrollSettings,
  saveProfile,
  saveRate,
  setOverride,
  type TimeEntryInput,
} from "@/server/payroll/run";
import { parseTimeCsv } from "@/domain/payroll/time-csv";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function refresh() {
  revalidatePath("/admin/payroll", "layout");
}

const fail = (msg: string | null) => {
  if (msg) throw new AppError("bad_request", msg);
};

export async function approveAndLockAction(start: string, end: string) {
  return safe(async () => {
    const ctx = await authorize("payroll.approve");
    const r = await approveAndLock(date.parse(start), date.parse(end), ctx.actor);
    if ("error" in r) {
      const m = (r.mismatches ?? []) as Mismatch[];
      throw new AppError("bad_request", m.length ? `${r.error} ${m.length} mismatch${m.length === 1 ? "" : "es"}: ${m.slice(0, 3).map((x) => `${x.detail} (${x.column})`).join("; ")}` : r.error);
    }
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

export async function saveSettingsAction(input: {
  trainingCountsTowardOt: boolean;
  trainingPayInCost: boolean;
  roundExport2dp: boolean;
  ftHoursPerWeek: number;
  ftBasis: string;
  ftWindowWeeks: number;
  otThresholdHours: number;
  dailyOtHours: number | null;
  otMultiplier: number;
  tipsInPayrollHeader: string;
}) {
  return safe(async () => {
    const ctx = await authorize("payroll.run");
    const v = z
      .object({
        trainingCountsTowardOt: z.boolean(),
        trainingPayInCost: z.boolean(),
        roundExport2dp: z.boolean(),
        ftHoursPerWeek: z.number().min(1).max(60),
        ftBasis: z.enum(Object.keys(FT_BASIS_LABEL) as [FtBasis, ...FtBasis[]]),
        ftWindowWeeks: z.number().int().min(1).max(26),
        otThresholdHours: z.number().min(1).max(80),
        dailyOtHours: z.number().min(1).max(24).nullable(),
        otMultiplier: z.number().min(1).max(3),
        tipsInPayrollHeader: z.string().trim().min(1, "Name the iSolved earning for tips paid in payroll").max(60),
      })
      .parse(input);
    await savePayrollSettings(v, ctx.actor);
    refresh();
    return null;
  });
}

export async function savePayGroupAction(input: {
  id: string;
  label: string;
  legalEntity: string;
  exportTab: string;
  anchorStart: string;
  anchorNumber: number;
  periodDays: number;
  checkOffsetDays: number;
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
        anchorStart: date,
        anchorNumber: z.number().int(),
        periodDays: z.number().int(),
        checkOffsetDays: z.number().int(),
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
          calendar: { anchorStart: v.anchorStart, anchorNumber: v.anchorNumber, periodDays: v.periodDays, checkOffsetDays: v.checkOffsetDays, numberResetsYearly: v.numberResetsYearly },
        },
        ctx.actor,
      ),
    );
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
        shopId: z.string().uuid().nullable(),
        hourlyRate: z.number(),
        servicePct: z.number(),
        productPct: z.number(),
        trainingRate: z.number().nullable(),
      })
      .parse(input);
    fail(await saveProfile(v.staffId, { employeeNumber: v.employeeNumber, keyIsText: v.keyIsText, isolvedName: v.isolvedName, exportPosition: v.exportPosition }, ctx.actor));
    fail(await saveRate(v.staffId, v.shopId, { hourlyRate: v.hourlyRate, servicePct: v.servicePct, productPct: v.productPct, trainingRate: v.trainingRate }, ctx.actor));
    refresh();
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
