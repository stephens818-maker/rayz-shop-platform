import { and, eq, isNull } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { appointmentOutreach, appointments, rebookLinks } from "@/db/schema";
import { LinkState, OutreachRules, linkExpiry, linkState } from "@/domain/outreach";
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
