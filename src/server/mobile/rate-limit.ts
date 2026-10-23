import { sql } from "drizzle-orm";
import { db } from "@/db";
import { AppError } from "@/server/errors";

/**
 * Fixed window counter. A request that would pass the limit throws and does not increment past it
 * only after the check — the count includes the attempt that was refused, so a tight loop stays blocked.
 */
export async function hitLimit(key: string, limit: number, windowMs: number): Promise<void> {
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));
  const [row] = (await db.execute(sql`
    insert into mobile_rate_buckets (key, window_start, count)
    values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when mobile_rate_buckets.window_start < now() - (${windowSeconds} || ' seconds')::interval then 1 else mobile_rate_buckets.count + 1 end,
      window_start = case when mobile_rate_buckets.window_start < now() - (${windowSeconds} || ' seconds')::interval then now() else mobile_rate_buckets.window_start end
    returning count
  `)) as unknown as { count: number }[];
  if (Number(row?.count ?? 0) > limit) throw new AppError("rate_limited", "Too many requests. Try again later.");
}

export async function limitOtp(input: { identifier: string; ip?: string | null; deviceKey?: string | null }) {
  if (input.ip) await hitLimit(`otp:ip:${input.ip}`, 20, 3_600_000);
  if (input.deviceKey) await hitLimit(`otp:device:${input.deviceKey}`, 10, 3_600_000);
  await hitLimit(`otp:id:${input.identifier}`, 5, 3_600_000);
}

export async function limitGuestBooking(input: { ip?: string | null; phone?: string | null }) {
  if (input.ip) await hitLimit(`book:ip:${input.ip}`, 8, 3_600_000);
  if (input.phone) await hitLimit(`book:phone:${input.phone}`, 4, 86_400_000);
}

/**
 * Per-IP cap for every /api/v1 request, with tighter caps on sending a code and on creating an appointment.
 * No IP header (local tests, some cron calls) is not counted. Production should send X-Forwarded-For.
 */
export async function limitApi(method: string, path: string, ip: string | null) {
  if (!ip || !path.startsWith("/api/v1")) return;
  const p = path.split("?")[0].replace(/\/$/, "");
  if (method === "POST" && p.endsWith("/auth/otp/start")) await hitLimit(`api:otp-start:ip:${ip}`, 20, 3_600_000);
  if (method === "POST" && (p.endsWith("/appointments") || p.endsWith("/appointment-groups"))) await hitLimit(`api:book:ip:${ip}`, 30, 3_600_000);
  await hitLimit(`api:ip:${ip}`, 600, 3_600_000);
}
