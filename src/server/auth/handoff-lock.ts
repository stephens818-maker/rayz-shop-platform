import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { checkoutHandoffs } from "@/db/schema";
import { signToken, verifyToken } from "./tokens";

/** As long as a staff session, so an abandoned hand-off can't outlive the sign-in that started it by much. */
export const HANDOFF_TTL = 60 * 60 * 12;
export const HANDOFF_BLOCKED = "This device is handed to a client. A staff PIN on the customer screen takes it back.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handoffToken = (id: string) => signToken({ hid: id }, "handoff", HANDOFF_TTL);

export async function handoffIdFrom(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const p = await verifyToken<{ hid?: unknown }>(token, "handoff");
  return typeof p?.hid === "string" && UUID.test(p.hid) ? p.hid : null;
}

/**
 * The hand-off this browser is locked to: a valid cookie for a hand-off that still holds the device
 * (with the client, or on its thank-you screen). Null means staff screens are open again.
 */
export async function lockedHandoff(token: string | null | undefined, now = new Date()): Promise<{ id: string; saleId: string; shopId: string } | null> {
  const id = await handoffIdFrom(token);
  if (!id) return null;
  const [row] = await db
    .select({ id: checkoutHandoffs.id, saleId: checkoutHandoffs.saleId, shopId: checkoutHandoffs.shopId })
    .from(checkoutHandoffs)
    .where(and(eq(checkoutHandoffs.id, id), or(isNull(checkoutHandoffs.endedAt), gt(checkoutHandoffs.endedAt, now))));
  return row ?? null;
}
