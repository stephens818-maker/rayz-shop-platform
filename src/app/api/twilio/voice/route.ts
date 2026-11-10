import { handleIncomingCall } from "@/server/shop-line";
import { twilioWebhook } from "@/server/twilio/webhook";

/** A call to a shop number (the number's "A call comes in" webhook): forwarded to the shop phone, or the after-hours message. */
export const POST = twilioWebhook((p) => handleIncomingCall({ from: p.From ?? "", to: p.To ?? "", callSid: p.CallSid ?? "" }));
