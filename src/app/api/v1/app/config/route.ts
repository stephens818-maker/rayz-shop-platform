import { json, options, route } from "@/server/api";
import { brandTimeFormat } from "@/server/brand-time";
import { loadAppConfig } from "@/server/mobile/client";

/** App boot config. `timeFormat` is the brand clock (default 12h). Instants elsewhere stay ISO-8601 UTC. */
export const OPTIONS = options;
export const GET = route(async () => {
  const cfg = await loadAppConfig();
  return json({
    ...cfg,
    timezone: "America/Chicago",
    timeFormat: await brandTimeFormat(),
  });
});
