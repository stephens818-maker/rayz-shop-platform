import { needsUpdate } from "./version";

export type BootState = "update" | "coming-soon" | "open" | "offline";
export type ClientPlatform = "ios" | "android";

export interface BootConfig {
  launched?: boolean;
  launchAt?: string | null;
  minVersion?: { ios?: string; android?: string };
  forceUpdateBelow?: { ios?: string; android?: string };
  minSupportedVersion?: { ios?: string; android?: string };
}

/**
 * A missing config stays closed. HTTP 426 and a platform minimum both force an update.
 * Android reads `android`; every other client reads `ios`.
 */
export function bootGate(config: BootConfig | null | undefined, version: string, platform: ClientPlatform = "ios", httpStatus?: number): BootState {
  if (httpStatus === 426) return "update";
  if (!config) return "offline";
  const floor = config.forceUpdateBelow?.[platform] ?? config.minVersion?.[platform] ?? config.minSupportedVersion?.[platform];
  if (floor && needsUpdate(floor, version)) return "update";
  if (config.launched === false) return "coming-soon";
  return "open";
}
