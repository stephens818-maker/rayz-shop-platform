import { handleDialResult } from "@/server/shop-line";
import { num, twilioWebhook } from "@/server/twilio/webhook";

/** How the forwarded call to the shop phone ended. */
export const POST = twilioWebhook((p) => handleDialResult({ callSid: p.CallSid ?? "", dialStatus: p.DialCallStatus ?? "", duration: num(p.DialCallDuration) }));
