/**
 * Render admin pages and call route handlers from DB tests, collecting everything a page would put
 * on screen or hand to the browser, so tests can check that a value never leaves the server.
 */
import { isValidElement } from "react";
import { vi } from "vitest";
import { AppError } from "@/server/errors";
import { redirectTarget } from "./session";

const pages = (import.meta as unknown as { glob(p: string): Record<string, () => Promise<unknown>> }).glob("/src/app/admin/**/page.tsx");

const isControl = (e: unknown) =>
  e instanceof AppError || (typeof (e as { digest?: unknown })?.digest === "string" && String((e as { digest: string }).digest).startsWith("NEXT_"));

/**
 * Everything a page would put on screen or hand to the browser: server components are rendered,
 * and client components (which can't run their hooks here) contribute every prop they receive.
 */
export async function textOf(node: unknown, seen: Set<object>, visit?: (type: unknown, props: Record<string, unknown>) => void): Promise<string> {
  if (node == null || typeof node === "boolean" || typeof node === "function" || typeof node === "symbol") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (typeof node !== "object") return "";
  if (node instanceof Date) return node.toISOString();
  if (seen.has(node)) return "";
  seen.add(node);
  if (node instanceof Promise) return textOf(await node, seen, visit);
  if (ArrayBuffer.isView(node)) return "";
  const all = async (xs: unknown[]) => (await Promise.all(xs.map((x) => textOf(x, seen, visit)))).join(" ");
  if (Array.isArray(node) || node instanceof Set) return all([...node]);
  if (node instanceof Map) return all([...node.values()]);
  if (!isValidElement(node)) return all(Object.values(node));
  const props = node.props as Record<string, unknown>;
  let type: unknown = node.type;
  while (type && typeof type === "object") {
    if ("type" in type) type = (type as { type: unknown }).type;
    else if ("render" in type) type = (type as { render: unknown }).render;
    else break;
  }
  visit?.(type, props);
  const own = await all(Object.values(props));
  if (typeof type !== "function" || (type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) return own;
  let out: unknown;
  try {
    out = (type as (p: unknown) => unknown)(props);
  } catch (e) {
    if (isControl(e)) throw e;
    return own;
  }
  return `${own} ${await textOf(out, seen, visit)}`;
}

export type Outcome = { kind: "ok"; text: string } | { kind: "denied" | "login" | "404" | "refused" | "redirect"; text?: undefined };

export async function open(
  route: string,
  params: Record<string, string> = {},
  searchParams: Record<string, string> = {},
  visit?: (type: unknown, props: Record<string, unknown>) => void,
): Promise<Outcome> {
  const mod = (await pages[`/src/app${route}/page.tsx`]()) as { default: (p: unknown) => Promise<unknown> };
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const el = await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) });
    return { kind: "ok", text: (await textOf(el, new Set(), visit)).replace(/\s+/g, " ") };
  } catch (e) {
    const to = redirectTarget(e);
    if (to === "/admin?denied=1") return { kind: "denied" };
    if (to === "/login") return { kind: "login" };
    if (to) return { kind: "redirect" };
    const d = (e as { digest?: unknown } | null)?.digest;
    if (typeof d === "string" && d.includes(";404")) return { kind: "404" };
    if (e instanceof AppError) return { kind: "refused" };
    throw e;
  } finally {
    quiet.mockRestore();
  }
}

export const found = (text: string, list: readonly string[]) => list.filter((s) => text.includes(s));

export async function get(handler: (req: Request, ctx?: unknown) => Promise<Response>, url: string, params?: Record<string, string>, init?: RequestInit) {
  const res = await handler(new Request(`http://localhost${url}`, init), { params: Promise.resolve(params ?? {}) });
  return { status: res.status, text: await res.text() };
}

/** The props a page hands to one component (a client component, say), for rendering it on its own. */
export async function propsOf<P>(component: unknown, route: string, params: Record<string, string> = {}, searchParams: Record<string, string> = {}): Promise<P[]> {
  const out: P[] = [];
  const r = await open(route, params, searchParams, (type, props) => type === component && out.push(props as P));
  if (r.kind !== "ok") throw new Error(`${route} didn't open: ${r.kind}`);
  return out;
}
