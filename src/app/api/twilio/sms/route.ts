import { handleInboundSms } from "@/server/shop-line";
import { twilioWebhook } from "@/server/twilio/webhook";

/** A client's text to a shop number (the number's "A message comes in" webhook). */
export const POST = twilioWebhook(async (p) => (await handleInboundSms({ from: p.From ?? "", to: p.To ?? "", body: p.Body ?? "", messageSid: p.MessageSid ?? null })).twiml);
