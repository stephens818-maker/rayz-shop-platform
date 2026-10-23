import { randomBytes } from "node:crypto";
import type { EmailAttachment } from "@/db/schema";
import { demoMode } from "@/lib/deployment";
import { TwilioEnv, twilioCall, twilioEnv, twilioSendSms, webhookUrl } from "../twilio/client";

/**
 * Pluggable SMS, voice and email providers: `disabled` (default), `console`, `simulator` (dev: the
 * call simulator drives replies, keypresses and delivery) and `twilio`, which is real but stays off
 * until TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set. `resend` is an interface-complete stub.
 */
export interface SendResult {
  providerMessageId?: string;
}

export interface SmsOptions {
  /** The shop's Twilio number; null uses the brand's sender. */
  from?: string | null;
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

export interface EmailProvider {
  name: string;
  enabled: boolean;
  sendEmail(to: string, subject: string, body: string, attachments?: EmailAttachment[]): Promise<SendResult>;
}

class DisabledProvider implements SmsProvider, EmailProvider, VoiceProvider {
  name = "disabled";
  enabled = false;
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

class ConsoleProvider implements SmsProvider, EmailProvider, VoiceProvider {
  name = "console";
  enabled = true;
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
  async sendEmail(to: string, subject: string, body: string, attachments: EmailAttachment[] = []) {
    const files = attachments.map((a) => `${a.filename} (${a.contentType}, ${Math.round((a.content.length * 3) / 4 / 1024)} KB)`).join(", ");
    console.log(`[email → ${to}] ${subject}\n${body}${files ? `\n[attachments: ${files}]` : ""}`);
    return { providerMessageId: `console-${Date.now()}` };
  }
}

/** Accepts everything and hands back IDs shaped like Twilio's; the simulator page plays the client's side. */
class SimulatorProvider implements SmsProvider, VoiceProvider {
  name = "simulator";
  enabled = true;
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
    return twilioSendSms(this.env, to, body, o.from ?? null);
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

class ResendEmailStub implements EmailProvider {
  name = "resend";
  enabled = true;
  async sendEmail(): Promise<SendResult> {
    // TODO(go-live): POST https://api.resend.com/emails with RESEND_API_KEY and a verified domain.
    // Attachments map to Resend's `attachments: [{ filename, content }]` (content is already base64).
    throw new Error("Resend provider is a stub in v1");
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
    case "resend":
      return new ResendEmailStub();
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
