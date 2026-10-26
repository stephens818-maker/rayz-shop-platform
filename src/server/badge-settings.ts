import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { customBadges } from "@/db/schema";
import {
  BADGE_ICONS,
  BADGE_TONES,
  BadgeSettings,
  CustomBadge,
} from "@/domain/badges";
import { SegmentSchema } from "@/domain/marketing";
import { offeredAt } from "./brand-sync/lists";
import { settingAt } from "./brand-sync/settings";

/** Which badges are on and who sees them at a shop (no shop: the brand's). Thresholds are always the brand's. */
export async function loadBadgeSettings(
  shopId?: string | null,
  tx: DBorTx = db,
): Promise<BadgeSettings> {
  const [at, brand] = await Promise.all([
    settingAt<BadgeSettings>("badges", shopId, tx),
    shopId ? settingAt<BadgeSettings>("badges", null, tx) : null,
  ]);
  return brand ? { ...at, thresholds: brand.thresholds } : at;
}

const isIcon = (v: string): v is CustomBadge["icon"] =>
  (BADGE_ICONS as readonly string[]).includes(v);
const isTone = (v: string): v is CustomBadge["tone"] =>
  (BADGE_TONES as readonly string[]).includes(v);

/** Custom badges in order; one whose stored filter no longer parses is left out rather than matching everyone. */
export async function listCustomBadges(
  o: {
    active?: boolean;
    /** Only the ones this shop shows. */ shopId?: string | null;
  } = {},
  tx: DBorTx = db,
): Promise<CustomBadge[]> {
  const rows = await tx
    .select()
    .from(customBadges)
    .where(o.active ? eq(customBadges.active, true) : undefined)
    .orderBy(asc(customBadges.sortOrder), asc(customBadges.createdAt));
  const out: CustomBadge[] = [];
  for (const r of rows) {
    const filter = SegmentSchema.safeParse(r.filter);
    if (!filter.success) continue;
    out.push({
      id: r.id,
      label: r.label,
      tooltip: r.tooltip,
      icon: isIcon(r.icon) ? r.icon : "tag",
      tone: isTone(r.tone) ? r.tone : "blue",
      filter: filter.data,
      active: r.active,
    });
  }
  return offeredAt("custom_badge", o.shopId, out, tx);
}
