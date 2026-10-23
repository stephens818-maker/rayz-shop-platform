import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { EmailAttachment, brandSettings, contactOptOuts, notificationJobs, shops } from "@/db/schema";
import { MergeValues, SavedTemplates, cutoffText, fill, isTemplateKind, templateFor } from "@/domain/message-templates";
import { appBaseUrl } from "@/lib/deployment";
import { formatDateTime } from "@/lib/time";
import { emailProvider, smsProvider, voiceProvider } from "./providers";

export type NotificationKind =
  | "confirmation"
  | "reminder_24h"
  | "reminder_2h"
  | "cancellation"
  | "reschedule"
  | "waitlist_ready"
  | "otp"
  | "purchase_order"
  | "low_stock"
  | "staff_text"
  | "staff_call"
  | "privacy_alert"
  /** A sign-in blocked by a location's network or device rule, to the brand. */
  | "access_alert"
  | "time_off_reschedule"
  | "time_off_decision"
  /** Call-in outreach: moved to another barber, a rebook link, an automated call, and the link texted after pressing 1. */
  | "callin_reassign"
  | "callin_rebook"
  | "callin_voice"
  | "callin_link"
  /** The shop line: texts after a missed or after-hours call, and replies to a client's text. */
  | "missed_call"
  | "shop_reply"
  /** Today's suggested actions and the morning digest. */
  | "fill_offer"
  | "rebook_nudge"
  | "no_show_reminder"
  | "running_late"
  | "digest"
  /** Time clock: a forgotten clock-out, and someone crossing the full-time line, both to their managers. */
  | "clock_forgot_out"
  | "ft_status_change"
  /** A tip payout sent to an employee, or one that failed (to them and the shop). */
  | "tip_payout"
  /** An employee's payout account: Stripe needs more information, or a security notice that the destination or method changed. */
  | "tip_banking"
  /** Time clock, live: not clocked in for the first client, and clients booked over a break or after an early clock-out. */
  | "clock_late_in"
  | "clock_affected"
  /** The receipt a client asked for on the customer screen at checkout. */
  | "receipt";

/** Automated calls a client can opt out of with 9; staff calls through the shop line aren't. */
const AUTOMATED_CALLS = new Set<string>(["callin_voice"]);

export interface AppointmentMessageContext {
  appointmentId: string;
  code: string;
  startsAt: Date;
  shopId: string;
  shopName: string;
  /** Street and city, for the confirmation. */
  shopAddress: string;
  barberName: string;
  customerId: string | null;
  phone: string | null;
  email: string | null;
  smsOptIn: boolean;
  emailOptIn: boolean;
  firstName?: string | null;
  shopSlug?: string;
  shopPhone?: string | null;
  cancelCutoffMinutes?: number;
}

const baseUrl = appBaseUrl;

export function mergeValues(c: AppointmentMessageContext, extra: MergeValues = {}): MergeValues {
  return {
    shop: `Ray'z ${c.shopName}`,
    first_name: c.firstName ?? "there",
    barber: c.barberName,
    when: formatDateTime(c.startsAt),
    address: c.shopAddress,
    link: `${baseUrl()}/a/${c.code}`,
    book_link: c.shopSlug ? `${baseUrl()}/book/${c.shopSlug}` : `${baseUrl()}/book`,
    cutoff: cutoffText(c.cancelCutoffMinutes ?? 30),
    phone: c.shopPhone ?? "",
    ...extra,
  };
}

/** The brand's saved wording, or none. Read per batch of messages so an edit applies to the next one. */
export async function savedTemplates(tx: DBorTx = db): Promise<SavedTemplates> {
  const [b] = await tx.select({ t: brandSettings.messageTemplates }).from(brandSettings).limit(1);
  return (b?.t ?? {}) as SavedTemplates;
}

export function renderMessage(kind: NotificationKind, c: AppointmentMessageContext, saved?: SavedTemplates, extra?: MergeValues): { subject: string; body: string } {
  const values = mergeValues(c, extra);
  if (!isTemplateKind(kind)) return { subject: values.shop!, body: values.shop! };
  const t = templateFor(kind, saved);
  return { subject: fill(t.subject, values), body: fill(t.body, values) };
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
  /** "imported": an upcoming Squire booking; "reminders": the caller sent its own message. Reminders only, either way. */
  event: "created" | "rescheduled" | "cancelled" | "imported" | "reminders",
  c: AppointmentMessageContext,
  tx: DBorTx = db,
  now: Date = new Date(),
) {
  await cancelPendingReminders(c.appointmentId, tx);
  const jobs: { kind: NotificationKind; runAt: Date }[] = [];
  if (event === "cancelled") jobs.push({ kind: "cancellation", runAt: now });
  else {
    if (event !== "imported" && event !== "reminders") jobs.push({ kind: event === "created" ? "confirmation" : "reschedule", runAt: now });
    const r24 = new Date(c.startsAt.getTime() - 24 * 3_600_000);
    const r2 = new Date(c.startsAt.getTime() - 2 * 3_600_000);
    if (r24 > now) jobs.push({ kind: "reminder_24h", runAt: r24 });
    if (r2 > now) jobs.push({ kind: "reminder_2h", runAt: r2 });
  }
  const to = recipients(c);
  const saved = jobs.length && to.length ? await savedTemplates(tx) : {};
  const rows = jobs.flatMap((j) =>
    to.map((r) => {
      const m = renderMessage(j.kind, c, saved);
      return {
        appointmentId: c.appointmentId,
        customerId: c.customerId,
        shopId: c.shopId,
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

/** One message about an appointment, now, on each channel the client opted in to. Returns how many were queued. */
export async function enqueueAppointmentMessage(kind: NotificationKind, c: AppointmentMessageContext, tx: DBorTx = db, now: Date = new Date(), extra?: MergeValues) {
  return (await queueAppointmentMessage(kind, c, tx, now, extra)).length;
}

/** The same, returning the queued jobs' ids so the caller can send them at once. */
export async function queueAppointmentMessage(kind: NotificationKind, c: AppointmentMessageContext, tx: DBorTx = db, now: Date = new Date(), extra?: MergeValues): Promise<string[]> {
  const to = recipients(c);
  if (!to.length) return [];
  const m = renderMessage(kind, c, await savedTemplates(tx), extra);
  const rows = to.map((r) => ({
    appointmentId: c.appointmentId,
    customerId: c.customerId,
    shopId: c.shopId,
    kind,
    channel: r.channel,
    to: r.to,
    subject: r.channel === "email" ? m.subject : null,
    body: m.body,
    runAt: now,
  }));
  if (!rows.length) return [];
  return (await tx.insert(notificationJobs).values(rows).returning({ id: notificationJobs.id })).map((r) => r.id);
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

export async function enqueueRaw(job: { kind: NotificationKind; channel: "sms" | "email"; to: string; subject?: string; body: string; customerId?: string | null; shopId: string }) {
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
export async function processDueJobs(
  opts: { limit?: number; now?: Date; /** Only these shops' messages; the cron job sends everyone's. */ shopIds?: string[]; /** Only these jobs (a call or text sent from the admin). */ ids?: string[] } = {},
) {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const sms = smsProvider();
  const email = emailProvider();
  const voice = voiceProvider();
  const stats = { sent: 0, suppressed: 0, failed: 0 };

  await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(notificationJobs)
      .where(
        and(
          eq(notificationJobs.status, "pending"),
          lte(notificationJobs.runAt, now),
          opts.shopIds ? (opts.shopIds.length ? inArray(notificationJobs.shopId, opts.shopIds) : sql`false`) : undefined,
          opts.ids ? (opts.ids.length ? inArray(notificationJobs.id, opts.ids) : sql`false`) : undefined,
        ),
      )
      .orderBy(notificationJobs.runAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    const shopIds = [...new Set(due.map((j) => j.shopId).filter((x): x is string => !!x))];
    const lines = new Map(
      shopIds.length ? (await tx.select({ id: shops.id, n: shops.twilioNumber }).from(shops).where(inArray(shops.id, shopIds))).map((r) => [r.id, r.n]) : [],
    );
    const phones = [...new Set(due.filter((j) => j.channel !== "email").map((j) => j.to))];
    const optedOut = new Set(
      phones.length ? (await tx.select({ phone: contactOptOuts.phone, channel: contactOptOuts.channel }).from(contactOptOuts).where(inArray(contactOptOuts.phone, phones))).map((o) => `${o.channel}:${o.phone}`) : [],
    );

    for (const job of due) {
      const provider = job.channel === "sms" ? sms : job.channel === "voice" ? voice : email;
      const stopped = (job.channel === "sms" && optedOut.has(`sms:${job.to}`)) || (job.channel === "voice" && AUTOMATED_CALLS.has(job.kind) && optedOut.has(`voice:${job.to}`));
      if (stopped) {
        await tx
          .update(notificationJobs)
          .set({ status: "suppressed", provider: provider.name, attempts: job.attempts + 1, lastError: job.channel === "sms" ? "The number replied STOP" : "The client asked for no automated calls" })
          .where(eq(notificationJobs.id, job.id));
        stats.suppressed++;
        continue;
      }
      if (!provider.enabled) {
        await tx
          .update(notificationJobs)
          .set({ status: "suppressed", provider: provider.name, attempts: job.attempts + 1 })
          .where(eq(notificationJobs.id, job.id));
        stats.suppressed++;
        continue;
      }
      try {
        const line = job.shopId ? (lines.get(job.shopId) ?? null) : null;
        const r =
          job.channel === "sms"
            ? await sms.sendSms(job.to, job.body, { from: line })
            : job.channel === "voice"
              ? AUTOMATED_CALLS.has(job.kind) && job.outreachId
                ? await voice.outreachCall(job.to, { outreachId: job.outreachId, jobId: job.id, callerId: line })
                : await voice.bridgeCall(job.to, job.subject, { jobId: job.id, callerId: line })
              : await email.sendEmail(job.to, job.subject ?? "Ray'z Barber Shop", job.body, job.attachments ?? []);
        await tx
          .update(notificationJobs)
          .set({ status: "sent", sentAt: new Date(), provider: provider.name, providerMessageId: r.providerMessageId ?? null, attempts: job.attempts + 1 })
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
