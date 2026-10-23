import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { flags as featureFlags } from "@/lib/flags";
import { AppError } from "@/server/errors";
import { compareVersions, localeFromHeader, message } from "./rules";

export type MobileClient = "ios" | "android" | "web" | "unknown";

export interface ClientInfo {
  client: MobileClient;
  appVersion: string | null;
  deviceKey: string | null;
  ip: string | null;
  locale: "en" | "es";
  androidHash: string | null;
  userAgent: string | null;
}

export function readClient(req: Request): ClientInfo {
  const raw = (req.headers.get("x-client") ?? "").toLowerCase();
  const client: MobileClient = raw === "ios" || raw === "android" || raw === "web" ? raw : "unknown";
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  return {
    client,
    appVersion: req.headers.get("x-app-version"),
    deviceKey: req.headers.get("x-device-key"),
    ip,
    locale: localeFromHeader(req.headers.get("accept-language")),
    androidHash: req.headers.get("x-android-app-hash"),
    userAgent: req.headers.get("user-agent"),
  };
}

const DEFAULT_FLAGS = {
  payments: true,
  family: true,
  pushMarketing: false,
  /** C18 stays off until Charles approves a review identity. Env must also be true. */
  appReviewLogin: false,
  /** No fee on Apple Pay or Google Pay until this is explicitly turned on. */
  walletCardFee: false,
  perShopBooking: true,
};

export type AppFlags = typeof DEFAULT_FLAGS;

export interface ResolvedConfig {
  minIos: string;
  minAndroid: string;
  latestIos: string;
  latestAndroid: string;
  iosStoreUrl: string;
  androidStoreUrl: string;
  flags: AppFlags;
}

let cached: { at: number; cfg: ResolvedConfig } | null = null;

export async function loadAppConfig(): Promise<ResolvedConfig> {
  if (cached && Date.now() - cached.at < 15_000) return cached.cfg;
  const row = await db.query.appConfig.findFirst();
  const flags = { ...DEFAULT_FLAGS, ...(row?.flags ?? {}) };
  // The review login and the wallet fee cannot be turned on from the database alone.
  // FEATURE_REVIEW_LOGIN and FEATURE_WALLET_FEE are on only when the variable is exactly "true".
  if (!featureFlags.reviewLogin()) flags.appReviewLogin = false;
  if (!featureFlags.walletFee()) flags.walletCardFee = false;
  const cfg: ResolvedConfig = {
    minIos: row?.minIos ?? "3.0.0",
    minAndroid: row?.minAndroid ?? "3.0.0",
    latestIos: row?.latestIos ?? "3.0.0",
    latestAndroid: row?.latestAndroid ?? "3.0.0",
    iosStoreUrl: row?.iosStoreUrl ?? "https://apps.apple.com/app/id1570336126",
    androidStoreUrl: row?.androidStoreUrl ?? "https://play.google.com/store/apps/details?id=com.getsquire.SquireRayz",
    flags,
  };
  cached = { at: Date.now(), cfg };
  return cfg;
}

export function clearConfigCache() {
  cached = null;
}

/** ios/android builds below the configured minimum get 426. Missing headers stay allowed so the website and older callers keep working. */
export async function assertSupportedClient(info: ClientInfo): Promise<void> {
  if (info.client !== "ios" && info.client !== "android") return;
  if (!info.appVersion) throw new AppError("bad_request", "Send X-App-Version with the app version.");
  const cfg = await loadAppConfig();
  const min = info.client === "ios" ? cfg.minIos : cfg.minAndroid;
  const store = info.client === "ios" ? cfg.iosStoreUrl : cfg.androidStoreUrl;
  if (compareVersions(info.appVersion, min) < 0) {
    throw new AppError("upgrade_required", message(info.locale, "upgrade"), {
      minSupportedVersion: min,
      storeUrl: store,
      forceUpdate: true,
      forceUpdateBelow: { ios: cfg.minIos, android: cfg.minAndroid },
    });
  }
}

/**
 * Optional HMAC gate. When MOBILE_CLIENT_SECRET is set, ios/android must send
 * X-App-Signature: hex HMAC-SHA256 of `${client}.${version}.${timestamp}` and X-App-Timestamp (unix seconds, ±5 min).
 * This is not App Attest or Play Integrity. Those need Apple and Google credentials from Charles.
 */
export async function assertAppSignature(req: Request, info: ClientInfo): Promise<void> {
  const secret = process.env.MOBILE_CLIENT_SECRET;
  if (!secret || (info.client !== "ios" && info.client !== "android")) return;
  const stamp = req.headers.get("x-app-timestamp");
  const sig = req.headers.get("x-app-signature");
  const ts = Number(stamp);
  if (!sig || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    throw new AppError("unauthorized", "App signature is missing or expired.");
  }
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(`${info.client}.${info.appVersion ?? ""}.${stamp}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError("unauthorized", "App signature is missing or expired.");
}
