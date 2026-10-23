import type { EmailAttachment } from "@/db/schema";
import { demoMode } from "@/lib/deployment";

/**
 * Pluggable SMS / email providers. v1 ships with `disabled` (default) and `console`.
 * `twilio` and `resend` are interface-complete stubs — wire the HTTP calls when going live.
 */
export interface SendResult {
  providerMessageId?: string;
}

export interface SmsProvider {
  name: string;
  enabled: boolean;
  sendSms(to: string, body: string): Promise<SendResult>;
}

/** Click-to-call through the shop line: the provider rings the staff member's shop, then connects the client, so neither sees the other's number. */
export interface VoiceProvider {
  name: string;
  enabled: boolean;
  bridgeCall(to: string, from: string | null): Promise<SendResult>;
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
  async sendEmail(): Promise<SendResult> {
    return {};
  }
}

class ConsoleProvider implements SmsProvider, EmailProvider, VoiceProvider {
  name = "console";
  enabled = true;
  async bridgeCall(to: string, from: string | null) {
    console.log(`[call ${from ?? "shop line"} → ${to}]`);
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

class TwilioSmsStub implements SmsProvider {
  name = "twilio";
  enabled = true;
  async sendSms(): Promise<SendResult> {
    // TODO(go-live): POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
    // with TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM. Requires A2P 10DLC registration.
    throw new Error("Twilio provider is a stub in v1");
  }
}

class TwilioVoiceStub implements VoiceProvider {
  name = "twilio";
  enabled = true;
  async bridgeCall(): Promise<SendResult> {
    // TODO(go-live): POST .../Calls.json to ring the shop line first, with TwiML <Dial callerId="{shop line}">{client}</Dial>.
    throw new Error("Twilio voice is a stub in v1");
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

export function smsProvider(): SmsProvider {
  if (demoMode()) return new DisabledProvider();
  switch ((process.env.NOTIFICATIONS_SMS_PROVIDER ?? "disabled").toLowerCase()) {
    case "console":
      return new ConsoleProvider();
    case "twilio":
      return new TwilioSmsStub();
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
    case "twilio":
      return new TwilioVoiceStub();
    default:
      return new DisabledProvider();
  }
}
