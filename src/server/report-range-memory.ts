import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { staffReportRanges } from "@/db/schema";
import { isValidLocalDate, type LocalDate } from "@/lib/time";

/** What a person last picked on a report: a preset, or custom dates. */
export type RememberedRange = { preset: string } | { from: LocalDate; to: LocalDate };

const valid = (r: RememberedRange) => ("preset" in r ? r.preset.length > 0 && r.preset.length <= 80 : isValidLocalDate(r.from) && isValidLocalDate(r.to) && r.from <= r.to);

export async function lastRange(staffId: string, report: string): Promise<RememberedRange | null> {
  const row = await db.query.staffReportRanges.findFirst({ where: and(eq(staffReportRanges.staffId, staffId), eq(staffReportRanges.report, report)) });
  if (!row) return null;
  if (row.preset) return { preset: row.preset };
  return row.from && row.to ? { from: row.from, to: row.to } : null;
}

/** Keeps the range a person just picked on a report for next time. Best effort: a report never fails over it. */
export async function rememberRange(staffId: string, report: string, r: RememberedRange): Promise<void> {
  if (!valid(r) || report.length > 40) return;
  const v = "preset" in r ? { preset: r.preset, from: null, to: null } : { preset: null, from: r.from, to: r.to };
  try {
    await db
      .insert(staffReportRanges)
      .values({ staffId, report, ...v })
      .onConflictDoUpdate({ target: [staffReportRanges.staffId, staffReportRanges.report], set: { ...v, updatedAt: new Date() } });
  } catch (e) {
    console.error("rememberRange", e);
  }
}
