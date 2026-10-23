import { db } from "@/db";
import { brandSettings } from "@/db/schema";
import { AppError } from "@/server/errors";

/**
 * One launch instant for the website, the iOS and Android customer apps, and customer-facing payments and push.
 * Core should call `launchState` / `assertLaunched` for any public web path that does not already go through
 * `createAppointment` (the booking wizard's POST /api/v1/appointments is already gated).
 *
 * `LAUNCH_AT` (ISO-8601 UTC) overrides `brand_settings.launch_at`. If neither is set, nothing customer-facing is live.
 */
export type LaunchSurface = "booking" | "payments" | "push";

export interface LaunchState {
  launched: boolean;
  /** ISO-8601 UTC, or null when no launch time is configured. */
  launchAt: string | null;
}

export const COMING_SOON_MESSAGE = "Ray'z isn't open in the app yet. Coming soon.";

/** Parse an env timestamp. Blank means "not set". An unparseable value is a misconfiguration, not a silent launch. */
export function parseLaunchAt(raw: string | null | undefined): Date | null {
  if (raw == null || raw.trim() === "") return null;
  const at = new Date(raw.trim());
  if (Number.isNaN(at.getTime())) throw new AppError("internal", "LAUNCH_AT must be an ISO-8601 UTC timestamp.");
  return at;
}

export async function launchState(now = new Date()): Promise<LaunchState> {
  const fromEnv = process.env.LAUNCH_AT?.trim();
  const at = fromEnv
    ? parseLaunchAt(fromEnv)
    : ((await db.query.brandSettings.findFirst({ columns: { launchAt: true } }))?.launchAt ?? null);
  const launchAt = at ? at.toISOString() : null;
  return { launched: at !== null && now.getTime() >= at.getTime(), launchAt };
}

export async function assertLaunched(surface: LaunchSurface, now = new Date()): Promise<void> {
  const state = await launchState(now);
  if (state.launched) return;
  throw new AppError("forbidden", COMING_SOON_MESSAGE, {
    reason: "not_launched",
    surface,
    launched: false,
    launchAt: state.launchAt,
  });
}
