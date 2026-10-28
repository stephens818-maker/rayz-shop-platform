import { and, eq, inArray } from "drizzle-orm";
import { db, type DBorTx } from "@/db";
import { staff, staffTrainingRates } from "@/db/schema";
import { sortTrainingRates, trainingRateProblem, type TrainingRateVersion } from "@/domain/payroll/training-rate";
import { todayLocal } from "@/lib/time";
import { audit, type Actor } from "@/server/audit";
import { lockedThrough } from "@/server/compensation";
import { AppError, notFound } from "@/server/errors";

export type StoredTrainingRate = TrainingRateVersion & { id: string; staffId: string; createdBy: string | null; createdAt: Date };

/** Every training rate version per employee, newest first. */
export async function trainingRatesFor(staffIds: readonly string[], tx: DBorTx = db): Promise<Map<string, StoredTrainingRate[]>> {
  const out = new Map<string, StoredTrainingRate[]>();
  if (!staffIds.length) return out;
  const rows = await tx.select().from(staffTrainingRates).where(inArray(staffTrainingRates.staffId, [...staffIds]));
  for (const r of rows) out.set(r.staffId, [...(out.get(r.staffId) ?? []), r]);
  for (const [k, v] of out) out.set(k, sortTrainingRates(v));
  return out;
}

export async function addTrainingRate(staffId: string, v: TrainingRateVersion, actor: Actor): Promise<StoredTrainingRate> {
  const [p] = await db.select({ kind: staff.kind }).from(staff).where(eq(staff.id, staffId));
  if (!p || p.kind !== "person") throw notFound("Employee");
  const [locked, existing] = await Promise.all([lockedThrough(), trainingRatesFor([staffId])]);
  const problem = trainingRateProblem(v, { lockedThrough: locked, existing: existing.get(staffId) ?? [] });
  if (problem) throw new AppError("bad_request", problem);
  const [row] = await db
    .insert(staffTrainingRates)
    .values({ staffId, effectiveFrom: v.effectiveFrom, rateCents: v.rateCents, createdBy: actor.staffId ?? null })
    .returning();
  await audit(actor, "payroll.training_rate_add", "staff", staffId, { versionId: row.id, effectiveFrom: row.effectiveFrom, rateCents: row.rateCents });
  return row;
}

/** Only a version that hasn't started yet can be withdrawn; the database refuses the rest too. */
export async function deleteTrainingRate(staffId: string, versionId: string, actor: Actor, now = new Date()) {
  const [row] = await db.select().from(staffTrainingRates).where(and(eq(staffTrainingRates.id, versionId), eq(staffTrainingRates.staffId, staffId)));
  if (!row) throw notFound("Training rate");
  if (row.effectiveFrom <= todayLocal(now)) throw new AppError("bad_request", "This training rate has already started, so it stays in the history. Add a new one to change it.");
  await db.delete(staffTrainingRates).where(eq(staffTrainingRates.id, versionId));
  await audit(actor, "payroll.training_rate_delete", "staff", staffId, { versionId, effectiveFrom: row.effectiveFrom, rateCents: row.rateCents });
}
