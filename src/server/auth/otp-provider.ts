/**
 * Who holds and checks a sign-in code. "local" makes the code here and sends it through the SMS or
 * email provider (src/server/notifications/providers.ts); the dev and demo fallback shows it on
 * screen. "twilio_verify" hands texts to Twilio Verify, which is exempt from 10DLC registration and
 * blocks SMS pumping with Fraud Guard (switched on in the Verify service's settings, not per
 * request). Email codes always go through the email provider, since Verify email needs SendGrid.
 *
 * Env: OTP_SMS_PROVIDER=local|twilio_verify, TWILIO_VERIFY_SERVICE_SID, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.
 */
import { demoMode } from "@/lib/deployment";
import { AppError } from "@/server/errors";

export type OtpProviderName = "local" | "twilio_verify";

export function smsOtpProvider(): OtpProviderName {
  if (demoMode()) return "local";
  return process.env.OTP_SMS_PROVIDER === "twilio_verify" ? "twilio_verify" : "local";
}

function verifyConfig() {
  const sid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const account = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !account || !token) throw new AppError("internal", "Sign-in codes aren't set up yet (TWILIO_VERIFY_SERVICE_SID, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).");
  return { sid, auth: `Basic ${Buffer.from(`${account}:${token}`).toString("base64")}` };
}

async function verifyPost(path: string, form: Record<string, string>) {
  const { sid, auth } = verifyConfig();
  return fetch(`https://verify.twilio.com/v2/Services/${sid}/${path}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Ask Verify to text a code. appHash is the Android SMS Retriever hash, so the app can fill the code in itself. */
export async function verifySend(phone: string, appHash?: string | null) {
  const res = await verifyPost("Verifications", { To: phone, Channel: "sms", ...(appHash ? { AppHash: appHash } : {}) });
  if (res.status === 429) throw new AppError("rate_limited", "Too many codes requested. Try again later.");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
    // 60410: Fraud Guard blocked the destination prefix. 60200: invalid number.
    if (body.code === 60410 || body.code === 60200) throw new AppError("bad_request", "We can't send a code to that number. Try email instead.");
    console.error("verify send failed", res.status, body.code);
    throw new AppError("internal", "We couldn't send your code. Try again in a minute.");
  }
}

/** True when Verify approves the code; false when it's wrong, expired or already used. */
export async function verifyCheck(phone: string, code: string): Promise<boolean> {
  const res = await verifyPost("VerificationCheck", { To: phone, Code: code });
  if (res.status === 404) return false;
  if (!res.ok) throw new AppError("internal", "We couldn't check your code. Try again in a minute.");
  return ((await res.json()) as { status?: string }).status === "approved";
}
