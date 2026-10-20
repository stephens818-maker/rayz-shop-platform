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

export interface EmailProvider {
  name: string;
  enabled: boolean;
  sendEmail(to: string, subject: string, body: string): Promise<SendResult>;
}

class DisabledProvider implements SmsProvider, EmailProvider {
  name = "disabled";
  enabled = false;
  async sendSms(): Promise<SendResult> {
    return {};
  }
  async sendEmail(): Promise<SendResult> {
    return {};
  }
}

class ConsoleProvider implements SmsProvider, EmailProvider {
  name = "console";
  enabled = true;
  async sendSms(to: string, body: string) {
    console.log(`[sms → ${to}] ${body}`);
    return { providerMessageId: `console-${Date.now()}` };
  }
  async sendEmail(to: string, subject: string, body: string) {
    console.log(`[email → ${to}] ${subject}\n${body}`);
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

class ResendEmailStub implements EmailProvider {
  name = "resend";
  enabled = true;
  async sendEmail(): Promise<SendResult> {
    // TODO(go-live): POST https://api.resend.com/emails with RESEND_API_KEY and a verified domain.
    throw new Error("Resend provider is a stub in v1");
  }
}

export function smsProvider(): SmsProvider {
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
  switch ((process.env.NOTIFICATIONS_EMAIL_PROVIDER ?? "disabled").toLowerCase()) {
    case "console":
      return new ConsoleProvider();
    case "resend":
      return new ResendEmailStub();
    default:
      return new DisabledProvider();
  }
}
