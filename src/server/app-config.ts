/**
 * What the customer app reads at launch (GET /api/v1/app/config), and the version gate every /api/v1
 * route applies to app builds. Everything comes from environment variables, so a minimum version
 * bump or a maintenance notice is a Vercel env change and a redeploy, with no app release.
 */
import { BRAND_NAME } from "@/domain/location-profile";
import { appBaseUrl, demoMode } from "@/lib/deployment";
import { appSwitches } from "./app-switches";
import { AppError } from "./errors";
import { appPaymentsConfig } from "./payments/saved-cards";

export type AppPlatform = "ios" | "android";

/** "1.4.2" → [1, 4, 2]; null when it isn't a dotted version. */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = v?.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

export function versionLessThan(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

const env = (k: string) => process.env[k]?.trim() || null;

function platformConfig(p: AppPlatform) {
  const P = p.toUpperCase();
  return { minVersion: env(`APP_${P}_MIN_VERSION`), latestVersion: env(`APP_${P}_LATEST_VERSION`), storeUrl: env(`APP_${P}_STORE_URL`) };
}

/** The X-Client header: ios or android for the app, anything else (or none) is the web. */
export function clientPlatform(req: Request): AppPlatform | null {
  const c = req.headers.get("x-client")?.trim().toLowerCase();
  return c === "ios" || c === "android" ? c : null;
}

const UNGATED = new Set(["/api/v1/app/config", "/api/v1/openapi.json"]);

/**
 * An app build older than its platform's minimum gets 426 upgrade_required on every v1 route but
 * the config and the spec. Requests without X-Client (the website, older builds that never sent
 * it) and builds with an unreadable X-App-Version pass.
 */
export function assertSupportedClient(req: Request) {
  const platform = clientPlatform(req);
  if (!platform) return;
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/v1/") || UNGATED.has(path)) return;
  const { minVersion, storeUrl } = platformConfig(platform);
  const version = req.headers.get("x-app-version");
  if (!minVersion || !version || !versionLessThan(version, minVersion)) return;
  throw new AppError("upgrade_required", "Please update the app to keep booking.", { platform, minVersion, storeUrl });
}

/** Where clients reach the brand for help, privacy requests and account questions. */
export function supportContact() {
  return { email: env("APP_SUPPORT_EMAIL"), phone: env("APP_SUPPORT_PHONE") };
}

export async function appConfig(platform: AppPlatform | null, version: string | null) {
  return { ...appConfigFromEnv(platform, version), features: await appSwitches(), payments: appPaymentsConfig() };
}

export function appConfigFromEnv(platform: AppPlatform | null, version: string | null) {
  const ios = platformConfig("ios");
  const android = platformConfig("android");
  const mine = platform === "ios" ? ios : platform === "android" ? android : null;
  const base = appBaseUrl();
  const maintenance = env("APP_MAINTENANCE_MESSAGE");
  return {
    brand: { name: BRAND_NAME, supportEmail: env("APP_SUPPORT_EMAIL"), supportPhone: env("APP_SUPPORT_PHONE") },
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
    links: {
      website: base,
      account: `${base}/account`,
      privacy: env("APP_PRIVACY_URL") ?? `${base}/privacy`,
      terms: env("APP_TERMS_URL") ?? `${base}/terms`,
      support: `${base}/support`,
      deleteAccount: `${base}/account/delete`,
    },
    environment: demoMode() ? ("demo" as const) : process.env.VERCEL_ENV === "production" ? ("production" as const) : ("development" as const),
  };
}

/** Web paths the app opens itself when installed (universal links / Android App Links). Staff, checkout and embed pages stay on the web. */
export const APP_LINK_PATHS = ["/a/*", "/g/*", "/book/*", "/locations/*", "/r/*", "/receipt/*", "/account", "/account/*"] as const;

/** apple-app-site-association, or null until APPLE_TEAM_ID and IOS_BUNDLE_ID are set. */
export function appleAppSiteAssociation() {
  const team = env("APPLE_TEAM_ID");
  const bundles = (env("IOS_BUNDLE_ID") ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!team || !bundles.length) return null;
  const appIDs = bundles.map((b) => `${team}.${b}`);
  return {
    applinks: { details: [{ appIDs, components: APP_LINK_PATHS.map((p) => ({ "/": p })) }] },
    webcredentials: { apps: appIDs },
  };
}

/** assetlinks.json, or null until ANDROID_PACKAGE and ANDROID_CERT_SHA256 (comma-separated signing-cert fingerprints) are set. */
export function androidAssetLinks() {
  const pkg = env("ANDROID_PACKAGE");
  const prints = (env("ANDROID_CERT_SHA256") ?? "").split(",").map((f) => f.trim().toUpperCase()).filter(Boolean);
  if (!pkg || !prints.length) return null;
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
      target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
    },
  ];
}
