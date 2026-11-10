import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  payrollCommissionAdjustments,
  payrollRuns,
  payrollSquireImports,
  payrollSquireInputs,
  shopCutovers,
  shopRollouts,
  shops,
  staff,
  staffShops,
  type CleanPeriodCheck,
} from "@/db/schema";
import { periodOf, periodsAround, periodStarting, type CalendarPeriod } from "@/domain/payroll/calendar";
import { parseSquireCommissions } from "@/domain/payroll/squire-commissions";
import { endOfLocalDay, formatDate, isValidLocalDate, todayLocal, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "./audit";
import { cutoverStage, type CutoverStage } from "./cutover";
import { AppError } from "./errors";
import { buildPayroll, ensurePayGroups, isLockedOn, type PayGroup } from "./payroll/run";
import { loadRolloutPlan, switchRefusal, type PayrollSource, type RolloutRow } from "./rollout-plan";

export interface RolloutPeriod {
  start: LocalDate;
  end: LocalDate;
  source: PayrollSource;
  locked: boolean;
  squireImport: { rows: number; importedAt: Date; fileName: string | null } | null;
}

export interface RolloutShop {
  shop: { id: string; name: string; status: string; bookingMode: string };
  plan: RolloutRow | null;
  wave: 1 | 2;
  /** Online booking: where the shop's clients book, from Squire cutover. */
  stage: CutoverStage;
  switchedAt: Date | null;
  /** Why it can't switch its booking over yet (the second wave before the pilot's clean period), or null. */
  switchBlocked: string | null;
  /** Squire is still the shop's backup today. */
  squireBackup: boolean;
  /** The last two pay periods, the current one and the next: where each one's payroll comes from. */
  periods: RolloutPeriod[];
  /** Pay period starts "payroll from" can be set to. */
  periodStarts: LocalDate[];
}

async function groupOf(shopId: string): Promise<PayGroup> {
  const g = (await ensurePayGroups()).find((x) => x.shopId === shopId);
  if (!g) throw new AppError("not_found", "That shop has no pay group. Set it up under Payroll setup first.");
  return g;
}

/** Every shop's go-live flags: booking, payroll source per pay period, Squire backup, and its wave. */
export async function rolloutView(now = new Date()) {
  const today = todayLocal(now);
  const plan = await loadRolloutPlan();
  const groups = await ensurePayGroups();
  const list = await db.select({ shop: shops, c: shopCutovers }).from(shops).leftJoin(shopCutovers, eq(shopCutovers.shopId, shops.id)).where(eq(shops.active, true)).orderBy(shops.name);
  const ids = list.map((r) => r.shop.id);
  const [runs, imports] = ids.length
    ? await Promise.all([
        db.select({ payGroupId: payrollRuns.payGroupId, start: payrollRuns.periodStart }).from(payrollRuns),
        db.select().from(payrollSquireImports).where(inArray(payrollSquireImports.shopId, ids)),
      ])
    : [[], []];
  const lockedSet = new Set(runs.map((r) => `${r.payGroupId}|${r.start}`));
  const shopsOut: RolloutShop[] = [];
  for (const { shop, c } of list) {
    const g = groups.find((x) => x.shopId === shop.id);
    const row = plan.rows.get(shop.id) ?? null;
    const around = g ? periodsAround(g.calendar, today, 2, 1).filter((p) => p.number >= 1).reverse() : [];
    shopsOut.push({
      shop: { id: shop.id, name: shop.name, status: shop.status, bookingMode: shop.bookingMode },
      plan: row,
      wave: plan.waveOf(shop.id),
      stage: cutoverStage(shop, c),
      switchedAt: c?.switchedAt ?? null,
      switchBlocked: shop.bookingMode === "external" ? await switchRefusal(shop.id) : null,
      squireBackup: !!row?.squireBackupUntil && row.squireBackupUntil >= today,
      periods: around.map((p) => {
        const q = imports.find((i) => i.shopId === shop.id && i.periodStart === p.start);
        return {
          start: p.start,
          end: p.end,
          source: plan.sourceOf(shop.id, p.start),
          locked: !!g && lockedSet.has(`${g.id}|${p.start}`),
          squireImport: q ? { rows: q.rows, importedAt: q.importedAt, fileName: q.fileName } : null,
        };
      }),
      periodStarts: g ? periodsAround(g.calendar, today, 2, 8).filter((p) => p.number >= 1 && !lockedSet.has(`${g.id}|${p.start}`)).map((p) => p.start).reverse() : [],
    });
  }
  return { active: plan.active, pilot: plan.pilot, shops: shopsOut };
}

export interface PlanInput {
  wave: 1 | 2;
  plannedOn: LocalDate | null;
  payrollFrom: LocalDate | null;
  squireBackupUntil: LocalDate | null;
  note: string | null;
}

/**
 * A shop's place in the rollout. Payroll from here starts on a pay period's first day (shops go
 * live then, a Sunday, when they're closed), and not on one already locked. Only one pilot.
 */
export async function savePlan(actor: Actor, shopId: string, v: PlanInput, now = new Date()) {
  const [shop] = await db.select({ id: shops.id, name: shops.name }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw new AppError("not_found", "No such shop");
  for (const [k, d] of [
    ["planned go-live day", v.plannedOn],
    ["payroll from", v.payrollFrom],
    ["Squire backup until", v.squireBackupUntil],
  ] as const)
    if (d !== null && !isValidLocalDate(d)) throw new AppError("bad_request", `Enter a date for ${k}, or leave it empty`);
  const plan = await loadRolloutPlan();
  const before = plan.rows.get(shopId) ?? null;
  if (v.wave === 1 && plan.pilot && plan.pilot.shopId !== shopId) {
    const [p] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, plan.pilot.shopId));
    throw new AppError("conflict", `${p?.name ?? "Another shop"} is the pilot. Move it to the second wave first: there's one pilot shop.`);
  }
  if (before?.cleanSignedAt && v.wave !== 1) throw new AppError("conflict", `${shop.name}'s clean pay period is signed off, so it stays the pilot.`);
  if (v.payrollFrom) {
    const g = await groupOf(shopId);
    const p = periodStarting(g.calendar, v.payrollFrom);
    if (!p || p.number < 1) {
      const near = periodOf(g.calendar, v.payrollFrom);
      throw new AppError("bad_request", `Payroll from here starts on the first day of a pay period. ${formatDate(v.payrollFrom, "MMM d")} is in the one that starts ${formatDate(near.start, "EEE, MMM d")}.`);
    }
    if (await isLockedOn(shopId, v.payrollFrom)) throw new AppError("conflict", `The pay period starting ${formatDate(v.payrollFrom, "MMM d")} is locked. Pick the first one that's still open.`);
  }
  const note = v.note?.trim().slice(0, 300) || null;
  const values = { wave: v.wave, plannedOn: v.plannedOn, payrollFrom: v.payrollFrom, squireBackupUntil: v.squireBackupUntil, note, updatedBy: actor.staffId ?? null, updatedAt: now };
  await db.insert(shopRollouts).values({ shopId, ...values }).onConflictDoUpdate({ target: shopRollouts.shopId, set: values });
  await audit(
    actor,
    "rollout.plan",
    "shop",
    shopId,
    { wave: v.wave, plannedOn: v.plannedOn, payrollFrom: v.payrollFrom, squireBackupUntil: v.squireBackupUntil, note, ...(before ? { before: { wave: before.wave, plannedOn: before.plannedOn, payrollFrom: before.payrollFrom, squireBackupUntil: before.squireBackupUntil } } : { firstPlan: !plan.active }) },
    shopId,
  );
}

/**
 * A shop's Squire Commissions report for a pay period whose payroll still comes from Squire: the
 * period's figures for everyone on it. Importing again replaces it, until the period is locked.
 * Nothing is saved if any line has a problem.
 */
export async function importSquireReport(actor: Actor, shopId: string, periodStart: LocalDate, file: { name: string | null; text: string }): Promise<{ errors: string[] } | { rows: number; notes: string[] }> {
  const [shop] = await db.select({ id: shops.id, name: shops.name, slug: shops.slug }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw new AppError("not_found", "No such shop");
  const g = await groupOf(shopId);
  const p = periodStarting(g.calendar, periodStart);
  if (!p || p.number < 1) throw new AppError("bad_request", "Pick one of the shop's pay periods");
  const plan = await loadRolloutPlan();
  if (plan.sourceOf(shopId, p.start) !== "squire")
    throw new AppError("conflict", `${shop.name}'s payroll for ${formatDate(p.start, "MMM d")} – ${formatDate(p.end, "MMM d")} comes from this platform (its punches and tickets), so there's nothing to import.`);
  if (await isLockedOn(shopId, p.start)) throw new AppError("conflict", "This pay period is locked, so its Squire data stays as approved.");
  const people = await db
    .select({ id: staff.id, label: staff.displayLabel, first: staff.firstName, last: staff.lastName, squireName: staff.squireName })
    .from(staff)
    .where(eq(staff.kind, "person"));
  const here = new Set((await db.select({ id: staffShops.staffId }).from(staffShops).where(eq(staffShops.shopId, shopId))).map((r) => r.id));
  const parsed = parseSquireCommissions(file.text, { staff: people.map((s) => ({ ...s, atShop: here.has(s.id) })), shop: { name: shop.name, slug: shop.slug } });
  if (parsed.errors.length) return { errors: parsed.errors };
  await db.transaction(async (tx) => {
    await tx.delete(payrollSquireImports).where(and(eq(payrollSquireImports.shopId, shopId), eq(payrollSquireImports.periodStart, p.start)));
    const [imp] = await tx
      .insert(payrollSquireImports)
      .values({ shopId, periodStart: p.start, periodEnd: p.end, fileName: file.name?.slice(0, 200) || null, rows: parsed.rows.length, totals: parsed.totals, notes: parsed.notes, importedBy: actor.staffId ?? null })
      .returning({ id: payrollSquireImports.id });
    await tx.insert(payrollSquireInputs).values(parsed.rows.map((r) => ({ ...r, importId: imp.id, shopId, periodStart: p.start })));
    await audit(actor, "payroll.squire_import", "shop", shopId, { periodStart: p.start, periodEnd: p.end, fileName: file.name, rows: parsed.rows.length, ...parsed.totals, notes: parsed.notes.length }, shopId, tx);
  });
  return { rows: parsed.rows.length, notes: parsed.notes };
}

/**
 * Whether a pay period at the pilot was clean on this platform: its payroll came from here, it
 * booked here the whole period, the period is over and locked, nothing changed since the lock, the
 * tips tie out to the cent, and no commission for it was paid late. What can't be checked here
 * (paychecks right, iSolved took the file, nobody had a complaint) is in the owner's sign-off note.
 */
export async function cleanPeriodCheck(shopId: string, periodStart: LocalDate, now = new Date()): Promise<{ period: CalendarPeriod; checks: CleanPeriodCheck[]; ok: boolean }> {
  const g = await groupOf(shopId);
  const p = periodStarting(g.calendar, periodStart);
  if (!p || p.number < 1) throw new AppError("bad_request", "Pick one of the shop's pay periods");
  const plan = await loadRolloutPlan();
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  const [c] = await db.select().from(shopCutovers).where(eq(shopCutovers.shopId, shopId));
  const view = await buildPayroll(p.start, p.end, { clockChecks: false });
  const b = view?.blocks.find((x) => x.shopId === shopId);
  const late = await db
    .select({ id: payrollCommissionAdjustments.id })
    .from(payrollCommissionAdjustments)
    .where(and(eq(payrollCommissionAdjustments.shopId, shopId), lte(payrollCommissionAdjustments.earnedStart, p.end), gte(payrollCommissionAdjustments.earnedEnd, p.start)));
  const live = !!shop && cutoverStage(shop, c ?? null) === "live";
  const wholePeriod = live && (!c?.switchedAt || c.switchedAt <= endOfLocalDay(p.start));
  const tipDiffs = view?.tips.mismatches.filter((m) => m.shopId === shopId) ?? [];
  const drift = b?.lockCheck ? (b.lockCheck.drift.length || (b.lockCheck.hash !== b.lockCheck.liveHash ? 1 : 0)) + b.lockCheck.importedAfterLock : 0;
  const checks: CleanPeriodCheck[] = [
    { label: "Payroll came from here", ok: plan.sourceOf(shopId, p.start) === "platform" && b?.source === "platform", detail: b?.source === "squire" ? "This period's payroll came from Squire data." : "Punches and tickets on this platform." },
    {
      label: "Booked here the whole period",
      ok: wholePeriod,
      detail: !live ? "Online booking isn't on this platform." : wholePeriod ? "Online booking was here from the first day." : `Switched over during the period (${c?.switchedAt?.toISOString().slice(0, 10)}).`,
    },
    { label: "The period is over", ok: todayLocal(now) > p.end, detail: `Ends ${formatDate(p.end, "EEE, MMM d")}.` },
    { label: "Approved and locked", ok: !!b?.locked, detail: b?.locked ? `Locked ${b.locked.at.slice(0, 10)}${b.locked.by ? ` by ${b.locked.by}` : ""}.` : "Not locked yet." },
    { label: "Nothing changed since the lock", ok: !!b?.locked && drift === 0, detail: drift ? `${drift} change${drift === 1 ? "" : "s"} since the lock.` : "The figures of record match the live data." },
    { label: "Tips tie out to the cent", ok: tipDiffs.length === 0, detail: tipDiffs.length ? tipDiffs.map((m) => m.detail).slice(0, 3).join(" ") : "Every employee's tips match the iSolved file and their payouts." },
    { label: "No commission for it paid late", ok: late.length === 0, detail: late.length ? `${late.length} late commission${late.length === 1 ? "" : "s"} for this period.` : "None." },
  ];
  return { period: p, checks, ok: checks.every((x) => x.ok) };
}

/** An owner signs off the pilot's clean pay period, saying what they checked; the second wave can switch from then on. */
export async function signCleanPeriod(actor: Actor, shopId: string, periodStart: LocalDate, note: string, now = new Date()) {
  const plan = await loadRolloutPlan();
  if (plan.pilot?.shopId !== shopId) throw new AppError("conflict", "Only the pilot shop's clean pay period is signed off.");
  const text = note.trim().slice(0, 300);
  if (text.length < 10) throw new AppError("bad_request", "Say what you checked: paychecks right, iSolved took the file, no complaints from the team.");
  const r = await cleanPeriodCheck(shopId, periodStart, now);
  if (!r.ok) throw new AppError("conflict", `Not a clean pay period yet: ${r.checks.filter((x) => !x.ok).map((x) => x.label.toLowerCase()).join("; ")}.`);
  await db
    .update(shopRollouts)
    .set({ cleanPeriodStart: r.period.start, cleanPeriodEnd: r.period.end, cleanCheck: r.checks, cleanNote: text, cleanSignedBy: actor.staffId ?? null, cleanSignedAt: now, updatedAt: now })
    .where(eq(shopRollouts.shopId, shopId));
  await audit(actor, "rollout.clean_period", "shop", shopId, { periodStart: r.period.start, periodEnd: r.period.end, note: text }, shopId);
}

/** The pilot's pay periods on this platform that have ended, newest first: the ones a clean period can be. */
export async function cleanCandidates(now = new Date()): Promise<{ shopId: string; periods: CalendarPeriod[] } | null> {
  const plan = await loadRolloutPlan();
  const pilot = plan.pilot;
  if (!pilot?.payrollFrom) return null;
  const g = (await ensurePayGroups()).find((x) => x.shopId === pilot.shopId);
  if (!g) return null;
  const today = todayLocal(now);
  return { shopId: pilot.shopId, periods: periodsAround(g.calendar, today, 3, 0).filter((p) => p.start >= pilot.payrollFrom! && p.end < today) };
}
