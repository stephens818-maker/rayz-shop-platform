/**
 * The Ray'z Staff app's universal links (iOS) and App Links (Android), next to the customer app's
 * in the same .well-known files (ST-I15): Stripe's payout setup comes back to HTTPS pages, and these
 * open them in the staff app when it's installed, so nothing depends on a custom URL scheme. Off
 * until the staff app's ids are set: STAFF_IOS_BUNDLE_ID (with APPLE_TEAM_ID), and
 * STAFF_ANDROID_PACKAGE with STAFF_ANDROID_CERT_SHA256 (comma-separated signing-cert fingerprints).
 */

export const STAFF_APP_LINK_PATHS = ["/staff-app/stripe/return", "/staff-app/stripe/refresh", "/staff-app/payouts"] as const;

const env = (k: string) => process.env[k]?.trim() || null;
const list = (k: string) =>
  (env(k) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The staff app's applinks entry, or null until it's configured. */
export function staffAppleAppLinks() {
  const team = env("APPLE_TEAM_ID");
  const bundles = list("STAFF_IOS_BUNDLE_ID");
  if (!team || !bundles.length) return null;
  return { appIDs: bundles.map((b) => `${team}.${b}`), components: STAFF_APP_LINK_PATHS.map((p) => ({ "/": p })) };
}

/** The staff app's assetlinks statement, or null until it's configured. */
export function staffAndroidAssetLinks() {
  const pkg = env("STAFF_ANDROID_PACKAGE");
  const prints = list("STAFF_ANDROID_CERT_SHA256").map((f) => f.toUpperCase());
  if (!pkg || !prints.length) return null;
  return { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints } };
}

type Aasa = { applinks: { details: unknown[] }; webcredentials?: { apps: string[] } };

/** The customer app's apple-app-site-association with the staff app's entry added; either one alone where only one is set up. */
export function withStaffAppleLinks(doc: Aasa | null): Aasa | null {
  const staff = staffAppleAppLinks();
  if (!staff) return doc;
  return doc ? { ...doc, applinks: { ...doc.applinks, details: [...doc.applinks.details, staff] } } : { applinks: { details: [staff] } };
}

/** The customer app's assetlinks.json with the staff app's statement added. */
export function withStaffAssetLinks<T>(doc: T[] | null): (T | NonNullable<ReturnType<typeof staffAndroidAssetLinks>>)[] | null {
  const staff = staffAndroidAssetLinks();
  if (!staff) return doc;
  return [...(doc ?? []), staff];
}
