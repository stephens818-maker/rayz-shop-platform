import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings, payGroups, payrollRuns, shops, timesheetLocks } from "@/db/schema";
import { periodOf, type PayCalendar } from "@/domain/payroll/calendar";
import { payrollSettings, type PayrollSettings } from "@/domain/payroll/calc";
import type { LocalDate } from "@/lib/time";
import { TEMPLATE_TABS } from "./export";

/** The brand's calendar (period 23 = 10/18–10/31/2026). A shop on its own calendar gets a pay group when it's set up, or one is edited in Payroll setup. */
export const DEFAULT_CALENDAR: PayCalendar = { anchorStart: "2026-10-18", anchorNumber: 23, periodDays: 14, checkOffsetDays: 6, numberResetsYearly: true };

export interface PayGroup {
  id: string;
  shopId: string;
  shop: string;
  label: string;
  legalEntity: string;
  exportTab: string;
  calendar: PayCalendar;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Every open shop gets a pay group the first time payroll looks: labelled after the shop, on the brand's calendar. */
export async function ensurePayGroups(): Promise<PayGroup[]> {
  const list = await db.select({ id: shops.id, name: shops.name, pg: payGroups.id }).from(shops).leftJoin(payGroups, eq(payGroups.shopId, shops.id)).where(eq(shops.active, true));
  const missing = list.filter((s) => !s.pg);
  if (missing.length) {
    await db
      .insert(payGroups)
      .values(
        missing.map((s) => {
          const cal = DEFAULT_CALENDAR;
          return {
            shopId: s.id,
            label: s.name,
            exportTab: TEMPLATE_TABS.find((t) => norm(t) === norm(s.name)) ?? s.name,
            anchorStart: cal.anchorStart,
            anchorNumber: cal.anchorNumber,
            periodDays: cal.periodDays,
            checkOffsetDays: cal.checkOffsetDays,
            numberResetsYearly: cal.numberResetsYearly,
          };
        }),
      )
      .onConflictDoNothing();
  }
  const rows = await db.select({ g: payGroups, shop: shops.name }).from(payGroups).innerJoin(shops, eq(shops.id, payGroups.shopId)).where(eq(shops.active, true)).orderBy(shops.name);
  return rows.map(({ g, shop }) => ({
    id: g.id,
    shopId: g.shopId,
    shop,
    label: g.label,
    legalEntity: g.legalEntity,
    exportTab: g.exportTab,
    calendar: { anchorStart: g.anchorStart, anchorNumber: g.anchorNumber, periodDays: g.periodDays, checkOffsetDays: g.checkOffsetDays, numberResetsYearly: g.numberResetsYearly },
  }));
}

export async function loadSettings(): Promise<PayrollSettings> {
  const [b] = await db.select({ payroll: brandSettings.payroll }).from(brandSettings).limit(1);
  return payrollSettings(b?.payroll);
}

/** Whether a shop's pay period holding `date` is locked; time and overrides in it can't change then. */
export async function isLockedOn(shopId: string, date: LocalDate): Promise<boolean> {
  const [g] = await db.select().from(payGroups).where(eq(payGroups.shopId, shopId));
  const cal = g ? { anchorStart: g.anchorStart, anchorNumber: g.anchorNumber, periodDays: g.periodDays, checkOffsetDays: g.checkOffsetDays, numberResetsYearly: g.numberResetsYearly } : DEFAULT_CALENDAR;
  const p = periodOf(cal, date);
  if (!g) return false;
  const [r] = await db.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.payGroupId, g.id), eq(payrollRuns.periodStart, p.start)));
  return !!r;
}

/** Hours at a shop on a date can't change: its timesheets are locked for the period, or the pay period is approved and locked. */
export async function hoursLockedOn(shopId: string, date: LocalDate): Promise<boolean> {
  const [t] = await db
    .select({ s: timesheetLocks.periodStart })
    .from(timesheetLocks)
    .where(and(eq(timesheetLocks.shopId, shopId), lte(timesheetLocks.periodStart, date), gte(timesheetLocks.periodEnd, date)));
  return !!t || isLockedOn(shopId, date);
}
