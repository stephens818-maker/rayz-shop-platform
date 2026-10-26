import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { payrollProfiles, payrollRates, shops, staff, timesheetLocks } from "@/db/schema";
import type { PayPeriod } from "@/domain/payroll";
import { splitByLocalDay } from "@/domain/payroll/overtime";
import { exportLines, genericCsv, mappedCsv, pairPunches, shiftWork, type ExportLine } from "@/domain/time-clock";
import { localDateOf, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "./audit";
import { AppError } from "./errors";
import { ensurePayGroups } from "./payroll/run";
import { payrollSalesBetween } from "./reports";
import { asLike, clockRulesAt, hoursSlices, loadClockRules, periodFor, punchesBetween } from "./time-clock";

/**
 * The time clock's payroll export and labor cost: hours from the time clock with tips and sales
 * from the sales reports. Kept apart from src/server/time-clock.ts so the cron (which reaches the
 * clock for forgotten clock-outs) never loads the reports module.
 */

const DAY = 86_400_000;
const bad = (msg: string) => new AppError("bad_request", msg);

// ───────────────────────────── Payroll export ─────────────────────────────

export type ExportFormat = "generic" | "isolved";

/** Per employee and shop for one pay period: regular and OT hours, breaks, tips and sales. */
export async function exportData(periodStart: LocalDate, shopIds: readonly string[]): Promise<{ lines: ExportLine[]; draft: boolean; period: PayPeriod }> {
  const period = periodFor(periodStart);
  const rules = await clockRulesAt(shopIds);
  const { slices } = await hoursSlices(period.start, period.end, null);
  const mine = slices.filter((s) => s.periodStart === period.start && shopIds.includes(s.shopId));
  const punches = await punchesBetween(null, new Date(period.startsAt.getTime() - DAY), new Date(period.endsAt.getTime() + DAY), db, shopIds);
  const { shifts } = pairPunches(punches.map(asLike));
  const breaks = new Map<string, { all: number; unpaid: number }>();
  for (const s of shifts) {
    const d = localDateOf(s.start);
    if (!s.end || d < period.start || d > period.end) continue;
    const w = shiftWork(s, rules(s.shopId));
    const k = `${s.staffId}|${s.shopId}`;
    const b = breaks.get(k) ?? { all: 0, unpaid: 0 };
    b.all += w.breakMin;
    b.unpaid += w.unpaidBreakMin;
    breaks.set(k, b);
  }
  const hours = new Map<string, { workedCenti: number; otCenti: number; ptoCenti: number; trainingCenti: number }>();
  for (const s of mine) {
    const k = `${s.staffId}|${s.shopId}`;
    const h = hours.get(k) ?? { workedCenti: 0, otCenti: 0, ptoCenti: 0, trainingCenti: 0 };
    h.workedCenti += s.worked;
    h.otCenti += s.ot;
    h.ptoCenti += s.pto;
    h.trainingCenti += s.training;
    hours.set(k, h);
  }
  for (const k of breaks.keys()) if (!hours.has(k)) hours.set(k, { workedCenti: 0, otCenti: 0, ptoCenti: 0, trainingCenti: 0 });
  const sales = await payrollSalesBetween({ shopIds: [...shopIds] }, period.start, period.end);
  const staffIds = [...new Set([...[...hours.keys()].map((k) => k.split("|")[0]), ...sales.map((s) => s.staffId)])];
  const [people, profiles, groups, shopRows] = await Promise.all([
    staffIds.length ? db.select({ id: staff.id, label: staff.displayLabel, first: staff.firstName, last: staff.lastName }).from(staff).where(inArray(staff.id, staffIds)) : [],
    staffIds.length ? db.select().from(payrollProfiles).where(inArray(payrollProfiles.staffId, staffIds)) : [],
    ensurePayGroups(),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, [...shopIds])),
  ]);
  const person = new Map(people.map((p) => [p.id, p]));
  const profile = new Map(profiles.map((p) => [p.staffId, p]));
  const lines = exportLines(
    [...hours.entries()].map(([k, h]) => {
      const [staffId, shopId] = k.split("|");
      const b = breaks.get(k) ?? { all: 0, unpaid: 0 };
      return { staffId, shopId, ...h, breakMin: b.all, unpaidBreakMin: b.unpaid };
    }),
    sales.map((s) => ({ staffId: s.staffId, shopId: s.shopId, cardTipsCents: s.cardTipsCents + s.giftCardTipsCents, cashTipsCents: s.cashTipsCents, serviceSalesCents: s.serviceSalesCents, productSalesCents: s.productSalesCents })),
    (id) => {
      const p = person.get(id);
      const pr = profile.get(id);
      return { name: p?.label ?? "Unknown", isolvedName: pr?.isolvedName ?? [p?.last, p?.first].filter(Boolean).join(", ").toUpperCase(), employeeNumber: pr?.employeeNumber ?? null };
    },
    (id) => ({ name: shopRows.find((s) => s.id === id)?.name ?? "", payGroup: groups.find((g) => g.shopId === id)?.exportTab ?? shopRows.find((s) => s.id === id)?.name ?? "" }),
    { start: period.start, end: period.end },
  );
  const locked = await db.select({ shopId: timesheetLocks.shopId }).from(timesheetLocks).where(and(eq(timesheetLocks.periodStart, period.start), inArray(timesheetLocks.shopId, [...shopIds])));
  return { lines, draft: locked.length < shopIds.length, period };
}

/** The CSV file. A period that isn't locked at every shop in it comes out marked DRAFT. Every download is logged (without the numbers in it). */
export async function payrollCsv(periodStart: LocalDate, shopIds: readonly string[], format: ExportFormat, actor: Actor) {
  if (!shopIds.length) throw bad("Pick at least one shop.");
  const { lines, draft, period } = await exportData(periodStart, shopIds);
  const rules = await loadClockRules();
  const body = format === "isolved" ? mappedCsv(lines, rules.isolvedColumns) : genericCsv(lines);
  const fileName = `rayz-payroll-${period.start}-to-${period.end}-${format === "isolved" ? "isolved" : "all-fields"}${draft ? "-DRAFT" : ""}.csv`;
  await audit(actor, "payroll.export_csv", "pay_period", period.start, { format, periodEnd: period.end, shops: shopIds.length, rows: lines.length, draft }, shopIds.length === 1 ? shopIds[0] : null);
  return { fileName, body, draft };
}

// ───────────────────────────── Labor and attendance ─────────────────────────────

export interface LaborRow {
  staffId: string;
  shopId: string;
  workedMin: number;
  otMin: number;
  regularCost: number;
  otCost: number;
  serviceCents: number;
  productCents: number;
  rate: number | null;
}

/**
 * Clocked hours and their cost (hourly rate × hours, OT at the multiplier) per barber and shop over
 * [from, to], with their sales. A workweek's OT counts in the range when the week starts in it.
 */
export async function laborRows(shopIds: readonly string[], from: LocalDate, to: LocalDate, staffIds: readonly string[] | null): Promise<LaborRow[]> {
  if (!shopIds.length) return [];
  const { slices, entries, settings } = await hoursSlices(from, to, staffIds);
  const minutes = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== "worked" || !shopIds.includes(e.shopId)) continue;
    for (const p of splitByLocalDay(e)) if (p.date >= from && p.date <= to) minutes.set(`${e.staffId}|${e.shopId}`, (minutes.get(`${e.staffId}|${e.shopId}`) ?? 0) + p.minutes);
  }
  const ot = new Map<string, number>();
  for (const s of slices) if (shopIds.includes(s.shopId) && s.weekStart >= from && s.weekStart <= to) ot.set(`${s.staffId}|${s.shopId}`, (ot.get(`${s.staffId}|${s.shopId}`) ?? 0) + s.ot);
  const sales = await payrollSalesBetween({ shopIds: [...shopIds], staffIds: staffIds ? [...staffIds] : null }, from, to);
  const keys = new Set([...minutes.keys(), ...ot.keys(), ...sales.filter((s) => s.serviceSalesCents || s.productSalesCents).map((s) => `${s.staffId}|${s.shopId}`)]);
  const ids = [...new Set([...keys].map((k) => k.split("|")[0]))];
  const rates = ids.length ? await db.select().from(payrollRates).where(inArray(payrollRates.staffId, ids)) : [];
  const rateOf = (sid: string, shopId: string) => rates.find((r) => r.staffId === sid && r.shopId === shopId) ?? rates.find((r) => r.staffId === sid && r.shopId === null);
  return [...keys].map((k) => {
    const [staffId, shopId] = k.split("|");
    const workedMin = Math.round(minutes.get(k) ?? 0);
    const otMin = Math.min(workedMin, Math.round(((ot.get(k) ?? 0) * 60) / 100));
    const rate = rateOf(staffId, shopId)?.hourlyRate ?? null;
    const s = sales.find((x) => x.staffId === staffId && x.shopId === shopId);
    return {
      staffId,
      shopId,
      workedMin,
      otMin,
      regularCost: Math.round(((workedMin - otMin) / 60) * (rate ?? 0) * 100),
      otCost: Math.round((otMin / 60) * (rate ?? 0) * settings.otMultiplier * 100),
      serviceCents: s?.serviceSalesCents ?? 0,
      productCents: s?.productSalesCents ?? 0,
      rate,
    };
  });
}
