import { NextResponse } from "next/server";
import { z, ZodError, ZodType } from "zod";
import { AppError } from "./errors";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, { status, headers: { ...CORS, "Cache-Control": "no-store", ...headers } });
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

/** Wrap a route handler: uniform JSON errors, CORS for API clients. */
export function route<P = Record<string, string>>(fn: Handler<P>) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    try {
      return await fn(req, (await ctx.params) ?? ({} as P));
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function options() {
  return new Response(null, { status: 204, headers: CORS });
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
