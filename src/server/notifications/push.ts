import { createPrivateKey, createSign, sign } from "node:crypto";
import http2 from "node:http2";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { customerDevices, staffDevices } from "@/db/schema";
import type { PushOptions, PushProvider, SendResult } from "./providers";

type Env = Record<string, string | undefined>;

/**
 * App push straight to Apple (APNs, token auth over HTTP/2) and Google (FCM HTTP v1), by the device's
 * row in customer_devices, or in staff_devices for the staff app. Real but off until its keys are set:
 * NOTIFICATIONS_PUSH_PROVIDER=native with APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY and APNS_BUNDLE_ID
 * (APNS_ENVIRONMENT=production for App Store builds; STAFF_APNS_BUNDLE_ID for the staff app, the same key
 * signs for both), and FCM_SERVICE_ACCOUNT_JSON (or FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY).
 * A token Apple or Google says is gone revokes the device, so nothing is sent to it again.
 */

export class PermanentSendError extends Error {}

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
  /** The staff app's bundle id, the topic for staff_devices; the customer app's when unset. */
  staffBundleId?: string;
  production: boolean;
}

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const pem = (s: string) => s.replace(/\\n/g, "\n").trim();

export function apnsConfig(env: Env = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const privateKey = env.APNS_PRIVATE_KEY?.trim();
  const bundleId = env.APNS_BUNDLE_ID?.trim();
  if (!keyId || !teamId || !privateKey || !bundleId) return null;
  return { keyId, teamId, privateKey: pem(privateKey), bundleId, staffBundleId: env.STAFF_APNS_BUNDLE_ID?.trim() || bundleId, production: env.APNS_ENVIRONMENT?.trim() === "production" };
}

export function fcmConfig(env: Env = process.env): FcmConfig | null {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (raw) {
    try {
      const j = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string };
      if (j.project_id && j.client_email && j.private_key) return { projectId: j.project_id, clientEmail: j.client_email, privateKey: pem(j.private_key) };
    } catch {
      return null;
    }
  }
  const projectId = env.FCM_PROJECT_ID?.trim();
  const clientEmail = env.FCM_CLIENT_EMAIL?.trim();
  const privateKey = env.FCM_PRIVATE_KEY?.trim();
  return projectId && clientEmail && privateKey ? { projectId, clientEmail, privateKey: pem(privateKey) } : null;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Apple's provider token: ES256 over {iss: team, iat}, good for up to an hour (we renew at 50 minutes). */
export function apnsJwt(c: Pick<ApnsConfig, "keyId" | "teamId" | "privateKey">, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.keyId }));
  const claims = b64url(JSON.stringify({ iss: c.teamId, iat: nowSec }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: createPrivateKey(c.privateKey), dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}

/** Google's OAuth assertion for the service account (RS256), traded for an access token. */
export function fcmAssertion(c: Pick<FcmConfig, "clientEmail" | "privateKey">, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: c.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }),
  );
  const s = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(c.privateKey);
  return `${head}.${claims}.${b64url(s)}`;
}

export type Http2Post = (origin: string, path: string, headers: Record<string, string>, body: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

const http2Post: Http2Post = (origin, path, headers, body) =>
  new Promise((resolve, reject) => {
    const client = http2.connect(origin);
    client.on("error", reject);
    const req = client.request({ ":method": "POST", ":path": path, "content-type": "application/json", ...headers });
    req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    let status = 0;
    const out: Record<string, string> = {};
    let data = "";
    req.on("response", (h) => {
      status = Number(h[":status"]);
      for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k] = v;
    });
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      client.close();
      resolve({ status, headers: out, body: data });
    });
    req.on("error", (e) => {
      client.close();
      reject(e);
    });
    req.end(body);
  });

type Device = { id: string; provider: string; token: string; pushEnabled: boolean; revokedAt: Date | null; staffApp?: boolean };

export class NativePush implements PushProvider {
  name = "native";
  enabled = true;
  private apnsToken: { jwt: string; at: number } | null = null;
  private fcmToken: { token: string; until: number } | null = null;

  constructor(
    private apns: ApnsConfig | null,
    private fcm: FcmConfig | null,
    private io: { post?: Http2Post; fetch?: typeof fetch; device?: (id: string) => Promise<Device | null>; revoke?: (id: string) => Promise<void> } = {},
  ) {}

  private async device(id: string): Promise<Device | null> {
    if (this.io.device) return this.io.device(id);
    const c = await db.query.customerDevices.findFirst({ where: eq(customerDevices.id, id) });
    if (c) return c;
    const s = await db.query.staffDevices.findFirst({ where: eq(staffDevices.id, id) });
    return s ? { ...s, staffApp: true } : null;
  }

  private async revoke(id: string) {
    if (this.io.revoke) return this.io.revoke(id);
    const now = new Date();
    await db
      .update(customerDevices)
      .set({ revokedAt: now })
      .where(and(eq(customerDevices.id, id), isNull(customerDevices.revokedAt)));
    await db
      .update(staffDevices)
      .set({ revokedAt: now })
      .where(and(eq(staffDevices.id, id), isNull(staffDevices.revokedAt)));
  }

  async sendPush(deviceId: string, title: string, body: string, o: PushOptions = {}): Promise<SendResult> {
    const d = await this.device(deviceId);
    if (!d || d.revokedAt) throw new PermanentSendError("The device signed out");
    if (!d.pushEnabled) throw new PermanentSendError("Notifications are off on the device");
    if (d.provider === "apns") return this.sendApns(d, title, body, o);
    if (d.provider === "fcm") return this.sendFcm(d, title, body, o);
    throw new PermanentSendError(`No sender for ${d.provider} tokens`);
  }

  private async sendApns(d: Device, title: string, body: string, o: PushOptions): Promise<SendResult> {
    const c = this.apns;
    if (!c) throw new PermanentSendError("APNs isn't configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID)");
    const now = Date.now();
    if (!this.apnsToken || now - this.apnsToken.at > 50 * 60_000) this.apnsToken = { jwt: apnsJwt(c, Math.floor(now / 1000)), at: now };
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: "default" }, ...(o.data ?? {}) });
    const r = await (this.io.post ?? http2Post)(
      c.production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com",
      `/3/device/${encodeURIComponent(d.token)}`,
      {
        authorization: `bearer ${this.apnsToken.jwt}`,
        "apns-topic": (d.staffApp && c.staffBundleId) || c.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      payload,
    );
    if (r.status === 200) return { providerMessageId: r.headers["apns-id"] };
    const reason = (JSON.parse(r.body || "{}") as { reason?: string }).reason ?? `status ${r.status}`;
    if (r.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") {
      await this.revoke(d.id);
      throw new PermanentSendError(`Apple says the device is gone (${reason})`);
    }
    if (r.status === 403) this.apnsToken = null;
    throw new Error(`APNs refused the push (${reason})`);
  }

  private async accessToken(c: FcmConfig) {
    const now = Date.now();
    if (this.fcmToken && now < this.fcmToken.until) return this.fcmToken.token;
    const res = await (this.io.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: fcmAssertion(c, Math.floor(now / 1000)) }),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) throw new Error(`Google sign-in for FCM failed (${j.error ?? res.status})`);
    this.fcmToken = { token: j.access_token, until: now + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 };
    return j.access_token;
  }

  private async sendFcm(d: Device, title: string, body: string, o: PushOptions): Promise<SendResult> {
    const c = this.fcm;
    if (!c) throw new PermanentSendError("FCM isn't configured (FCM_SERVICE_ACCOUNT_JSON)");
    const token = await this.accessToken(c);
    const res = await (this.io.fetch ?? fetch)(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(c.projectId)}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { token: d.token, notification: { title, body }, android: { priority: o.marketing ? "normal" : "high" }, ...(o.data ? { data: o.data } : {}) },
      }),
    });
    const j = (await res.json().catch(() => ({}))) as { name?: string; error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
    if (res.ok) return { providerMessageId: j.name };
    const code = j.error?.details?.find((x) => x.errorCode)?.errorCode ?? j.error?.status ?? String(res.status);
    if (code === "UNREGISTERED" || (code === "INVALID_ARGUMENT" && /token/i.test(j.error?.message ?? ""))) {
      await this.revoke(d.id);
      throw new PermanentSendError(`Google says the device is gone (${code})`);
    }
    if (res.status === 401) this.fcmToken = null;
    throw new Error(`FCM refused the push (${code})`);
  }
}

/** native with neither set of keys is off, like disabled. */
export function nativePush(env: Env = process.env): NativePush | null {
  const apns = apnsConfig(env);
  const fcm = fcmConfig(env);
  return apns || fcm ? new NativePush(apns, fcm) : null;
}
