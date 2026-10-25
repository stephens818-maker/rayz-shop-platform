import { handleOperatorChoice } from "@/server/shop-line";
import { twilioWebhook } from "@/server/twilio/webhook";

/** A key on the phone operator's menu (or what the caller said, when speech is on), or `none=1` when the caller did neither. */
export const POST = twilioWebhook((p, url) =>
  handleOperatorChoice({ callSid: p.CallSid ?? "", digits: (p.Digits ?? "").slice(0, 2), speech: p.SpeechResult ?? null, none: url.searchParams.get("none") === "1" }),
);
