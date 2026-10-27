import "server-only";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { sales, shopCutovers, shops, staff, staffPayoutConfirmations, staffShops, staffYtdImports } from "@/db/schema";
import { same } from "@/domain/brand-sync";
import { periodOf } from "@/domain/payroll/calendar";
import Papa from "papaparse";
import { addDays, isValidLocalDate, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "./audit";
import { AppError, notFound } from "./errors";
import { DEFAULT_CALENDAR, ensurePayGroups } from "./payroll/groups";
import { stripePayoutsOn } from "./tips/payout-model";

/**
 * Tip payouts across the Squire cutover (ST-C9, staff plan §6): per barber, the tips Squire still
 * owes (Squire tickets after Squire's last payout statement, up to the last day Squire pays the shop's
 * tips), Squire's last payout date, and the first Ray'z payout (the check date of the pay period
 * after Squire stops, as tips are paid through payroll). Each barber confirms or disputes their line
 * in the staff app, the manager signs the report off, and year-to-date tips and sales from Squire come
 * in so the year's totals and the W-2 reconcile. Squire pays what it owes; nothing here moves money.
 */

const bad = (m: string, field?: string) => new AppError("bad_request", m, field ? { field } : undefined);

export interface PayoutCutoverLine {
  staffId: string;
  name: string;
  squireOwedCents: number;
  tickets: number;
  confirmation: { status: "confirmed" | "disputed"; note: string | null; decidedAt: string; current: boolean } | null;
}

export interface PayoutCutoverReport {
  shopId: string;
  shop: string;
  squirePaidThrough: LocalDate | null;
  squireTipsEndOn: LocalDate | null;
  squireLastPayoutOn: LocalDate | null;
  firstRayzPayout: { periodStart: LocalDate; periodEnd: LocalDate; checkDate: LocalDate; via: "payroll" | "stripe" } | null;
  lines: PayoutCutoverLine[];
  totals: { squireOwedCents: number; confirmed: number; disputed: number; waiting: number };
  ready: boolean;
  signedOff: { at: string; by: string | null; current: boolean } | null;
}

async function cutoverRow(shopId: string) {
  const [r] = await db.select({ c: shopCutovers, shop: shops.name }).from(shops).leftJoin(shopCutovers, eq(shopCutovers.shopId, shops.id)).where(eq(shops.id, shopId));
  if (!r) throw notFound("Shop");
  return r;
}

/** Squire tickets' tips per barber in (paidThrough, tipsEndOn]: what Squire's remaining payouts owe them. */
async function squireOwed(shopId: string, paidThrough: LocalDate | null, endOn: LocalDate) {
  return db
    .select({ staffId: sales.staffId, cents: sql<number>`coalesce(sum(${sales.tipCents}), 0)::int`, tickets: sql<number>`count(*)::int` })
    .from(sales)
    .where(and(eq(sales.shopId, shopId), eq(sales.isImported, true), inArray(sales.status, ["paid", "refunded", "partially_refunded"]), lte(sales.businessDate, endOn), paidThrough ? gt(sales.businessDate, paidThrough) : undefined))
    .groupBy(sales.staffId);
}

/** The first Ray'z payout of tips after Squire stops: the pay period holding the next day, paid on its check date. */
async function firstPayout(shopId: string, endOn: LocalDate) {
  const g = (await ensurePayGroups()).find((x) => x.shopId === shopId);
  const p = periodOf(g?.calendar ?? DEFAULT_CALENDAR, addDays(endOn, 1));
  return { periodStart: p.start, periodEnd: p.end, checkDate: p.checkDate, via: stripePayoutsOn() ? ("stripe" as const) : ("payroll" as const) };
}

export async function payoutCutoverReport(shopId: string): Promise<PayoutCutoverReport> {
  const { c, shop } = await cutoverRow(shopId);
  const endOn = c?.squireTipsEndOn ?? null;
  const owed = endOn ? await squireOwed(shopId, c?.squirePaidThrough ?? null, endOn) : [];
  const team = await db
    .select({ id: staff.id, label: staff.displayLabel })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), eq(staff.kind, "person"), eq(staff.active, true)));
  const ids = [...new Set([...team.map((t) => t.id), ...owed.map((o) => o.staffId).filter((x): x is string => !!x)])];
  const [names, answers] = ids.length
    ? await Promise.all([
        db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, ids)),
        db.select().from(staffPayoutConfirmations).where(and(eq(staffPayoutConfirmations.shopId, shopId), inArray(staffPayoutConfirmations.staffId, ids))),
      ])
    : [[], []];
  const label = new Map(names.map((n) => [n.id, n.label]));
  const lines: PayoutCutoverLine[] = ids
    .map((id) => {
      const o = owed.find((x) => x.staffId === id);
      const cents = o?.cents ?? 0;
      const a = answers.find((x) => x.staffId === id);
      return {
        staffId: id,
        name: label.get(id) ?? "Someone",
        squireOwedCents: cents,
        tickets: o?.tickets ?? 0,
        confirmation: a ? { status: a.status, note: a.note, decidedAt: a.decidedAt.toISOString(), current: a.squireOwedCents === cents } : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const current = (l: PayoutCutoverLine) => !!l.confirmation?.current;
  const signedBy = c?.payoutReportSignedBy ? ((await db.query.staff.findFirst({ where: eq(staff.id, c.payoutReportSignedBy), columns: { displayLabel: true } }))?.displayLabel ?? null) : null;
  const report: PayoutCutoverReport = {
    shopId,
    shop,
    squirePaidThrough: c?.squirePaidThrough ?? null,
    squireTipsEndOn: endOn,
    squireLastPayoutOn: c?.squireLastPayoutOn ?? null,
    firstRayzPayout: endOn ? await firstPayout(shopId, endOn) : null,
    lines,
    totals: {
      squireOwedCents: lines.reduce((s, l) => s + l.squireOwedCents, 0),
      confirmed: lines.filter((l) => current(l) && l.confirmation!.status === "confirmed").length,
      disputed: lines.filter((l) => current(l) && l.confirmation!.status === "disputed").length,
      waiting: lines.filter((l) => !current(l)).length,
    },
    ready: !!endOn && !!c?.squireLastPayoutOn,
    signedOff: null,
  };
  if (c?.payoutReportSignedAt) report.signedOff = { at: c.payoutReportSignedAt.toISOString(), by: signedBy, current: same(c.payoutReport, signable(report)) };
  return report;
}

/** What the manager signs: the dates and each barber's owed amount and answer. */
const signable = (r: PayoutCutoverReport) => ({
  squirePaidThrough: r.squirePaidThrough,
  squireTipsEndOn: r.squireTipsEndOn,
  squireLastPayoutOn: r.squireLastPayoutOn,
  firstRayzPayout: r.firstRayzPayout,
  lines: r.lines.map((l) => ({ staffId: l.staffId, squireOwedCents: l.squireOwedCents, answer: l.confirmation?.current ? l.confirmation.status : null })),
});

/** Squire's last payout statement covers tips through `paidThrough`; its last payout of this shop's tips is on `lastPayoutOn`. */
export async function setPayoutCutoverDates(actor: Actor, shopId: string, v: { paidThrough: LocalDate | null; lastPayoutOn: LocalDate | null }, now = new Date()) {
  for (const [k, d] of Object.entries(v)) if (d !== null && !isValidLocalDate(d)) throw bad("Enter a date", k);
  const { c } = await cutoverRow(shopId);
  const end = c?.squireTipsEndOn ?? null;
  if (v.paidThrough && end && v.paidThrough > end) throw bad("Squire's last statement can't cover days after it stops paying this shop's tips", "paidThrough");
  if (v.lastPayoutOn && v.paidThrough && v.lastPayoutOn < v.paidThrough) throw bad("Squire's last payout is on or after the last day it covers", "lastPayoutOn");
  await db
    .insert(shopCutovers)
    .values({ shopId, squirePaidThrough: v.paidThrough, squireLastPayoutOn: v.lastPayoutOn, updatedAt: now })
    .onConflictDoUpdate({ target: shopCutovers.shopId, set: { squirePaidThrough: v.paidThrough, squireLastPayoutOn: v.lastPayoutOn, updatedAt: now } });
  await audit(actor, "cutover.payout_dates", "shop", shopId, { squirePaidThrough: v.paidThrough, squireLastPayoutOn: v.lastPayoutOn }, shopId);
}

/** The manager signs the report off once the dates are in and nobody's line is disputed; a later change shows it needs signing again. */
export async function signOffPayoutReport(actor: Actor, shopId: string, now = new Date()) {
  const r = await payoutCutoverReport(shopId);
  if (!r.ready) throw new AppError("conflict", "Enter the last day Squire pays this shop's tips and the date of Squire's last payout first");
  if (r.totals.disputed) throw new AppError("conflict", `${r.totals.disputed} barber${r.totals.disputed === 1 ? " disputes" : "s dispute"} what Squire owes them. Settle it with them first.`);
  const report = signable(r);
  await db.update(shopCutovers).set({ payoutReport: report, payoutReportSignedBy: actor.staffId ?? null, payoutReportSignedAt: now, updatedAt: now }).where(eq(shopCutovers.shopId, shopId));
  await audit(actor, "cutover.payout_report_sign_off", "shop", shopId, { barbers: r.lines.length, squireOwedCents: r.totals.squireOwedCents, confirmed: r.totals.confirmed, waiting: r.totals.waiting }, shopId);
  return payoutCutoverReport(shopId);
}

// ───────────────────────────── The barber's side (staff app) ─────────────────────────────

/** Every shop of theirs with a Squire tips end date: their own line only, never anyone else's. */
export async function myPayoutCutover(staffId: string, shopIds: readonly string[]) {
  if (!shopIds.length) return { shops: [] };
  const rows = await db.select({ shopId: shopCutovers.shopId }).from(shopCutovers).where(and(inArray(shopCutovers.shopId, [...shopIds]), sql`${shopCutovers.squireTipsEndOn} is not null`)).orderBy(asc(shopCutovers.shopId));
  const out = [];
  for (const { shopId } of rows) {
    const r = await payoutCutoverReport(shopId);
    const mine = r.lines.find((l) => l.staffId === staffId);
    if (!mine) continue;
    out.push({
      shopId,
      shop: r.shop,
      squireTipsEndOn: r.squireTipsEndOn,
      squireLastPayoutOn: r.squireLastPayoutOn,
      squireOwedCents: mine.squireOwedCents,
      tickets: mine.tickets,
      firstRayzPayout: r.firstRayzPayout,
      answer: mine.confirmation,
      needsAnswer: r.ready && !mine.confirmation?.current,
    });
  }
  return { shops: out };
}

/** POST /me/payout-cutover/confirm: they agree with their line, or say what's wrong with it. */
export async function answerPayoutCutover(actor: Actor, staffId: string, shopId: string, v: { status: "confirmed" | "disputed"; note?: string | null }, now = new Date()) {
  const r = await payoutCutoverReport(shopId);
  const mine = r.lines.find((l) => l.staffId === staffId);
  if (!mine || !r.squireTipsEndOn) throw notFound("Payout cutover");
  if (!r.ready) throw new AppError("conflict", "The shop hasn't finished the Squire payout dates yet");
  const note = v.note?.trim() || null;
  if (v.status === "disputed" && !note) throw bad("Say what looks wrong, so the manager can check it", "note");
  if (note && note.length > 500) throw bad("Keep it under 500 characters", "note");
  const values = { status: v.status, squireOwedCents: mine.squireOwedCents, note, decidedAt: now };
  await db
    .insert(staffPayoutConfirmations)
    .values({ shopId, staffId, ...values })
    .onConflictDoUpdate({ target: [staffPayoutConfirmations.shopId, staffPayoutConfirmations.staffId], set: values });
  await audit(actor, `cutover.payout_${v.status}`, "staff", staffId, { squireOwedCents: mine.squireOwedCents, note: v.status === "disputed" ? note : null }, shopId);
  return myPayoutCutover(staffId, [shopId]);
}

// ───────────────────────────── Year to date from Squire ─────────────────────────────

const money = (v: string | undefined) => {
  const s = (v ?? "").replace(/[$,\s]/g, "");
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

/**
 * Squire's year-to-date tips and sales per barber at one shop, from a CSV with a header row:
 * barber (their staff code or name as it appears here), card_tips, cash_tips, service_sales,
 * product_sales, paid_out (tips Squire paid them directly), in dollars. A second import for the
 * same year replaces the first. Rows that match nobody come back by number; nothing is guessed.
 */
export async function importYtd(actor: Actor, shopId: string, v: { year: number; throughDate: LocalDate; csv: string }, now = new Date()) {
  if (!Number.isInteger(v.year) || v.year < 2020 || v.year > 2100) throw bad("Pick the year", "year");
  if (!isValidLocalDate(v.throughDate) || Number(v.throughDate.slice(0, 4)) !== v.year) throw bad("The through date is in that year", "throughDate");
  const rows = Papa.parse<string[]>(v.csv.trim(), { skipEmptyLines: true }).data;
  if (rows.length < 2) throw bad("The file needs a header row and at least one barber", "csv");
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, ""));
  const col = (k: string) => head.indexOf(k);
  if (col("barber") < 0) throw bad("The file needs a barber column (staff code or name)", "csv");
  const team = await db
    .select({ id: staff.id, code: staff.staffCode, label: staff.displayLabel, first: staff.firstName, last: staff.lastName })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), eq(staff.kind, "person")));
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const find = (key: string) => {
    const k = norm(key);
    const hits = team.filter((t) => norm(t.code) === k || norm(t.label) === k || norm(`${t.first} ${t.last ?? ""}`) === k);
    return hits.length === 1 ? hits[0] : null;
  };
  const unmatched: number[] = [];
  const invalid: number[] = [];
  const saved = new Set<string>();
  for (const [i, r] of rows.slice(1).entries()) {
    if (r.every((x) => !x.trim())) continue;
    const who = find(r[col("barber")] ?? "");
    if (!who) {
      unmatched.push(i + 2);
      continue;
    }
    const get = (k: string) => (col(k) < 0 ? 0 : money(r[col(k)]));
    const amounts = { cardTipsCents: get("card_tips"), cashTipsCents: get("cash_tips"), serviceSalesCents: get("service_sales"), productSalesCents: get("product_sales"), paidOutCents: get("paid_out") };
    if (Object.values(amounts).some((x) => x === null)) {
      invalid.push(i + 2);
      continue;
    }
    const set = { ...(amounts as Record<keyof typeof amounts, number>), throughDate: v.throughDate, importedBy: actor.staffId ?? null, updatedAt: now };
    await db
      .insert(staffYtdImports)
      .values({ staffId: who.id, shopId, year: v.year, source: "squire", ...set })
      .onConflictDoUpdate({ target: [staffYtdImports.staffId, staffYtdImports.shopId, staffYtdImports.year, staffYtdImports.source], set });
    saved.add(who.id);
  }
  await audit(actor, "cutover.ytd_import", "shop", shopId, { year: v.year, throughDate: v.throughDate, barbers: saved.size, unmatched: unmatched.length, invalid: invalid.length }, shopId);
  return { imported: saved.size, unmatched, invalid };
}

export async function ytdImports(shopId: string, year: number) {
  return db
    .select({ staffId: staffYtdImports.staffId, name: staff.displayLabel, throughDate: staffYtdImports.throughDate, cardTipsCents: staffYtdImports.cardTipsCents, cashTipsCents: staffYtdImports.cashTipsCents, serviceSalesCents: staffYtdImports.serviceSalesCents, productSalesCents: staffYtdImports.productSalesCents, paidOutCents: staffYtdImports.paidOutCents })
    .from(staffYtdImports)
    .innerJoin(staff, eq(staff.id, staffYtdImports.staffId))
    .where(and(eq(staffYtdImports.shopId, shopId), eq(staffYtdImports.year, year)))
    .orderBy(asc(staff.displayLabel));
}
