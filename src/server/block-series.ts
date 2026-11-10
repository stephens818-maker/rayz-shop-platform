import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { timeBlockSeries, timeBlocks } from "@/db/schema";
import { SERIES_HORIZON_DAYS, seriesOccurrences } from "@/domain/staff-time";
import { addDays, todayLocal } from "@/lib/time";

/** Recurring blocks written ahead. Kept apart from staff-time so the cron route doesn't pull in the staff app. */

export type SeriesRow = typeof timeBlockSeries.$inferSelect;

export const pattern = (s: Pick<SeriesRow, "weekdays" | "startMin" | "endMin" | "startsOn" | "endsOn">) => ({
  weekdays: s.weekdays,
  startMin: s.startMin,
  endMin: s.endMin,
  startsOn: s.startsOn,
  endsOn: s.endsOn,
});

export async function insertOccurrences(tx: DBorTx, s: SeriesRow, occ: readonly { startsAt: Date; endsAt: Date }[]) {
  for (let i = 0; i < occ.length; i += 500) {
    const chunk = occ.slice(i, i + 500);
    await tx
      .insert(timeBlocks)
      .values(chunk.map((o) => ({ staffId: s.staffId, shopId: s.shopId, startsAt: o.startsAt, endsAt: o.endsAt, kind: "block", category: s.category, reasonId: s.reasonId, reason: s.reason, note: s.note, seriesId: s.id, createdBy: s.createdBy })))
      .onConflictDoNothing();
  }
}

/** Writes recurring blocks ahead to the horizon; the notifications cron runs it. Returns how many occurrences it wrote. */
export async function extendSeries(now: Date = new Date(), tx: DBorTx = db) {
  const through = addDays(todayLocal(now), SERIES_HORIZON_DAYS);
  const due = await tx
    .select()
    .from(timeBlockSeries)
    .where(
      and(
        isNull(timeBlockSeries.endedAt),
        lt(timeBlockSeries.materializedThrough, through),
        or(isNull(timeBlockSeries.endsOn), gt(timeBlockSeries.endsOn, timeBlockSeries.materializedThrough)),
      ),
    );
  let written = 0;
  for (const s of due) {
    const occ = seriesOccurrences(pattern(s), addDays(s.materializedThrough, 1), through);
    await insertOccurrences(tx, s, occ);
    await tx.update(timeBlockSeries).set({ materializedThrough: through }).where(eq(timeBlockSeries.id, s.id));
    written += occ.length;
  }
  return written;
}
