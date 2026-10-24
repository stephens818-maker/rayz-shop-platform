import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Time-based one-time codes (RFC 6238): 6 digits, 30-second steps, SHA-1, as authenticator apps expect. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not a base32 secret");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export const totpStep = (now: Date | number = Date.now()) => Math.floor(Number(now) / 1000 / STEP_SECONDS);

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const totpCode = (secret: string, now: Date | number = Date.now()) => hotp(secret, totpStep(now));

/**
 * The step a code matches, allowing one step of clock drift either way, or null. A step at or
 * before `afterStep` (the last one used) never matches, so a code can't be used twice.
 */
export function verifyTotp(secret: string, code: string, opts: { now?: Date | number; afterStep?: number | null } = {}): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const cur = totpStep(opts.now ?? Date.now());
  for (const step of [cur - 1, cur, cur + 1]) {
    if (opts.afterStep != null && step <= opts.afterStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(digits))) return step;
  }
  return null;
}

/** The link an authenticator app scans: otpauth://totp/Issuer:account?secret=…&issuer=Issuer */
export function otpauthUri(secret: string, account: string, issuer = "Ray'z Barber Shop"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** "JBSW Y3DP …" for typing the secret in by hand. */
export const groupedSecret = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();
