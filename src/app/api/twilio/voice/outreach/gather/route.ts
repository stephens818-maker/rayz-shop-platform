import { response, hangup } from "@/domain/twiml";
import { voiceOutreachGather } from "@/server/shop-line";
import { twilioWebhook, uuidParam } from "@/server/twilio/webhook";

/** The key the client pressed on an automated call-in call. */
export const POST = twilioWebhook(async (p, url) => {
  const o = uuidParam(url, "o");
  if (!o) return response(hangup());
  return voiceOutreachGather({ outreachId: o, callSid: p.CallSid ?? "", digits: (p.Digits ?? "").slice(0, 4) });
});
