import "server-only";
import { EMPTY_RESPONSE } from "@/domain/twiml";
import { appBaseUrl } from "@/lib/deployment";
import { twilioEnv } from "./client";
import { validTwilioSignature } from "./signature";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidParam = (url: URL, name: string) => {
  const v = url.searchParams.get(name);
  return v && UUID.test(v) ? v : null;
};

/**
 * A Twilio webhook: closed unless Twilio is configured, and only for requests carrying a valid
 * X-Twilio-Signature for the public URL (APP_BASE_URL + path + query). Answers with TwiML.
 */
export function twilioWebhook(handler: (params: Record<string, string>, url: URL) => Promise<string | null | void>) {
  return async (req: Request) => {
    const env = twilioEnv();
    const form = await req.formData().catch(() => null);
    const params: Record<string, string> = {};
    form?.forEach((v, k) => {
      if (typeof v === "string") params[k] = v;
    });
    const url = new URL(req.url);
    const signedUrl = `${appBaseUrl()}${url.pathname}${url.search}`;
    if (!env || !validTwilioSignature(env.authToken, req.headers.get("x-twilio-signature"), signedUrl, params)) return new Response("Forbidden", { status: 403 });
    const xml = (await handler(params, url)) || EMPTY_RESPONSE;
    return new Response(xml, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
  };
}

export const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);
