import { json, options, route } from "@/server/api";
import { brandTimeFormat } from "@/server/brand-time";
import { launchState, pilotShopSlugs } from "@/server/launch";
import { loadAppConfig } from "@/server/mobile/client";

/**
 * App boot config. Existing keys stay. `launched` and `launchAt` let a store build show "coming soon"
 * until launch day. `pilot` and `pilotShops` open the app for a one-shop pilot while the brand instant
 * is still in the future. Each shop also returns its own `launched`. `minVersion` and `forceUpdateBelow`
 * repeat the minimum the server already enforces with 426.
 * `timeFormat` is the brand clock (default 12h). Instants elsewhere stay ISO-8601 UTC.
 */
export const OPTIONS = options;
export const GET = route(async () => {
  const cfg = await loadAppConfig();
  const launch = await launchState();
  const pilotShops = await pilotShopSlugs();
  return json({
    ...cfg,
    timezone: "America/Chicago",
    timeFormat: await brandTimeFormat(),
    launched: launch.launched || pilotShops.length > 0,
    launchAt: launch.launchAt,
    pilot: pilotShops.length > 0,
    pilotShops,
    minVersion: { ios: cfg.minIos, android: cfg.minAndroid },
    forceUpdateBelow: { ios: cfg.minIos, android: cfg.minAndroid },
  });
});
