import { needsUpdate } from "./net";

export function bootGate(config: { launched: boolean; launchAt: string | null; minVersion: { ios: string } }, version: string): "update" | "coming-soon" | "open" {
  if (needsUpdate(config.minVersion.ios, version)) return "update";
  if (!config.launched) return "coming-soon";
  return "open";
}