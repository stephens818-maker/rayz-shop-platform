"use client";

/** Browser client for /api/v1 — the same endpoints the future mobile app will call. */

const TOKENS_KEY = "rayz.tokens";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function getTokens(): Tokens | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function setTokens(t: { accessToken: string; refreshToken: string; expiresIn: number } | null) {
  if (!t) localStorage.removeItem(TOKENS_KEY);
  else localStorage.setItem(TOKENS_KEY, JSON.stringify({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: Date.now() + t.expiresIn * 1000 }));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function refreshIfNeeded(): Promise<string | null> {
  const t = getTokens();
  if (!t) return null;
  if (t.expiresAt - Date.now() > 60_000) return t.accessToken;
  const res = await fetch("/api/v1/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
  if (!res.ok) {
    setTokens(null);
    return null;
  }
  const n = await res.json();
  setTokens(n);
  return n.accessToken;
}

/** `base` "/api" reaches the web's own customer routes (e.g. /api/account/badges) with the same sign-in. */
export async function api<T>(path: string, init: RequestInit & { auth?: boolean; base?: string } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-client", "web");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init.auth !== false) {
    const token = await refreshIfNeeded();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${init.base ?? "/api/v1"}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? "Request failed");
  return data as T;
}

export const dollars = (c: number) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;

export function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
}
export function fmtDay(isoOrDate: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) {
  const d = isoOrDate.length === 10 ? new Date(`${isoOrDate}T12:00:00Z`) : new Date(isoOrDate);
  return d.toLocaleDateString("en-US", { ...opts, timeZone: isoOrDate.length === 10 ? "UTC" : "America/Chicago" });
}
export function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function addDaysStr(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function chicagoHour(iso: string) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(new Date(iso)));
}
