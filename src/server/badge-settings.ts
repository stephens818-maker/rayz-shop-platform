import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { brandSettings, customBadges } from "@/db/schema";
import { BADGE_ICONS, BADGE_TONES, BadgeSettings, CustomBadge, badgeSettings } from "@/domain/badges";
import { SegmentSchema } from "@/domain/marketing";

export async function loadBadgeSettings(tx: DBorTx = db): Promise<BadgeSettings> {
  const [row] = await tx.select({ badges: brandSettings.badges }).from(brandSettings).limit(1);
  return badgeSettings(row?.badges);
}

const isIcon = (v: string): v is CustomBadge["icon"] => (BADGE_ICONS as readonly string[]).includes(v);
const isTone = (v: string): v is CustomBadge["tone"] => (BADGE_TONES as readonly string[]).includes(v);

/** Custom badges in order; one whose stored filter no longer parses is left out rather than matching everyone. */
export async function listCustomBadges(o: { active?: boolean } = {}, tx: DBorTx = db): Promise<CustomBadge[]> {
  const rows = await tx
    .select()
    .from(customBadges)
    .where(o.active ? eq(customBadges.active, true) : undefined)
    .orderBy(asc(customBadges.sortOrder), asc(customBadges.createdAt));
  const out: CustomBadge[] = [];
  for (const r of rows) {
    const filter = SegmentSchema.safeParse(r.filter);
    if (!filter.success) continue;
    out.push({ id: r.id, label: r.label, tooltip: r.tooltip, icon: isIcon(r.icon) ? r.icon : "tag", tone: isTone(r.tone) ? r.tone : "blue", filter: filter.data, active: r.active });
  }
  return out;
}
