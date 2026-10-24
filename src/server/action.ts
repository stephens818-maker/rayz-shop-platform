import "server-only";
import { headers } from "next/headers";
import { ZodError } from "zod";
import { withEventContext } from "@/db/event-context";
import { deviceClass } from "@/domain/analytics";
import { AppError } from "./errors";

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

/** Server actions return errors as values so client components can show them inline. */
export async function safe<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await withEventContext({ device: await requestDevice() }, fn) };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message };
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => i.message).join("; ") };
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e;
    console.error(e);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}

async function requestDevice(): Promise<string | null> {
  try {
    return deviceClass((await headers()).get("user-agent"));
  } catch {
    return null;
  }
}
