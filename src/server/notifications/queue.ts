import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { EmailAttachment, contactOptOuts, notificationJobs, shops } from "@/db/schema";
import { MergeValues, SavedTemplates, cutoffText, fill, isTemplateKind, templateFor } from "@/domain/message-templates";
import { icsCalendar, locationDescription } from "@/domain/ics";
import { OPT_OUT_REASON, clientEmailHtml, reminderTimes, withUnsubscribe } from "@/domain/notification-delivery";
import type { OutreachRules } from "@/domain/outreach";
import type { MarketingSettings } from "@/domain/marketing";
import { brandColumn, settingAt, settingFor } from "../brand-sync/settings";
import { appBaseUrl } from "@/lib/deployment";
import { nextMarketingTime } from "@/domain/quiet-hours";
import { SHOP_TZ, formatDateTime } from "@/lib/time";
import { SUPPRESSION_ERROR, oneClickUnsubscribeUrl, suppressedEmails, takesUnsubscribe, unsubscribeUrl } from "./email-events";
import { emailProvider, pushProvider, smsProvider, voiceProvider } from "./providers";
import { PermanentSendError } from "./push";
import { loadDisplay } from "../display";

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
  /** Today's suggested actions and the Morning Dashboard. */
  | "fill_offer"
  | "rebook_nudge"
  /** The reminder to book that staff set at checkout when the client didn't book there. */
  | "rebook_reminder"
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
  /** An invite or reminder to set up Stripe tip payouts under Ray'z, by text or email. */
  | "tip_onboarding"
  /** The monthly reminder to declare last month's cash tips. */
  | "tip_declaration"
  /** An employee's pay question: to the managers or owners who answer it, and the answer back to them. */
  | "pay_question"
  /** Time clock, live: not clocked in for the first client, and clients booked over a break or after an early clock-out. */
  | "clock_late_in"
  | "clock_affected"
  /** The receipt a client asked for on the customer screen at checkout. */
  | "receipt"
  /** A location's Google review link, a set time after the visit (same for every client who agreed to texts or emails). */
  | "review_request"
  /** Campaign Center: an automated campaign or a blast, only to clients who agreed to marketing on that channel. */
  | "marketing"
  /** A scheduled custom report, to a staff member; its file is dropped from the outbox once sent. */
  | "saved_report"
  /** An invite to the brand portal; the outbox keeps it without the sign-up link. */
  | "staff_invite"
  /** The staff app's sign-in link, by text or email; the outbox keeps it without the link. */
  | "staff_app_invite"
  /** A staff sign-in on a browser or phone they hadn't used before, to them. */
  | "new_sign_in"
  /** A staff milestone, to the brand and the person's managers. */
  | "milestone";

/**
 * Texts and push sent under marketing consent. They go out only 8 AM to 9 PM where the recipient is
 * (domain/quiet-hours.ts), checked again at send time since a job can wait in the queue, and through
 * the marketing Messaging Service (its own 10DLC campaign) when TWILIO_MARKETING_MESSAGING_SERVICE_SID is set.
 */
const MARKETING_SMS = new Set<string>(["marketing", "fill_offer", "rebook_nudge"]);
const quietHoursApply = (j: { kind: string; channel: string }) => MARKETING_SMS.has(j.kind) && (j.channel === "sms" || j.channel === "push");
const QUIET_ERROR = "Not sent: the brand's quiet hours leave no time to send marketing";

/** The number a client's messages go to (the parent's for a child), for their local time. */
async function householdPhones(customerIds: string[], tx: DBorTx) {
  if (!customerIds.length) return new Map<string, string | null>();
  const rows = (await tx.execute(
    sql`select c.id, coalesce(g.phone, c.phone) phone from customers c left join customers g on g.id = c.guardian_id where c.id in (${sql.join(
      [...new Set(customerIds)].map((i) => sql`${i}::uuid`),
      sql`, `,
    )})`,
  )) as unknown as { id: string; phone: string | null }[];
  return new Map(rows.map((r) => [r.id, r.phone]));
}

/**
 * Reminders wait in the queue, sometimes for weeks (a Squire import's upcoming bookings), so the
 * household holder's consent and the push device are checked again when each one goes out.
 */
async function reminderConsent(jobs: { kind: string; channel: string; to: string; customerId: string | null }[], tx: DBorTx) {
  const waiting = jobs.filter((j) => j.customerId && (REMINDER_KINDS as readonly string[]).includes(j.kind));
  if (!waiting.length) return () => true;
  const ids = [...new Set(waiting.map((j) => j.customerId!))];
  const holders = (await tx.execute(
    sql`select c.id, h.sms_opt_in sms, h.email_opt_in email, h.push_transactional push, h.deleted_at is not null gone
        from customers c join customers h on h.id = coalesce(c.guardian_id, c.id)
        where c.id in (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})`,
  )) as unknown as { id: string; sms: boolean; email: boolean; push: boolean; gone: boolean }[];
  const byId = new Map(holders.map((h) => [h.id, h]));
  const deviceIds = [...new Set(waiting.filter((j) => j.channel === "push").map((j) => j.to))];
  const live = new Set(
    deviceIds.length
      ? ((await tx.execute(
          sql`select id::text id from customer_devices where push_enabled and revoked_at is null and id::text in (${sql.join(
            deviceIds.map((i) => sql`${i}`),
            sql`, `,
          )})`,
        )) as unknown as { id: string }[]).map((d) => d.id)
      : [],
  );
  return (j: { kind: string; channel: string; to: string; customerId: string | null }) => {
    if (!j.customerId || !(REMINDER_KINDS as readonly string[]).includes(j.kind)) return true;
    const h = byId.get(j.customerId);
    if (!h || h.gone) return false;
    if (j.channel === "sms") return h.sms;
    if (j.channel === "email") return h.email;
    if (j.channel === "push") return h.push && live.has(j.to);
    return true;
  };
}

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
  /** For the email's location footer and calendar invite. */
  endsAt?: Date;
  shopFullAddress?: string;
  shopGeo?: { lat: number; lng: number } | null;
  shopDirections?: string | null;
  services?: string[];
  /** The barber's reminder times, in hours before; 0 is none. Unset: 24 and 2. */
  reminders?: { firstHours: number; secondHours: number };
}

const baseUrl = appBaseUrl;

export function mergeValues(c: AppointmentMessageContext, extra: MergeValues = {}): MergeValues {
  return {
    shop: `Ray'z ${c.shopName}`,
    first_name: c.firstName ?? "there",
    barber: c.barberName,
    when: formatDateTime(c.startsAt),
    address: c.shopAddress,
    full_address: c.shopFullAddress ?? c.shopAddress,
    map_link: c.shopSlug ? `${baseUrl()}/locations/${c.shopSlug}/directions` : "",
    calendar_link: `${baseUrl()}/a/${c.code}/calendar.ics`,
    link: `${baseUrl()}/a/${c.code}`,
    book_link: c.shopSlug ? `${baseUrl()}/book/${c.shopSlug}` : `${baseUrl()}/book`,
    cutoff: cutoffText(c.cancelCutoffMinutes ?? 30),
    phone: c.shopPhone ?? "",
    ...extra,
  };
}

/** The saved wording at a shop (the message.<kind> settings), or none; no shop, the brand's. Read per batch of messages so an edit applies to the next one. */
export async function savedTemplates(shopId?: string | null, tx: DBorTx = db): Promise<SavedTemplates> {
  return ((await brandColumn("messageTemplates", shopId, tx)) ?? {}) as SavedTemplates;
}

export function renderMessage(kind: NotificationKind, c: AppointmentMessageContext, saved?: SavedTemplates, extra?: MergeValues): { subject: string; body: string } {
  const values = mergeValues(c, extra);
  if (!isTemplateKind(kind)) return { subject: values.shop!, body: values.shop! };
  const t = templateFor(kind, saved);
  return { subject: fill(t.subject, values), body: fill(t.body, values) };
}

/** Emails about an appointment end with where the shop is: its full address, phone, directions and the calendar link. */
export function locationFooter(c: AppointmentMessageContext, values: MergeValues): string {
  if (!c.shopFullAddress) return "";
  return [
    "",
    "—",
    `Ray'z ${c.shopName}`,
    c.shopFullAddress,
    c.shopPhone ? `Call ${c.shopPhone}` : null,
    c.shopDirections ? `Parking: ${c.shopDirections}` : null,
    values.map_link ? `Directions: ${values.map_link}` : null,
    `Add to calendar: ${values.calendar_link}`,
    ...(values.calendar_link === `${baseUrl()}/a/${c.code}/calendar.ics` ? [`Google Calendar: ${baseUrl()}/a/${c.code}/calendar/google`, `Outlook: ${baseUrl()}/a/${c.code}/calendar/outlook`] : []),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

const INVITE_KINDS = new Set<NotificationKind>(["confirmation", "reschedule", "cancellation"]);

/**
 * The calendar invite on a confirmation, move or cancel email, for one appointment (not a family's
 * one message). The same UID with a higher SEQUENCE updates the event; a cancel marks it CANCELLED.
 */
export function inviteAttachment(kind: NotificationKind, c: AppointmentMessageContext, extra: MergeValues | undefined, now: Date): EmailAttachment[] | null {
  if (!INVITE_KINDS.has(kind) || !c.endsAt || extra?.link) return null;
  const manageUrl = `${baseUrl()}/a/${c.code}`;
  const ics = icsCalendar(
    [
      {
        uid: `${c.code}@rayzbs.com`,
        start: c.startsAt,
        end: c.endsAt,
        summary: `Ray'z ${c.shopName}: ${c.services?.[0] ?? "Haircut"} with ${c.barberName}`,
        description: locationDescription({ phone: c.shopPhone ?? null, directions: c.shopDirections ?? null, manageUrl, mapUrl: c.shopSlug ? `${baseUrl()}/locations/${c.shopSlug}/directions` : null }),
        location: `Ray'z ${c.shopName}, ${c.shopFullAddress ?? c.shopAddress}`,
        geo: c.shopGeo ?? null,
        url: manageUrl,
        status: kind === "cancellation" ? "CANCELLED" : "CONFIRMED",
        sequence: Math.max(0, Math.floor(now.getTime() / 1000) - 1_790_000_000),
        now,
      },
    ],
    { method: "PUBLISH", name: `Ray'z ${c.shopName}` },
  );
  return [{ filename: `rayz-${c.code}.ics`, contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: Buffer.from(ics, "utf8").toString("base64") }];
}

async function recipients(c: AppointmentMessageContext, tx: DBorTx) {
  const out: { channel: "sms" | "email" | "push"; to: string }[] = [];
  if (c.phone && c.smsOptIn) out.push({ channel: "sms", to: c.phone });
  if (c.email && c.emailOptIn) out.push({ channel: "email", to: c.email });
  for (const id of await pushDevices(c.customerId, tx)) out.push({ channel: "push", to: id });
  return out;
}

/**
 * The app devices that get push about a client's appointments: the household's (a child's go to the
 * parent's phone), when its holder turned appointment notifications on and the phone allows them.
 */
export async function pushDevices(customerId: string | null, tx: DBorTx = db): Promise<string[]> {
  if (!customerId) return [];
  const rows = (await tx.execute(sql`
    select d.id from customer_devices d join customers h on h.id = d.customer_id
    where h.id = (select coalesce(c.guardian_id, c.id) from customers c where c.id = ${customerId}::uuid)
      and h.push_transactional and h.deleted_at is null and d.push_enabled and d.revoked_at is null
    order by d.last_seen_at desc limit 5`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
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
  /** A family booked together: everyone's names, barbers and the group's link in the one set of messages. */
  extra?: MergeValues,
) {
  await cancelPendingReminders(c.appointmentId, tx);
  const jobs: { kind: NotificationKind; runAt: Date }[] = [];
  if (event === "cancelled") jobs.push({ kind: "cancellation", runAt: now });
  else {
    if (event !== "imported" && event !== "reminders") jobs.push({ kind: event === "created" ? "confirmation" : "reschedule", runAt: now });
    jobs.push(...reminderJobs(c.startsAt, now, c.reminders, await quietRules(c.shopId, tx)));
  }
  return insertJobs(jobs, c, tx, extra, now);
}

const REMINDER_KINDS = ["reminder_24h", "reminder_2h"] as const;

/** The shop's quiet hours (Call-ins rules), which reminders keep out of. */
const quietRules = (shopId: string, tx: DBorTx): Promise<OutreachRules> => settingAt<OutreachRules>("outreach", shopId, tx);

/**
 * The first ("day before") and second ("same day") reminders, at the barber's times when they set
 * them, moved out of quiet hours (reminderTimes).
 */
function reminderJobs(startsAt: Date, now: Date, hours: { firstHours: number; secondHours: number } = { firstHours: 24, secondHours: 2 }, rules: OutreachRules) {
  const jobs: { kind: NotificationKind; runAt: Date }[] = [];
  const t = reminderTimes(startsAt, now, hours, rules);
  if (t.first) jobs.push({ kind: "reminder_24h", runAt: t.first });
  if (t.second) jobs.push({ kind: "reminder_2h", runAt: t.second });
  return jobs;
}

/**
 * A family booked together has one set of reminders, on whoever is first. Drop the reminders still
 * queued for any of them (other messages stay) and queue a fresh set for `c`, or none when it's null.
 */
export async function moveReminders(appointmentIds: string[], c: AppointmentMessageContext | null, tx: DBorTx = db, now: Date = new Date(), extra?: MergeValues) {
  if (appointmentIds.length)
    await tx
      .update(notificationJobs)
      .set({ status: "cancelled" })
      .where(and(inArray(notificationJobs.appointmentId, appointmentIds), eq(notificationJobs.status, "pending"), inArray(notificationJobs.kind, [...REMINDER_KINDS])));
  return c ? insertJobs(reminderJobs(c.startsAt, now, c.reminders, await quietRules(c.shopId, tx)), c, tx, extra, now) : 0;
}

async function insertJobs(jobs: { kind: NotificationKind; runAt: Date }[], c: AppointmentMessageContext, tx: DBorTx, extra?: MergeValues, now: Date = new Date()) {
  const to = jobs.length ? await recipients(c, tx) : [];
  const saved = jobs.length && to.length ? await savedTemplates(c.shopId, tx) : {};
  const footer = locationFooter(c, mergeValues(c, extra));
  const rows = jobs.flatMap((j) =>
    to.map((r) => {
      const m = renderMessage(j.kind, c, saved, extra);
      return {
        appointmentId: c.appointmentId,
        customerId: c.customerId,
        shopId: c.shopId,
        kind: j.kind,
        channel: r.channel,
        to: r.to,
        subject: r.channel === "sms" ? null : m.subject,
        body: r.channel === "email" && isTemplateKind(j.kind) && footer ? `${m.body}\n${footer}` : m.body,
        attachments: r.channel === "email" ? inviteAttachment(j.kind, c, extra, now) : null,
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
  const to = await recipients(c, tx);
  if (!to.length) return [];
  const m = renderMessage(kind, c, await savedTemplates(c.shopId, tx), extra);
  const footer = locationFooter(c, mergeValues(c, extra));
  const rows = to.map((r) => ({
    appointmentId: c.appointmentId,
    customerId: c.customerId,
    shopId: c.shopId,
    kind,
    channel: r.channel,
    to: r.to,
    subject: r.channel === "sms" ? null : m.subject,
    body: r.channel === "email" && isTemplateKind(kind) && footer ? `${m.body}\n${footer}` : m.body,
    attachments: r.channel === "email" ? inviteAttachment(kind, c, extra, now) : null,
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

export async function enqueueRaw(job: { kind: NotificationKind; channel: "sms" | "email"; to: string; subject?: string; body: string; customerId?: string | null; shopId: string }, at: Date = new Date()) {
  await db.insert(notificationJobs).values({ ...job, subject: job.subject ?? null, customerId: job.customerId ?? null, runAt: at, createdAt: at });
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
  await loadDisplay();
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const sms = smsProvider();
  const email = emailProvider();
  const voice = voiceProvider();
  const push = pushProvider();
  const stats = { sent: 0, suppressed: 0, failed: 0, deferred: 0 };

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
    const shopRows = shopIds.length ? await tx.select({ id: shops.id, n: shops.twilioNumber, tz: shops.timezone }).from(shops).where(inArray(shops.id, shopIds)) : [];
    const lines = new Map(shopRows.map((r) => [r.id, r.n]));
    const zones = new Map(shopRows.map((r) => [r.id, r.tz]));
    const timed = due.filter((j) => quietHoursApply(j));
    const quietAt = timed.length ? await settingFor<MarketingSettings>("marketing", timed.map((j) => j.shopId), tx) : null;
    const pushPhones = await householdPhones(timed.filter((j) => j.channel === "push" && j.customerId).map((j) => j.customerId!), tx);
    const marketingService = process.env.TWILIO_MARKETING_MESSAGING_SERVICE_SID?.trim() || null;
    const phones = [...new Set(due.filter((j) => j.channel !== "email").map((j) => j.to))];
    const optedOut = new Set(
      phones.length ? (await tx.select({ phone: contactOptOuts.phone, channel: contactOptOuts.channel }).from(contactOptOuts).where(inArray(contactOptOuts.phone, phones))).map((o) => `${o.channel}:${o.phone}`) : [],
    );
    const stoppedEmails = await suppressedEmails(
      due.filter((j) => j.channel === "email").map((j) => j.to),
      tx,
    );
    const stillWanted = await reminderConsent(due, tx);

    for (const job of due) {
      const provider = job.channel === "sms" ? sms : job.channel === "voice" ? voice : job.channel === "push" ? push : email;
      const emailStop = job.channel === "email" ? stoppedEmails.get(job.to.trim().toLowerCase()) : undefined;
      const smsStop = job.channel === "sms" && optedOut.has(`sms:${job.to}`);
      const withdrawn = !stillWanted(job);
      const stopped = smsStop || (job.channel === "voice" && AUTOMATED_CALLS.has(job.kind) && optedOut.has(`voice:${job.to}`)) || !!emailStop || withdrawn;
      if (stopped) {
        const why = emailStop ? SUPPRESSION_ERROR[emailStop] : smsStop ? OPT_OUT_REASON.stop : withdrawn ? OPT_OUT_REASON.withdrawn : OPT_OUT_REASON.noCalls;
        await tx
          .update(notificationJobs)
          .set({ status: "suppressed", provider: provider.name, attempts: job.attempts + 1, lastError: why })
          .where(eq(notificationJobs.id, job.id));
        stats.suppressed++;
        continue;
      }
      if (quietHoursApply(job)) {
        const phone = job.channel === "sms" ? job.to : job.customerId ? (pushPhones.get(job.customerId) ?? null) : null;
        const at = nextMarketingTime(now, phone, (job.shopId && zones.get(job.shopId)) || SHOP_TZ, quietAt ? quietAt(job.shopId) : null);
        if (!at || at.getTime() !== now.getTime()) {
          await tx
            .update(notificationJobs)
            .set(at ? { runAt: at } : { status: "suppressed", lastError: QUIET_ERROR })
            .where(eq(notificationJobs.id, job.id));
          if (at) stats.deferred++;
          else stats.suppressed++;
          continue;
        }
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
            ? await sms.sendSms(job.to, job.body, MARKETING_SMS.has(job.kind) && marketingService ? { from: null, messagingServiceSid: marketingService } : { from: line })
            : job.channel === "voice"
              ? AUTOMATED_CALLS.has(job.kind) && job.outreachId
                ? await voice.outreachCall(job.to, { outreachId: job.outreachId, jobId: job.id, callerId: line })
                : await voice.bridgeCall(job.to, job.subject, { jobId: job.id, callerId: line })
              : job.channel === "push"
                ? await push.sendPush(job.to, job.subject ?? "Ray'z Barber Shop", job.body, {
                    data: { kind: job.kind, ...(job.appointmentId ? { appointmentId: job.appointmentId } : {}) },
                    marketing: MARKETING_SMS.has(job.kind),
                  })
                : await sendEmailJob(email, job);
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
            status: attempts >= 5 || e instanceof PermanentSendError ? "failed" : "pending",
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

/**
 * An email to a client goes out in the brand's HTML layout (unless it has its own, like Campaign
 * Center's) with a stop link in both parts and the one-click unsubscribe headers.
 */
function sendEmailJob(email: ReturnType<typeof emailProvider>, job: typeof notificationJobs.$inferSelect) {
  const subject = job.subject ?? "Ray'z Barber Shop";
  const stop = takesUnsubscribe(job.kind) ? unsubscribeUrl(job.id) : null;
  const html = job.htmlBody ?? (CLIENT_EMAIL_LAYOUT.has(job.kind) ? clientEmailHtml({ subject, body: job.body, unsubscribeUrl: stop }) : null);
  return email.sendEmail(job.to, subject, job.htmlBody || !stop ? job.body : withUnsubscribe(job.body, stop), job.attachments ?? [], html, {
    listUnsubscribe: stop ? oneClickUnsubscribeUrl(job.id) : null,
    stream: job.kind === "marketing" ? "broadcast" : "outbound",
  });
}

/** Client emails that get the brand layout when they're sent as plain text. */
const CLIENT_EMAIL_LAYOUT = new Set<string>(["confirmation", "reminder_24h", "reminder_2h", "cancellation", "reschedule", "waitlist_ready", "time_off_reschedule", "callin_reassign", "callin_rebook", "fill_offer", "rebook_nudge", "rebook_reminder", "no_show_reminder", "running_late", "receipt", "review_request"]);

export async function notificationCounts(appointmentIds: string[]) {
  if (!appointmentIds.length) return [];
  return db
    .select({ appointmentId: notificationJobs.appointmentId, status: notificationJobs.status, n: sql<number>`count(*)::int` })
    .from(notificationJobs)
    .where(inArray(notificationJobs.appointmentId, appointmentIds))
    .groupBy(notificationJobs.appointmentId, notificationJobs.status);
}
