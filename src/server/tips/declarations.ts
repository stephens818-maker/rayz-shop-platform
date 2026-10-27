import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { notificationJobs, shops, staff, tipDeclarations, timeEntries, type TipDeclarationSource } from "@/db/schema";
import type { PayrollSettings, TipDeclarationSettings } from "@/domain/payroll/calc";
import { closesOn, declarationProblem, lastMonthOf, monthOf, reminderDue } from "@/domain/tip-declarations";
import { formatCents } from "@/lib/money";
import { addDays, startOfLocalDay, todayLocal, type LocalDate } from "@/lib/time";
import { appBaseUrl } from "@/lib/deployment";
import { audit, type Actor } from "@/server/audit";
import { settingAt } from "@/server/brand-sync/settings";
import { assertStaffAtShop } from "@/server/checkout";
import { AppError, notFound } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";
import { isLockedOn } from "@/server/payroll/groups";

/** Declarations nothing has replaced: what payroll and the reports count. */
const current = sql`not exists (select 1 from tip_declarations r where r.replaces_id = ${tipDeclarations.id})`;

export async function declarationRules(tx: DBorTx = db): Promise<TipDeclarationSettings> {
  return (await settingAt<PayrollSettings>("payroll", null, tx)).declarations;
}

export interface DeclareInput {
  staffId: string;
  shopId: string;
  businessDate: LocalDate;
  amountCents: number;
  attested: boolean;
  source: TipDeclarationSource;
  /** Correcting an earlier declaration: its id, and why. */
  replacesId?: string | null;
  reason?: string | null;
  actor: Actor;
}

/**
 * Records a cash tip declaration with the attestation the employee checked. A correction replaces an
 * earlier declaration of the same employee, shop and day (the old row stays). Refused once the pay
 * period is locked, and after the month closes unless a manager enters it with a reason.
 */
export async function declareCashTips(i: DeclareInput, now = new Date()) {
  const rules = await declarationRules();
  const manager = i.source === "manager";
  const problem = declarationProblem(
    { businessDate: i.businessDate, amountCents: i.amountCents, attested: manager || i.attested, manager, reason: i.reason, periodLocked: await isLockedOn(i.shopId, i.businessDate) },
    todayLocal(now),
    rules,
  );
  if (problem) throw new AppError(problem.startsWith("Check") || problem.startsWith("Enter") || problem.startsWith("Pick") || problem.startsWith("Say") ? "bad_request" : "conflict", problem);
  await assertStaffAtShop(i.staffId, i.shopId);
  return db.transaction(async (tx) => {
    if (i.replacesId) {
      const [old] = await tx.select().from(tipDeclarations).where(eq(tipDeclarations.id, i.replacesId)).for("update");
      if (!old || old.staffId !== i.staffId) throw notFound("Declaration");
      if (old.shopId !== i.shopId || old.businessDate !== i.businessDate) throw new AppError("bad_request", "A correction keeps the shop and day; declare another day separately.");
      if (!(i.reason ?? "").trim()) throw new AppError("bad_request", "Say why it's being corrected.");
      const [replaced] = await tx.select({ id: tipDeclarations.id }).from(tipDeclarations).where(eq(tipDeclarations.replacesId, old.id));
      if (replaced) throw new AppError("conflict", "That declaration was already corrected.");
    }
    const [row] = await tx
      .insert(tipDeclarations)
      .values({
        staffId: i.staffId,
        shopId: i.shopId,
        businessDate: i.businessDate,
        amountCents: i.amountCents,
        source: i.source,
        attestation: manager ? `Entered by a manager: ${(i.reason ?? "").trim()}`.slice(0, 500) : rules.attestation,
        replacesId: i.replacesId ?? null,
        reason: i.reason?.trim().slice(0, 300) || null,
        createdBy: i.actor.staffId ?? null,
        createdAt: now,
      })
      .returning();
    await audit(
      i.actor,
      i.replacesId ? "tips.declaration_correct" : "tips.declare",
      "tip_declaration",
      row.id,
      { staffId: i.staffId, businessDate: i.businessDate, amountCents: i.amountCents, source: i.source, replacesId: i.replacesId ?? null, reason: row.reason },
      i.shopId,
      tx,
    );
    return row;
  });
}

/** Today's cash tips declared as they clock out. Never fails the punch: a declaration that can't be taken says why. */
export async function declareAtClockOut(i: { staffId: string; shopId: string; cents: number; attested: boolean; actor: Actor; source?: "clock_out" | "web" }, now = new Date()) {
  try {
    const d = await declareCashTips({ staffId: i.staffId, shopId: i.shopId, businessDate: todayLocal(now), amountCents: i.cents, attested: i.attested, source: i.source ?? "clock_out", actor: i.actor }, now);
    return { declared: { id: d.id, businessDate: d.businessDate, amountCents: d.amountCents }, error: null };
  } catch (e) {
    if (e instanceof AppError) return { declared: null, error: e.message };
    throw e;
  }
}

/** An employee's declarations from a day on, newest first, with which are current and whether each can still be corrected. */
export async function myDeclarations(staffId: string, from: LocalDate, today: LocalDate = todayLocal()) {
  const rules = await declarationRules();
  const rows = await db
    .select({ d: tipDeclarations, shop: shops.name, current: sql<boolean>`${current}` })
    .from(tipDeclarations)
    .innerJoin(shops, eq(shops.id, tipDeclarations.shopId))
    .where(and(eq(tipDeclarations.staffId, staffId), gte(tipDeclarations.businessDate, from)))
    .orderBy(desc(tipDeclarations.businessDate), desc(tipDeclarations.createdAt));
  const lastMonth = lastMonthOf(today);
  const declaredLastMonth = rows.some((r) => r.current && monthOf(r.d.businessDate) === lastMonth);
  return {
    rules: { enabled: rules.enabled, atClockOut: rules.atClockOut, attestation: rules.attestation, lockDay: rules.lockDay },
    reminder: reminderDue(today, rules, declaredLastMonth) ? { month: lastMonth, closesOn: closesOn(`${lastMonth}-01`, rules) } : null,
    declarations: rows.map((r) => ({
      id: r.d.id,
      shopId: r.d.shopId,
      shop: r.shop,
      businessDate: r.d.businessDate,
      amountCents: r.d.amountCents,
      source: r.d.source,
      replacesId: r.d.replacesId,
      reason: r.d.reason,
      createdAt: r.d.createdAt,
      current: r.current,
      closesOn: closesOn(r.d.businessDate, rules),
    })),
  };
}

/** Current declared cash tips in [start, end], per `staffId|shopId`, in cents. */
export async function declaredTipsBetween(shopIds: readonly string[], start: LocalDate, end: LocalDate, tx: DBorTx = db): Promise<Map<string, number>> {
  if (!shopIds.length) return new Map();
  const rows = await tx
    .select({ staffId: tipDeclarations.staffId, shopId: tipDeclarations.shopId, cents: sql<number>`sum(${tipDeclarations.amountCents})::int` })
    .from(tipDeclarations)
    .where(and(inArray(tipDeclarations.shopId, [...shopIds]), gte(tipDeclarations.businessDate, start), lte(tipDeclarations.businessDate, end), current))
    .groupBy(tipDeclarations.staffId, tipDeclarations.shopId);
  return new Map(rows.filter((r) => r.cents).map((r) => [`${r.staffId}|${r.shopId}`, r.cents]));
}

/**
 * Reminders for last month's cash tips: an email on the first day of the window (the 1st, or the
 * first day the cron runs in it) and a last call on the reminder day, to each active employee who
 * clocked hours last month and hasn't declared anything for it (a $0 declaration counts).
 */
export async function declarationReminderCron(now = new Date()) {
  const out = { sent: 0 };
  const rules = await declarationRules();
  const today = todayLocal(now);
  if (!reminderDue(today, rules, false)) return out;
  const lastCall = Number(today.slice(8, 10)) === rules.remindUntilDay;
  const month = lastMonthOf(today);
  const from = `${month}-01`;
  const to = addDays(`${monthOf(today)}-01`, -1);
  const worked = await db
    .selectDistinctOn([timeEntries.staffId], { staffId: timeEntries.staffId, shopId: timeEntries.shopId, email: staff.email, first: staff.firstName })
    .from(timeEntries)
    .innerJoin(staff, eq(staff.id, timeEntries.staffId))
    .where(and(gte(timeEntries.startsAt, startOfLocalDay(from)), lte(timeEntries.startsAt, startOfLocalDay(addDays(to, 1))), eq(staff.active, true), eq(staff.kind, "person")))
    .orderBy(timeEntries.staffId);
  if (!worked.length) return out;
  const ids = worked.map((w) => w.staffId);
  const declared = new Set(
    (
      await db
        .selectDistinct({ staffId: tipDeclarations.staffId })
        .from(tipDeclarations)
        .where(and(inArray(tipDeclarations.staffId, ids), gte(tipDeclarations.businessDate, from), lte(tipDeclarations.businessDate, to)))
    ).map((r) => r.staffId),
  );
  const emails = worked.filter((w) => !declared.has(w.staffId) && w.email).map((w) => w.email!.toLowerCase());
  const sent = new Map<string, { n: number; today: boolean }>();
  if (emails.length) {
    const rows = await db
      .select({ to: notificationJobs.to, at: notificationJobs.createdAt })
      .from(notificationJobs)
      .where(and(eq(notificationJobs.kind, "tip_declaration"), inArray(notificationJobs.to, emails), gte(notificationJobs.createdAt, startOfLocalDay(`${monthOf(today)}-01`))));
    for (const r of rows) {
      const k = r.to.toLowerCase();
      const v = sent.get(k) ?? { n: 0, today: false };
      sent.set(k, { n: v.n + 1, today: v.today || r.at >= startOfLocalDay(today) });
    }
  }
  const closes = closesOn(from, rules);
  for (const w of worked) {
    if (declared.has(w.staffId) || !w.email) continue;
    const before = sent.get(w.email.toLowerCase());
    if (before && (before.today || before.n >= 2 || !lastCall)) continue;
    await enqueueRaw({
      kind: "tip_declaration",
      channel: "email",
      to: w.email,
      subject: before ? `Last day to declare ${month}'s cash tips` : "Declare last month's cash tips",
      body: `Hi ${w.first ?? "there"}, please declare the cash tips you were handed in ${month} (tips that weren't rung up on a ticket), even if it's ${formatCents(0)}. Declarations for ${month} close on ${closes}. Open the staff app's tips screen, or ${appBaseUrl()}/admin/my-tips.`,
      shopId: w.shopId,
    }, now);
    out.sent++;
  }
  return out;
}
