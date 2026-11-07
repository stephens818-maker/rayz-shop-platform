import { and, eq, inArray, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { customers, emailSuppressions, marketingUnsubscribes, notificationJobs } from "@/db/schema";
import { CLIENT_MESSAGE_KINDS, OPT_OUT_REASON, normalizeEmail, type EmailEvent, type SuppressionReason } from "@/domain/notification-delivery";
import { appBaseUrl } from "@/lib/deployment";
import { readSignedId, signedId } from "@/lib/webhook-auth";
import { SYSTEM, audit, type Actor } from "../audit";

const UNSUB = "email-unsub";

/** The stop link in an email to a client, naming the email's own job (no address in the link). */
export const unsubscribeUrl = (jobId: string) => `${appBaseUrl()}/u/e/${signedId(UNSUB, jobId)}`;
/** The one-click POST target for mail apps (RFC 8058). */
export const oneClickUnsubscribeUrl = (jobId: string) => `${appBaseUrl()}/api/email/unsubscribe/${signedId(UNSUB, jobId)}`;

/** Emails to clients carry the stop link; staff and vendor emails don't, and Campaign Center's carry their own. */
export const takesUnsubscribe = (kind: string) => CLIENT_MESSAGE_KINDS.has(kind) && kind !== "otp" && kind !== "marketing";

/** Which of these addresses are stopped, and why. */
export async function suppressedEmails(emails: string[], tx: DBorTx = db): Promise<Map<string, SuppressionReason>> {
  const list = [...new Set(emails.map(normalizeEmail))];
  if (!list.length) return new Map();
  const rows = await tx.select({ email: emailSuppressions.email, reason: emailSuppressions.reason }).from(emailSuppressions).where(inArray(emailSuppressions.email, list));
  return new Map(rows.map((r) => [r.email, r.reason]));
}

/**
 * Stop every email to an address: record it once, turn off "OK to email" for the clients who have
 * it, and add a marketing unsubscribe so Campaign Center leaves it out too. Audited.
 */
export async function suppressEmail(rawEmail: string, reason: SuppressionReason, o: { provider?: string | null; actor?: Actor } = {}, tx: DBorTx = db) {
  const email = normalizeEmail(rawEmail);
  if (!email.includes("@")) return { added: false, customers: 0 };
  const off = await tx
    .update(customers)
    .set({ emailOptIn: false })
    .where(and(sql`lower(${customers.email}) = ${email}`, eq(customers.emailOptIn, true)))
    .returning({ id: customers.id });
  const ids = off.map((c) => c.id);
  const [row] = await tx.insert(emailSuppressions).values({ email, reason, provider: o.provider ?? null, customerIds: ids }).onConflictDoNothing().returning({ id: emailSuppressions.id });
  if (row) await tx.insert(marketingUnsubscribes).values({ channel: "email", email, customerId: ids[0] ?? null, source: reason === "staff" ? "staff" : "link" });
  await audit(o.actor ?? SYSTEM, "email.suppressed", "email_suppression", row?.id ?? null, { reason, provider: o.provider ?? null, customersTurnedOff: ids.length, alreadyStopped: !row }, null, tx);
  return { added: !!row, customers: ids.length };
}

/** A delivery event from the email provider's webhook. Unknown message ids are ignored. */
export async function handleEmailEvent(e: EmailEvent, provider: string, now = new Date()) {
  const job = e.messageId ? await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.providerMessageId, e.messageId), columns: { id: true, to: true, channel: true } }) : null;
  const email = e.email ?? (job?.channel === "email" ? job.to : null);
  if (e.kind === "delivered") {
    if (job) await db.update(notificationJobs).set({ deliveredAt: now }).where(eq(notificationJobs.id, job.id));
    return { job: job?.id ?? null, suppressed: false };
  }
  return db.transaction(async (tx) => {
    if (job && e.kind === "bounced")
      await tx
        .update(notificationJobs)
        .set({ status: "failed", lastError: e.permanent ? "Bounced: the address doesn't take mail" : "Bounced for now (for example a full mailbox)" })
        .where(eq(notificationJobs.id, job.id));
    const stop = email && (e.kind === "complained" || e.permanent);
    if (stop) await suppressEmail(email, e.kind === "complained" ? "complaint" : "bounce", { provider }, tx);
    return { job: job?.id ?? null, suppressed: !!stop };
  });
}

/** The address an email's stop link is for, or null for a bad or unknown link. */
export async function unsubscribeTarget(token: string): Promise<{ jobId: string; email: string; stopped: boolean } | null> {
  const jobId = readSignedId(UNSUB, token);
  if (!jobId) return null;
  const job = await db.query.notificationJobs.findFirst({ where: eq(notificationJobs.id, jobId), columns: { to: true, channel: true } });
  if (!job || job.channel !== "email") return null;
  const email = normalizeEmail(job.to);
  return { jobId, email, stopped: (await suppressedEmails([email])).has(email) };
}

/** Follow an email's stop link. Returns false for a bad link. */
export async function unsubscribeByEmailLink(token: string): Promise<boolean> {
  const t = await unsubscribeTarget(token);
  if (!t) return false;
  if (!t.stopped) await db.transaction((tx) => suppressEmail(t.email, "unsubscribe", { actor: { staffId: null, label: "customer:email link" } }, tx));
  return true;
}

export const SUPPRESSION_ERROR: Record<SuppressionReason, string> = {
  bounce: OPT_OUT_REASON.bounce,
  complaint: OPT_OUT_REASON.complaint,
  unsubscribe: OPT_OUT_REASON.unsubscribe,
  staff: OPT_OUT_REASON.staff,
};
