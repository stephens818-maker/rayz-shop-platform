import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { phoneState, phoneTimeZone } from "@/domain/area-codes";
import { CONSENT_CHANNELS, CONSENT_TEXTS, consentDiff, consentSource } from "@/domain/consent-texts";
import { mayMarketAt, nextMarketingTime } from "@/domain/quiet-hours";
import type { Http2Post } from "@/server/notifications/push";

vi.mock("server-only", () => ({}));

describe("consent wording", () => {
  it("pins each version to its text, so changing the words means a new version", () => {
    const pinned = Object.fromEntries(CONSENT_CHANNELS.map((c) => [CONSENT_TEXTS[c].version, createHash("sha256").update(CONSENT_TEXTS[c].text).digest("hex").slice(0, 12)]));
    expect(pinned).toMatchInlineSnapshot(`
      {
        "email-2026-10-26": "81d0a56e8057",
        "email-marketing-2026-10-26": "fa2c92ddade2",
        "push-2026-10-26": "aad1162a8bf2",
        "push-marketing-2026-10-26": "57050d1b1615",
        "sms-2026-10-26": "59a56920d9a8",
        "sms-marketing-2026-10-26": "c0821be223c6",
      }
    `);
  });

  it("says what TCPA needs on marketing texts", () => {
    const t = CONSENT_TEXTS.sms_marketing.text;
    for (const part of [/automated/, /STOP/, /HELP/, /not a condition/i, /rates may apply/i]) expect(t).toMatch(part);
    expect(CONSENT_CHANNELS.filter((c) => CONSENT_TEXTS[c].marketing).sort()).toEqual(["email_marketing", "push_marketing", "sms_marketing"]);
  });

  it("finds what changed, and tells the app from the website", () => {
    expect(consentDiff({ smsOptIn: true, smsMarketingOptIn: false }, { smsOptIn: true, smsMarketingOptIn: true, emailOptIn: false })).toEqual([{ channel: "sms_marketing", granted: true }]);
    expect(consentDiff({}, { smsOptIn: false })).toEqual([]);
    expect([consentSource("ios"), consentSource("android"), consentSource("web"), consentSource(null), consentSource("kiosk")]).toEqual(["ios", "android", "web", "web", "web"]);
  });
});

describe("area codes", () => {
  it("knows the state and zone, with the split area codes", () => {
    expect([phoneState("+13195551234"), phoneTimeZone("+13195551234")]).toEqual(["IA", "America/Chicago"]);
    expect(phoneTimeZone("+12135551234")).toBe("America/Los_Angeles");
    expect(phoneTimeZone("+16025551234")).toBe("America/Phoenix");
    expect(phoneTimeZone("+19155551234")).toBe("America/Denver");
    expect(phoneTimeZone("+18655551234")).toBe("America/New_York");
    expect(phoneTimeZone("+12195551234")).toBe("America/Chicago");
    expect(phoneTimeZone("+18085551234")).toBe("Pacific/Honolulu");
    expect(phoneTimeZone("+18005551234")).toBeNull();
    expect(phoneTimeZone("555-1234")).toBeNull();
  });
});

describe("marketing quiet hours", () => {
  const at = (iso: string) => new Date(iso);
  const brand = { quietStart: "21:00", quietEnd: "09:00" };

  it("sends 9 AM to 8 PM where the recipient is, and where the shop is (Charles, Oct 28)", () => {
    // 2026-11-10 15:00Z is 9 AM Central, 7 AM Pacific, 10 AM Eastern.
    expect(mayMarketAt(at("2026-11-10T15:00:00Z"), "+13195551234", "America/Chicago", brand)).toBe(true);
    expect(mayMarketAt(at("2026-11-10T14:59:00Z"), "+13195551234", "America/Chicago")).toBe(false);
    expect(mayMarketAt(at("2026-11-10T15:00:00Z"), "+12135551234", "America/Chicago", brand)).toBe(false);
    // 9 AM Pacific.
    expect(nextMarketingTime(at("2026-11-10T15:00:00Z"), "+12135551234", "America/Chicago", brand)?.toISOString()).toBe("2026-11-10T17:00:00.000Z");
    // 7:59 PM Central is the last minute; 8 PM is out, in every state.
    expect(mayMarketAt(at("2026-11-11T01:59:00Z"), "+13195551234", "America/Chicago")).toBe(true);
    expect(mayMarketAt(at("2026-11-11T02:00:00Z"), "+13195551234", "America/Chicago")).toBe(false);
    expect(mayMarketAt(at("2026-11-11T01:30:00Z"), "+12125551234", "America/New_York")).toBe(false);
    // An unknown area code is held to the shop's time.
    expect(mayMarketAt(at("2026-11-10T15:30:00Z"), "+18005551234", "America/Chicago")).toBe(true);
    expect(mayMarketAt(at("2026-11-10T14:30:00Z"), "+18005551234", "America/Chicago")).toBe(false);
  });

  it("has nothing to offer when the brand's quiet hours cover the whole legal day", () => {
    expect(nextMarketingTime(at("2026-11-10T15:00:00Z"), "+13195551234", "America/Chicago", { quietStart: "07:00", quietEnd: "22:00" })).toBeNull();
  });
});

describe("native push", () => {
  it("signs Apple's and Google's tokens so they verify", async () => {
    const { apnsJwt, fcmAssertion } = await import("@/server/notifications/push");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwt = apnsJwt({ keyId: "KEY123", teamId: "TEAM45", privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "TEAM45", iat: 1_800_000_000 });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const a = fcmAssertion({ clientEmail: "push@rayz.iam.gserviceaccount.com", privateKey: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, 1_800_000_000);
    const [ah, ac, as] = a.split(".");
    expect(JSON.parse(Buffer.from(ac, "base64url").toString())).toMatchObject({ iss: "push@rayz.iam.gserviceaccount.com", aud: "https://oauth2.googleapis.com/token", exp: 1_800_003_600 });
    expect(verify("RSA-SHA256", Buffer.from(`${ah}.${ac}`), rsa.publicKey, Buffer.from(as, "base64url"))).toBe(true);
  });

  it("sends to APNs and FCM, and revokes a device either says is gone", async () => {
    const { NativePush, PermanentSendError } = await import("@/server/notifications/push");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const devices: Record<string, { id: string; provider: string; token: string; pushEnabled: boolean; revokedAt: Date | null; staffApp?: boolean }> = {
      ios: { id: "ios", provider: "apns", token: "aa11", pushEnabled: true, revokedAt: null },
      staffIos: { id: "staffIos", provider: "apns", token: "ee55", pushEnabled: true, revokedAt: null, staffApp: true },
      gone: { id: "gone", provider: "apns", token: "bb22", pushEnabled: true, revokedAt: null },
      droid: { id: "droid", provider: "fcm", token: "cc33", pushEnabled: true, revokedAt: null },
      off: { id: "off", provider: "fcm", token: "dd44", pushEnabled: false, revokedAt: null },
    };
    const revoked: string[] = [];
    const posts: { origin: string; path: string; headers: Record<string, string>; body: string }[] = [];
    const fetches: { url: string; body: string }[] = [];
    const push = new NativePush(
      { keyId: "K", teamId: "T", privateKey: ec, bundleId: "com.rayz.app", staffBundleId: "com.rayz.staff", production: false },
      { projectId: "rayz-app", clientEmail: "push@rayz.iam.gserviceaccount.com", privateKey: rsa },
      {
        device: async (id) => devices[id] ?? null,
        revoke: async (id) => void revoked.push(id),
        post: async (origin, path, headers, body): ReturnType<Http2Post> => {
          posts.push({ origin, path, headers, body });
          return path.endsWith("bb22") ? { status: 410, headers: {}, body: JSON.stringify({ reason: "Unregistered" }) } : { status: 200, headers: { "apns-id": "apns-1" }, body: "" };
        },
        fetch: (async (url: string, init: RequestInit) => {
          fetches.push({ url, body: String(init.body) });
          if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }));
          return new Response(JSON.stringify({ name: "projects/rayz-app/messages/1" }));
        }) as typeof fetch,
      },
    );
    expect(await push.sendPush("ios", "Ray'z", "See you at 3", { data: { kind: "reminder_2h" } })).toEqual({ providerMessageId: "apns-1" });
    expect(posts[0]).toMatchObject({ origin: "https://api.sandbox.push.apple.com", path: "/3/device/aa11", headers: { "apns-topic": "com.rayz.app", "apns-push-type": "alert" } });
    expect(JSON.parse(posts[0].body)).toEqual({ aps: { alert: { title: "Ray'z", body: "See you at 3" }, sound: "default" }, kind: "reminder_2h" });
    await push.sendPush("staffIos", "New booking", "Jordan booked you for 3:00");
    expect(posts[1]).toMatchObject({ path: "/3/device/ee55", headers: { "apns-topic": "com.rayz.staff" } });
    await expect(push.sendPush("gone", "Ray'z", "Hi")).rejects.toBeInstanceOf(PermanentSendError);
    expect(revoked).toEqual(["gone"]);

    expect(await push.sendPush("droid", "Ray'z", "Booked")).toEqual({ providerMessageId: "projects/rayz-app/messages/1" });
    expect(fetches.map((f) => f.url)).toEqual(["https://oauth2.googleapis.com/token", "https://fcm.googleapis.com/v1/projects/rayz-app/messages:send"]);
    expect(JSON.parse(fetches[1].body).message).toMatchObject({ token: "cc33", notification: { title: "Ray'z", body: "Booked" } });
    await expect(push.sendPush("off", "Ray'z", "Hi")).rejects.toThrow(/off/);
    await expect(push.sendPush("missing", "Ray'z", "Hi")).rejects.toThrow(/signed out/);
  });

  it("stays off without keys", async () => {
    const { nativePush, apnsConfig, fcmConfig } = await import("@/server/notifications/push");
    expect(nativePush({})).toBeNull();
    expect(
      apnsConfig({
        APNS_KEY_ID: "K",
        APNS_TEAM_ID: "T",
        APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        APNS_BUNDLE_ID: "com.rayz.app",
        APNS_ENVIRONMENT: "production",
      }),
    ).toMatchObject({
      production: true,
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    });
    expect(fcmConfig({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: "p", client_email: "e", private_key: "k" }) })).toEqual({ projectId: "p", clientEmail: "e", privateKey: "k" });
  });
});
