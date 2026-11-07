import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Calls /api/staff/v1 route handlers in-process, the way the app would over HTTP. */

export const STAFF_BASE = "http://localhost/api/staff/v1";
export const STAFF_ROUTE_DIR = join(process.cwd(), "src/app/api/staff/v1");
export const STAFF_ROUTE_FILES: string[] = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : [];
  });
})(STAFF_ROUTE_DIR);
/** "appointments/[id]/notes" for its route file. */
export const routePathOf = (file: string) => relative(STAFF_ROUTE_DIR, file).split(sep).slice(0, -1).join("/");

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type RouteMod = Partial<Record<Method, Handler>>;

export interface CallOpts {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  shop?: string;
  /** Leave out the X-Clock-Nonce and X-Clock-Timestamp a POST gets otherwise (a fresh pair each call, as the app sends). */
  noNonce?: boolean;
}

export async function staffApp() {
  const routes: Record<string, RouteMod> = {};
  for (const file of STAFF_ROUTE_FILES) routes[routePathOf(file)] = (await import(/* @vite-ignore */ file)) as RouteMod;

  async function call(method: Method, path: string, o: CallOpts = {}) {
    const [bare, search] = path.split("?");
    const parts = bare.split("/").filter(Boolean);
    // A static segment wins over [id], as in Next.
    const keys = Object.keys(routes).filter((k) => {
      const ks = k.split("/").filter(Boolean);
      return ks.length === parts.length && ks.every((s, i) => s.startsWith("[") || s === parts[i]);
    });
    const key = keys.sort((a, b) => (a.match(/\[/g)?.length ?? 0) - (b.match(/\[/g)?.length ?? 0))[0];
    if (!key) throw new Error(`no route for ${path}`);
    const params = Object.fromEntries(key.split("/").flatMap((s, i) => (s.startsWith("[") ? [[s.slice(1, -1), parts[i]]] : [])));
    const handler = routes[key][method];
    if (!handler) throw new Error(`no ${method} on ${key}`);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.shop ? { "x-shop-id": o.shop } : {}),
      ...(method === "POST" && !o.noNonce ? { "x-clock-nonce": crypto.randomUUID(), "x-clock-timestamp": String(Date.now()) } : {}),
      ...(o.headers ?? {}),
    };
    const res = await handler(new Request(`${STAFF_BASE}/${bare}${search ? `?${search}` : ""}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), {
      params: Promise.resolve(params),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, text, headers: res.headers, json: json as any };
  }

  async function login(email: string, password = process.env.SEED_PASSWORD ?? "rayz2026!", extra: Record<string, unknown> = {}) {
    const r = await call("POST", "auth/login", { body: { email, password, deviceName: "Test phone", ...extra } });
    if (r.status !== 200 || !r.json?.tokens) throw new Error(`staff app login ${email}: ${r.status} ${r.text}`);
    return r.json.tokens as { accessToken: string; refreshToken: string; sessionId: string };
  }

  return { routes, call, login };
}
