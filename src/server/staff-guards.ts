import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffShops } from "@/db/schema";
import { loadStaffAccess } from "./auth/access";
import { forbidden, notFound } from "./errors";

/** Schedules and time off: people who work at one of your shops, or yourself. */
export async function assertCanSchedule(ctx: { brandWide: boolean; shopIds: string[]; staff: { id: string } }, staffId: string) {
  const s = await db.query.staff.findFirst({ where: eq(staff.id, staffId) });
  if (!s) throw notFound("Staff member");
  if (ctx.brandWide || s.id === ctx.staff.id) return;
  const target = await loadStaffAccess(staffId);
  if (target?.isOwner) throw forbidden("Only someone with access to every shop can change the Brand Owner's schedule");
  const links = await db.select().from(staffShops).where(and(eq(staffShops.staffId, staffId), inArray(staffShops.shopId, ctx.shopIds)));
  if (!links.length) throw forbidden("That person isn't on your shops' team");
}
