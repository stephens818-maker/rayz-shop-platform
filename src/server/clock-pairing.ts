import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "@/db";
import { clockDevices, clockPairings, shops } from "@/db/schema";
import { appBaseUrl } from "@/lib/deployment";
import { Actor, audit } from "./audit";
import { randomToken, sameSecret, sha256 } from "./auth/tokens";
import { AppError, forbidden } from "./errors";
import { rateLimit } from "./rate-limit";

/**
 * Pairing a front-desk clock by a manager's QR code (ST-C0c), instead of signing a shared shop
 * login in on it. A manager makes a one-time code for a shop (good for 10 minutes) and the tablet
 * scans it, or opens its link, or types it. The tablet gets its own long-lived clock token, kept by
 * the browser or the staff app; from then on it runs the clock with each person's own PIN and no
 * staff session. A paired app install's token works only with that install's id. A manager
 * revokes the device in Time clock setup.
 */

export const PAIRING_MINUTES = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REDEEM_PER_IP = 20;

/** "K7QD-M3XP": eight letters and digits without look-alikes, so it can be typed off the manager's screen. */
function pairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const s = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const normalizeCode = (raw: string) => {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
};

const codeHash = (code: string) => sha256(`clock-pair:${code}`);
export const installHash = (installId: string) => sha256(`clock-install:${installId}`);

export const pairingUrl = (code: string) => `${appBaseUrl()}/clock/pair?code=${encodeURIComponent(code)}`;

/** A manager's pairing code for one of their shops. Its QR code opens the link that pairs the device scanning it. */
export async function startPairing(c: { actor: Actor; shopIds: readonly string[] }, shopId: string, label: string, now = new Date()) {
  if (!c.shopIds.includes(shopId)) throw forbidden("That shop is outside your access");
  if (!c.actor.staffId) throw forbidden();
  const name = label.trim().slice(0, 60);
  if (!name) throw new AppError("bad_request", "Name the device, e.g. Front desk iPad.", { field: "label" });
  const code = pairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000);
  const [row] = await db.insert(clockPairings).values({ shopId, label: name, codeHash: codeHash(code), createdBy: c.actor.staffId, expiresAt }).returning({ id: clockPairings.id });
  await audit(c.actor, "timeclock.pairing_start", "clock_pairing", row.id, { label: name }, shopId);
  const url = pairingUrl(code);
  return { id: row.id, code, url, svg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }), expiresAt: expiresAt.toISOString() };
}

/**
 * Uses a pairing code once: the device becomes the shop's front-desk clock. The caller keeps the
 * token (a cookie on the web, the app's keychain); an app install binds it to its install id.
 */
export async function redeemPairing(input: { code: string; installId?: string | null; ip: string | null }, now = new Date()) {
  await rateLimit("clock_pair_ip", input.ip, REDEEM_PER_IP, 15 * 60_000, "Too many pairing attempts. Try again in 15 minutes.");
  const code = normalizeCode(input.code);
  const wrong = new AppError("bad_request", "That pairing code isn't right or has expired. Ask a manager for a new one.", { field: "code" });
  if (!code) throw wrong;
  const installId = input.installId?.trim() || null;
  if (installId && !/^[A-Za-z0-9._:-]{8,128}$/.test(installId)) throw new AppError("bad_request", "That install id isn't valid");
  const token = randomToken();
  const result = await db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(clockPairings)
      .where(and(eq(clockPairings.codeHash, codeHash(code)), isNull(clockPairings.usedAt), gt(clockPairings.expiresAt, now)))
      .for("update");
    if (!p) throw wrong;
    const [device] = await tx
      .insert(clockDevices)
      .values({ shopId: p.shopId, label: p.label, tokenHash: sha256(token), registeredBy: p.createdBy, pairedAt: now, installHash: installId ? installHash(installId) : null })
      .returning({ id: clockDevices.id });
    await tx.update(clockPairings).set({ usedAt: now, deviceId: device.id }).where(eq(clockPairings.id, p.id));
    const shop = await tx.query.shops.findFirst({ where: eq(shops.id, p.shopId), columns: { name: true } });
    return { pairing: p, deviceId: device.id, shop: shop?.name ?? "" };
  });
  await audit({ staffId: result.pairing.createdBy, label: `kiosk:${result.pairing.label}` }, "timeclock.device_pair", "clock_device", result.deviceId, { label: result.pairing.label, via: installId ? "staff_app" : "web", ip: input.ip }, result.pairing.shopId);
  return { token, device: { id: result.deviceId, shopId: result.pairing.shopId, shop: result.shop, label: result.pairing.label } };
}

/** A paired front-desk clock from its token, while it's in use; an app install's token only with its own install id. Marks it seen. */
export async function pairedDevice(token: string | null | undefined, installId: string | null | undefined, now = new Date()) {
  if (!token) return null;
  const [d] = await db
    .select({ id: clockDevices.id, shopId: clockDevices.shopId, label: clockDevices.label, shop: shops.name, pairedAt: clockDevices.pairedAt, installHash: clockDevices.installHash })
    .from(clockDevices)
    .innerJoin(shops, eq(shops.id, clockDevices.shopId))
    .where(and(eq(clockDevices.tokenHash, sha256(token)), isNull(clockDevices.revokedAt)));
  if (!d?.pairedAt) return null;
  if (d.installHash && !(installId && sameSecret(d.installHash, installHash(installId)))) return null;
  await db.update(clockDevices).set({ lastSeenAt: now }).where(eq(clockDevices.id, d.id));
  return { id: d.id, shopId: d.shopId, label: d.label, shop: d.shop };
}
