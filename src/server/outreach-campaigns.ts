/**
 * Texts Today suggests: an open chair to clients due for a cut, a nudge to regulars overdue to
 * rebook, an extra reminder to clients who tend not to show, and a heads-up when a barber runs
 * behind. The first two are marketing, so they only go to clients who agreed to marketing texts,
 * during the day, at most once a week each.
 */
import { and, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, clientNudges, contactOptOuts, notificationJobs, shops } from "@/db/schema";
import type { NudgeKind } from "@/db/schema";
import { MergeValues, fill, templateFor } from "@/domain/message-templates";
import { dueForCut, rebookDue } from "@/domain/today";
import { appBaseUrl } from "@/lib/deployment";
import { todayLocal, zonedWallTime } from "@/lib/time";
import { Actor, audit } from "./audit";
import { messageContext } from "./booking";
import { AppError, notFound } from "./errors";
import { processDueJobs, queueAppointmentMessage, savedTemplates } from "./notifications/queue";
import { cadenceFor } from "./visit-cadence";

/** At most one marketing text per client per week. */
const NUDGE_DAYS = 7;
/** Marketing texts go out between these local hours. */
const SEND_FROM_MIN = 9 * 60;
const SEND_UNTIL_MIN = 20 * 60;
const MAX_PER_CAMPAIGN = 40;

let consentCache: { at: number; sms: boolean; email: boolean } | null = null;

/**
 * Whether marketing consent is recorded at all (core_0085). On a database without the columns
 * nobody has agreed, so nothing marketing is texted or emailed.
 */
export async function marketingConsent(): Promise<{ sms: boolean; email: boolean }> {
  if (consentCache && Date.now() - consentCache.at < 60_000) return consentCache;
  const rows = (await db.execute(sql`
    select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = 'customers' and column_name in ('sms_marketing_opt_in', 'email_marketing_opt_in')`)) as unknown as { column_name: string }[];
  const names = new Set(rows.map((r) => r.column_name));
  consentCache = { at: Date.now(), sms: names.has("sms_marketing_opt_in"), email: names.has("email_marketing_opt_in") };
  return consentCache;
}

export interface Candidate {
  customerId: string;
  firstName: string;
  phone: string | null;
  lastStaffId: string | null;
  visits: number;
  usualDays: number;
  sinceDays: number;
  /** Agreed to marketing texts, has a number, hasn't replied STOP and hasn't been texted this week. */
  canText: boolean;
}

/** Clients whose last visit was at this shop, with no appointment booked, and how their visits run. */
async function history(shopId: string, now: Date) {
  const consent = await marketingConsent();
  const marketing = consent.sms ? sql.raw("bool_or(coalesce(g.sms_marketing_opt_in, c.sms_marketing_opt_in))") : sql`false`;
  const rows = (await db.execute(sql`
    with v as (
      select a.customer_id, count(*)::int n, min(a.starts_at) first_at, max(a.starts_at) last_at,
        (array_agg(a.shop_id order by a.starts_at desc))[1] last_shop,
        (array_agg(a.staff_id order by a.starts_at desc))[1] last_staff
      from appointments a
      where a.status = 'completed' and a.customer_id is not null and a.starts_at > ${new Date(now.getTime() - 400 * 86_400_000).toISOString()}
      group by a.customer_id
    )
    select v.customer_id, v.n, v.first_at, v.last_at, v.last_staff, c.first_name, coalesce(g.phone, c.phone) phone, ${marketing} as marketing
    from v join customers c on c.id = v.customer_id left join customers g on g.id = c.guardian_id
    where v.last_shop = ${shopId}
      and not exists (select 1 from appointments f where f.customer_id = v.customer_id and f.starts_at > ${now.toISOString()} and f.status in ('booked', 'confirmed', 'checked_in', 'in_service'))
    group by v.customer_id, v.n, v.first_at, v.last_at, v.last_staff, c.first_name, coalesce(g.phone, c.phone)`)) as unknown as {
    customer_id: string;
    n: number;
    first_at: string | Date;
    last_at: string | Date;
    last_staff: string | null;
    first_name: string;
    phone: string | null;
    marketing: boolean;
  }[];
  if (!rows.length) return [];
  const ids = rows.map((r) => r.customer_id);
  const phones = rows.map((r) => r.phone).filter((p): p is string => !!p);
  const [nudged, stopped, cadence] = await Promise.all([
    db
      .selectDistinct({ id: clientNudges.customerId })
      .from(clientNudges)
      .where(and(inArray(clientNudges.customerId, ids), inArray(clientNudges.kind, ["fill", "rebook"]), gte(clientNudges.createdAt, new Date(now.getTime() - NUDGE_DAYS * 86_400_000)))),
    phones.length ? db.select({ phone: contactOptOuts.phone }).from(contactOptOuts).where(and(inArray(contactOptOuts.phone, phones), eq(contactOptOuts.channel, "sms"))) : Promise.resolve([]),
    cadenceFor(ids, now),
  ]);
  const recent = new Set(nudged.map((r) => r.id));
  const stop = new Set(stopped.map((r) => r.phone));
  return rows.map((r) => {
    const h = { visits: r.n, firstVisit: new Date(r.first_at).getTime(), lastVisit: new Date(r.last_at).getTime(), cadenceDays: cadence.get(r.customer_id)?.cadenceDays ?? null };
    return { r, h, canText: !!r.marketing && !!r.phone && !stop.has(r.phone) && !recent.has(r.customer_id) };
  });
}

const toCandidate = (x: Awaited<ReturnType<typeof history>>[number], now: number): Candidate => {
  const d = rebookDue(x.h, now);
  return { customerId: x.r.customer_id, firstName: x.r.first_name, phone: x.r.phone, lastStaffId: x.r.last_staff, visits: x.r.n, usualDays: d.usualDays, sinceDays: d.sinceDays, canText: x.canText };
};

/** Due for a cut, most overdue first: who hears about an open chair today. */
export async function fillCandidates(shopId: string, now: Date = new Date()): Promise<Candidate[]> {
  const t = now.getTime();
  return (await history(shopId, now))
    .filter((x) => x.h.visits >= 2 && dueForCut(x.h, t))
    .map((x) => toCandidate(x, t))
    .sort((a, b) => b.sinceDays / Math.max(a.usualDays, 21) - a.sinceDays / Math.max(b.usualDays, 21));
}

/** Regulars well past their usual gap. */
export async function rebookCandidates(shopId: string, now: Date = new Date()): Promise<Candidate[]> {
  const t = now.getTime();
  return (await history(shopId, now))
    .filter((x) => rebookDue(x.h, t).due)
    .map((x) => toCandidate(x, t))
    .sort((a, b) => b.sinceDays - a.sinceDays);
}

function assertSendingHours(now: Date, untilMin = SEND_UNTIL_MIN) {
  const today = todayLocal(now);
  if (now.getTime() < zonedWallTime(today, SEND_FROM_MIN).toMillis() || now.getTime() > zonedWallTime(today, untilMin).toMillis())
    throw new AppError("conflict", "Marketing texts only go out between 9 AM and 8 PM");
}

async function sendMarketing(kind: "fill" | "rebook", shopId: string, who: { actor: Actor; staffId: string }, now: Date, extra: MergeValues) {
  assertSendingHours(now, kind === "fill" ? 19 * 60 : SEND_UNTIL_MIN);
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || shop.status !== "live") throw notFound("Live shop");
  const phones = new Set<string>();
  // A parent and their children share one number: one text per household.
  const list = (kind === "fill" ? await fillCandidates(shopId, now) : await rebookCandidates(shopId, now))
    .filter((c) => c.canText && !phones.has(c.phone!) && !!phones.add(c.phone!))
    .slice(0, MAX_PER_CAMPAIGN);
  if (!list.length) return { sent: 0 };
  const template = templateFor(kind === "fill" ? "fill_offer" : "rebook_nudge", await savedTemplates());
  const values: MergeValues = { shop: `Ray'z ${shop.name}`, book_link: `${appBaseUrl()}/book/${shop.slug}`, ...extra };
  const jobIds = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(notificationJobs)
      .values(list.map((c) => ({ customerId: c.customerId, shopId, kind: kind === "fill" ? "fill_offer" : "rebook_nudge", channel: "sms", to: c.phone!, body: fill(template.body, { ...values, first_name: c.firstName }), runAt: now })))
      .returning({ id: notificationJobs.id });
    await tx.insert(clientNudges).values(list.map((c) => ({ customerId: c.customerId, shopId, kind: kind as NudgeKind, channel: "sms", staffId: who.staffId, createdAt: now })));
    await audit(who.actor, `campaign.${kind}`, "shop", shopId, { clients: list.length }, shopId, tx);
    return rows.map((r) => r.id);
  });
  await processDueJobs({ ids: jobIds, now });
  return { sent: list.length };
}

/** "A chair opened up": to clients due for a cut, naming the barbers with open time. */
export async function sendFillCampaign(shopId: string, barbers: string[], who: { actor: Actor; staffId: string }, now: Date = new Date()) {
  const names = barbers.length <= 2 ? barbers.join(" and ") : `${barbers.slice(0, -1).join(", ")} and ${barbers.at(-1)}`;
  return sendMarketing("fill", shopId, who, now, { barber: names || "We" });
}

export async function sendRebookCampaign(shopId: string, who: { actor: Actor; staffId: string }, now: Date = new Date()) {
  return sendMarketing("rebook", shopId, who, now, {});
}

/** One appointment message per appointment, once: the extra no-show reminder or the running-late note. */
export async function nudgeAppointments(kind: "no_show_reminder" | "running_late", appointmentIds: string[], who: { actor: Actor; staffId: string; shopIds: readonly string[] }, extra: MergeValues = {}, now: Date = new Date()) {
  if (!appointmentIds.length) return { sent: 0, skipped: 0 };
  const rows = await db.select().from(appointments).where(and(inArray(appointments.id, appointmentIds), inArray(appointments.status, ["booked", "confirmed"]), gt(appointments.startsAt, now)));
  const done = new Set(
    (await db.select({ id: clientNudges.appointmentId }).from(clientNudges).where(and(inArray(clientNudges.appointmentId, appointmentIds), eq(clientNudges.kind, kind)))).map((r) => r.id),
  );
  let sent = 0;
  let skipped = appointmentIds.length - rows.length;
  const jobIds: string[] = [];
  for (const a of rows) {
    if (!who.shopIds.includes(a.shopId)) throw new AppError("forbidden", "That appointment isn't at one of your shops");
    if (done.has(a.id) || !a.customerId) {
      skipped++;
      continue;
    }
    const queued = await queueAppointmentMessage(kind, await messageContext(a.id), db, now, extra);
    const n = queued.length;
    if (!n) {
      skipped++;
      continue;
    }
    jobIds.push(...queued);
    await db.insert(clientNudges).values({ customerId: a.customerId, shopId: a.shopId, appointmentId: a.id, kind, channel: "appointment", staffId: who.staffId, createdAt: now });
    await audit(who.actor, `nudge.${kind}`, "appointment", a.id, { code: a.code, messages: n, ...extra }, a.shopId);
    sent++;
  }
  if (jobIds.length) await processDueJobs({ ids: jobIds, now });
  return { sent, skipped };
}

