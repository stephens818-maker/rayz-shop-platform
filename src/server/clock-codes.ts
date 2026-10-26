import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { shopClockSettings } from "@/domain/time-clock";
import { appBaseUrl } from "@/lib/deployment";
import { Actor, audit } from "./audit";
import { hmac, sameSecret } from "./auth/tokens";
import { notFound } from "./errors";

/**
 * P1: presence proofs for a phone punch that aren't biometric. The front-desk screen shows a QR code
 * that changes every 30 seconds (a code from the last minute is accepted, so a photo of it goes
 * stale); the shop's NFC sticker holds a fixed link that a manager can retire. Both open the
 * signed-in person's clock page with the proof in the address, and neither is stored.
 */
export const QR_STEP_MS = 30_000;

const qrFor = (shopId: string, step: number) => hmac(`clock-qr:${shopId}:${step}`).slice(0, 12);

export function clockQrCode(shopId: string, now = new Date()) {
  const step = Math.floor(now.getTime() / QR_STEP_MS);
  return { code: qrFor(shopId, step), expiresAt: new Date((step + 1) * QR_STEP_MS) };
}

export function qrValid(shopId: string, code: string | null | undefined, now = new Date()): boolean {
  if (!code) return false;
  const step = Math.floor(now.getTime() / QR_STEP_MS);
  return [step, step - 1].some((s) => sameSecret(qrFor(shopId, s), code));
}

const tagFor = (shopId: string, version: number) => hmac(`clock-nfc:${shopId}:${version}`).slice(0, 22);

export function nfcValid(shopId: string, version: number, tag: string | null | undefined): boolean {
  return !!tag && sameSecret(tagFor(shopId, version), tag);
}

export function clockProofUrl(shopId: string, proof: { qr: string } | { tag: string }) {
  const q = new URLSearchParams({ shop: shopId, ...proof });
  return `${appBaseUrl()}/admin/clock?${q}`;
}

/** The link to write to the shop's NFC sticker. */
export async function nfcTagUrl(shopId: string) {
  const [s] = await db.select({ timeClock: shops.timeClock }).from(shops).where(eq(shops.id, shopId));
  if (!s) throw notFound("Shop");
  return clockProofUrl(shopId, { tag: tagFor(shopId, shopClockSettings(s.timeClock).nfcTagVersion) });
}

/** A lost or copied sticker: every tag written before stops working. */
export async function retireNfcTag(shopId: string, actor: Actor) {
  const [s] = await db.select({ timeClock: shops.timeClock }).from(shops).where(eq(shops.id, shopId));
  if (!s) throw notFound("Shop");
  const settings = shopClockSettings(s.timeClock);
  const next = { ...settings, nfcTagVersion: settings.nfcTagVersion + 1 };
  await db
    .update(shops)
    .set({ timeClock: next as unknown as Record<string, unknown> })
    .where(eq(shops.id, shopId));
  await audit(actor, "timeclock.nfc_retired", "shop", shopId, { version: next.nfcTagVersion }, shopId);
  return nfcTagUrl(shopId);
}
