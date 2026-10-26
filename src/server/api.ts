import { NextResponse } from "next/server";
import { z, ZodError, ZodType } from "zod";
import { appBaseUrl } from "@/lib/deployment";
import { assertSupportedClient } from "./app-config";
import { AppError } from "./errors";

const CORS = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Client, X-App-Version",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "600",
};

/**
 * The browser origin allowed to call the API, or null: the app's own origin, those in CORS_ORIGINS
 * (comma-separated, e.g. the brand website), and localhost in development. The mobile apps send no
 * Origin, so they're never affected; a browser on any other site gets no CORS headers and is blocked.
 */
export function allowedOrigin(origin: string | null, env: Record<string, string | undefined> = process.env): string | null {
  if (!origin) return null;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return null;
  }
  const list = [appBaseUrl(), ...(env.CORS_ORIGINS ?? "").split(",")].map((x) => x.trim().replace(/\/$/, "")).filter(Boolean);
  if (list.includes(o.origin)) return o.origin;
  if (env.NODE_ENV !== "production" && (o.hostname === "localhost" || o.hostname === "127.0.0.1")) return o.origin;
  return null;
}

/** Adds CORS headers for an allowed origin; every API response varies by Origin. */
export function withCors<R extends Response>(req: Request, res: R): R {
  res.headers.append("Vary", "Origin");
  const origin = allowedOrigin(req.headers.get("origin"));
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  }
  return res;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, e.status);
  if (e instanceof ZodError) {
    return json({ error: { code: "bad_request", message: "Invalid request", details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, 400);
  }
  console.error(e);
  return json({ error: { code: "internal", message: "Something went wrong" } }, 500);
}

type Handler<P> = (req: Request, params: P) => Promise<Response>;

/** Wrap a route handler: uniform JSON errors, CORS for allowed browser origins, and the app version gate. */
export function route<P = Record<string, string>>(fn: Handler<P>) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    let res: Response;
    try {
      assertSupportedClient(req);
      res = await fn(req, (await ctx.params) ?? ({} as P));
    } catch (e) {
      res = errorResponse(e);
    }
    return withCors(req, res);
  };
}

export function options(req: Request) {
  return withCors(req, new Response(null, { status: 204 }));
}

export async function body<T extends ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("bad_request", "Body must be JSON");
  }
  return schema.parse(raw);
}

export function query<T extends ZodType>(req: Request, schema: T): z.infer<T> {
  const url = new URL(req.url);
  return schema.parse(Object.fromEntries(url.searchParams.entries()));
}
