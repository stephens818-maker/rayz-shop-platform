"use server";

import { headers } from "next/headers";
import { clientIp } from "@/lib/client-ip";
import { safe } from "@/server/action";
import { AppError } from "@/server/errors";
import { joinOpeningsWaitlist, liveOpenings } from "@/server/marketing/openings";

const WINDOW_MS = 10 * 60_000;
const hits = new Map<string, number[]>();

/** Per server instance and IP, like the coupon checks: it slows abuse rather than stopping it. Without a trusted IP nothing is limited. */
async function limit(kind: string, max: number, message: string) {
  const ip = clientIp(await headers());
  if (!ip) return;
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) throw new AppError("rate_limited", message);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear();
}

/** The open times now, for the page to refresh itself as they're booked. */
export async function liveOpeningsAction(id: string) {
  return safe(async () => {
    await limit("poll", 120, "Too many refreshes. Reload the page in a few minutes.");
    return liveOpenings(String(id));
  });
}

export async function joinOpeningsWaitlistAction(id: string, input: { firstName: string; phone: string; date: string | null }) {
  return safe(async () => {
    await limit("join", 5, "Too many tries. Try again in a few minutes.");
    return joinOpeningsWaitlist(String(id), { firstName: String(input?.firstName ?? ""), phone: String(input?.phone ?? ""), date: input?.date ? String(input.date) : null });
  });
}
