/**
 * Staff side of "I can't sign in" (C21): requests from the app and the website, a profile that
 * failed its identity check five times, or a number idle 18 months with no verified email. Staff
 * confirm who it is in person or by phone, then confirm the profile (which unlocks its rewards and
 * lets its number sign in again), merge it on the duplicates page, or dismiss the request.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { customers, identityHelpRequests } from "@/db/schema";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";

export const HELP_REASON_LABEL = {
  identity_check: "Missed the identity check five times",
  idle_number: "Number unused 18 months, no confirmed email",
  cant_sign_in: "Asked for help signing in",
  child_claim: "A parent asked to put a child's profile on their account (Family card: put an existing client on the account)",
} as const;

export async function helpRequests(status: "open" | "closed" = "open") {
  const rows = await db
    .select()
    .from(identityHelpRequests)
    .where(status === "open" ? eq(identityHelpRequests.status, "open") : inArray(identityHelpRequests.status, ["resolved", "dismissed"]))
    .orderBy(desc(identityHelpRequests.createdAt))
    .limit(200);
  const ids = [...new Set(rows.flatMap((r) => r.candidateIds))];
  const people = ids.length
    ? await db
        .select({ id: customers.id, firstName: customers.firstName, lastName: customers.lastName, phone: customers.phone, email: customers.email, source: customers.source, identityVerifiedAt: customers.identityVerifiedAt })
        .from(customers)
        .where(inArray(customers.id, ids))
    : [];
  return rows.map((r) => ({ ...r, candidates: (r.candidateIds).map((id) => people.find((p) => p.id === id)).filter((p) => !!p) }));
}

/** Close a request. confirmCustomerId: staff checked it's this client, so their check passes and their number counts as active again. */
export async function closeHelpRequest(actor: Actor, id: string, o: { status: "resolved" | "dismissed"; resolution?: string | null; confirmCustomerId?: string | null }) {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(identityHelpRequests).where(eq(identityHelpRequests.id, id)).for("update");
    if (!r) throw notFound("Request");
    if (r.status !== "open") throw new AppError("conflict", "That request is already closed");
    if (o.confirmCustomerId) {
      const [c] = await tx
        .update(customers)
        .set({ identityVerifiedAt: new Date(), identityCheckFailures: 0 })
        .where(eq(customers.id, o.confirmCustomerId))
        .returning({ id: customers.id });
      if (!c) throw notFound("Client");
      await audit(actor, "customer.identity_confirmed", "customer", c.id, { via: "sign_in_help", requestId: id }, null, tx);
    }
    await tx
      .update(identityHelpRequests)
      .set({ status: o.status, resolution: o.resolution?.trim() || null, resolvedAt: new Date(), resolvedBy: actor.staffId ?? null })
      .where(eq(identityHelpRequests.id, id));
    await audit(actor, `sign_in_help.${o.status}`, "identity_help_request", id, { confirmed: o.confirmCustomerId ?? null }, null, tx);
  });
}
