export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8787";
export const APP_VERSION = "3.0.0";

export async function api<T>(path: string, token?: string | null, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  headers.set("x-client", "ios");
  headers.set("x-app-version", APP_VERSION);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 204) return null as T;
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? "Something went wrong");
  return body as T;
}

export function needsUpdate(min: string, current = APP_VERSION): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number(n) || 0);
  const [a, b, c] = parse(current);
  const [x, y, z] = parse(min);
  if (a !== x) return a < x;
  if (b !== y) return b < y;
  return c < z;
}
