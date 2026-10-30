import { and, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { staffDevices, timePunchPhotos } from "@/db/schema";
import { PUNCH_PHOTO_DAYS, SIGNED_OUT_DEVICE_DAYS } from "@/domain/staff-privacy";

const DAY = 86_400_000;

/**
 * The deletions the employee privacy notice promises (STAFF_DATA_MAP): a signed-out phone's push
 * token and details after SIGNED_OUT_DEVICE_DAYS, and punch photos after PUNCH_PHOTO_DAYS unless the
 * person has a pay question still open. Run from cron.
 */
export async function staffRetentionCron(now = new Date()) {
  const devices = await db
    .delete(staffDevices)
    .where(and(isNotNull(staffDevices.revokedAt), lt(staffDevices.revokedAt, new Date(now.getTime() - SIGNED_OUT_DEVICE_DAYS * DAY))))
    .returning({ id: staffDevices.id });
  const photos = await db
    .delete(timePunchPhotos)
    .where(
      and(
        lt(timePunchPhotos.createdAt, new Date(now.getTime() - PUNCH_PHOTO_DAYS * DAY)),
        sql`not exists (select 1 from time_punches p join pay_questions q on q.staff_id = p.staff_id and q.status <> 'resolved' where p.id = ${timePunchPhotos.punchId})`,
      ),
    )
    .returning({ punchId: timePunchPhotos.punchId });
  return { devices: devices.length, punchPhotos: photos.length };
}
