/**
 * A barber's own lapsed clients ("Campaign Center: own lapsed clients"): the clients whose primary
 * barber they are (most recent barber when preferred barbers are hidden from them), with nothing
 * booked since their last visit, two weeks to a year ago. They see a first name and last initial,
 * the last visit and how they'd hear, never a phone number or email, and can send the brand's
 * "From your barber" message, signed with their name and booking with them. It goes out like any
 * campaign: only to clients who agreed, outside quiet hours, within the frequency limits, once per
 * lapse, and only where the location has it switched on.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns, marketingLocationSettings, marketingSends, promoCodes, shops } from "@/db/schema";
import { Channel, LAPSED_BUCKETS, LAPSED_MAX_DAYS, SKIP_LABEL, bucketOf, pickChannel, triggerSettings } from "@/domain/marketing";
import { startOfLocalDay, todayLocal } from "@/lib/time";
import { audit } from "../audit";
import { StaffContext, assertCan, openShops } from "../auth/staff";
import { clientPolicy } from "../client-privacy";
import { AppError, forbidden } from "../errors";
import { processDueJobs } from "../notifications/queue";
import { BOOKED_SINCE, barberCards, signedBy } from "./audiences";
import { ensureTriggerCampaigns } from "./campaigns";
import { consentColumns, contactsFor } from "./consent";
import { DeliverResult, channelsOf, deliver, templatesOf } from "./engine";
import { loadMarketingSettings } from "./settings";

const DAY = 86_400_000;
/** The list starts at two weeks, the first lapsed bucket. */
const LIST_FROM_DAYS = 14;

export interface MyClient {
  customerId: string;
  /** First name and last initial. */
  name: string;
  shopId: string;
  shopName: string;
  lastVisit: Date;
  sinceDays: number;
  bucket: string;
  visits: number;
  /** How they'd get it, or null when they haven't agreed to marketing on any of the campaign's channels. */
  channel: Channel | null;
  /** This barber already sent them the message since their last visit. */
  sentAt: Date | null;
  /** Why it can't be sent now, or null. */
  blocked: string | null;
}

export interface MyClients {
  campaignId: string;
  clients: MyClient[];
  minDays: number;
  maxPerDay: number;
  sentToday: number;
  /** Their locations, and whether each lets barbers send it. */
  shops: { id: string; name: string; on: boolean }[];
  /** "primary" or "recent": who counts as their client. */
  match: "primary" | "recent";
}

async function outreachCampaign() {
  await ensureTriggerCampaigns();
  const [c] = await db
    .select()
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.kind, "trigger"), eq(marketingCampaigns.trigger, "barber_outreach")));
  return c;
}

const initial = (s: string | null) => (s?.trim() ? ` ${s.trim()[0].toUpperCase()}.` : "");

export async function myLapsedClients(ctx: StaffContext, now = new Date()): Promise<MyClients> {
  assertCan(ctx, "campaign_center.own_clients", "Seeing your lapsed clients needs Campaign Center: own lapsed clients");
  const c = await outreachCampaign();
  const mine = openShops(ctx);
  const ids = mine.map((s) => s.id);
  const loc = ids.length ? await db.select().from(marketingLocationSettings).where(and(eq(marketingLocationSettings.campaignId, c.id), inArray(marketingLocationSettings.shopId, ids))) : [];
  const set = triggerSettings("barber_outreach", c.settings);
  const policy = await clientPolicy(ctx);
  const match = policy.level("preferred_barber") === "hidden" ? "recent" : "primary";
  const me = ctx.staff.id;
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  const inShops = sql`(${sql.join(ids.length ? ids.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;
  const rows = ids.length
    ? ((await db.execute(sql`
        with v as (
          select a.customer_id, count(*)::int n, max(a.starts_at) last_at,
            (array_agg(a.shop_id order by a.starts_at desc))[1] last_shop,
            (array_agg(a.staff_id order by a.starts_at desc))[1] last_staff
          from appointments a where a.status = 'completed' and a.customer_id is not null
          group by a.customer_id
        )
        select c.id, c.first_name, c.last_name, v.n, v.last_at, v.last_shop
        from customers c join v on v.customer_id = c.id
        where v.last_shop in ${inShops}
          and ${match === "primary" ? sql`coalesce(c.preferred_staff_id, v.last_staff)` : sql`v.last_staff`} = ${me}
          and v.last_at < ${ago(LIST_FROM_DAYS)} and v.last_at >= ${ago(LAPSED_MAX_DAYS)}
          and not ${BOOKED_SINCE}
        order by v.last_at desc`)) as unknown as { id: string; first_name: string; last_name: string | null; n: number; last_at: string | Date; last_shop: string }[])
    : [];
  const deleted = rows.length ? await deletedOf(rows.map((r) => r.id)) : new Set<string>();
  const live = rows.filter((r) => !deleted.has(r.id));
  const [contacts, sent, settings, today] = await Promise.all([
    contactsFor(live.map((r) => r.id)),
    live.length
      ? db
          .select({ customerId: marketingSends.customerId, at: marketingSends.createdAt, status: marketingSends.status })
          .from(marketingSends)
          .where(and(eq(marketingSends.campaignId, c.id), eq(marketingSends.staffId, me), inArray(marketingSends.customerId, live.map((r) => r.id))))
      : [],
    loadMarketingSettings(),
    sentTodayBy(c.id, me, now),
  ]);
  const channels = channelsOf(c.channels);
  const on = new Set(loc.filter((l) => l.enabled).map((l) => l.shopId));
  const shopName = new Map(mine.map((s) => [s.id, s.name]));
  const clients = live.map((r): MyClient => {
    const lastVisit = new Date(r.last_at);
    const sinceDays = Math.floor((now.getTime() - lastVisit.getTime()) / DAY);
    const reach = contacts.get(r.id)?.reach;
    const channel = reach ? pickChannel(channels, { ...reach, email: reach.email && !!settings.address.trim() }) : null;
    const sentAt = sent.filter((x) => x.customerId === r.id && x.status === "queued" && x.at >= lastVisit).sort((a, b) => b.at.getTime() - a.at.getTime())[0]?.at ?? null;
    const blocked = !on.has(r.last_shop)
      ? `${shopName.get(r.last_shop) ?? "This location"} hasn't switched on "From your barber"`
      : sentAt
        ? "You already sent it since their last visit"
        : sinceDays < set.minDays
          ? `Too soon: the brand allows it after ${set.minDays} days`
          : !channel
            ? SKIP_LABEL.no_consent
            : null;
    return {
      customerId: r.id,
      name: `${r.first_name}${initial(r.last_name)}`,
      shopId: r.last_shop,
      shopName: shopName.get(r.last_shop) ?? "",
      lastVisit,
      sinceDays,
      bucket: LAPSED_BUCKETS[bucketOf(sinceDays)]?.label ?? "",
      visits: r.n,
      channel,
      sentAt,
      blocked,
    };
  });
  return { campaignId: c.id, clients, minDays: set.minDays, maxPerDay: set.maxPerDay, sentToday: today, shops: mine.map((s) => ({ id: s.id, name: s.name, on: on.has(s.id) })), match };
}

async function deletedOf(ids: string[]): Promise<Set<string>> {
  if (!(await consentColumns()).deleted) return new Set();
  const rows = (await db.execute(sql`select id from customers where deleted_at is not null and id in (${sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  )})`)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Messages this barber sent today (the location's day where they work, the brand's day otherwise). */
async function sentTodayBy(campaignId: string, staffId: string, now: Date) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(marketingSends)
    .where(and(eq(marketingSends.campaignId, campaignId), eq(marketingSends.staffId, staffId), eq(marketingSends.status, "queued"), gte(marketingSends.createdAt, startOfLocalDay(todayLocal(now)))));
  return r?.n ?? 0;
}

export interface OutreachResult {
  queued: number;
  skipped: { reason: string; count: number }[];
}

/** Sends "From your barber" to these of their own lapsed clients. Anyone else, or a blocked client, is refused before anything goes. */
export async function sendToMyClients(ctx: StaffContext, customerIds: readonly string[], now = new Date()): Promise<OutreachResult> {
  const want = [...new Set(customerIds)];
  if (!want.length) throw new AppError("bad_request", "Pick at least one client");
  const list = await myLapsedClients(ctx, now);
  const byId = new Map(list.clients.map((x) => [x.customerId, x]));
  if (want.some((id) => !byId.has(id))) throw forbidden("You can only message your own lapsed clients");
  const blocked = want.map((id) => byId.get(id)!).filter((x) => x.blocked);
  if (blocked.length) throw new AppError("bad_request", `${blocked[0].name}: ${blocked[0].blocked}`);
  const left = list.maxPerDay - list.sentToday;
  if (want.length > left) throw new AppError("bad_request", left > 0 ? `You can message ${left} more client${left === 1 ? "" : "s"} today` : `You've reached today's limit of ${list.maxPerDay}`);

  const [c] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, list.campaignId));
  const shopIds = [...new Set(want.map((id) => byId.get(id)!.shopId))];
  const [shopRows, loc, contacts, cards, settings] = await Promise.all([
    db.select().from(shops).where(inArray(shops.id, shopIds)),
    db.select().from(marketingLocationSettings).where(and(eq(marketingLocationSettings.campaignId, c.id), inArray(marketingLocationSettings.shopId, shopIds))),
    contactsFor(want),
    barberCards([ctx.staff.id]),
    loadMarketingSettings(),
  ]);
  const [promo] = c.promoId ? await db.select().from(promoCodes).where(eq(promoCodes.id, c.promoId)) : [];
  const tally = new Map<string, number>();
  let queued = 0;
  const jobs: string[] = [];
  for (const id of want) {
    const x = byId.get(id)!;
    const shop = shopRows.find((s) => s.id === x.shopId)!;
    const l = loc.find((y) => y.shopId === x.shopId);
    const r: DeliverResult = await deliver({
      campaign: c,
      shop,
      target: { customerId: id, shopId: x.shopId, staffId: ctx.staff.id, occasion: `barber:${x.lastVisit.toISOString().slice(0, 10)}`, ...signedBy(cards.get(ctx.staff.id), x.shopId) },
      contact: contacts.get(id),
      templates: templatesOf(c.templates, l?.templates),
      channels: channelsOf(c.channels),
      settings,
      promo: promo ?? null,
      recordSkips: false,
      now,
    });
    if (r.status === "queued") {
      queued++;
      jobs.push(r.jobId);
    } else {
      const reason = r.status === "dupe" ? "Already sent" : (SKIP_LABEL[r.reason] ?? r.reason);
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
  }
  if (jobs.length) await processDueJobs({ now, ids: jobs });
  const skipped = [...tally].map(([reason, count]) => ({ reason, count }));
  await audit(ctx.actor, "campaign_center.own_clients_sent", "marketing_campaign", c.id, { picked: want.length, queued, skipped }, shopIds.length === 1 ? shopIds[0] : null);
  return { queued, skipped };
}
