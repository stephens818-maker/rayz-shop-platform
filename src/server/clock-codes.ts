import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";
import { shopClockSettings } from "@/domain/time-clock";
import { appBaseUrl } from "@/lib/deployment";
import { Actor, audit } from "./audit";
import { hmac } from "./auth/tokens";
import { notFound } from "./errors";

/**
 * The links a phone opens at the shop. The front-desk clock's QR code (clock-security.ts: signed,
 * single-use, a minute long) is the only one that punches. The NFC sticker's fixed link is still
 * made and retired here, but since the kiosk-only rule it no longer punches on its own.
 */
const tagFor = (shopId: string, version: number) => hmac(`clock-nfc:${shopId}:${version}`).slice(0, 22);

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
