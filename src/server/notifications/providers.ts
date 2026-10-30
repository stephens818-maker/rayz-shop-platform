import { randomBytes } from "node:crypto";
import type { EmailAttachment } from "@/db/schema";
import { demoMode } from "@/lib/deployment";
import { TwilioEnv, twilioCall, twilioEnv, twilioSendSms, webhookUrl } from "../twilio/client";
import { nativePush } from "./push";

/**
 * Pluggable SMS, voice and email providers: `disabled` (default), `console`, `simulator` (dev: the
 * call simulator drives replies, keypresses and delivery) and `twilio`, which is real but stays off
 * until TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set. Email is `resend` (RESEND_API_KEY) or `postmark`
 * (POSTMARK_SERVER_TOKEN), real and off until its key is set, from EMAIL_FROM on a verified domain.
 * App push is `disabled`, `console`, `simulator`, `native` (APNs and FCM, src/server/notifications/push.ts) or the
 * `expo` stub, by NOTIFICATIONS_PUSH_PROVIDER.
 */
export interface SendResult {
  providerMessageId?: string;
}

export interface SmsOptions {
  /** The shop's Twilio number; null uses the brand's sender. */
  from?: string | null;
  /** Send through this Messaging Service instead (marketing has its own 10DLC campaign). */
  messagingServiceSid?: string | null;
}

export interface SmsProvider {
  name: string;
  enabled: boolean;
  sendSms(to: string, body: string, o?: SmsOptions): Promise<SendResult>;
}

/**
 * Click-to-call through the shop line: the provider rings the shop phone, then connects the client, so
 * neither sees the other's number. Outreach calls are automated text-to-speech calls about a call-in.
 */
export interface VoiceProvider {
  name: string;
  enabled: boolean;
  bridgeCall(to: string, shopPhone: string | null, o?: { jobId?: string; callerId?: string | null }): Promise<SendResult>;
  outreachCall(to: string, o: { outreachId: string; jobId: string; callerId: string | null }): Promise<SendResult>;
}

export interface EmailOptions {
  /** The one-click stop link (List-Unsubscribe and List-Unsubscribe-Post headers). */
  listUnsubscribe?: string | null;
  /** Postmark's message stream: "broadcast" for Campaign Center, "outbound" for everything else. */
  stream?: "outbound" | "broadcast";
}

export interface EmailProvider {
  name: string;
  enabled: boolean;
  /** `body` is the plain text part; `html`, when given, goes alongside it as the HTML part. */
  sendEmail(to: string, subject: string, body: string, attachments?: EmailAttachment[], html?: string | null, o?: EmailOptions): Promise<SendResult>;
}

export interface PushOptions {
  /** Strings the app reads when the notification is tapped (kind, appointment). */
  data?: Record<string, string>;
  marketing?: boolean;
}

/** App push to one of a client's devices (customer_devices), by the device row's id. */
export interface PushProvider {
  name: string;
  enabled: boolean;
  sendPush(deviceId: string, title: string, body: string, o?: PushOptions): Promise<SendResult>;
}

class DisabledProvider implements SmsProvider, EmailProvider, VoiceProvider, PushProvider {
  name = "disabled";
  enabled = false;
  async sendPush(): Promise<SendResult> {
    return {};
  }
  async sendSms(): Promise<SendResult> {
    return {};
  }
  async bridgeCall(): Promise<SendResult> {
    return {};
  }
  async outreachCall(): Promise<SendResult> {
    return {};
  }
  async sendEmail(): Promise<SendResult> {
    return {};
  }
}

class ConsoleProvider implements SmsProvider, EmailProvider, VoiceProvider, PushProvider {
  name = "console";
  enabled = true;
  async sendPush(deviceId: string, title: string, body: string) {
    console.log(`[push → device ${deviceId}] ${title}: ${body}`);
    return { providerMessageId: `console-${Date.now()}` };
  }
  async bridgeCall(to: string, shopPhone: string | null) {
    console.log(`[call ${shopPhone ?? "shop line"} → ${to}]`);
    return { providerMessageId: `console-${Date.now()}` };
  }
  async outreachCall(to: string, o: { outreachId: string }) {
    console.log(`[automated call → ${to}] outreach ${o.outreachId}`);
    return { providerMessageId: `console-${Date.now()}` };
  }
  async sendSms(to: string, body: string) {
    console.log(`[sms → ${to}] ${body}`);
    return { providerMessageId: `console-${Date.now()}` };
  }
  async sendEmail(to: string, subject: string, body: string, attachments: EmailAttachment[] = [], html?: string | null, o: EmailOptions = {}) {
    const files = attachments.map((a) => `${a.filename} (${a.contentType}, ${Math.round((a.content.length * 3) / 4 / 1024)} KB)`).join(", ");
    const htmlNote = html ? `\n[html part: ${Math.max(1, Math.round(Buffer.byteLength(html) / 1024))} KB]` : "";
    const stop = o.listUnsubscribe ? `\n[one-click stop: ${o.listUnsubscribe}]` : "";
    console.log(`[email → ${to}] ${subject}\n${body}${htmlNote}${files ? `\n[attachments: ${files}]` : ""}${stop}`);
    return { providerMessageId: `console-${Date.now()}` };
  }
}

/** Accepts everything and hands back IDs shaped like Twilio's; the simulator page plays the client's side. */
class SimulatorProvider implements SmsProvider, VoiceProvider, PushProvider {
  name = "simulator";
  enabled = true;
  async sendPush() {
    return { providerMessageId: `PNsim${randomBytes(12).toString("hex")}` };
  }
  async sendSms() {
    return { providerMessageId: `SMsim${randomBytes(12).toString("hex")}` };
  }
  async bridgeCall() {
    return { providerMessageId: `CAsim${randomBytes(12).toString("hex")}` };
  }
  async outreachCall() {
    return { providerMessageId: `CAsim${randomBytes(12).toString("hex")}` };
  }
}

class TwilioSms implements SmsProvider {
  name = "twilio";
  enabled = true;
  constructor(private env: TwilioEnv) {}
  sendSms(to: string, body: string, o: SmsOptions = {}) {
    return twilioSendSms(o.messagingServiceSid ? { ...this.env, messagingServiceSid: o.messagingServiceSid } : this.env, to, body, o.messagingServiceSid ? null : (o.from ?? null));
  }
}

class TwilioVoice implements VoiceProvider {
  name = "twilio";
  enabled = true;
  constructor(private env: TwilioEnv) {}
  async bridgeCall(_to: string, shopPhone: string | null, o: { jobId?: string; callerId?: string | null } = {}) {
    if (!shopPhone) throw new Error("The shop has no phone number to ring first");
    if (!o.jobId) throw new Error("Bridged calls need the job they belong to");
    // Ring the shop first; when it answers, Twilio fetches the bridge TwiML, which dials the client by job, never by number in a URL.
    return twilioCall(this.env, { to: shopPhone, from: o.callerId ?? null, url: webhookUrl("voice/bridge", { job: o.jobId }) });
  }
  outreachCall(to: string, o: { outreachId: string; jobId: string; callerId: string | null }) {
    return twilioCall(this.env, { to, from: o.callerId, url: webhookUrl("voice/outreach", { o: o.outreachId }), machineDetection: true });
  }
}

export const DEFAULT_EMAIL_FROM = "Ray'z Barber Shop <no-reply@rayzbs.com>";
const emailFrom = () => process.env.EMAIL_FROM?.trim() || DEFAULT_EMAIL_FROM;

const unsubscribeHeaders = (url: string | null | undefined): Record<string, string> =>
  url ? { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/** https://resend.com/docs/api-reference/emails/send-email */
export class ResendEmail implements EmailProvider {
  name = "resend";
  enabled = true;
  constructor(
    private apiKey: string,
    private from = emailFrom(),
  ) {}
  async sendEmail(to: string, subject: string, body: string, attachments: EmailAttachment[] = [], html?: string | null, o: EmailOptions = {}): Promise<SendResult> {
    const headers = unsubscribeHeaders(o.listUnsubscribe);
    const r = await postJson(
      "https://api.resend.com/emails",
      { Authorization: `Bearer ${this.apiKey}` },
      {
        from: this.from,
        to: [to],
        subject,
        text: body,
        ...(html ? { html } : {}),
        ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })) } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      },
    );
    if (!r.ok) throw new Error(`Resend refused the email (${r.status}${typeof r.json.message === "string" ? `: ${r.json.message}` : ""})`.slice(0, 300));
    return { providerMessageId: typeof r.json.id === "string" ? r.json.id : undefined };
  }
}

/** https://postmarkapp.com/developer/api/email-api */
export class PostmarkEmail implements EmailProvider {
  name = "postmark";
  enabled = true;
  constructor(
    private serverToken: string,
    private from = emailFrom(),
  ) {}
  async sendEmail(to: string, subject: string, body: string, attachments: EmailAttachment[] = [], html?: string | null, o: EmailOptions = {}): Promise<SendResult> {
    const headers = Object.entries(unsubscribeHeaders(o.listUnsubscribe)).map(([Name, Value]) => ({ Name, Value }));
    const r = await postJson(
      "https://api.postmarkapp.com/email",
      { "X-Postmark-Server-Token": this.serverToken },
      {
        From: this.from,
        To: to,
        Subject: subject,
        TextBody: body,
        ...(html ? { HtmlBody: html } : {}),
        MessageStream: o.stream ?? "outbound",
        TrackOpens: false,
        ...(attachments.length ? { Attachments: attachments.map((a) => ({ Name: a.filename, Content: a.content, ContentType: a.contentType })) } : {}),
        ...(headers.length ? { Headers: headers } : {}),
      },
    );
    const code = typeof r.json.ErrorCode === "number" ? r.json.ErrorCode : 0;
    if (!r.ok || code !== 0) throw new Error(`Postmark refused the email (${r.status}${code ? `, error ${code}` : ""}${typeof r.json.Message === "string" ? `: ${r.json.Message}` : ""})`.slice(0, 300));
    return { providerMessageId: typeof r.json.MessageID === "string" ? r.json.MessageID : undefined };
  }
}

class ExpoPushStub implements PushProvider {
  name = "expo";
  enabled = true;
  async sendPush(): Promise<SendResult> {
    // TODO(go-live): POST https://exp.host/--/api/v2/push/send with the device's token, looked up by id at send time.
    throw new Error("Expo push provider is a stub in v1");
  }
}

/** "twilio" without the keys is off, like "disabled": nothing leaves and the outbox says suppressed. */
function twilioOr<T>(make: (env: TwilioEnv) => T): T | DisabledProvider {
  const env = twilioEnv();
  return env ? make(env) : new DisabledProvider();
}

export function smsProvider(): SmsProvider {
  if (demoMode()) return new DisabledProvider();
  switch ((process.env.NOTIFICATIONS_SMS_PROVIDER ?? "disabled").toLowerCase()) {
    case "console":
      return new ConsoleProvider();
    case "simulator":
      return new SimulatorProvider();
    case "twilio":
      return twilioOr((env) => new TwilioSms(env));
    default:
      return new DisabledProvider();
  }
}

export function emailProvider(): EmailProvider {
  if (demoMode()) return new DisabledProvider();
  switch ((process.env.NOTIFICATIONS_EMAIL_PROVIDER ?? "disabled").toLowerCase()) {
    case "console":
      return new ConsoleProvider();
    case "resend": {
      const key = process.env.RESEND_API_KEY?.trim();
      return key ? new ResendEmail(key) : new DisabledProvider();
    }
    case "postmark": {
      const token = process.env.POSTMARK_SERVER_TOKEN?.trim();
      return token ? new PostmarkEmail(token) : new DisabledProvider();
    }
    default:
      return new DisabledProvider();
  }
}

export function pushProvider(): PushProvider {
  if (demoMode()) return new DisabledProvider();
  switch ((process.env.NOTIFICATIONS_PUSH_PROVIDER ?? "disabled").toLowerCase()) {
    case "console":
      return new ConsoleProvider();
    case "simulator":
      return new SimulatorProvider();
    case "expo":
      return new ExpoPushStub();
    case "native":
      return nativePush() ?? new DisabledProvider();
    default:
      return new DisabledProvider();
  }
}

export function voiceProvider(): VoiceProvider {
  if (demoMode()) return new DisabledProvider();
  switch ((process.env.NOTIFICATIONS_VOICE_PROVIDER ?? "disabled").toLowerCase()) {
    case "console":
      return new ConsoleProvider();
    case "simulator":
      return new SimulatorProvider();
    case "twilio":
      return twilioOr((env) => new TwilioVoice(env));
    default:
      return new DisabledProvider();
  }
}

/** Live Twilio is connected for texts or calls: webhooks are verified and the simulator stays off. */
export const liveTwilio = () => smsProvider().name === "twilio" || voiceProvider().name === "twilio";
