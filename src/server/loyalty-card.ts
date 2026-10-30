import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

/**
 * A client's loyalty card: RAYZ1-<client number>-<signature>, in a QR the desk scans into any client
 * search. The signature (HMAC with AUTH_SECRET) means a card can't be made up for a number, so a
 * scanned card finds its client at any Ray'z shop, like their full phone number would.
 */
function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET must be set (32+ chars)");
    return "dev-only-insecure-secret-change-me-0123456789";
  }
  return s;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function loyaltyCardSig(customerId: string, number: number): string {
  const mac = createHmac("sha256", secret()).update(`loyalty-card:${customerId}:${number}`).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of mac) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 10) break;
  }
  return out;
}

export const loyaltyCardValue = (c: { id: string; number: number }) => `RAYZ1-${c.number}-${loyaltyCardSig(c.id, c.number)}`;

export function loyaltyCardValid(c: { id: string; number: number }, sig: string): boolean {
  const want = Buffer.from(loyaltyCardSig(c.id, c.number));
  const got = Buffer.from(sig.toUpperCase());
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The card as an SVG QR code. */
export const loyaltyCardSvg = (c: { id: string; number: number }) => QRCode.toString(loyaltyCardValue(c), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
