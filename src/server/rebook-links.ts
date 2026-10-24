import { and, eq, isNull } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { appointmentOutreach, appointments, notificationJobs, rebookLinks } from "@/db/schema";
import { LinkState, OutreachRules, isOpen, linkExpiry, linkState } from "@/domain/outreach";
import { TOKEN_SHAPE, hashToken, newRebookToken } from "@/domain/rebook-token";
import { appBaseUrl } from "@/lib/deployment";

export const rebookUrl = (token: string) => `${appBaseUrl()}/r/${token}`;

/**
 * A fresh link for the appointment the outreach is about. Any earlier link for the same outreach stops
 * working, so only the latest text or email does anything. The token itself is returned once, never stored.
 */
export async function issueLink(o: { outreachId: string; appointmentId: string }, rules: Pick<OutreachRules, "linkTtlHours">, tx: DBorTx = db, now = new Date()) {
  await tx
    .update(rebookLinks)
    .set({ revokedAt: now })
    .where(and(eq(rebookLinks.outreachId, o.outreachId), isNull(rebookLinks.usedAt), isNull(rebookLinks.revokedAt)));
  const token = newRebookToken();
  const expiresAt = linkExpiry(now, rules);
  await tx.insert(rebookLinks).values({ tokenHash: hashToken(token), appointmentId: o.appointmentId, outreachId: o.outreachId, expiresAt, createdAt: now });
  return { token, url: rebookUrl(token), expiresAt };
}

export type ResolvedLink =
  | { state: "unknown" }
  | {
      state: LinkState;
      link: typeof rebookLinks.$inferSelect;
      outreach: typeof appointmentOutreach.$inferSelect;
      appointment: typeof appointments.$inferSelect;
    };

/** What a token opens. Unknown, malformed and outreach-less tokens all look the same from outside. */
export async function resolveLink(token: string, now = new Date(), tx: DBorTx = db): Promise<ResolvedLink> {
  if (!TOKEN_SHAPE.test(token)) return { state: "unknown" };
  const [row] = await tx
    .select({ link: rebookLinks, outreach: appointmentOutreach, appointment: appointments })
    .from(rebookLinks)
    .innerJoin(appointmentOutreach, eq(appointmentOutreach.id, rebookLinks.outreachId))
    .innerJoin(appointments, eq(appointments.id, rebookLinks.appointmentId))
    .where(eq(rebookLinks.tokenHash, hashToken(token)));
  if (!row) return { state: "unknown" };
  return { state: linkState(row.link, row.appointment.status, now), ...row };
}

/** Ends every open link for the outreach: it's been answered. */
export async function closeLinks(outreachId: string, tx: DBorTx = db, now = new Date()) {
  await tx
    .update(rebookLinks)
    .set({ usedAt: now })
    .where(and(eq(rebookLinks.outreachId, outreachId), isNull(rebookLinks.usedAt), isNull(rebookLinks.revokedAt)));
}

/** The client answered: the row is closed, its links stop working and nothing more goes out for it. */
export async function finishOutreach(row: Pick<typeof appointmentOutreach.$inferSelect, "id">, status: "rebooked" | "declined", resolution: string, now: Date, tx: DBorTx = db) {
  await tx.update(appointmentOutreach).set({ status, resolution, respondedAt: now, nextActionAt: null, flaggedAt: null, flagReason: null, updatedAt: now }).where(eq(appointmentOutreach.id, row.id));
  await closeLinks(row.id, tx, now);
  await tx.update(notificationJobs).set({ status: "cancelled" }).where(and(eq(notificationJobs.outreachId, row.id), eq(notificationJobs.status, "pending")));
}

/** The client acted on the rebook page. */
export async function markAnswered(outreachId: string, status: "rebooked" | "declined", resolution: string, now = new Date()) {
  const row = await db.query.appointmentOutreach.findFirst({ where: eq(appointmentOutreach.id, outreachId) });
  if (!row || !isOpen(row.status)) return;
  await finishOutreach(row, status, resolution, now);
}
