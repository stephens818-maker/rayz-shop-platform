import { json, options, route } from "@/server/api";
import { brandTimeFormat } from "@/server/brand-time";
import { closedShopCopy, launchState, pilotShopSlugs } from "@/server/launch";
import { loadAppConfig } from "@/server/mobile/client";
import { shopGateRows } from "@/server/mobile/shop-gates";

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
  const [pilotShops, copy, gates] = await Promise.all([pilotShopSlugs(), closedShopCopy(), shopGateRows(launch)]);
  return json({
    ...cfg,
    timezone: "America/Chicago",
    timeFormat: await brandTimeFormat(),
    launched: launch.launched || pilotShops.length > 0,
    launchAt: launch.launchAt,
    pilot: pilotShops.length > 0,
    pilotShops,
    closedShopCopy: copy,
    shops: gates.map((row) => ({
      id: row.id,
      slug: row.slug,
      launched: row.launched,
      launchAt: row.launchAt,
      closedCopy: row.launched ? null : copy,
      shopId: row.shopId,
      booking: row.booking,
      externalBookingUrl: row.externalBookingUrl,
      payments: row.payments,
      clockIn: row.clockIn,
      tipTransfers: row.tipTransfers,
    })),
    minVersion: { ios: cfg.minIos, android: cfg.minAndroid },
    forceUpdateBelow: { ios: cfg.minIos, android: cfg.minAndroid },
    minSupportedVersion: { ios: cfg.minIos, android: cfg.minAndroid },
    latestVersion: { ios: cfg.latestIos, android: cfg.latestAndroid },
    supportPhone: process.env.SUPPORT_PHONE ?? "+13195550199",
    supportEmail: process.env.SUPPORT_EMAIL ?? "hello@rayzbs.com",
    privacyUrl: process.env.PRIVACY_URL ?? "https://rayzbs.com/privacy",
    termsUrl: process.env.TERMS_URL ?? "https://rayzbs.com/terms",
    deletionUrl: process.env.DELETION_URL ?? "https://rayzbs.com/account/delete",
    featureFlags: { payments: cfg.flags.payments, family: cfg.flags.family, pushMarketing: cfg.flags.pushMarketing },
  });
});
