import { demoMode } from "@/lib/deployment";
import { flags } from "@/lib/flags";
import { AppError } from "@/server/errors";

export function twilioVerifyConfigured(): boolean {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  // Demo mode never calls Twilio. A live-looking key is still a stub until the three Verify vars are set.
  if (demoMode()) return false;
  return Boolean(sid && token && service && sid.startsWith("AC"));
}

function authHeader(): string {
  const raw = `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** Twilio Verify creates and checks the code (Fraud Guard, 10DLC-exempt). The local code table is the fallback. */
export async function startTwilioVerify(to: string, channel: "sms" | "email", appHash?: string | null): Promise<string> {
  const service = process.env.TWILIO_VERIFY_SERVICE_SID!;
  const body = new URLSearchParams({ To: to, Channel: channel });
  if (appHash && channel === "sms") body.set("AppHash", appHash);
  const res = await fetch(`https://verify.twilio.com/v2/Services/${service}/Verifications`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new AppError("internal", "We couldn't send your code. Try again in a minute.");
  const data = (await res.json()) as { sid?: string };
  if (!data.sid) throw new AppError("internal", "We couldn't send your code. Try again in a minute.");
  return data.sid;
}

export async function checkTwilioVerify(to: string, code: string): Promise<boolean> {
  const service = process.env.TWILIO_VERIFY_SERVICE_SID!;
  const res = await fetch(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, Code: code }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { status?: string };
  return data.status === "approved";
}

/** Fixed review code. Off unless FEATURE_REVIEW_LOGIN=true. The app-config flag cannot turn this on by itself. */
export function reviewCodeFor(phone: string | null): string | null {
  if (!flags.reviewLogin()) return null;
  const allowed = process.env.APP_REVIEW_PHONE?.trim();
  const code = process.env.APP_REVIEW_CODE?.trim();
  if (!allowed || !code || phone !== allowed) return null;
  return code;
}

export function autofillSmsBody(code: string, domain: string, androidHash?: string | null): string {
  const lines = [`Your Ray'z Barber Shop code is ${code}. It expires in 10 minutes.`, `@${domain} #${code}`];
  if (androidHash) lines.push(androidHash);
  return lines.join("\n");
}
