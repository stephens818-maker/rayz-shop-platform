import { json, options, route } from "@/server/api";
import { brandTimeFormat } from "@/server/brand-time";
import { launchState } from "@/server/launch";
import { loadAppConfig } from "@/server/mobile/client";

/**
 * App boot config. Existing keys stay. `launched` and `launchAt` let a store build show "coming soon"
 * until launch day. `minVersion` and `forceUpdateBelow` repeat the minimum the server already enforces with 426.
 * `timeFormat` is the brand clock (default 12h). Instants elsewhere stay ISO-8601 UTC.
 */
export const OPTIONS = options;
export const GET = route(async () => {
  const cfg = await loadAppConfig();
  const launch = await launchState();
  return json({
    ...cfg,
    timezone: "America/Chicago",
    timeFormat: await brandTimeFormat(),
    launched: launch.launched,
    launchAt: launch.launchAt,
    minVersion: { ios: cfg.minIos, android: cfg.minAndroid },
    forceUpdateBelow: { ios: cfg.minIos, android: cfg.minAndroid },
  });
});
