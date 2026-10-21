import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { EmailAttachment, notificationJobs } from "@/db/schema";
import { formatDateTime } from "@/lib/time";
import { emailProvider, smsProvider } from "./providers";

export type NotificationKind =
  | "confirmation"
  | "reminder_24h"
  | "reminder_2h"
  | "cancellation"
  | "reschedule"
  | "waitlist_ready"
  | "otp"
  | "purchase_order"
  | "low_stock";

export interface AppointmentMessageContext {
  appointmentId: string;
  code: string;
  startsAt: Date;
  shopName: string;
  barberName: string;
  customerId: string | null;
  phone: string | null;
  email: string | null;
  smsOptIn: boolean;
  emailOptIn: boolean;
}

const baseUrl = () => process.env.APP_BASE_URL ?? "http://localhost:3000";

export function renderMessage(kind: NotificationKind, c: AppointmentMessageContext): { subject: string; body: string } {
  const when = formatDateTime(c.startsAt);
  const link = `${baseUrl()}/a/${c.code}`;
  const shop = `Ray'z ${c.shopName}`;
  switch (kind) {
    case "confirmation":
      return { subject: `${shop}: you're booked`, body: `${shop}: You're booked with ${c.barberName} on ${when}. Cancel or reschedule: ${link}` };
    case "reschedule":
      return { subject: `${shop}: appointment moved`, body: `${shop}: Your appointment is now ${when} with ${c.barberName}. Details: ${link}` };
    case "reminder_24h":
      return { subject: `${shop}: see you tomorrow`, body: `${shop}: Reminder — ${when} with ${c.barberName}. Need to change it? ${link}` };
    case "reminder_2h":
      return { subject: `${shop}: see you soon`, body: `${shop}: See you at ${when} with ${c.barberName}. Changes allowed up to 30 min before: ${link}` };
    case "cancellation":
      return { subject: `${shop}: appointment cancelled`, body: `${shop}: Your ${when} appointment was cancelled. Book again anytime: ${baseUrl()}/book` };
    default:
      return { subject: shop, body: shop };
  }
}

function recipients(c: AppointmentMessageContext) {
  const out: { channel: "sms" | "email"; to: string }[] = [];
  if (c.phone && c.smsOptIn) out.push({ channel: "sms", to: c.phone });
  if (c.email && c.emailOptIn) out.push({ channel: "email", to: c.email });
  return out;
}

/** Cancel any reminders that haven't gone out yet (used on cancel / reschedule / no-show). */
export async function cancelPendingReminders(appointmentId: string, tx: DBorTx = db) {
  await tx
    .update(notificationJobs)
    .set({ status: "cancelled" })
    .where(and(eq(notificationJobs.appointmentId, appointmentId), eq(notificationJobs.status, "pending")));
}

export async function scheduleAppointmentNotifications(
  /** "imported": an upcoming Squire booking; reminders only, the client already has a confirmation. */
  event: "created" | "rescheduled" | "cancelled" | "imported",
  c: AppointmentMessageContext,
  tx: DBorTx = db,
  now: Date = new Date(),
) {
  await cancelPendingReminders(c.appointmentId, tx);
  const jobs: { kind: NotificationKind; runAt: Date }[] = [];
  if (event === "cancelled") jobs.push({ kind: "cancellation", runAt: now });
  else {
    if (event !== "imported") jobs.push({ kind: event === "created" ? "confirmation" : "reschedule", runAt: now });
    const r24 = new Date(c.startsAt.getTime() - 24 * 3_600_000);
    const r2 = new Date(c.startsAt.getTime() - 2 * 3_600_000);
    if (r24 > now) jobs.push({ kind: "reminder_24h", runAt: r24 });
    if (r2 > now) jobs.push({ kind: "reminder_2h", runAt: r2 });
  }
  const rows = jobs.flatMap((j) =>
    recipients(c).map((r) => {
      const m = renderMessage(j.kind, c);
      return {
        appointmentId: c.appointmentId,
        customerId: c.customerId,
        kind: j.kind,
        channel: r.channel,
        to: r.to,
        subject: r.channel === "email" ? m.subject : null,
        body: m.body,
        runAt: j.runAt,
      };
    }),
  );
  if (rows.length) await tx.insert(notificationJobs).values(rows);
  return rows.length;
}

/**
 * Deliver immediately and keep only `storedBody` in the outbox. Used for one-time codes, which must
 * never sit in the database or show up on the outbox page.
 */
export async function sendNow(job: { kind: NotificationKind; channel: "sms" | "email"; to: string; subject?: string; body: string; storedBody: string; customerId?: string | null }) {
  const provider = job.channel === "sms" ? smsProvider() : emailProvider();
  let status: "sent" | "suppressed" | "failed" = "suppressed";
  let lastError: string | null = null;
  if (provider.enabled) {
    try {
      if (job.channel === "sms") await smsProvider().sendSms(job.to, job.body);
      else await emailProvider().sendEmail(job.to, job.subject ?? "Ray'z Barber Shop", job.body);
      status = "sent";
    } catch (e) {
      status = "failed";
      lastError = (e as Error).message.slice(0, 500);
    }
  }
  const now = new Date();
  await db.insert(notificationJobs).values({
    kind: job.kind,
    channel: job.channel,
    to: job.to,
    subject: job.subject ?? null,
    body: job.storedBody,
    customerId: job.customerId ?? null,
    runAt: now,
    status,
    attempts: 1,
    provider: provider.name,
    lastError,
    sentAt: status === "sent" ? now : null,
  });
  return status;
}

export async function enqueueRaw(job: { kind: NotificationKind; channel: "sms" | "email"; to: string; subject?: string; body: string; customerId?: string | null }) {
  await db.insert(notificationJobs).values({ ...job, subject: job.subject ?? null, customerId: job.customerId ?? null, runAt: new Date() });
}

/** A staff email that belongs to a shop (a purchase order to a vendor, a low-stock alert), sent by the next queue run. */
export async function enqueueShopEmail(
  job: { kind: NotificationKind; to: string; subject: string; body: string; shopId: string; purchaseOrderId?: string | null; attachments?: EmailAttachment[] },
  tx: DBorTx = db,
  now = new Date(),
) {
  const [row] = await tx
    .insert(notificationJobs)
    .values({ kind: job.kind, channel: "email", to: job.to, subject: job.subject, body: job.body, shopId: job.shopId, purchaseOrderId: job.purchaseOrderId ?? null, attachments: job.attachments ?? null, runAt: now })
    .returning({ id: notificationJobs.id });
  return row.id;
}

/**
 * Drain due jobs. Safe to run concurrently (SKIP LOCKED). Triggered by Vercel Cron
 * (/api/cron/notifications) in production and `pnpm worker` locally.
 */
export async function processDueJobs(opts: { limit?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const sms = smsProvider();
  const email = emailProvider();
  const stats = { sent: 0, suppressed: 0, failed: 0 };

  await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(notificationJobs)
      .where(and(eq(notificationJobs.status, "pending"), lte(notificationJobs.runAt, now)))
      .orderBy(notificationJobs.runAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    for (const job of due) {
      const provider = job.channel === "sms" ? sms : email;
      if (!provider.enabled) {
        await tx
          .update(notificationJobs)
          .set({ status: "suppressed", provider: provider.name, attempts: job.attempts + 1 })
          .where(eq(notificationJobs.id, job.id));
        stats.suppressed++;
        continue;
      }
      try {
        if (job.channel === "sms") await sms.sendSms(job.to, job.body);
        else await email.sendEmail(job.to, job.subject ?? "Ray'z Barber Shop", job.body, job.attachments ?? []);
        await tx
          .update(notificationJobs)
          .set({ status: "sent", sentAt: new Date(), provider: provider.name, attempts: job.attempts + 1 })
          .where(eq(notificationJobs.id, job.id));
        stats.sent++;
      } catch (e) {
        const attempts = job.attempts + 1;
        await tx
          .update(notificationJobs)
          .set({
            status: attempts >= 5 ? "failed" : "pending",
            attempts,
            provider: provider.name,
            lastError: (e as Error).message,
            // Exponential backoff: 1, 2, 4, 8 minutes.
            runAt: new Date(now.getTime() + 60_000 * 2 ** (attempts - 1)),
          })
          .where(eq(notificationJobs.id, job.id));
        stats.failed++;
      }
    }
  });
  return stats;
}

export async function notificationCounts(appointmentIds: string[]) {
  if (!appointmentIds.length) return [];
  return db
    .select({ appointmentId: notificationJobs.appointmentId, status: notificationJobs.status, n: sql<number>`count(*)::int` })
    .from(notificationJobs)
    .where(inArray(notificationJobs.appointmentId, appointmentIds))
    .groupBy(notificationJobs.appointmentId, notificationJobs.status);
}
