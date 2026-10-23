import { handleCallStatus } from "@/server/shop-line";
import { num, twilioWebhook } from "@/server/twilio/webhook";

/** Final status of a call the shop placed (StatusCallback on each call). */
export const POST = twilioWebhook(async (p) => {
  if (p.CallSid && p.CallStatus) await handleCallStatus({ callSid: p.CallSid, callStatus: p.CallStatus, duration: num(p.CallDuration) });
  return null;
});
