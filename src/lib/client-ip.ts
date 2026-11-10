import { parseIp } from "@/domain/time-clock";

type HeaderSource = { get(name: string): string | null };

const valid = (s: string | null | undefined) => {
  const v = s?.trim();
  return v && parseIp(v) ? v : null;
};

/**
 * The client's public IP, read only from headers a trusted proxy wrote. On Vercel its edge sets
 * x-real-ip and overwrites x-forwarded-for, so a client can't supply its own. Self-hosted, set
 * TRUSTED_PROXY_HOPS to how many proxies sit in front of the app: each appends the address it saw,
 * so the client is that many entries from the end and anything a client sent itself is ignored.
 * With neither the IP is unknown (null), and a location that limits sign-in to its network refuses
 * the request.
 */
export function clientIp(h: HeaderSource, env: Record<string, string | undefined> = process.env): string | null {
  if (env.VERCEL) return valid(h.get("x-real-ip")) ?? valid(h.get("x-vercel-forwarded-for")?.split(",")[0]) ?? valid(h.get("x-forwarded-for")?.split(",")[0]);
  const hops = Number(env.TRUSTED_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 1) return null;
  const list = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return valid(list[list.length - hops]);
}
