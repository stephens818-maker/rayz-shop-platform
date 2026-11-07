import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio signs every webhook: HMAC-SHA1 of the full URL followed by each POST parameter's name and
 * value, sorted by name, keyed with the account's auth token, in base64 (X-Twilio-Signature).
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validTwilioSignature(authToken: string | undefined, signature: string | null, url: string, params: Record<string, string>): boolean {
  if (!authToken || !signature) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
