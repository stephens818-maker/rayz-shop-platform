import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { payrollFinalPays, staff, staffShops } from "@/db/schema";
import { periodOf } from "@/domain/payroll/calendar";
import type { Anomaly } from "@/domain/payroll/calc";
import { formatDate, isValidLocalDate, todayLocal, type LocalDate } from "@/lib/time";
import { audit, type Actor } from "@/server/audit";
import { loadStaffAccess } from "@/server/auth/access";
import { lockPayrollTips } from "@/server/tips/payouts";
import { isolvedTimecardExporter, type PayrollExporter } from "./export";
import { ensurePayGroups, loadSettings } from "./groups";
import { buildPayroll, preparersOf, SELF_APPROVAL, type FinalPayShop } from "./run";

/**
 * Final pay off-cycle (N9): someone who leaves is paid by the next regular payday at the latest (IL
 * and IA), so their pay for the period of their last day can be approved and filed on its own. The
 * figures are the Payroll Report's for them, as they stand, at every shop; each shop gets its own
 * one-row iSolved file in the usual format, and the regular run for that period leaves them out.
 */
export interface FinalPayPreview {
  staffId: string;
  name: string;
  start: LocalDate;
  end: LocalDate;
  lastDay: LocalDate;
  shops: FinalPayShop[];
  /** The Payroll Report's flags on them for the period: worth a look before approving. */
  anomalies: Anomaly[];
  totalWages: number;
  hash: string;
}

/** The pay period of their last day, on their first shop's pay calendar (else the brand's). */
async function periodFor(staffId: string, lastDay: LocalDate) {
  const [groups, mine] = await Promise.all([ensurePayGroups(), db.select({ shopId: staffShops.shopId }).from(staffShops).where(eq(staffShops.staffId, staffId))]);
  const g = groups.find((x) => mine.some((m) => m.shopId === x.shopId));
  return periodOf(g?.calendar ?? (await loadSettings()).calendar, lastDay);
}

export async function previewFinalPay(staffId: string, lastDay: LocalDate): Promise<{ error: string } | FinalPayPreview> {
  if (!isValidLocalDate(lastDay)) return { error: "Pick their last day." };
  if (lastDay > todayLocal()) return { error: "Final pay runs once they've left: their last day can't be in the future." };
  const [person] = await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(eq(staff.id, staffId));
  if (!person) return { error: "That employee isn't on file." };
  const p = await periodFor(staffId, lastDay);
  const [done] = await db.select().from(payrollFinalPays).where(and(eq(payrollFinalPays.staffId, staffId), eq(payrollFinalPays.periodStart, p.start)));
  if (done) return { error: `${person.label}'s final pay for ${formatDate(p.start, "MMM d")} – ${formatDate(p.end, "MMM d")} was approved ${formatDate(done.approvedAt.toISOString().slice(0, 10), "MMM d")}.` };
  const view = await buildPayroll(p.start, p.end);
  if (!view) return { error: "No shop has a pay period with those dates." };
  const mine = view.blocks.filter((b) => b.lines.some((l) => l.staffId === staffId));
  const locked = mine.filter((b) => b.locked);
  if (locked.length) return { error: `The pay period of their last day is already locked at ${locked.map((b) => b.shop).join(", ")}, so their pay is in its file.` };
  if (!mine.length) return { error: `${person.label} has nothing to pay in the pay period of their last day (${formatDate(p.start, "MMM d")} – ${formatDate(p.end, "MMM d")}).` };
  const shops: FinalPayShop[] = [];
  for (const b of mine) {
    const exportRow = b.exportRows.find((r) => r.staffId === staffId);
    if (!exportRow) return { error: `${person.label} has no row in ${b.shop}'s iSolved file: add their iSolved Key on Payroll setup first.` };
    shops.push({
      shopId: b.shopId,
      shop: b.shop,
      payGroupId: b.payGroupId,
      payGroup: b.payGroup,
      payGroupCode: b.payGroupCode,
      exportTab: b.exportTab,
      periodNumber: b.period.number,
      line: b.lines.find((l) => l.staffId === staffId)!,
      exportRow,
      ...(b.exportHeaders ? { exportHeaders: b.exportHeaders } : {}),
      ...(b.exportFrom ? { exportFrom: b.exportFrom } : {}),
    });
  }
  return {
    staffId,
    name: person.label,
    start: p.start,
    end: p.end,
    lastDay,
    shops,
    anomalies: view.anomalies.filter((a) => a.staffId === staffId),
    totalWages: shops.reduce((a, x) => a + x.line.totalWages, 0),
    hash: createHash("sha256").update(JSON.stringify(shops)).digest("hex"),
  };
}

/** Approve and file it, by someone who didn't change the period's figures by hand (or the Brand Owner, recorded as such). */
export async function approveFinalPay(staffId: string, lastDay: LocalDate, note: string | null, actor: Actor): Promise<{ error: string } | { id: string }> {
  const pre = await previewFinalPay(staffId, lastDay);
  if ("error" in pre) return pre;
  const selfApproved = actor.staffId ? (await preparersOf(pre.start, pre.end)).some((p) => p.staffId === actor.staffId) : false;
  if (selfApproved && !(await loadStaffAccess(actor.staffId!))?.isOwner) return { error: SELF_APPROVAL };
  const text = note?.trim().slice(0, 300) || null;
  // Their tips paid through payroll are claimed now, so no batch or later lock pays them again.
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(payrollFinalPays)
      .values({ staffId, periodStart: pre.start, periodEnd: pre.end, lastDay, snapshot: { shops: pre.shops as unknown as Record<string, unknown>[] }, figuresHash: pre.hash, note: text, approvedBy: actor.staffId ?? null })
      .onConflictDoNothing()
      .returning({ id: payrollFinalPays.id });
    if (r) await lockPayrollTips(tx, pre.shops.map((x) => ({ shopId: x.shopId, lines: [x.line] })), pre.start, pre.end, actor, { only: staffId });
    return r;
  });
  if (!row) return { error: "Their final pay was approved by someone else just now." };
  await audit(
    actor,
    "payroll.final_pay",
    "payroll_final_pay",
    row.id,
    { periodStart: pre.start, periodEnd: pre.end, lastDay, staffId, shops: pre.shops.map((x) => x.shop), totalWages: pre.totalWages, figuresHash: pre.hash, note: text, ...(selfApproved ? { selfApproved: true } : {}) },
    null,
  );
  return { id: row.id };
}

export async function finalPaysList(limit = 20) {
  const rows = await db.select({ f: payrollFinalPays, name: staff.displayLabel }).from(payrollFinalPays).innerJoin(staff, eq(staff.id, payrollFinalPays.staffId)).orderBy(desc(payrollFinalPays.approvedAt)).limit(limit);
  const approvers = [...new Set(rows.map((r) => r.f.approvedBy).filter((x): x is string => !!x))];
  const byOf = new Map((approvers.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, approvers)) : []).map((s) => [s.id, s.label]));
  return rows.map(({ f, name }) => ({
    id: f.id,
    staffId: f.staffId,
    name,
    periodStart: f.periodStart,
    periodEnd: f.periodEnd,
    lastDay: f.lastDay,
    approvedAt: f.approvedAt,
    approvedBy: f.approvedBy ? (byOf.get(f.approvedBy) ?? null) : null,
    note: f.note,
    shops: (f.snapshot.shops as unknown as FinalPayShop[]).map((x) => ({ payGroupId: x.payGroupId, shop: x.shop, totalWages: x.line.totalWages })),
  }));
}

/** One shop's one-row iSolved file for a final pay, as approved. */
export async function finalPayFile(id: string, payGroupId: string, exporter: PayrollExporter = isolvedTimecardExporter) {
  const [f] = await db.select({ f: payrollFinalPays, name: staff.displayLabel }).from(payrollFinalPays).innerJoin(staff, eq(staff.id, payrollFinalPays.staffId)).where(eq(payrollFinalPays.id, id));
  const x = f && (f.f.snapshot.shops as unknown as FinalPayShop[]).find((s) => s.payGroupId === payGroupId);
  if (!f || !x) return null;
  const s = await loadSettings();
  const file = { tab: x.exportTab, payGroup: x.payGroup, payGroupCode: x.payGroupCode, periodNumber: x.periodNumber, periodStart: f.f.periodStart, periodEnd: f.f.periodEnd, rows: [x.exportRow], headers: x.exportHeaders, format: s.exportFormat, namePattern: s.exportFileName };
  const base = exporter.fileName(file);
  const dot = base.lastIndexOf(".");
  const fileName = `${dot > 0 ? base.slice(0, dot) : base} final pay ${f.name.replace(/[^\w .-]/g, "")}${dot > 0 ? base.slice(dot) : ""}`;
  return { fileName, contentType: exporter.contentType, body: await exporter.render(file), shop: x.shop, finalPayId: f.f.id };
}
