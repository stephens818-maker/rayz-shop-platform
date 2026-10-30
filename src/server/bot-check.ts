import { AppError } from "./errors";

/**
 * I14: bot protection on signed-out web booking, with Cloudflare Turnstile. Off until
 * TURNSTILE_SECRET_KEY is set (with NEXT_PUBLIC_TURNSTILE_SITE_KEY for the widget); then a guest
 * booking needs the widget's token, sent as captchaToken or the cf-turnstile-response header.
 */
export function botCheckOn() {
  return !!process.env.TURNSTILE_SECRET_KEY?.trim();
}

export async function assertHuman(token: string | null | undefined, ip: string | null) {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return;
  if (!token) throw new AppError("forbidden", "Please complete the check that you're not a robot.", { reason: "bot_check_required" });
  const form = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res?.ok) throw new AppError("internal", "We couldn't check that you're not a robot. Try again in a minute.");
  const body = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!body.success) throw new AppError("forbidden", "Please complete the check that you're not a robot.", { reason: "bot_check_failed" });
}
