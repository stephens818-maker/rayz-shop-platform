import { response, hangup } from "@/domain/twiml";
import { voiceOutreachAnswer } from "@/server/shop-line";
import { twilioWebhook, uuidParam } from "@/server/twilio/webhook";

/** An automated call-in call was answered, by a person or a machine (answering-machine detection). */
export const POST = twilioWebhook(async (p, url) => {
  const o = uuidParam(url, "o");
  if (!o) return response(hangup());
  return voiceOutreachAnswer({ outreachId: o, callSid: p.CallSid ?? "", answeredBy: p.AnsweredBy ?? null, to: p.To ?? null });
});
