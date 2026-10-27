import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { payGroups, payrollEmployerStates, payrollEmployers, payrollRuns, shops, timesheetLocks } from "@/db/schema";
import { DEFAULT_BRAND_CALENDAR, periodOf, type PayCalendar } from "@/domain/payroll/calendar";
import type { PayrollSettings } from "@/domain/payroll/calc";
import { workStateOf } from "@/domain/wage-hour";
import { settingAt } from "../brand-sync/settings";
import { stripePayoutsOn } from "../tips/payout-model";
import type { LocalDate } from "@/lib/time";
import { audit, type Actor } from "../audit";
import { TEMPLATE_TABS } from "./export";
import { groupCalendar, storedPeriodDates } from "./period-dates";

export { groupCalendar } from "./period-dates";

/** Until the brand saves its own calendar (the payroll setting): period 22 = 10/4–10/17/2026, due 10/21, check 10/23. */
export const DEFAULT_CALENDAR: PayCalendar = DEFAULT_BRAND_CALENDAR;

/** The brand's pay calendar (Payroll setup), matched to iSolved's. New pay groups start on it; a shop on its own calendar is edited in Payroll setup. */
export async function brandCalendar(tx: DBorTx = db): Promise<PayCalendar> {
  return (await settingAt<PayrollSettings>("payroll", null, tx)).calendar;
}

export interface PayGroup {
  id: string;
  shopId: string;
  shop: string;
  label: string;
  legalEntity: string;
  employerId: string | null;
  /** The shop's work state (its address), whose wage-hour rules and withholding apply. Null when the address has none. */
  workState: string | null;
  exportTab: string;
  /** iSolved's pay group code (B is Rock Island), picked at upload. Null until entered. */
  code: string | null;
  /** With each period's stored check and submit-by dates. */
  calendar: PayCalendar;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** The pay group codes iSolved has given so far (still being confirmed); the rest are entered on Payroll → Setup. */
export const KNOWN_PAY_GROUP_CODES: Readonly<Record<string, string>> = { rockisland: "B", moline: "C" };

/** Every open shop gets a pay group the first time payroll looks: labelled after the shop, on the brand's calendar. Never the Demo Shop (ST-I19). */
export async function ensurePayGroups(): Promise<PayGroup[]> {
  const list = await db.select({ id: shops.id, name: shops.name, pg: payGroups.id }).from(shops).leftJoin(payGroups, eq(payGroups.shopId, shops.id)).where(and(eq(shops.active, true), eq(shops.isDemo, false)));
  const missing = list.filter((s) => !s.pg);
  if (missing.length) {
    const cal = await brandCalendar();
    const taken = new Set((await db.select({ c: payGroups.isolvedCode }).from(payGroups)).map((r) => r.c));
    await db
      .insert(payGroups)
      .values(
        missing.map((s) => {
          return {
            shopId: s.id,
            label: s.name,
            exportTab: TEMPLATE_TABS.find((t) => norm(t) === norm(s.name)) ?? s.name,
            isolvedCode: taken.has(KNOWN_PAY_GROUP_CODES[norm(s.name)]) ? null : (KNOWN_PAY_GROUP_CODES[norm(s.name)] ?? null),
            anchorStart: cal.anchorStart,
            anchorNumber: cal.anchorNumber,
            periodDays: cal.periodDays,
            checkOffsetDays: cal.checkOffsetDays,
            submitOffsetDays: cal.submitOffsetDays,
            numberResetsYearly: cal.numberResetsYearly,
          };
        }),
      )
      .onConflictDoNothing();
  }
  const rows = await db.select({ g: payGroups, shop: shops.name, state: shops.state }).from(payGroups).innerJoin(shops, eq(shops.id, payGroups.shopId)).where(and(eq(shops.active, true), eq(shops.isDemo, false))).orderBy(shops.name);
  const dates = await storedPeriodDates(rows.map((r) => r.g));
  return rows.map(({ g, shop, state }) => ({
    id: g.id,
    shopId: g.shopId,
    shop,
    label: g.label,
    legalEntity: g.legalEntity,
    employerId: g.employerId,
    workState: workStateOf(state),
    exportTab: g.exportTab,
    code: g.isolvedCode,
    calendar: groupCalendar(g, dates.get(g.id)),
  }));
}

/** The payroll rules (the payroll setting): one for the whole brand. */
/** With direct Stripe payouts on, the file always marks tips already paid out, whatever was saved before. */
export async function loadSettings(): Promise<PayrollSettings> {
  const s = await settingAt<PayrollSettings>("payroll");
  return stripePayoutsOn() && !s.markPaidTips ? { ...s, markPaidTips: true } : s;
}

/** Whether a shop's pay period holding `date` is locked; time and overrides in it can't change then. */
export async function isLockedOn(shopId: string, date: LocalDate, tx: DBorTx = db): Promise<boolean> {
  const [g] = await tx.select().from(payGroups).where(eq(payGroups.shopId, shopId));
  if (!g) return false;
  const p = periodOf(groupCalendar(g), date);
  const [r] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.payGroupId, g.id), eq(payrollRuns.periodStart, p.start)));
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

/** The employers (one FEIN each) the pay groups belong to, with their shops, the states those shops are in, and the states the employer is registered in. Made from the pay groups' legal entity. */
export async function payrollEmployerList() {
  const [list, groups, states] = await Promise.all([
    db.select().from(payrollEmployers).orderBy(payrollEmployers.legalName),
    db.select({ employerId: payGroups.employerId, shop: shops.name, state: shops.state }).from(payGroups).innerJoin(shops, eq(shops.id, payGroups.shopId)).orderBy(shops.name),
    db.select().from(payrollEmployerStates).orderBy(payrollEmployerStates.state),
  ]);
  return list.map((e) => {
    const mine = groups.filter((g) => g.employerId === e.id);
    const registered = states.filter((s) => s.employerId === e.id);
    const workStates = [...new Set(mine.map((g) => g.state.trim().toUpperCase()).filter((s) => US_STATE.test(s)))].sort();
    return {
      ...e,
      shops: mine.length,
      shopNames: mine.map((g) => g.shop),
      workStates,
      states: registered,
      unregistered: workStates.filter((s) => !registered.some((r) => r.state === s)),
    };
  });
}

const US_STATE = /^[A-Z]{2}$/;
const LAST4 = /^\d{4}$/;

/**
 * A legal entity's registration in a state: the last 4 of its withholding and unemployment account
 * numbers and when it registered. Like the EIN, anything longer than four digits is refused.
 */
export async function saveEmployerState(
  employerId: string,
  v: { state: string; withholdingIdLast4: string; unemploymentIdLast4: string; registeredOn: string | null },
  actor: Actor,
): Promise<string | null> {
  const state = v.state.trim().toUpperCase();
  const wh = v.withholdingIdLast4.trim();
  const ui = v.unemploymentIdLast4.trim();
  if (!US_STATE.test(state)) return "Enter the state's two-letter code, like IL or IA.";
  if ((wh && !LAST4.test(wh)) || (ui && !LAST4.test(ui))) return "Enter only the last 4 digits of the state account number, never the whole number.";
  const [e] = await db.select().from(payrollEmployers).where(eq(payrollEmployers.id, employerId));
  if (!e) return "That employer is gone.";
  const row = { withholdingIdLast4: wh || null, unemploymentIdLast4: ui || null, registeredOn: v.registeredOn || null };
  const [before] = await db.select().from(payrollEmployerStates).where(and(eq(payrollEmployerStates.employerId, employerId), eq(payrollEmployerStates.state, state)));
  await db
    .insert(payrollEmployerStates)
    .values({ employerId, state, ...row })
    .onConflictDoUpdate({ target: [payrollEmployerStates.employerId, payrollEmployerStates.state], set: { ...row, updatedAt: new Date() } });
  await audit(actor, "payroll.employer_state", "payroll_employer", employerId, {
    legalName: e.legalName,
    state,
    from: before ? { withholdingIdLast4: before.withholdingIdLast4, unemploymentIdLast4: before.unemploymentIdLast4, registeredOn: before.registeredOn } : null,
    to: row,
  });
  return null;
}

export async function removeEmployerState(employerId: string, state: string, actor: Actor): Promise<string | null> {
  const gone = await db
    .delete(payrollEmployerStates)
    .where(and(eq(payrollEmployerStates.employerId, employerId), eq(payrollEmployerStates.state, state.trim().toUpperCase())))
    .returning();
  if (!gone.length) return "That state registration is gone.";
  await audit(actor, "payroll.employer_state_removed", "payroll_employer", employerId, { state: gone[0].state });
  return null;
}

/** Each shop's legal entity: its employer's name, iSolved company code and EIN last 4. */
export async function legalEntitiesOf(shopIds: readonly string[], tx: DBorTx = db) {
  if (!shopIds.length) return new Map<string, LegalEntity>();
  const rows = await tx
    .select({ shopId: shops.id, id: payrollEmployers.id, legalName: payrollEmployers.legalName, isolvedCompanyCode: payrollEmployers.isolvedCompanyCode, taxIdLast4: payrollEmployers.taxIdLast4 })
    .from(shops)
    .innerJoin(payrollEmployers, eq(payrollEmployers.id, shops.legalEntityId))
    .where(inArray(shops.id, [...shopIds]));
  return new Map(rows.map(({ shopId, ...e }) => [shopId, e]));
}

export interface LegalEntity {
  id: string;
  legalName: string;
  isolvedCompanyCode: string | null;
  taxIdLast4: string | null;
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
