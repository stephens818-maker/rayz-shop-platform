import "server-only";
import { appBaseUrl, demoMode } from "@/lib/deployment";
import { flags } from "@/lib/flags";
import { clientPlatform, versionLessThan, type AppPlatform } from "@/server/app-config";
import { AppError } from "@/server/errors";
import { stripePayoutsOn } from "@/server/tips/payout-model";
import { STAFF_LEGAL_VERSIONS } from "@/domain/legal";

/**
 * What the staff app reads at launch (GET /api/staff/v1/config, ST-I8) and the version gate every
 * other staff route applies. All from environment variables, so a minimum version bump or switching
 * the clock off is an env change and a redeploy, with no app release:
 * - STAFF_APP_{IOS,ANDROID}_{MIN,LATEST}_VERSION and _STORE_URL
 * - STAFF_APP_MAINTENANCE_MESSAGE
 * - STAFF_APP_CLOCK_OFF=true: the app's time clock stands down (the front-desk clock and the web clock keep working)
 * - FEATURE_STAFF_STRIPE_PAYOUTS: direct Stripe tip payouts (on hold; off means payroll)
 * - FEATURE_STAFF_TAP_TO_PAY: Stripe Terminal Tap to Pay on the phone (off until Apple's entitlement and each shop's Terminal location are ready)
 */

const env = (k: string) => process.env[k]?.trim() || null;

function platformConfig(p: AppPlatform) {
  const P = p.toUpperCase();
  return { minVersion: env(`STAFF_APP_${P}_MIN_VERSION`), latestVersion: env(`STAFF_APP_${P}_LATEST_VERSION`), storeUrl: env(`STAFF_APP_${P}_STORE_URL`) };
}

export const staffSwitches = () => ({
  clock: env("STAFF_APP_CLOCK_OFF") !== "true",
  stripePayouts: stripePayoutsOn(),
  tapToPay: flags.staffTapToPay(),
});

/**
 * A staff app build older than its platform's minimum gets 426 upgrade_required on every route but
 * the config and the spec. Requests without X-Client, or with an unreadable X-App-Version, pass.
 */
export function assertSupportedStaffClient(req: Request) {
  const platform = clientPlatform(req);
  if (!platform) return;
  const { minVersion, storeUrl } = platformConfig(platform);
  const version = req.headers.get("x-app-version");
  if (!minVersion || !version || !versionLessThan(version, minVersion)) return;
  throw new AppError("upgrade_required", "Please update the Ray'z Staff app.", { platform, minVersion, storeUrl });
}

export function assertClockOn() {
  if (!staffSwitches().clock) throw new AppError("conflict", "The app's time clock is switched off for now. Punch at the front-desk clock.", { feature: "clock", enabled: false });
}

export function assertTapToPay() {
  if (!staffSwitches().tapToPay) throw new AppError("forbidden", "Tap to Pay isn't switched on yet. Check out at the front desk.", { feature: "tap_to_pay", enabled: false });
}

export function staffAppConfig(req: Request) {
  const platform = clientPlatform(req);
  const version = req.headers.get("x-app-version");
  const ios = platformConfig("ios");
  const android = platformConfig("android");
  const mine = platform === "ios" ? ios : platform === "android" ? android : null;
  const base = appBaseUrl();
  const maintenance = env("STAFF_APP_MAINTENANCE_MESSAGE");
  return {
    platforms: { ios, android },
    client: mine
      ? {
          platform,
          version,
          updateRequired: !!(mine.minVersion && version && versionLessThan(version, mine.minVersion)),
          updateAvailable: !!(mine.latestVersion && version && versionLessThan(version, mine.latestVersion)),
        }
      : null,
    maintenance: { active: !!maintenance, message: maintenance },
    features: staffSwitches(),
    payouts: { defaultMethod: "payroll" as const, stripe: stripePayoutsOn() },
    links: {
      privacy: `${base}/staff-app/privacy`,
      terms: `${base}/staff-app/terms`,
      support: `${base}/staff-app/support`,
    },
    legal: STAFF_LEGAL_VERSIONS,
    support: { email: env("STAFF_APP_SUPPORT_EMAIL") ?? env("APP_SUPPORT_EMAIL"), phone: env("STAFF_APP_SUPPORT_PHONE") ?? env("APP_SUPPORT_PHONE") },
    environment: demoMode() ? ("demo" as const) : process.env.VERCEL_ENV === "production" ? ("production" as const) : ("development" as const),
  };
}
