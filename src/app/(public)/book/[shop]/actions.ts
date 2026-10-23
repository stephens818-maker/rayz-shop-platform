"use server";

import { headers } from "next/headers";
import { safe } from "@/server/action";
import { customerFromRequest } from "@/server/auth/customer";
import { finishBookingDraft, saveBookingDraft } from "@/server/booking-drafts";
import { checkBookingCoupon, holdBookingCoupon } from "@/server/coupons";
import { AppError } from "@/server/errors";

const CHECKS_PER_WINDOW = 20;
const WINDOW_MS = 10 * 60_000;
const checks = new Map<string, number[]>();

/** Per server instance, so it slows guessing rather than stopping it; single-use codes also only work for their own client at checkout. */
async function limitChecks() {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const now = Date.now();
  const recent = (checks.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= CHECKS_PER_WINDOW) throw new AppError("rate_limited", "Too many coupon tries. Try again in a few minutes.");
  recent.push(now);
  checks.set(ip, recent);
  if (checks.size > 10_000) checks.clear();
}

async function signedIn(accessToken: string | null): Promise<string | null> {
  if (!accessToken) return null;
  return customerFromRequest(new Request("http://booking.local", { headers: { authorization: `Bearer ${accessToken}` } }));
}

export async function checkCouponAction(shopSlug: string, code: string) {
  return safe(async () => {
    await limitChecks();
    return checkBookingCoupon(String(shopSlug), String(code).slice(0, 40));
  });
}

export async function holdCouponAction(appointmentCode: string, code: string) {
  return safe(async () => holdBookingCoupon(String(appointmentCode), String(code).slice(0, 40)));
}

export async function saveDraftAction(input: unknown, accessToken: string | null) {
  return safe(async () => {
    await saveBookingDraft(input, await signedIn(accessToken));
    return null;
  });
}

export async function finishDraftAction(token: string, appointmentCode: string) {
  return safe(async () => {
    await finishBookingDraft(String(token), String(appointmentCode));
    return null;
  });
}
