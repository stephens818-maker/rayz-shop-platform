import { createSign } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { and, eq, isNull } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { customerDevices } from "@/db/schema";
import { demoMode } from "@/lib/deployment";
import { shopLaunchState, launchState } from "@/server/launch";

export interface PushPayload {
  type: string;
  appointmentCode?: string | null;
  deepLink?: string | null;
  title?: string;
  body?: string;
}

export function pushConfigured(provider: "apns" | "fcm" | "expo"): boolean {
  if (demoMode()) return false;
  if (provider === "apns") {
    const apns = apnsMaterial();
    return Boolean(apns.keyId && apns.teamId && apns.privateKey && apns.bundleId);
  }
  if (provider === "fcm") return Boolean(process.env.FCM_PROJECT_ID && (process.env.FCM_ACCESS_TOKEN || process.env.FCM_SERVICE_ACCOUNT_JSON));
  return Boolean(process.env.EXPO_ACCESS_TOKEN);
}

/**
 * Send one push. Returns unregistered when APNs says 410 or FCM says UNREGISTERED so the caller can revoke the device.
 * Nothing is sent before launch. Pass the appointment's shop so a pilot shop can notify while the brand is still closed.
 */
export async function sendPush(
  provider: "apns" | "fcm" | "expo",
  token: string,
  payload: PushPayload,
  shopId?: string | null,
): Promise<{ sent: boolean; unregistered: boolean }> {
  const open = shopId ? (await shopLaunchState(shopId)).launched : (await launchState()).launched;
  if (!open) return { sent: false, unregistered: false };
  if (!pushConfigured(provider)) return { sent: false, unregistered: false };
  if (provider === "expo") return sendExpo(token, payload);
  if (provider === "fcm") return sendFcm(token, payload);
  return sendApns(token, payload);
}

async function sendExpo(token: string, payload: PushPayload) {
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` },
    body: JSON.stringify({ to: token, title: payload.title, body: payload.body, data: payload }),
  });
  const data = (await res.json().catch(() => null)) as { data?: { status?: string; details?: { error?: string } } } | null;
  const unregistered = data?.data?.details?.error === "DeviceNotRegistered";
  return { sent: res.ok && data?.data?.status === "ok", unregistered };
}

async function sendFcm(token: string, payload: PushPayload) {
  const access = await fcmAccessToken();
  const project = process.env.FCM_PROJECT_ID!;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { token, notification: { title: payload.title, body: payload.body }, data: stringifyData(payload) } }),
  });
  const text = await res.text();
  const unregistered = res.status === 404 || text.includes("UNREGISTERED");
  return { sent: res.ok, unregistered };
}

async function fcmAccessToken(): Promise<string> {
  if (process.env.FCM_ACCESS_TOKEN) return process.env.FCM_ACCESS_TOKEN;
  const json = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string; token_uri?: string };
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(
    JSON.stringify({
      iss: json.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: json.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${signer.sign(json.private_key).toString("base64url")}`;
  const res = await fetch(json.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error("FCM auth failed");
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

let apnsJwt: { token: string; exp: number; material: string } | null = null;

/** Key id, team id, bundle, and the .p8 body. Read on every send so a new key does not need a code deploy. */
export function apnsMaterial(): { keyId: string; teamId: string; privateKey: string; bundleId: string; production: boolean } {
  return {
    keyId: process.env.APNS_KEY_ID?.trim() ?? "",
    teamId: process.env.APNS_TEAM_ID?.trim() ?? "",
    privateKey: (process.env.APNS_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    bundleId: process.env.APNS_BUNDLE_ID?.trim() ?? "",
    production: process.env.APNS_PRODUCTION === "true",
  };
}

function apnsMaterialKey(m = apnsMaterial()) {
  return `${m.keyId}\0${m.teamId}\0${m.bundleId}\0${m.production ? "1" : "0"}\0${m.privateKey}`;
}

async function sendApns(deviceToken: string, payload: PushPayload) {
  const now = Math.floor(Date.now() / 1000);
  const material = apnsMaterial();
  const materialKey = apnsMaterialKey(material);
  if (!apnsJwt || apnsJwt.material !== materialKey || apnsJwt.exp < now + 60) {
    const key = await importPKCS8(material.privateKey, "ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: material.keyId })
      .setIssuer(material.teamId)
      .setIssuedAt(now)
      .sign(key);
    apnsJwt = { token, exp: now + 50 * 60, material: materialKey };
  }
  const host = material.production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  const res = await fetch(`${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${apnsJwt.token}`,
      "apns-topic": material.bundleId,
      "apns-push-type": "alert",
    },
    body: JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body } }, ...payload }),
  });
  return { sent: res.ok, unregistered: res.status === 410 };
}

function stringifyData(payload: PushPayload): Record<string, string> {
  return {
    type: payload.type,
    appointmentCode: payload.appointmentCode ?? "",
    deepLink: payload.deepLink ?? "",
  };
}

export async function revokeDeviceToken(token: string, tx: DBorTx = db) {
  await tx.update(customerDevices).set({ revokedAt: new Date(), pushEnabled: false }).where(and(eq(customerDevices.token, token), isNull(customerDevices.revokedAt)));
}
