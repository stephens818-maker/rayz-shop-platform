/**
 * "We have openings" (Campaign Center: We have openings). A location picks one or more of its
 * barbers and a day or two; for each barber this pulls their real open times and texts or emails
 * their regulars (two or more visits with them here in a year) and recent clients (a visit with
 * them here lately) who agreed to marketing and have nothing booked. One blast per barber. The
 * link goes to a live page of that barber's open times, which disappear as they're booked; when
 * the last one goes it says all booked and offers the waitlist.
 *
 * Nobody sending it sees who gets it: the preview and the results are counts. It goes through the
 * engine like any campaign, so consent, unsubscribes, quiet hours and the weekly and monthly caps
 * apply, plus the brand's openings cap (one openings message per client in so many days) and each
 * location's daily and weekly send limits. When the brand requires approval, a blast waits for
 * someone with Campaign Center: send and access to all shops, and its times are pulled again then.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import { customers, marketingCampaigns, notificationJobs, openingsWaitlist, services, shops, staff } from "@/db/schema";
import { MarketingSettings, SKIP_LABEL, capProblem, fill, nextSendAt, pickChannel } from "@/domain/marketing";
import {
  OPENINGS_STATUS_LABEL,
  OpeningsInputSchema,
  OpeningsSegment,
  OpeningsSegmentSchema,
  OpeningsSettings,
  dayLabel,
  limitProblem,
  openingsDays,
  rulesFor,
  windowProblem,
} from "@/domain/openings";
import { appBaseUrl } from "@/lib/deployment";
import { normalizePhone } from "@/lib/phone";
import { addDays, formatDate, formatTime, localDateOf, startOfLocalDay, todayLocal } from "@/lib/time";
import { audit } from "../audit";
import { StaffContext, assertShopAccess, can, openShops } from "../auth/staff";
import { getAvailability } from "../booking";
import { shopBarbers, shopCatalog } from "../catalog";
import { AppError, forbidden, notFound } from "../errors";
import { processDueJobs } from "../notifications/queue";
import { consentColumns, contactsFor } from "./consent";
import { channelsOf, deliver, templatesOf } from "./engine";
import { loadMarketingSettings, loadOpeningsSettings } from "./settings";

const DAY = 86_400_000;
type Campaign = typeof marketingCampaigns.$inferSelect;
type Shop = typeof shops.$inferSelect;

export const mayOpenings = (ctx: Pick<StaffContext, "permissions">) => can(ctx, "campaign_center.openings");
/** Approves locations' openings blasts when the brand requires it. */
export const mayApproveOpenings = (ctx: Pick<StaffContext, "permissions" | "brandWide">) => ctx.brandWide && can(ctx, "campaign_center.send");
/** Sets the openings rules for every location. */
export const mayConfigureOpenings = (ctx: Pick<StaffContext, "permissions" | "brandWide">) => ctx.brandWide && can(ctx, "campaign_center.create");

/** Blasts that count toward a location's send limits. */
const COUNTED = sql.raw("('pending_approval', 'sending', 'sent')");
const uuids = (xs: readonly string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
const UUID = z.uuid();

const parse = <T extends z.ZodType>(s: T, input: unknown): z.infer<T> => {
  const r = s.safeParse(input);
  if (!r.success) throw new AppError("bad_request", r.error.issues[0]?.message ?? "Check the openings");
  return r.data;
};

/** "Today", "Tomorrow" or "Thu, Oct 29", for lists. */
export const dayName = (d: string, today: string) => (d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : formatDate(d, "EEE, MMM d"));

// ───────────────────────────── Facts ─────────────────────────────

/** The barber's most booked service at the location in the last 90 days, or the location's first service. */
async function serviceFor(shopId: string, staffId: string, now: Date): Promise<{ id: string; slug: string; name: string } | null> {
  const menu = (await shopCatalog(shopId, { onlineOnly: true })).filter((s) => s.kind === "service");
  const rows = (await db.execute(sql`
    select ai.service_id, count(*)::int n from appointments a join appointment_items ai on ai.appointment_id = a.id and ai.kind = 'service'
    where a.shop_id = ${shopId} and a.staff_id = ${staffId} and a.status in ('booked', 'confirmed', 'checked_in', 'in_service', 'completed')
      and a.starts_at > ${new Date(now.getTime() - 90 * DAY).toISOString()} and ai.service_id is not null
    group by 1 order by 2 desc`)) as unknown as { service_id: string }[];
  const pick = rows.map((r) => menu.find((s) => s.id === r.service_id)).find(Boolean) ?? menu[0];
  return pick ? { id: pick.id, slug: pick.slug, name: pick.name } : null;
}

export interface DayTimes {
  date: string;
  /** Open start times, ISO. */
  slots: string[];
}

/** The barber's open times on each day, as online booking offers them now. */
async function openTimes(shop: Shop, staffId: string, serviceId: string, dates: readonly string[], now: Date): Promise<{ days: DayTimes[]; reason: string | null }> {
  const days: DayTimes[] = [];
  let reason: string | null = null;
  for (const date of dates) {
    const r = await getAvailability({ shopRef: shop.id, date, serviceId, barberRef: staffId, now }).catch((e: Error) => ({ slots: [] as { startsAt: string }[], reason: e.message }));
    days.push({ date, slots: r.slots.map((s) => s.startsAt).filter((s) => new Date(s).getTime() > now.getTime()) });
    reason ??= r.reason;
  }
  return { days, reason: days.some((d) => d.slots.length) ? null : reason };
}

interface Recipient {
  customerId: string;
  lastAt: Date;
}

/**
 * The barber's regulars (two or more completed visits with them at this location in a year) and
 * recent clients (one within recentDays), with nothing booked anywhere, longest since their last
 * visit first. With "last visit over N weeks", only clients whose last visit anywhere is older.
 */
async function audienceOf(shopId: string, staffId: string, o: { recentDays: number; lastVisitOverWeeks: number | null }, now: Date): Promise<Recipient[]> {
  const cols = await consentColumns();
  const iso = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  const rows = (await db.execute(sql`
    with mine as (
      select a.customer_id, count(*)::int n, max(a.starts_at) last_with
      from appointments a
      where a.shop_id = ${shopId} and a.staff_id = ${staffId} and a.status = 'completed' and a.customer_id is not null and a.starts_at > ${iso(365)}
      group by a.customer_id
    ), v as (
      select a.customer_id, max(a.starts_at) last_at from appointments a
      where a.status = 'completed' and a.customer_id in (select customer_id from mine)
      group by a.customer_id
    )
    select c.id, v.last_at from customers c join mine on mine.customer_id = c.id join v on v.customer_id = c.id
    where (mine.n >= 2 or mine.last_with > ${iso(o.recentDays)})
      and not exists (select 1 from appointments f where f.customer_id = c.id and f.starts_at > ${now.toISOString()} and f.status in ('booked', 'confirmed', 'checked_in', 'in_service'))
      ${o.lastVisitOverWeeks ? sql`and v.last_at < ${iso(o.lastVisitOverWeeks * 7)}` : sql``}
      ${cols.deleted ? sql`and c.deleted_at is null` : sql``}
    order by v.last_at asc, c.id`)) as unknown as { id: string; last_at: string | Date }[];
  return rows.map((r) => ({ customerId: r.id, lastAt: new Date(r.last_at) }));
}

/** Why each of these clients would be held back by a frequency cap now, for the preview. The engine checks again as it sends. */
async function capReasons(ids: readonly string[], now: Date, s: MarketingSettings, capDays: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const [recent, openings] = await Promise.all([
    db.execute(sql`
      select customer_id, created_at at from marketing_sends where status = 'queued' and customer_id in ${uuids(ids)} and created_at >= ${since}
      union all
      select customer_id, created_at from client_nudges where kind in ('fill', 'rebook') and customer_id in ${uuids(ids)} and created_at >= ${since}`) as unknown as Promise<
      { customer_id: string; at: string | Date }[]
    >,
    db.execute(sql`
      select distinct ms.customer_id from marketing_sends ms join marketing_campaigns mc on mc.id = ms.campaign_id
      where ms.status = 'queued' and mc.kind = 'openings' and ms.customer_id in ${uuids(ids)} and ms.created_at >= ${new Date(now.getTime() - capDays * DAY).toISOString()}`) as unknown as Promise<
      { customer_id: string }[]
    >,
  ]);
  const sent = new Map<string, Date[]>();
  for (const r of recent) sent.set(r.customer_id, [...(sent.get(r.customer_id) ?? []), new Date(r.at)]);
  for (const [id, at] of sent) {
    const cap = capProblem(at, now, s);
    if (cap) out.set(id, cap);
  }
  for (const r of openings) if (!out.has(r.customer_id)) out.set(r.customer_id, "openings_cap");
  return out;
}

/** Openings blasts this location sent (or asked the brand to approve) today and in the last 7 days. */
async function usedAt(shopId: string, now: Date, tx: DBorTx = db): Promise<{ today: number; week: number }> {
  const [r] = (await tx.execute(sql`
    select count(*) filter (where created_at >= ${startOfLocalDay(todayLocal(now)).toISOString()})::int today,
      count(*) filter (where created_at >= ${new Date(now.getTime() - 7 * DAY).toISOString()})::int week
    from marketing_campaigns where kind = 'openings' and status in ${COUNTED} and shop_ids @> ${JSON.stringify([shopId])}::jsonb`)) as unknown as { today: number; week: number }[];
  return { today: r?.today ?? 0, week: r?.week ?? 0 };
}

/** When the messages arrive (after quiet hours), that day, and the days still worth announcing then. */
function timing(shop: Shop, days: readonly DayTimes[], s: MarketingSettings, now: Date) {
  const at = nextSendAt(now, shop.timezone, s);
  const arrives = localDateOf(at);
  const left = days.filter((d) => d.date >= arrives && d.slots.some((x) => new Date(x).getTime() > at.getTime()));
  return { at, deferred: at.getTime() > now.getTime(), arrives, left, label: dayLabel(left.map((d) => d.date), arrives) };
}

// ───────────────────────────── Planning a blast ─────────────────────────────

interface Plan {
  staffId: string;
  /** The barber's first name, as the message says it. */
  firstName: string;
  label: string;
  service: { id: string; slug: string; name: string } | null;
  days: DayTimes[];
  open: number;
  dayText: string;
  sendAt: Date;
  deferred: boolean;
  recipients: Recipient[];
  /** Why this barber's blast can't go, or null. */
  problem: string | null;
}

async function planFor(shop: Shop, staffId: string, seg: Pick<OpeningsSegment, "dates" | "lastVisitOverWeeks"> & { serviceId?: string }, s: MarketingSettings, os: OpeningsSettings, now: Date): Promise<Plan> {
  const [b] = await db.select({ firstName: staff.firstName, label: staff.displayLabel }).from(staff).where(eq(staff.id, staffId));
  const service = seg.serviceId ? await serviceById(seg.serviceId) : await serviceFor(shop.id, staffId, now);
  const base = { staffId, firstName: b?.firstName ?? "", label: b?.label ?? "", service, recipients: [] as Recipient[], days: [] as DayTimes[], open: 0, dayText: "", sendAt: now, deferred: false };
  if (!service) return { ...base, problem: "This location has no service to book online" };
  const { days, reason } = await openTimes(shop, staffId, service.id, seg.dates, now);
  const t = timing(shop, days, s, now);
  const open = t.left.reduce((a, d) => a + d.slots.filter((x) => new Date(x).getTime() > t.at.getTime()).length, 0);
  const plan = { ...base, days, open, dayText: t.label, sendAt: t.at, deferred: t.deferred };
  if (!days.some((d) => d.slots.length)) return { ...plan, problem: reason && reason !== "No openings on this day" ? reason : "No open times on those days" };
  if (!t.left.length) return { ...plan, problem: `It's quiet hours: messages wait until ${formatTime(t.at)}, after these open times` };
  return { ...plan, recipients: await audienceOf(shop.id, staffId, { recentDays: os.recentDays, lastVisitOverWeeks: seg.lastVisitOverWeeks }, now), problem: null };
}

async function serviceById(id: string) {
  const [s] = await db.select({ id: services.id, slug: services.slug, name: services.name }).from(services).where(eq(services.id, id));
  return s ?? null;
}

async function shopFor(ctx: StaffContext, shopId: string): Promise<Shop> {
  assertShopAccess(ctx, shopId);
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Location");
  if (shop.status !== "live") throw new AppError("bad_request", `${shop.name} isn't open for bookings yet`);
  return shop;
}

async function bookableHere(shopId: string, staffIds: readonly string[]) {
  const team = await shopBarbers(shopId, { onlineOnly: true });
  const missing = staffIds.find((id) => !team.some((b) => b.id === id));
  if (missing) throw new AppError("bad_request", "Pick barbers who take online bookings at this location");
  return team;
}

// ───────────────────────────── The page ─────────────────────────────

export interface OpeningsSetup {
  shop: { id: string; name: string; slug: string };
  barbers: { id: string; name: string; today: number; tomorrow: number }[];
  days: { date: string; label: string }[];
  today: string;
  defaultDates: string[];
  rules: { perDay: number; perWeek: number; approval: boolean };
  used: { today: number; week: number };
  capDays: number;
  maxRecipients: number;
  recentDays: number;
  /** Marketing email needs the brand's postal address. */
  emailReady: boolean;
  quiet: { start: string; end: string; now: boolean; until: string | null };
}

/** What the page needs to pick barbers and days: each barber's open times today and tomorrow, and the limits. */
export async function openingsSetup(ctx: StaffContext, shopId: string, now = new Date()): Promise<OpeningsSetup> {
  if (!mayOpenings(ctx)) throw forbidden("Sending openings needs Campaign Center: We have openings");
  const shop = await shopFor(ctx, shopId);
  const [s, os, team, used] = await Promise.all([loadMarketingSettings(), loadOpeningsSettings(), shopBarbers(shop.id, { onlineOnly: true }), usedAt(shop.id, now)]);
  const today = todayLocal(now);
  const tomorrow = addDays(today, 1);
  const barbers = [];
  for (const b of team) {
    const service = await serviceFor(shop.id, b.id, now);
    const { days } = service ? await openTimes(shop, b.id, service.id, [today, tomorrow], now) : { days: [] };
    barbers.push({ id: b.id, name: b.displayName, today: days[0]?.slots.length ?? 0, tomorrow: days[1]?.slots.length ?? 0 });
  }
  const at = nextSendAt(now, shop.timezone, s);
  return {
    shop: { id: shop.id, name: shop.name, slug: shop.slug },
    barbers,
    days: openingsDays(today).map((d) => ({ date: d, label: dayName(d, today) })),
    today,
    defaultDates: barbers.some((b) => b.today > 0) && localDateOf(at) === today ? [today] : [tomorrow],
    rules: rulesFor(os, shop.id),
    used,
    capDays: os.capDays,
    maxRecipients: os.maxRecipients,
    recentDays: os.recentDays,
    emailReady: !!s.address.trim(),
    quiet: { start: s.quietStart, end: s.quietEnd, now: at.getTime() > now.getTime(), until: at.getTime() > now.getTime() ? at.toISOString() : null },
  };
}

export interface OpeningsPreview {
  barbers: {
    staffId: string;
    name: string;
    open: number;
    days: { date: string; label: string; times: string[] }[];
    /** Regulars and recent clients with nothing booked (and the weeks filter). */
    clients: number;
    willGet: number;
    byChannel: { sms: number; email: number };
    skipped: { label: string; count: number }[];
    problem: string | null;
  }[];
  /** The message as the first barber's clients would get it, with a sample first name. */
  sample: { sms: string; emailSubject: string; emailBody: string } | null;
  sendsAt: string | null;
  approval: boolean;
  limit: string | null;
  problem: string | null;
}

/** Counts only: who'd get each barber's openings, who wouldn't and why, and the message. Never names or contact details. */
export async function previewOpenings(ctx: StaffContext, input: unknown, now = new Date()): Promise<OpeningsPreview> {
  if (!mayOpenings(ctx)) throw forbidden("Sending openings needs Campaign Center: We have openings");
  const v = parse(OpeningsInputSchema, input);
  const shop = await shopFor(ctx, v.shopId);
  await bookableHere(shop.id, v.staffIds);
  const [s, os, used] = await Promise.all([loadMarketingSettings(), loadOpeningsSettings(), usedAt(shop.id, now)]);
  const rules = rulesFor(os, shop.id);
  const today = todayLocal(now);
  const problem = windowProblem(v.dates, today);
  const out: OpeningsPreview = { barbers: [], sample: null, sendsAt: null, approval: rules.approval, limit: limitProblem(used, v.staffIds.length, rules), problem };
  if (problem) return out;
  const seen = new Set<string>();
  const channels = v.channels.filter((c) => c === "sms" || s.address.trim());
  for (const staffId of v.staffIds) {
    const p = await planFor(shop, staffId, { dates: v.dates, lastVisitOverWeeks: v.lastVisitOverWeeks }, s, os, now);
    const ids = p.recipients.map((r) => r.customerId);
    const [contacts, caps] = await Promise.all([contactsFor(ids), capReasons(ids, now, s, os.capDays)]);
    const tally = new Map<string, number>();
    const byChannel = { sms: 0, email: 0 };
    let willGet = 0;
    for (const id of ids) {
      const reach = contacts.get(id)?.reach;
      const ch = reach ? pickChannel(channels, reach) : null;
      const why = !ch ? "no_consent" : seen.has(id) ? "other_barber" : (caps.get(id) ?? (willGet >= os.maxRecipients ? "max" : null));
      if (why) {
        tally.set(why, (tally.get(why) ?? 0) + 1);
        continue;
      }
      seen.add(id);
      willGet++;
      byChannel[ch as "sms" | "email"]++;
    }
    const label = (k: string) =>
      k === "other_barber" ? "Getting another barber's openings in this send" : k === "max" ? `Over the brand's ${os.maxRecipients} clients a blast` : (SKIP_LABEL[k] ?? k);
    out.barbers.push({
      staffId,
      name: p.label,
      open: p.open,
      days: p.days.map((d) => ({ date: d.date, label: dayName(d.date, today), times: d.slots.map((x) => formatTime(x)) })),
      clients: ids.length,
      willGet: p.problem ? 0 : willGet,
      byChannel,
      skipped: [...tally].map(([k, count]) => ({ label: label(k), count })),
      problem: p.problem,
    });
    if (!out.sample && !p.problem) {
      const t = templatesOf(os.templates);
      const values = { first_name: "Jordan", barber: p.firstName, shop: `Ray'z ${shop.name}`, day: p.dayText, book_link: `${appBaseUrl()}/m/…` };
      out.sample = { sms: fill(t.sms, values), emailSubject: fill(t.emailSubject, values), emailBody: fill(t.emailBody, values) };
      out.sendsAt = p.deferred ? p.sendAt.toISOString() : null;
    }
  }
  return out;
}

// ───────────────────────────── Sending ─────────────────────────────

export interface OpeningsResult {
  staffId: string;
  name: string;
  campaignId: string | null;
  status: "sent" | "pending_approval" | "expired" | "not_sent";
  queued: number;
  skipped: { label: string; count: number }[];
  problem: string | null;
}

/** One blast's messages, through the engine. The campaign row must be "sending". */
async function deliverOpenings(c: Campaign, shop: Shop, plan: Plan, s: MarketingSettings, os: OpeningsSettings, now: Date) {
  const contacts = await contactsFor(plan.recipients.map((r) => r.customerId));
  const templates = templatesOf(c.templates);
  const channels = channelsOf(c.channels).filter((x) => x === "sms" || x === "email");
  const path = `/book/${shop.slug}/openings/${c.id}`;
  const tally = new Map<string, number>();
  const jobs: string[] = [];
  for (const r of plan.recipients) {
    if (jobs.length >= os.maxRecipients) break;
    const res = await deliver({
      campaign: c,
      shop,
      target: { customerId: r.customerId, shopId: shop.id, staffId: plan.staffId, occasion: "openings", values: { barber: plan.firstName, day: plan.dayText }, path },
      contact: contacts.get(r.customerId),
      templates,
      channels,
      settings: s,
      promo: null,
      recordSkips: true,
      openingsCapDays: os.capDays,
      now,
    }).catch((e: Error) => {
      console.error("openings send failed", c.id, e.message);
      return { status: "skipped" as const, reason: "failed" };
    });
    if (res.status === "queued") jobs.push(res.jobId);
    else if (res.status === "skipped") tally.set(res.reason, (tally.get(res.reason) ?? 0) + 1);
  }
  await db
    .update(marketingCampaigns)
    .set({ status: "sent", sentAt: now, settings: { openSlots: plan.open, recipients: plan.recipients.length }, updatedAt: now })
    .where(eq(marketingCampaigns.id, c.id));
  return { jobs, skipped: [...tally].map(([k, count]) => ({ label: SKIP_LABEL[k] ?? (k === "failed" ? "Couldn't send" : k), count })) };
}

const nameFor = (barber: string, dates: readonly string[], today: string) => `We have openings: ${barber}, ${dates.map((d) => dayName(d, today)).join(" & ")}`;

/**
 * Sends each barber's openings, or puts them up for the brand's approval. The location's send
 * limits are checked and taken under a lock, so two people sending at once can't both squeeze in.
 */
export async function sendOpenings(ctx: StaffContext, input: unknown, now = new Date()): Promise<OpeningsResult[]> {
  if (!mayOpenings(ctx)) throw forbidden("Sending openings needs Campaign Center: We have openings");
  const v = parse(OpeningsInputSchema, input);
  const shop = await shopFor(ctx, v.shopId);
  await bookableHere(shop.id, v.staffIds);
  const today = todayLocal(now);
  const wp = windowProblem(v.dates, today);
  if (wp) throw new AppError("bad_request", wp);
  const [s, os] = await Promise.all([loadMarketingSettings(), loadOpeningsSettings()]);
  if (v.channels.includes("email") && !s.address.trim() && !v.channels.includes("sms")) throw new AppError("bad_request", "Email needs the brand's postal address. Send by text, or ask the brand to add it.");
  const rules = rulesFor(os, shop.id);
  const staffIds = [...new Set(v.staffIds)];
  const plans: Plan[] = [];
  for (const id of staffIds) plans.push(await planFor(shop, id, { dates: v.dates, lastVisitOverWeeks: v.lastVisitOverWeeks }, s, os, now));
  const ready = plans.filter((p) => !p.problem);
  if (!ready.length) throw new AppError("bad_request", plans.length === 1 ? plans[0].problem! : `None of these barbers can send: ${plans[0].problem}`);

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`openings:${shop.id}`}))`);
    const lp = limitProblem(await usedAt(shop.id, now, tx), ready.length, rules);
    if (lp) throw new AppError("bad_request", lp);
    const rows: Campaign[] = [];
    for (const p of ready) {
      const segment: OpeningsSegment = { staffId: p.staffId, dates: [...v.dates].sort(), lastVisitOverWeeks: v.lastVisitOverWeeks, serviceId: p.service!.id };
      const [c] = await tx
        .insert(marketingCampaigns)
        .values({
          kind: "openings",
          name: nameFor(p.label, segment.dates, today),
          channels: v.channels,
          templates: { ...os.templates },
          segment: { ...segment },
          settings: { openSlots: p.open },
          shopIds: [shop.id],
          status: rules.approval ? "pending_approval" : "sending",
          scheduledAt: now,
          createdBy: ctx.staff.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      rows.push(c);
    }
    return rows;
  });

  const results: OpeningsResult[] = plans
    .filter((p) => p.problem)
    .map((p) => ({ staffId: p.staffId, name: p.label, campaignId: null, status: "not_sent" as const, queued: 0, skipped: [], problem: p.problem }));
  const jobs: string[] = [];
  for (const [i, c] of created.entries()) {
    const p = ready[i];
    if (rules.approval) {
      results.push({ staffId: p.staffId, name: p.label, campaignId: c.id, status: "pending_approval", queued: 0, skipped: [], problem: null });
      await audit(ctx.actor, "campaign_center.openings_requested", "marketing_campaign", c.id, { staffId: p.staffId, dates: v.dates, channels: v.channels, openSlots: p.open }, shop.id);
      continue;
    }
    const r = await deliverOpenings(c, shop, p, s, os, now);
    jobs.push(...r.jobs);
    results.push({ staffId: p.staffId, name: p.label, campaignId: c.id, status: "sent", queued: r.jobs.length, skipped: r.skipped, problem: null });
    await audit(ctx.actor, "campaign_center.openings_sent", "marketing_campaign", c.id, { staffId: p.staffId, dates: v.dates, channels: v.channels, openSlots: p.open, queued: r.jobs.length }, shop.id);
  }
  if (jobs.length) await processDueJobs({ now, ids: jobs });
  return results;
}

async function openingsById(id: string): Promise<Campaign> {
  if (!UUID.safeParse(id).success) throw notFound("Openings blast");
  const [c] = await db.select().from(marketingCampaigns).where(and(eq(marketingCampaigns.id, id), eq(marketingCampaigns.kind, "openings")));
  if (!c) throw notFound("Openings blast");
  return c;
}

/** The brand approves a waiting blast: its times and clients are pulled again now, and it expires if the times are gone. */
export async function approveOpenings(ctx: StaffContext, id: string, now = new Date()): Promise<OpeningsResult> {
  if (!mayApproveOpenings(ctx)) throw forbidden("Approving openings needs Campaign Center: send with access to all shops");
  const c0 = await openingsById(id);
  const [c] = await db
    .update(marketingCampaigns)
    .set({ status: "sending", reviewedBy: ctx.staff.id, reviewedAt: now, updatedAt: now })
    .where(and(eq(marketingCampaigns.id, c0.id), eq(marketingCampaigns.status, "pending_approval")))
    .returning();
  if (!c) throw new AppError("conflict", "Someone already handled this one");
  const seg = OpeningsSegmentSchema.parse(c.segment);
  const [shop] = await db.select().from(shops).where(eq(shops.id, c.shopIds[0]));
  const [s, os] = await Promise.all([loadMarketingSettings(), loadOpeningsSettings()]);
  const left = seg.dates.filter((d) => d >= todayLocal(now));
  const p = shop && left.length ? await planFor(shop, seg.staffId, { ...seg, dates: left }, s, os, now) : null;
  if (!shop || !p || p.problem) {
    const problem = p?.problem ?? (shop ? "These openings have passed" : "This location is gone");
    await db.update(marketingCampaigns).set({ status: "expired", reviewNote: problem, updatedAt: now }).where(eq(marketingCampaigns.id, c.id));
    await audit(ctx.actor, "campaign_center.openings_expired", "marketing_campaign", c.id, { problem }, c.shopIds[0] ?? null);
    return { staffId: seg.staffId, name: p?.label ?? "", campaignId: c.id, status: "expired", queued: 0, skipped: [], problem };
  }
  const r = await deliverOpenings(c, shop, p, s, os, now);
  await audit(ctx.actor, "campaign_center.openings_approved", "marketing_campaign", c.id, { queued: r.jobs.length, openSlots: p.open }, shop.id);
  if (r.jobs.length) await processDueJobs({ now, ids: r.jobs });
  return { staffId: seg.staffId, name: p.label, campaignId: c.id, status: "sent", queued: r.jobs.length, skipped: r.skipped, problem: null };
}

export async function rejectOpenings(ctx: StaffContext, id: string, note: string, now = new Date()) {
  if (!mayApproveOpenings(ctx)) throw forbidden("Approving openings needs Campaign Center: send with access to all shops");
  const c0 = await openingsById(id);
  const reason = String(note ?? "").trim().slice(0, 300);
  const [c] = await db
    .update(marketingCampaigns)
    .set({ status: "rejected", reviewedBy: ctx.staff.id, reviewedAt: now, reviewNote: reason || null, updatedAt: now })
    .where(and(eq(marketingCampaigns.id, c0.id), eq(marketingCampaigns.status, "pending_approval")))
    .returning({ id: marketingCampaigns.id });
  if (!c) throw new AppError("conflict", "Someone already handled this one");
  await audit(ctx.actor, "campaign_center.openings_rejected", "marketing_campaign", c0.id, { note: reason }, c0.shopIds[0] ?? null);
}

/** The location takes back a blast still waiting for the brand. */
export async function withdrawOpenings(ctx: StaffContext, id: string, now = new Date()) {
  if (!mayOpenings(ctx)) throw forbidden("Sending openings needs Campaign Center: We have openings");
  const c0 = await openingsById(id);
  for (const s of c0.shopIds) assertShopAccess(ctx, s);
  const [c] = await db
    .update(marketingCampaigns)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(marketingCampaigns.id, c0.id), eq(marketingCampaigns.status, "pending_approval")))
    .returning({ id: marketingCampaigns.id });
  if (!c) throw new AppError("conflict", "This one isn't waiting any more");
  await audit(ctx.actor, "campaign_center.openings_withdrawn", "marketing_campaign", c0.id, {}, c0.shopIds[0] ?? null);
}

/** Waiting blasts whose days have all passed. */
async function expireStale(now: Date) {
  await db.execute(sql`
    update marketing_campaigns set status = 'expired', review_note = coalesce(review_note, 'The days passed before it was approved'), updated_at = ${now.toISOString()}
    where kind = 'openings' and status = 'pending_approval'
      and not exists (select 1 from jsonb_array_elements_text(segment->'dates') d where d >= ${todayLocal(now)})`);
}

// ───────────────────────────── Lists and stats ─────────────────────────────

export interface OpeningsBlastView {
  id: string;
  shopId: string;
  shopName: string;
  barber: string;
  days: string;
  status: string;
  statusLabel: string;
  createdAt: string;
  sentBy: string;
  reviewNote: string | null;
  channels: string[];
  openAtSend: number;
  sent: number;
  clicked: number;
  booked: number;
  waitlist: { id: string; name: string; wantsDate: string | null; status: string }[];
}

export interface BlastStats {
  sent: number;
  clicked: number;
  /** Recipients who booked with that barber, at that location, on those days, after the message. */
  booked: number;
}

/** Sent, clicked and booked per openings blast. */
export async function openingsStats(ids: readonly string[]): Promise<Map<string, BlastStats>> {
  const out = new Map<string, BlastStats>();
  if (!ids.length) return out;
  const rows = (await db.execute(sql`
    select ms.campaign_id id, count(*)::int sent, count(*) filter (where ms.clicks > 0)::int clicked,
      count(*) filter (where exists (
        select 1 from appointments a join shops sh on sh.id = a.shop_id
        where a.customer_id = ms.customer_id and a.shop_id = ms.shop_id and a.staff_id = (mc.segment->>'staffId')::uuid
          and a.created_at > ms.created_at and a.status <> 'cancelled'
          and to_char(a.starts_at at time zone sh.timezone, 'YYYY-MM-DD') in (select jsonb_array_elements_text(mc.segment->'dates'))
      ))::int booked
    from marketing_sends ms join marketing_campaigns mc on mc.id = ms.campaign_id
    where ms.status = 'queued' and ms.campaign_id in ${uuids(ids)}
    group by ms.campaign_id`)) as unknown as ({ id: string } & BlastStats)[];
  for (const r of rows) out.set(r.id, { sent: r.sent, clicked: r.clicked, booked: r.booked });
  return out;
}

/** Openings blasts at these locations, newest first, with their numbers and waitlists. */
export async function listOpenings(ctx: StaffContext, o: { shopIds?: string[]; status?: "pending_approval"; days?: number } = {}, now = new Date()): Promise<OpeningsBlastView[]> {
  if (!mayOpenings(ctx) && !mayApproveOpenings(ctx)) throw forbidden("Sending openings needs Campaign Center: We have openings");
  await expireStale(now);
  const scope = o.shopIds ?? (ctx.brandWide ? null : ctx.shopIds);
  if (scope) for (const s of scope) if (!ctx.brandWide) assertShopAccess(ctx, s);
  const since = new Date(now.getTime() - (o.days ?? 14) * DAY);
  const rows = await db
    .select()
    .from(marketingCampaigns)
    .where(
      and(
        eq(marketingCampaigns.kind, "openings"),
        o.status ? eq(marketingCampaigns.status, o.status) : sql`${marketingCampaigns.createdAt} >= ${since.toISOString()}`,
        scope ? sql`${marketingCampaigns.shopIds}->>0 in (${sql.join(scope.length ? scope.map((x) => sql`${x}`) : [sql`''`], sql`, `)})` : undefined,
      ),
    )
    .orderBy(desc(marketingCampaigns.createdAt))
    .limit(100);
  if (!rows.length) return [];
  const segs = new Map(rows.map((c) => [c.id, OpeningsSegmentSchema.safeParse(c.segment).data]));
  const people = [...new Set(rows.flatMap((c) => [c.createdBy, segs.get(c.id)?.staffId].filter((x): x is string => !!x)))];
  const [names, shopRows, stats, wait] = await Promise.all([
    people.length ? db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, people)) : [],
    db.select({ id: shops.id, name: shops.name }).from(shops),
    openingsStats(rows.map((c) => c.id)),
    db
      .select({ id: openingsWaitlist.id, campaignId: openingsWaitlist.campaignId, firstName: openingsWaitlist.firstName, wantsDate: openingsWaitlist.wantsDate, status: openingsWaitlist.status })
      .from(openingsWaitlist)
      .where(and(inArray(openingsWaitlist.campaignId, rows.map((c) => c.id)), sql`${openingsWaitlist.status} <> 'removed'`))
      .orderBy(openingsWaitlist.createdAt),
  ]);
  const label = new Map(names.map((n) => [n.id, n.label]));
  const shopName = new Map(shopRows.map((x) => [x.id, x.name]));
  const today = todayLocal(now);
  return rows.map((c) => {
    const seg = segs.get(c.id);
    const st = stats.get(c.id) ?? { sent: 0, clicked: 0, booked: 0 };
    return {
      id: c.id,
      shopId: c.shopIds[0] ?? "",
      shopName: shopName.get(c.shopIds[0] ?? "") ?? "",
      barber: seg ? (label.get(seg.staffId) ?? "") : "",
      days: seg ? seg.dates.map((d) => dayName(d, today)).join(", ") : "",
      status: c.status,
      statusLabel: OPENINGS_STATUS_LABEL[c.status] ?? c.status,
      createdAt: c.createdAt.toISOString(),
      sentBy: c.createdBy ? (label.get(c.createdBy) ?? "") : "",
      reviewNote: c.reviewNote,
      channels: channelsOf(c.channels),
      openAtSend: Number(c.settings?.openSlots ?? 0),
      ...st,
      waitlist: wait.filter((w) => w.campaignId === c.id).map((w) => ({ id: w.id, name: w.firstName, wantsDate: w.wantsDate, status: w.status })),
    };
  });
}

// ───────────────────────────── The live page ─────────────────────────────

export interface LiveOpenings {
  id: string;
  shop: { name: string; slug: string };
  barber: { firstName: string; slug: string | null };
  service: { slug: string; name: string };
  days: { date: string; label: string; slots: string[] }[];
  /** "open": times left. "all_booked": none left on days still to come. "over": the days have passed. */
  state: "open" | "all_booked" | "over";
}

/** A sent blast's barber and their open times now, for the link in the message. Nothing about who got it. */
export async function liveOpenings(id: string, now = new Date()): Promise<LiveOpenings | null> {
  if (!UUID.safeParse(id).success) return null;
  const [c] = await db.select().from(marketingCampaigns).where(and(eq(marketingCampaigns.id, id), eq(marketingCampaigns.kind, "openings")));
  if (!c || (c.status !== "sent" && c.status !== "sending")) return null;
  const seg = OpeningsSegmentSchema.safeParse(c.segment);
  if (!seg.success) return null;
  const [[shop], [b], service] = await Promise.all([
    db.select().from(shops).where(eq(shops.id, c.shopIds[0])),
    db.select({ firstName: staff.firstName, slug: staff.publicSlug }).from(staff).where(eq(staff.id, seg.data.staffId)),
    serviceById(seg.data.serviceId),
  ]);
  if (!shop || !b || !service) return null;
  const today = todayLocal(now);
  const dates = seg.data.dates.filter((d) => d >= today);
  const base = { id: c.id, shop: { name: shop.name, slug: shop.slug }, barber: { firstName: b.firstName, slug: b.slug }, service: { slug: service.slug, name: service.name } };
  if (!dates.length) return { ...base, days: [], state: "over" };
  const { days } = await openTimes(shop, seg.data.staffId, service.id, dates, now);
  return {
    ...base,
    days: days.map((d) => ({ date: d.date, label: dayName(d.date, today), slots: d.slots })),
    state: days.some((d) => d.slots.length) ? "open" : "all_booked",
  };
}

const WaitlistInput = z.object({
  firstName: z.string().trim().min(1, "Enter your first name").max(40),
  phone: z.string().max(30),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
});

/** "All booked, join the waitlist": the location texts them if a time with this barber opens up. */
export async function joinOpeningsWaitlist(id: string, input: unknown, now = new Date()) {
  const v = parse(WaitlistInput, input);
  const phone = normalizePhone(v.phone);
  if (!phone) throw new AppError("bad_request", "Enter a 10-digit mobile number");
  const live = await liveOpenings(id, now);
  if (!live || live.state === "over") throw notFound("These openings");
  const [c] = await db.select({ shopIds: marketingCampaigns.shopIds, segment: marketingCampaigns.segment }).from(marketingCampaigns).where(eq(marketingCampaigns.id, id));
  const seg = OpeningsSegmentSchema.parse(c.segment);
  const cols = await consentColumns();
  const [known] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.phone, phone), cols.deleted ? sql`deleted_at is null` : undefined))
    .limit(1);
  const wants = v.date && seg.dates.includes(v.date) ? v.date : null;
  await db
    .insert(openingsWaitlist)
    .values({ campaignId: id, shopId: c.shopIds[0], staffId: seg.staffId, customerId: known?.id ?? null, firstName: v.firstName, phone, wantsDate: wants, createdAt: now })
    .onConflictDoUpdate({ target: [openingsWaitlist.campaignId, openingsWaitlist.phone], set: { firstName: v.firstName, wantsDate: wants, status: "waiting" } });
  return { barber: live.barber.firstName, shop: live.shop.name };
}

/** Texts everyone waiting on this blast that times are open again, with the live link. Numbers stay hidden. */
export async function textOpeningsWaitlist(ctx: StaffContext, id: string, now = new Date()): Promise<{ texted: number }> {
  if (!mayOpenings(ctx)) throw forbidden("Sending openings needs Campaign Center: We have openings");
  const c = await openingsById(id);
  for (const s of c.shopIds) assertShopAccess(ctx, s);
  const live = await liveOpenings(id, now);
  if (!live || live.state !== "open") throw new AppError("bad_request", "There are no open times to text about right now");
  const waiting = await db.select().from(openingsWaitlist).where(and(eq(openingsWaitlist.campaignId, id), eq(openingsWaitlist.status, "waiting")));
  if (!waiting.length) throw new AppError("bad_request", "Nobody is waiting");
  const [shop] = await db.select().from(shops).where(eq(shops.id, c.shopIds[0]));
  const s = await loadMarketingSettings();
  const runAt = nextSendAt(now, shop.timezone, s);
  const body = `Ray'z ${shop.name}: a time with ${live.barber.firstName} just opened up. First come, first served: ${appBaseUrl()}/book/${shop.slug}/openings/${id}`;
  const jobs = await db.transaction(async (tx) => {
    const ids: string[] = [];
    for (const w of waiting) {
      const [j] = await tx
        .insert(notificationJobs)
        .values({ kind: "waitlist_ready", channel: "sms", to: w.phone, body, shopId: shop.id, customerId: w.customerId, runAt })
        .returning({ id: notificationJobs.id });
      ids.push(j.id);
    }
    await tx
      .update(openingsWaitlist)
      .set({ status: "texted", textedAt: now })
      .where(inArray(openingsWaitlist.id, waiting.map((w) => w.id)));
    return ids;
  });
  await processDueJobs({ now, ids: jobs });
  await audit(ctx.actor, "campaign_center.openings_waitlist_texted", "marketing_campaign", id, { texted: waiting.length }, shop.id);
  return { texted: waiting.length };
}

export async function removeFromOpeningsWaitlist(ctx: StaffContext, entryId: string) {
  if (!mayOpenings(ctx)) throw forbidden("Sending openings needs Campaign Center: We have openings");
  if (!UUID.safeParse(entryId).success) throw notFound("Waitlist entry");
  const [e] = await db.select().from(openingsWaitlist).where(eq(openingsWaitlist.id, entryId));
  if (!e) throw notFound("Waitlist entry");
  assertShopAccess(ctx, e.shopId);
  await db.update(openingsWaitlist).set({ status: "removed" }).where(eq(openingsWaitlist.id, entryId));
  await audit(ctx.actor, "campaign_center.openings_waitlist_removed", "marketing_campaign", e.campaignId, {}, e.shopId);
}

/** The locations a person can send openings from. */
export const openingsShops = (ctx: StaffContext) => openShops(ctx).filter((s) => s.status === "live");
