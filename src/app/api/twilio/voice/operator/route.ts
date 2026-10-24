import { handleOperatorChoice } from "@/server/shop-line";
import { twilioWebhook } from "@/server/twilio/webhook";

/** A key on the phone operator's menu, or `none=1` when the caller pressed nothing. */
export const POST = twilioWebhook((p, url) => handleOperatorChoice({ callSid: p.CallSid ?? "", digits: (p.Digits ?? "").slice(0, 2), none: url.searchParams.get("none") === "1" }));
