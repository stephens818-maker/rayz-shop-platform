import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { payGroups, payrollEmployers, payrollRuns, shops, timesheetLocks } from "@/db/schema";
import { periodOf, type PayCalendar } from "@/domain/payroll/calendar";
import type { PayrollSettings } from "@/domain/payroll/calc";
import { settingAt } from "../brand-sync/settings";
import { stripePayoutsOn } from "../tips/payout-model";
import type { LocalDate } from "@/lib/time";
import { audit, type Actor } from "../audit";
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

/** The payroll rules (the payroll setting): one for the whole brand. */
/** With direct Stripe payouts on, the file always marks tips already paid out, whatever was saved before. */
export async function loadSettings(): Promise<PayrollSettings> {
  const s = await settingAt<PayrollSettings>("payroll");
  return stripePayoutsOn() && !s.markPaidTips ? { ...s, markPaidTips: true } : s;
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

/** The employers (one FEIN each) the pay groups belong to, with how many shops each has. Made from the pay groups' legal entity. */
export async function payrollEmployerList() {
  const [list, groups] = await Promise.all([db.select().from(payrollEmployers).orderBy(payrollEmployers.legalName), db.select({ employerId: payGroups.employerId }).from(payGroups)]);
  return list.map((e) => ({ ...e, shops: groups.filter((g) => g.employerId === e.id).length }));
}

/**
 * An employer's iSolved company code and the last 4 of its EIN, for the tips-paid export. Only four
 * digits are ever taken: anything longer is refused, so a full EIN never reaches the database.
 */
export async function saveEmployer(id: string, v: { isolvedCompanyCode: string; taxIdLast4: string }, actor: Actor): Promise<string | null> {
  const code = v.isolvedCompanyCode.trim();
  const last4 = v.taxIdLast4.trim();
  if (code && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(code)) return "The iSolved company code is letters, digits, spaces, dots, dashes or underscores, up to 40.";
  if (last4 && !/^\d{4}$/.test(last4)) return "Enter only the last 4 digits of the EIN, never the whole number.";
  const [before] = await db.select().from(payrollEmployers).where(eq(payrollEmployers.id, id));
  if (!before) return "That employer is gone.";
  await db
    .update(payrollEmployers)
    .set({ isolvedCompanyCode: code || null, taxIdLast4: last4 || null, updatedAt: new Date() })
    .where(eq(payrollEmployers.id, id));
  await audit(actor, "payroll.employer", "payroll_employer", id, {
    legalName: before.legalName,
    from: { isolvedCompanyCode: before.isolvedCompanyCode, taxIdLast4: before.taxIdLast4 },
    to: { isolvedCompanyCode: code || null, taxIdLast4: last4 || null },
  });
  return null;
}
