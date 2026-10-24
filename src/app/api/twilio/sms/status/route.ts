import { handleSmsStatus } from "@/server/shop-line";
import { twilioWebhook } from "@/server/twilio/webhook";

/** Delivery reports for texts the shop sent (StatusCallback on each message). */
export const POST = twilioWebhook(async (p) => {
  if (p.MessageSid && p.MessageStatus) await handleSmsStatus({ messageSid: p.MessageSid, status: p.MessageStatus, errorCode: p.ErrorCode ?? null });
  return null;
});
