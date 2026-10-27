import "server-only";
import { and, asc, eq, gt, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { sales, shopCutovers, shops, staff, staffPayoutConfirmations, staffShops, staffYtdImports } from "@/db/schema";
import { same } from "@/domain/brand-sync";
import { periodOf } from "@/domain/payroll/calendar";
import Papa from "papaparse";
import { addDays, formatDate, isValidLocalDate, localDateOf, todayLocal, weekdayOf, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "./audit";
import { AppError, notFound } from "./errors";
import { notSquireEra, squireEra } from "./squire-era";
import { DEFAULT_CALENDAR, ensurePayGroups } from "./payroll/groups";
import { stripePayoutsOn } from "./tips/payout-model";

/**
 * Tip payouts across the Squire cutover (ST-C9, staff plan §6): per barber, the tips Squire still
 * owes (Squire tickets after Squire's last payout statement, up to the last day Squire pays the shop's
 * tips), Squire's last payout date, and the first Ray'z payout (the check date of the pay period
 * after Squire stops, as tips are paid through payroll). Each barber confirms or disputes their line
 * in the staff app, the manager signs the report off, and year-to-date tips and sales from Squire come
 * in so the year's totals and the W-2 reconcile. Squire pays what it owes; nothing here moves money.
 *
 * The checklist on top (ST-C9): Squire stops at a Saturday close, so the first Ray'z week starts on
 * a Sunday; one owner per tip date (Squire through that Saturday, Ray'z after); a three-way tie-out
 * of Squire's tickets, Squire's final statement and the barbers' answers, signed by the manager and
 * then the CPA; and year-to-date figures from Squire, prior years too where the CPA wants them.
 */

const bad = (m: string, field?: string) => new AppError("bad_request", m, field ? { field } : undefined);

export interface PayoutCutoverLine {
  staffId: string;
  name: string;
  squireOwedCents: number;
  tickets: number;
  confirmation: { status: "confirmed" | "disputed"; note: string | null; decidedAt: string; current: boolean } | null;
}

export type CutoverCheckKey = "saturday_close" | "squire_dates" | "one_owner" | "tie_out" | "barbers" | "manager" | "cpa" | "ytd";

export interface CutoverCheck {
  key: CutoverCheckKey;
  label: string;
  done: boolean;
  detail: string;
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
  /** Squire's last tips day is a Saturday (null until it's set). */
  saturdayClose: boolean | null;
  /** Tickets whose tips the other side would pay: Ray'z tickets in the days Squire still owes, and Squire tickets after Squire stops. */
  owners: { rayzInSquireDays: { tickets: number; tipCents: number }; squireAfterEnd: { tickets: number; tipCents: number } };
  tieOut: { ticketsCents: number; statementCents: number | null; confirmedCents: number; matched: boolean };
  cpa: { name: string; signedOn: LocalDate; recordedAt: string; by: string | null; current: boolean } | null;
  checklist: CutoverCheck[];
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
    .where(and(eq(sales.shopId, shopId), squireEra("sales"), inArray(sales.status, ["paid", "refunded", "partially_refunded"]), lte(sales.businessDate, endOn), paidThrough ? gt(sales.businessDate, paidThrough) : undefined))
    .groupBy(sales.staffId);
}

const tipTickets = (shopId: string, ...where: (SQL | undefined)[]) =>
  db
    .select({ tickets: sql<number>`count(*)::int`, tipCents: sql<number>`coalesce(sum(${sales.tipCents}), 0)::int` })
    .from(sales)
    .where(and(eq(sales.shopId, shopId), inArray(sales.status, ["paid", "refunded", "partially_refunded"]), gt(sales.tipCents, 0), ...where))
    .then((r) => r[0]);

/** Who pays each tip date: Squire through its last tips day, Ray'z after. Anything on the wrong side would be paid twice or never. */
async function ownerConflicts(shopId: string, paidThrough: LocalDate | null, endOn: LocalDate) {
  const [rayzInSquireDays, squireAfterEnd] = await Promise.all([
    tipTickets(shopId, notSquireEra("sales"), lte(sales.businessDate, endOn), paidThrough ? gt(sales.businessDate, paidThrough) : undefined),
    tipTickets(shopId, squireEra("sales"), gt(sales.businessDate, endOn)),
  ]);
  return { rayzInSquireDays, squireAfterEnd };
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
  const nameOf = async (id: string | null | undefined) => (id ? ((await db.query.staff.findFirst({ where: eq(staff.id, id), columns: { displayLabel: true } }))?.displayLabel ?? null) : null);
  const signedBy = await nameOf(c?.payoutReportSignedBy);
  const owners = endOn ? await ownerConflicts(shopId, c?.squirePaidThrough ?? null, endOn) : { rayzInSquireDays: { tickets: 0, tipCents: 0 }, squireAfterEnd: { tickets: 0, tipCents: 0 } };
  const ticketsCents = lines.reduce((s, l) => s + l.squireOwedCents, 0);
  const confirmedCents = lines.filter((l) => current(l) && l.confirmation!.status === "confirmed").reduce((s, l) => s + l.squireOwedCents, 0);
  const statementCents = c?.squireStatementCents ?? null;
  const report: PayoutCutoverReport = {
    shopId,
    shop,
    squirePaidThrough: c?.squirePaidThrough ?? null,
    squireTipsEndOn: endOn,
    squireLastPayoutOn: c?.squireLastPayoutOn ?? null,
    firstRayzPayout: endOn ? await firstPayout(shopId, endOn) : null,
    lines,
    totals: {
      squireOwedCents: ticketsCents,
      confirmed: lines.filter((l) => current(l) && l.confirmation!.status === "confirmed").length,
      disputed: lines.filter((l) => current(l) && l.confirmation!.status === "disputed").length,
      waiting: lines.filter((l) => !current(l)).length,
    },
    ready: !!endOn && !!c?.squireLastPayoutOn,
    signedOff: null,
    saturdayClose: endOn ? weekdayOf(endOn) === 6 : null,
    owners,
    tieOut: { ticketsCents, statementCents, confirmedCents, matched: statementCents !== null && statementCents === ticketsCents && confirmedCents === ticketsCents },
    cpa: null,
    checklist: [],
  };
  if (c?.payoutReportSignedAt) report.signedOff = { at: c.payoutReportSignedAt.toISOString(), by: signedBy, current: same(c.payoutReport, signable(report)) };
  if (c?.cpaRecordedAt && c.cpaSignedName && c.cpaSignedOn)
    report.cpa = { name: c.cpaSignedName, signedOn: c.cpaSignedOn, recordedAt: c.cpaRecordedAt.toISOString(), by: await nameOf(c.cpaRecordedBy), current: same(c.cpaReport, signable(report)) };
  report.checklist = checklistOf(report, await ytdYears(shopId));
  return report;
}

async function ytdYears(shopId: string) {
  const rows = await db.selectDistinct({ year: staffYtdImports.year }).from(staffYtdImports).where(eq(staffYtdImports.shopId, shopId));
  return rows.map((r) => r.year).sort();
}

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** The cutover checklist, in order. A step that isn't done says what's missing. */
function checklistOf(r: PayoutCutoverReport, years: number[]): CutoverCheck[] {
  const { rayzInSquireDays: early, squireAfterEnd: late } = r.owners;
  const t = r.tieOut;
  const year = Number((r.squireTipsEndOn ?? todayLocal()).slice(0, 4));
  return [
    {
      key: "saturday_close",
      label: "Squire stops at a Saturday close",
      done: r.saturdayClose === true,
      detail: !r.squireTipsEndOn ? "Set the last day Squire pays this shop's tips." : r.saturdayClose ? `Squire's last tips day is ${formatDate(r.squireTipsEndOn, "EEEE, MMM d")}; Ray'z owns the week from Sunday.` : `${formatDate(r.squireTipsEndOn, "EEEE, MMM d")} isn't a Saturday: pick the Saturday the shop closes on, so no workweek is split.`,
    },
    {
      key: "squire_dates",
      label: "Squire's barber payouts end on a fixed date",
      done: r.ready,
      detail: r.ready ? `Squire's last payout is ${formatDate(r.squireLastPayoutOn!)}${r.squirePaidThrough ? `, its last statement covers through ${formatDate(r.squirePaidThrough)}` : ""}.` : "Enter the date of Squire's last payout, and through when its last statement covers.",
    },
    {
      key: "one_owner",
      label: "One owner for every tip date",
      done: !!r.squireTipsEndOn && !early.tickets && !late.tickets,
      detail: !r.squireTipsEndOn
        ? "Set Squire's last tips day first."
        : [
            early.tickets ? `${n(early.tickets, "Ray'z ticket")} (${dollars(early.tipCents)} in tips) fall in days Squire still pays: void them here or make sure Squire leaves them out.` : null,
            late.tickets ? `${n(late.tickets, "Squire ticket")} (${dollars(late.tipCents)} in tips) are after Squire stops, so nobody would pay them: ring them up here, or move Squire's last day.` : null,
          ]
            .filter(Boolean)
            .join(" ") || "Squire pays every tip through its last day, Ray'z every one after.",
    },
    {
      key: "tie_out",
      label: "Three-way tie-out: Squire's tickets, its statement, the barbers",
      done: t.matched,
      detail:
        t.statementCents === null
          ? `Enter the total of Squire's final statement; its tickets say ${dollars(t.ticketsCents)}.`
          : t.statementCents !== t.ticketsCents
            ? `Squire's statement says ${dollars(t.statementCents)} but its tickets say ${dollars(t.ticketsCents)}: a ${dollars(Math.abs(t.statementCents - t.ticketsCents))} difference to settle with Squire.`
            : t.confirmedCents !== t.ticketsCents
              ? `Tickets and statement agree at ${dollars(t.ticketsCents)}; barbers have confirmed ${dollars(t.confirmedCents)} of it.`
              : `${dollars(t.ticketsCents)} on Squire's tickets, its statement and the barbers' answers.`,
    },
    {
      key: "barbers",
      label: "Every barber confirms their line",
      done: r.lines.length > 0 && r.totals.waiting === 0 && r.totals.disputed === 0,
      detail: `${r.totals.confirmed} confirmed, ${r.totals.disputed} disputed, ${r.totals.waiting} waiting, in the staff app.`,
    },
    {
      key: "manager",
      label: "The manager signs the tie-out",
      done: !!r.signedOff?.current,
      detail: !r.signedOff ? "Not signed yet." : r.signedOff.current ? `Signed ${formatDate(r.signedOff.at)}${r.signedOff.by ? ` by ${r.signedOff.by}` : ""}.` : "Something changed since it was signed: sign it again.",
    },
    {
      key: "cpa",
      label: "The CPA signs the tie-out",
      done: !!r.cpa?.current,
      detail: !r.cpa ? "After the manager: an owner records the CPA's sign-off." : r.cpa.current ? `${r.cpa.name} signed ${formatDate(r.cpa.signedOn)}.` : "Something changed since the CPA signed: ask them again.",
    },
    {
      key: "ytd",
      label: "Year to date from Squire",
      done: years.includes(year),
      detail: years.length ? `Imported for ${years.join(", ")}.${years.includes(year) ? "" : ` ${year} is still missing.`} Earlier years can come in too, where the CPA asks.` : `Import Squire's ${year} year to date, so the year's totals and W-2s add up.`,
    },
  ];
}

/** What the manager and the CPA sign: the dates, Squire's statement total and each barber's owed amount and answer. */
const signable = (r: PayoutCutoverReport) => ({
  squireStatementCents: r.tieOut.statementCents,
  squirePaidThrough: r.squirePaidThrough,
  squireTipsEndOn: r.squireTipsEndOn,
  squireLastPayoutOn: r.squireLastPayoutOn,
  firstRayzPayout: r.firstRayzPayout,
  lines: r.lines.map((l) => ({ staffId: l.staffId, squireOwedCents: l.squireOwedCents, answer: l.confirmation?.current ? l.confirmation.status : null })),
});

/**
 * Squire's last payout statement covers tips through `paidThrough`; its last payout of this shop's
 * tips is on `lastPayoutOn`; `statementCents` is that statement's total still owed (left alone when
 * not given).
 */
export async function setPayoutCutoverDates(actor: Actor, shopId: string, v: { paidThrough: LocalDate | null; lastPayoutOn: LocalDate | null; statementCents?: number | null }, now = new Date()) {
  const { statementCents, ...dates } = v;
  for (const [k, d] of Object.entries(dates)) if (d !== null && !isValidLocalDate(d)) throw bad("Enter a date", k);
  if (statementCents !== undefined && statementCents !== null && !(Number.isInteger(statementCents) && statementCents >= 0 && statementCents < 1e9)) throw bad("Enter the statement's total in dollars and cents", "statementCents");
  const { c } = await cutoverRow(shopId);
  const end = c?.squireTipsEndOn ?? null;
  if (v.paidThrough && end && v.paidThrough > end) throw bad("Squire's last statement can't cover days after it stops paying this shop's tips", "paidThrough");
  if (v.lastPayoutOn && v.paidThrough && v.lastPayoutOn < v.paidThrough) throw bad("Squire's last payout is on or after the last day it covers", "lastPayoutOn");
  const set = { squirePaidThrough: v.paidThrough, squireLastPayoutOn: v.lastPayoutOn, ...(statementCents === undefined ? {} : { squireStatementCents: statementCents }), updatedAt: now };
  await db.insert(shopCutovers).values({ shopId, ...set }).onConflictDoUpdate({ target: shopCutovers.shopId, set });
  await audit(actor, "cutover.payout_dates", "shop", shopId, { squirePaidThrough: v.paidThrough, squireLastPayoutOn: v.lastPayoutOn, ...(statementCents === undefined ? {} : { squireStatementCents: statementCents }) }, shopId);
}

/** The manager signs the report off once the dates are in and nobody's line is disputed; a later change shows it needs signing again. */
export async function signOffPayoutReport(actor: Actor, shopId: string, now = new Date()) {
  const r = await payoutCutoverReport(shopId);
  if (!r.ready) throw new AppError("conflict", "Enter the last day Squire pays this shop's tips and the date of Squire's last payout first");
  if (r.totals.disputed) throw new AppError("conflict", `${r.totals.disputed} barber${r.totals.disputed === 1 ? " disputes" : "s dispute"} what Squire owes them. Settle it with them first.`);
  for (const k of ["saturday_close", "one_owner"] as const) {
    const step = r.checklist.find((x) => x.key === k)!;
    if (!step.done) throw new AppError("conflict", step.detail);
  }
  if (r.tieOut.statementCents === null || r.tieOut.statementCents !== r.tieOut.ticketsCents) throw new AppError("conflict", r.checklist.find((x) => x.key === "tie_out")!.detail);
  const report = signable(r);
  await db.update(shopCutovers).set({ payoutReport: report, payoutReportSignedBy: actor.staffId ?? null, payoutReportSignedAt: now, updatedAt: now }).where(eq(shopCutovers.shopId, shopId));
  await audit(actor, "cutover.payout_report_sign_off", "shop", shopId, { barbers: r.lines.length, squireOwedCents: r.totals.squireOwedCents, confirmed: r.totals.confirmed, waiting: r.totals.waiting }, shopId);
  return payoutCutoverReport(shopId);
}

/**
 * An owner records the CPA's sign-off of the tie-out the manager signed: the CPA's name and the day
 * they signed. Kept with the report as it stood; a later change shows it needs signing again.
 */
export async function recordCpaSignOff(actor: Actor, shopId: string, v: { name: string; signedOn: LocalDate }, now = new Date()) {
  const name = v.name.trim();
  if (name.length < 2 || name.length > 120) throw bad("Enter the CPA's name", "name");
  if (!isValidLocalDate(v.signedOn) || v.signedOn > todayLocal(now)) throw bad("Enter the day the CPA signed, today or earlier", "signedOn");
  const r = await payoutCutoverReport(shopId);
  if (!r.signedOff?.current) throw new AppError("conflict", "The manager signs the tie-out first; the CPA signs what the manager signed.");
  if (v.signedOn < localDateOf(r.signedOff.at)) throw bad("The CPA signs on or after the manager's day", "signedOn");
  await db
    .update(shopCutovers)
    .set({ cpaSignedName: name, cpaSignedOn: v.signedOn, cpaReport: signable(r), cpaRecordedBy: actor.staffId ?? null, cpaRecordedAt: now, updatedAt: now })
    .where(eq(shopCutovers.shopId, shopId));
  await audit(actor, "cutover.cpa_sign_off", "shop", shopId, { cpa: name, signedOn: v.signedOn, squireOwedCents: r.totals.squireOwedCents, statementCents: r.tieOut.statementCents }, shopId);
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
