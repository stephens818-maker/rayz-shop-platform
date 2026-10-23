import { response, hangup } from "@/domain/twiml";
import { voiceBridge } from "@/server/shop-line";
import { twilioWebhook, uuidParam } from "@/server/twilio/webhook";

/** Click-to-call: the shop phone answered; connect the client. */
export const POST = twilioWebhook(async (_p, url) => {
  const job = uuidParam(url, "job");
  return job ? voiceBridge(job) : response(hangup());
});
