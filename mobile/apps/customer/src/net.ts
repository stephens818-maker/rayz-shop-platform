import { needsUpdate as versionBehind } from "@rayz/api";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8787";
export const APP_VERSION = "3.0.0";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(path: string, token?: string | null, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("x-client")) headers.set("x-client", "ios");
  if (!headers.has("x-app-version")) headers.set("x-app-version", APP_VERSION);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 204) return null as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.message ?? "Something went wrong");
  return body as T;
}

export function needsUpdate(min: string, current = APP_VERSION): boolean {
  return versionBehind(min, current);
}
