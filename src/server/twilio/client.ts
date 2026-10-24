/**
 * Twilio's REST API, called with fetch: texts (Messages) and calls (Calls). Only used when the keys are
 * set; see twilioConfigured(). Nothing here is reached in tests or with the simulator.
 */
import { appBaseUrl } from "@/lib/deployment";

const API = "https://api.twilio.com/2010-04-01";

export interface TwilioEnv {
  accountSid: string;
  authToken: string;
  /** Sends texts from the service's number pool when a shop has no number of its own. */
  messagingServiceSid: string | null;
  /** The brand's fallback sender. */
  from: string | null;
}

export function twilioEnv(): TwilioEnv | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return null;
  return { accountSid, authToken, messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null, from: process.env.TWILIO_FROM?.trim() || null };
}

export const twilioConfigured = () => twilioEnv() !== null;

/** Where Twilio calls us back. Signatures are checked against this exact URL. */
export const webhookUrl = (path: string, query: Record<string, string> = {}) => {
  const q = new URLSearchParams(query).toString();
  return `${appBaseUrl()}/api/twilio/${path}${q ? `?${q}` : ""}`;
};

async function post(env: TwilioEnv, path: string, form: [string, string][]) {
  const res = await fetch(`${API}/Accounts/${env.accountSid}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.accountSid}:${env.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) throw new Error(`Twilio ${res.status}${json.code ? ` (${json.code})` : ""}: ${json.message ?? "request failed"}`);
  return json;
}

export async function twilioSendSms(env: TwilioEnv, to: string, body: string, from: string | null) {
  const sender: [string, string] = from ? ["From", from] : env.messagingServiceSid ? ["MessagingServiceSid", env.messagingServiceSid] : ["From", env.from ?? ""];
  if (!sender[1]) throw new Error("No Twilio sender: give the shop a Twilio number, or set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM");
  const r = await post(env, "Messages.json", [["To", to], sender, ["Body", body], ["StatusCallback", webhookUrl("sms/status")]]);
  return { providerMessageId: r.sid };
}

export async function twilioCall(env: TwilioEnv, o: { to: string; from: string | null; url: string; machineDetection?: boolean }) {
  const from = o.from ?? env.from;
  if (!from) throw new Error("No Twilio caller ID: give the shop a Twilio number, or set TWILIO_FROM");
  const form: [string, string][] = [
    ["To", o.to],
    ["From", from],
    ["Url", o.url],
    ["Method", "POST"],
    ["StatusCallback", webhookUrl("voice/status")],
    ["StatusCallbackMethod", "POST"],
  ];
  if (o.machineDetection) form.push(["MachineDetection", "DetectMessageEnd"]);
  const r = await post(env, "Calls.json", form);
  return { providerMessageId: r.sid };
}
