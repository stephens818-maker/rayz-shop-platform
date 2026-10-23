import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { json, options, route } from "@/server/api";
import { brandTimeFormat } from "@/server/brand-time";
import { closedShopCopy, effectiveLaunch, launchState, pilotShopSlugs } from "@/server/launch";
import { loadAppConfig } from "@/server/mobile/client";

/**
 * App boot config. Existing keys stay. `launched` is the brand release (or a pilot shop already open).
 * `shops` is every active shop's own gate. A shop with `launched: false` includes `closedCopy` and
 * must not be offered for booking or payment. `minVersion` and `forceUpdateBelow` repeat the floor
 * the server already enforces with 426.
 * `timeFormat` is the brand clock (default 12h). Instants elsewhere stay ISO-8601 UTC.
 */
export const OPTIONS = options;
export const GET = route(async () => {
  const cfg = await loadAppConfig();
  const launch = await launchState();
  const [pilotShops, copy, rows] = await Promise.all([
    pilotShopSlugs(),
    closedShopCopy(),
    db.select({ id: shops.id, slug: shops.slug, launchAt: shops.launchAt }).from(shops).where(eq(shops.active, true)).orderBy(asc(shops.slug)),
  ]);
  return json({
    ...cfg,
    timezone: "America/Chicago",
    timeFormat: await brandTimeFormat(),
    launched: launch.launched || pilotShops.length > 0,
    launchAt: launch.launchAt,
    pilot: pilotShops.length > 0,
    pilotShops,
    closedShopCopy: copy,
    shops: rows.map((row) => {
      const state = effectiveLaunch(row.launchAt, launch);
      return { id: row.id, slug: row.slug, launched: state.launched, launchAt: state.launchAt, closedCopy: state.launched ? null : copy };
    }),
    minVersion: { ios: cfg.minIos, android: cfg.minAndroid },
    forceUpdateBelow: { ios: cfg.minIos, android: cfg.minAndroid },
  });
});
