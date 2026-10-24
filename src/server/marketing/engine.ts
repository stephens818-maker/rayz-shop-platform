/**
 * Sends marketing: automated campaigns, lapsed sequences and blasts. Run by the cron job
 * (/api/cron/campaign-center) and the local worker; a barber's own outreach goes through deliver too. Every message is
 * one marketing_sends row whose dedupe key (campaign, client, occasion) is unique, so a second run,
 * or two at once, never sends twice. Only clients who agreed to marketing on a channel get it there,
 * never more than the brand's weekly and monthly caps, and never in quiet hours: a message due then
 * waits in the queue until quiet hours end in the location's time zone.
 */
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { clientNudges, couponCodes, customers, marketingCampaigns, marketingLocationSettings, marketingSends, marketingSteps, notificationJobs, promoCodes, shops, staff } from "@/db/schema";
import { issuedExpiry, uniqueCode } from "@/domain/coupons";
import {
  Channel,
  MANUAL_TRIGGERS,
  MarketingSettings,
  MarketingValues,
  SegmentSchema,
  SequenceAudienceSchema,
  SequenceSettingsSchema,
  Templates,
  TemplatesSchema,
  TriggerKey,
  capProblem,
  costCents,
  dedupeKey,
  isTriggerKey,
  nextSendAt,
  pickChannel,
  render,
  stepDue,
  triggerSettings,
} from "@/domain/marketing";
import { appBaseUrl } from "@/lib/deployment";
import { couponSuffix, marketingToken } from "@/lib/ids";
import { addDays, formatDate, todayLocal } from "@/lib/time";
import { processDueJobs } from "../notifications/queue";
import { Target, barberCards, clientsOf, segmentMembers, signedBy, triggerTargets } from "./audiences";
import { Contact, contactsFor } from "./consent";
import { loadMarketingSettings } from "./settings";

const DAY = 86_400_000;
export const BRAND_NAME = "Ray'z Barber Shop";

type Campaign = typeof marketingCampaigns.$inferSelect;
type Shop = typeof shops.$inferSelect;
type Promo = typeof promoCodes.$inferSelect;
type Step = typeof marketingSteps.$inferSelect;

export type DeliverResult = { status: "queued"; sendId: string; jobId: string; channel: Channel } | { status: "skipped"; reason: string } | { status: "dupe" };

export const templatesOf = (raw: unknown, over?: unknown): Templates => {
  const base = TemplatesSchema.parse(raw ?? {});
  const o = TemplatesSchema.partial().safeParse(over ?? {});
  if (!o.success) return base;
  return { ...base, ...Object.fromEntries(Object.entries(o.data).filter(([, v]) => typeof v === "string" && v.trim())) };
};

export const channelsOf = (raw: unknown): Channel[] => (Array.isArray(raw) ? raw.filter((c): c is Channel => c === "sms" || c === "email" || c === "push") : []);

/** The tracked link's destination: the location's booking page with the barber, service and coupon filled in. */
export function bookPathFor(shopSlug: string, o: { barber?: string | null; service?: string | null; coupon?: string | null }): string {
  const q = new URLSearchParams();
  if (o.service) q.set("service", o.service);
  if (o.barber) q.set("barber", o.barber);
  if (o.coupon) q.set("coupon", o.coupon);
  return `/book/${shopSlug}${q.size ? `?${q}` : ""}`;
}

/** A parent and their children: one phone, one inbox, so one set of caps. */
async function household(headId: string, tx: DBorTx): Promise<string[]> {
  const kids = await tx.select({ id: customers.id }).from(customers).where(eq(customers.guardianId, headId));
  return [headId, ...kids.map((k) => k.id)];
}

/** Marketing this household got in the last 30 days (and Today's fill and rebook texts), for the caps. */
async function recentSends(ids: string[], now: Date, tx: DBorTx): Promise<Date[]> {
  const since = new Date(now.getTime() - 30 * DAY);
  const [a, b] = await Promise.all([
    tx
      .select({ at: marketingSends.createdAt })
      .from(marketingSends)
      .where(and(inArray(marketingSends.customerId, ids), eq(marketingSends.status, "queued"), gte(marketingSends.createdAt, since))),
    tx
      .select({ at: clientNudges.createdAt })
      .from(clientNudges)
      .where(and(inArray(clientNudges.customerId, ids), inArray(clientNudges.kind, ["fill", "rebook"]), gte(clientNudges.createdAt, since))),
  ]);
  return [...a, ...b].map((r) => r.at);
}

/** Why the campaign's coupon can't go out, or null. */
function promoProblem(p: Promo | null | undefined, today: string): string | null {
  if (!p) return null;
  if (!p.active || (p.endsOn && p.endsOn < today) || (p.maxRedemptions != null && p.redemptions >= p.maxRedemptions)) return "no_coupon";
  return null;
}

export interface DeliverInput {
  campaign: Campaign;
  shop: Shop;
  target: Target;
  contact: Contact | undefined;
  templates: Templates;
  channels: Channel[];
  settings: MarketingSettings;
  promo: Promo | null;
  /** Blasts record clients who were skipped; automated campaigns try them again on the next run while the occasion lasts. */
  recordSkips: boolean;
  /** Lapsed sequences: the step it is. */
  stepId?: string | null;
  /** We have openings: no client gets a second openings message within this many days. */
  openingsCapDays?: number;
  now: Date;
}

/** Someone in this household got a We have openings message in the last `days` days. */
async function hadOpenings(ids: string[], days: number, now: Date, tx: DBorTx): Promise<boolean> {
  const [r] = await tx
    .select({ id: marketingSends.id })
    .from(marketingSends)
    .innerJoin(marketingCampaigns, eq(marketingCampaigns.id, marketingSends.campaignId))
    .where(
      and(
        inArray(marketingSends.customerId, ids),
        eq(marketingSends.status, "queued"),
        eq(marketingCampaigns.kind, "openings"),
        gte(marketingSends.createdAt, new Date(now.getTime() - days * DAY)),
      ),
    )
    .limit(1);
  return !!r;
}

/** One message to one client, idempotently. */
export async function deliver(i: DeliverInput): Promise<DeliverResult> {
  const { campaign: c, shop, target: t, settings: s, now } = i;
  const key = dedupeKey(c.id, t.customerId, t.occasion);
  return db.transaction(async (tx): Promise<DeliverResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`marketing:${i.contact?.householdId ?? t.customerId}`}))`);
    const [dupe] = await tx.select({ id: marketingSends.id }).from(marketingSends).where(eq(marketingSends.dedupeKey, key)).limit(1);
    if (dupe) return { status: "dupe" } as const;
    const skip = async (reason: string): Promise<DeliverResult> => {
      if (i.recordSkips)
        await tx
          .insert(marketingSends)
          .values({ campaignId: c.id, customerId: t.customerId, shopId: shop.id, staffId: t.staffId, stepId: i.stepId ?? null, dedupeKey: key, status: "skipped", skipped: reason, token: marketingToken(), createdAt: now })
          .onConflictDoNothing();
      return { status: "skipped", reason };
    };
    const reach = i.contact?.reach ?? { sms: false, email: false, push: false };
    // CAN-SPAM: no marketing email without the brand's postal address.
    const channel = pickChannel(i.channels, { ...reach, email: reach.email && !!s.address.trim() });
    if (!channel) return skip("no_consent");
    const members = await household(i.contact?.householdId ?? t.customerId, tx);
    if (members.length > 1 && (c.kind === "blast" || c.kind === "openings")) {
      const [sibling] = await tx
        .select({ id: marketingSends.id })
        .from(marketingSends)
        .where(and(eq(marketingSends.campaignId, c.id), eq(marketingSends.status, "queued"), inArray(marketingSends.customerId, members)))
        .limit(1);
      if (sibling) return skip("household");
    }
    const cap = capProblem(await recentSends(members, now, tx), now, s);
    if (cap) return skip(cap);
    if (i.openingsCapDays && (await hadOpenings(members, i.openingsCapDays, now, tx))) return skip("openings_cap");
    const today = todayLocal(now);
    const promoBad = promoProblem(i.promo, today);
    if (promoBad) return skip(promoBad);

    let code: string | null = null;
    let couponCodeId: string | null = null;
    let expiresOn: string | null = null;
    if (i.promo) {
      if (i.promo.codeMode === "unique") {
        expiresOn = issuedExpiry(today, i.promo.validDays, i.promo.endsOn, addDays);
        for (let n = 0; n < 5 && !couponCodeId; n++) {
          const [row] = await tx
            .insert(couponCodes)
            .values({ promoId: i.promo.id, code: uniqueCode(i.promo.code, (k) => couponSuffix(k)), customerId: t.customerId, campaignId: c.id, expiresOn, createdAt: now })
            .onConflictDoNothing()
            .returning({ id: couponCodes.id, code: couponCodes.code });
          if (row) [couponCodeId, code] = [row.id, row.code];
        }
        if (!couponCodeId) return skip("no_coupon");
      } else {
        code = i.promo.code;
        expiresOn = i.promo.endsOn;
      }
    }

    let barber = t.values?.barber ?? null;
    if (!barber && t.staffId) {
      const [b] = await tx.select({ n: staff.firstName }).from(staff).where(eq(staff.id, t.staffId));
      barber = b?.n ?? null;
    }
    const token = marketingToken();
    const base = appBaseUrl();
    const values: MarketingValues = {
      first_name: i.contact?.firstName || "there",
      shop: `Ray'z ${shop.name}`,
      barber: barber ?? "your barber",
      book_link: `${base}/m/${token}`,
      coupon_code: code ?? "",
      expiry: expiresOn ? formatDate(expiresOn, "MMM d") : "",
      ...t.values,
    };
    const m = render(i.templates, values, { brand: BRAND_NAME, address: s.address, unsubscribeUrl: `${base}/m/${token}/unsubscribe` });
    const contact = i.contact!;
    const to = channel === "sms" ? contact.phone! : channel === "email" ? contact.email! : contact.deviceId!;
    const [job] = await tx
      .insert(notificationJobs)
      .values({
        kind: "marketing",
        channel,
        to,
        subject: channel === "email" ? m.email.subject : channel === "push" ? m.push.title : null,
        body: channel === "sms" ? m.sms : channel === "email" ? m.email.body : m.push.body,
        shopId: shop.id,
        customerId: t.customerId,
        runAt: nextSendAt(now, shop.timezone, s),
      })
      .returning({ id: notificationJobs.id });
    const [send] = await tx
      .insert(marketingSends)
      .values({
        campaignId: c.id,
        customerId: t.customerId,
        shopId: shop.id,
        staffId: t.staffId,
        channel,
        dedupeKey: key,
        status: "queued",
        jobId: job.id,
        couponCodeId,
        token,
        bookPath: t.path ?? bookPathFor(shop.slug, { ...t.link, coupon: code }),
        costCents: costCents(channel, s),
        stepId: i.stepId ?? null,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: marketingSends.id });
    if (!send) throw new DupeRace();
    return { status: "queued", sendId: send.id, jobId: job.id, channel };
  }).catch((e): DeliverResult => {
    if (e instanceof DupeRace) return { status: "dupe" };
    throw e;
  });
}

class DupeRace extends Error {}

export interface RunStats {
  queued: number;
  skipped: number;
  failed: number;
}
const add = (a: RunStats, r: DeliverResult | "failed") => {
  if (r === "failed") a.failed++;
  else if (r.status === "queued") a.queued++;
  else if (r.status === "skipped") a.skipped++;
};

async function promoById(id: string | null, tx: DBorTx = db): Promise<Promo | null> {
  if (!id) return null;
  const [p] = await tx.select().from(promoCodes).where(eq(promoCodes.id, id));
  return p ?? null;
}

/** Automated campaigns at every location that has them on. */
export async function runTriggers(now = new Date(), o: { shopIds?: string[]; keys?: TriggerKey[] } = {}): Promise<RunStats> {
  const stats: RunStats = { queued: 0, skipped: 0, failed: 0 };
  const settings = await loadMarketingSettings();
  const on = await db
    .select({ c: marketingCampaigns, l: marketingLocationSettings, shop: shops })
    .from(marketingLocationSettings)
    .innerJoin(marketingCampaigns, eq(marketingCampaigns.id, marketingLocationSettings.campaignId))
    .innerJoin(shops, eq(shops.id, marketingLocationSettings.shopId))
    .where(
      and(
        eq(marketingLocationSettings.enabled, true),
        eq(marketingCampaigns.kind, "trigger"),
        eq(shops.status, "live"),
        o.shopIds ? inArray(shops.id, o.shopIds.length ? o.shopIds : [crypto.randomUUID()]) : undefined,
      ),
    );
  const clients = await clientsOf([...new Set(on.map((r) => r.shop.id))], now);
  for (const { c, l, shop } of on) {
    if (!isTriggerKey(c.trigger) || MANUAL_TRIGGERS.has(c.trigger) || (o.keys && !o.keys.includes(c.trigger))) continue;
    try {
      const key = c.trigger;
      const targets = await triggerTargets({ key, shop, settings: triggerSettings(key, { ...c.settings, ...(l.settings ?? {}) }), clients: clients.get(shop.id) ?? [], now });
      const fresh = key === "lapsed" || key === "win_back" ? await notInSequence(await unsent(c.id, targets)) : await unsent(c.id, targets);
      if (!fresh.length) continue;
      const contacts = await contactsFor(fresh.map((x) => x.customerId));
      const promo = await promoById(c.promoId);
      const templates = templatesOf(c.templates, l.templates);
      for (const target of fresh) {
        add(
          stats,
          await deliver({ campaign: c, shop, target, contact: contacts.get(target.customerId), templates, channels: channelsOf(c.channels), settings, promo, recordSkips: false, now }).catch((e) => {
            console.error("marketing send failed", c.trigger, (e as Error).message);
            return "failed" as const;
          }),
        );
      }
    } catch (e) {
      stats.failed++;
      console.error("marketing campaign failed", c.trigger, shop.slug, (e as Error).message);
    }
  }
  return stats;
}

/**
 * "We miss you" and win-back leave alone clients a lapsed sequence already wrote to since their
 * last visit (the occasion carries that visit's day), so nobody hears both.
 */
async function notInSequence(targets: Target[]): Promise<Target[]> {
  if (!targets.length) return targets;
  const rows = await db
    .select({ id: marketingSends.customerId, at: sql<string>`max(${marketingSends.createdAt})` })
    .from(marketingSends)
    .where(
      and(
        sql`${marketingSends.stepId} is not null`,
        eq(marketingSends.status, "queued"),
        inArray(marketingSends.customerId, [...new Set(targets.map((t) => t.customerId))]),
      ),
    )
    .groupBy(marketingSends.customerId);
  const last = new Map(rows.map((r) => [r.id, new Date(r.at).getTime()]));
  return targets.filter((t) => {
    const at = last.get(t.customerId);
    const since = t.occasion.split(":")[1];
    return at === undefined || !since || at < new Date(`${since}T00:00:00Z`).getTime();
  });
}

/** The targets not already sent (one occasion per client; the first target wins). */
export async function unsent<T extends Target>(campaignId: string, targets: T[]): Promise<T[]> {
  const byKey = new Map<string, T>();
  for (const t of targets) {
    const k = dedupeKey(campaignId, t.customerId, t.occasion);
    if (!byKey.has(k)) byKey.set(k, t);
  }
  if (!byKey.size) return [];
  const keys = [...byKey.keys()];
  const done = new Set<string>();
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await db.select({ k: marketingSends.dedupeKey }).from(marketingSends).where(inArray(marketingSends.dedupeKey, keys.slice(i, i + 1000)));
    for (const r of rows) done.add(r.k);
  }
  return keys.filter((k) => !done.has(k)).map((k) => byKey.get(k)!);
}

/** A blast stuck "sending" this long (the run died) is picked up again; the dedupe keys keep it from sending twice. */
const STALE_SENDING_MS = 10 * 60_000;

/** Blasts that are due. Each is claimed by moving it to "sending", so two runs don't both work through it. */
export async function runBlasts(now = new Date(), o: { ids?: string[] } = {}): Promise<RunStats> {
  const stats: RunStats = { queued: 0, skipped: 0, failed: 0 };
  const claimed = await db
    .update(marketingCampaigns)
    .set({ status: "sending", updatedAt: now })
    .where(
      and(
        eq(marketingCampaigns.kind, "blast"),
        lte(marketingCampaigns.scheduledAt, now),
        or(eq(marketingCampaigns.status, "scheduled"), and(eq(marketingCampaigns.status, "sending"), lte(marketingCampaigns.updatedAt, new Date(now.getTime() - STALE_SENDING_MS)))),
        o.ids ? inArray(marketingCampaigns.id, o.ids.length ? o.ids : [crypto.randomUUID()]) : undefined,
      ),
    )
    .returning();
  if (!claimed.length) return stats;
  const settings = await loadMarketingSettings();
  const allShops = await db.select().from(shops);
  const shopById = new Map(allShops.map((x) => [x.id, x]));
  for (const c of claimed) {
    try {
      const seg = SegmentSchema.parse(c.segment ?? {});
      const scope = c.shopIds.length ? c.shopIds : allShops.filter((x) => x.status !== "archived").map((x) => x.id);
      const members = await segmentMembers(seg, scope, now);
      const contacts = await contactsFor(members.map((m) => m.customerId));
      const promo = await promoById(c.promoId);
      const templates = templatesOf(c.templates);
      const channels = seg.channel === "any" ? channelsOf(c.channels) : channelsOf(c.channels).filter((x) => x === seg.channel);
      for (const [n, m] of members.entries()) {
        if (n && n % 200 === 0) await db.update(marketingCampaigns).set({ updatedAt: new Date() }).where(eq(marketingCampaigns.id, c.id));
        const shop = shopById.get(m.shopId);
        if (!shop) continue;
        add(
          stats,
          await deliver({
            campaign: c,
            shop,
            target: { customerId: m.customerId, shopId: m.shopId, staffId: m.staffId, occasion: "blast" },
            contact: contacts.get(m.customerId),
            templates,
            channels,
            settings,
            promo,
            recordSkips: true,
            now,
          }).catch((e) => {
            console.error("marketing blast send failed", c.id, (e as Error).message);
            return "failed" as const;
          }),
        );
      }
      await db.update(marketingCampaigns).set({ status: "sent", sentAt: now, updatedAt: now }).where(eq(marketingCampaigns.id, c.id));
    } catch (e) {
      stats.failed++;
      console.error("marketing blast failed", c.id, (e as Error).message);
    }
  }
  return stats;
}

export interface SequenceTarget extends Target {
  stepId: string;
}

export const stepsOf = (campaignId: string, tx: DBorTx = db) => tx.select().from(marketingSteps).where(eq(marketingSteps.campaignId, campaignId)).orderBy(marketingSteps.afterDays);

/**
 * Who a lapsed sequence writes to now, and with which step: clients of its locations (and barbers)
 * whose last visit has reached a step, with nothing booked since, before the sequence stops. One
 * occasion per step per lapse (the last visit's day), so each step goes once and a client who
 * comes back and lapses again starts over. Signed by the client's barber, booking with them.
 */
export async function sequenceTargets(c: Pick<Campaign, "segment" | "settings" | "shopIds">, steps: readonly Pick<Step, "id" | "afterDays">[], scope: readonly string[], now: Date): Promise<SequenceTarget[]> {
  if (!steps.length) return [];
  const aud = SequenceAudienceSchema.parse(c.segment ?? {});
  const { stopAfterDays } = SequenceSettingsSchema.parse(c.settings ?? {});
  const first = Math.min(...steps.map((x) => x.afterDays));
  const seg = SegmentSchema.parse({ staffIds: aud.staffIds, barberMatch: aud.barberMatch, notBooked: true, lastVisitOverDays: first, lastVisitWithinDays: stopAfterDays });
  const shopIds = c.shopIds.length ? c.shopIds.filter((s) => scope.includes(s)) : [...scope];
  const members = await segmentMembers(seg, shopIds, now);
  const cards = await barberCards(members.flatMap((m) => (m.staffId ? [m.staffId] : [])));
  return members.flatMap((m) => {
    if (!m.lastAt) return [];
    const step = stepDue(steps, Math.floor((now.getTime() - m.lastAt.getTime()) / DAY), stopAfterDays);
    if (!step) return [];
    const lastDay = m.lastAt.toISOString().slice(0, 10);
    return [{ customerId: m.customerId, shopId: m.shopId, staffId: m.staffId, occasion: `seq:${lastDay}:${step.id}`, stepId: step.id, ...signedBy(m.staffId ? cards.get(m.staffId) : undefined, m.shopId) }];
  });
}

/** Lapsed sequences that are on, at live locations. */
export async function runSequences(now = new Date(), o: { ids?: string[] } = {}): Promise<RunStats> {
  const stats: RunStats = { queued: 0, skipped: 0, failed: 0 };
  const list = await db
    .select()
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.kind, "sequence"), eq(marketingCampaigns.enabled, true), o.ids ? inArray(marketingCampaigns.id, o.ids.length ? o.ids : [crypto.randomUUID()]) : undefined));
  if (!list.length) return stats;
  const settings = await loadMarketingSettings();
  const live = await db.select().from(shops).where(eq(shops.status, "live"));
  const shopById = new Map(live.map((x) => [x.id, x]));
  for (const c of list) {
    try {
      const steps = await stepsOf(c.id);
      const fresh = await unsent(c.id, await sequenceTargets(c, steps, [...shopById.keys()], now));
      if (!fresh.length) continue;
      const contacts = await contactsFor(fresh.map((x) => x.customerId));
      const promos = new Map<string, Promo | null>();
      for (const target of fresh) {
        const step = steps.find((x) => x.id === target.stepId)!;
        if (step.promoId && !promos.has(step.promoId)) promos.set(step.promoId, await promoById(step.promoId));
        add(
          stats,
          await deliver({
            campaign: c,
            shop: shopById.get(target.shopId)!,
            target,
            contact: contacts.get(target.customerId),
            templates: templatesOf(step.templates),
            channels: channelsOf(c.channels),
            settings,
            promo: step.promoId ? (promos.get(step.promoId) ?? null) : null,
            recordSkips: false,
            stepId: step.id,
            now,
          }).catch((e) => {
            console.error("marketing sequence send failed", c.id, (e as Error).message);
            return "failed" as const;
          }),
        );
      }
    } catch (e) {
      stats.failed++;
      console.error("marketing sequence failed", c.id, (e as Error).message);
    }
  }
  return stats;
}

/** The cron pass: automated campaigns, lapsed sequences, then due blasts. Delivery is the notification queue's job. */
export async function runMarketing(now = new Date()) {
  const triggers = await runTriggers(now);
  const sequences = await runSequences(now);
  const blasts = await runBlasts(now);
  return { triggers, sequences, blasts };
}

/**
 * A test message to the person editing the campaign, on their own phone or email, with sample
 * values and a real link. Not counted in the report; quiet hours and consent don't apply because
 * it's to staff. Sent at once.
 */
export async function testSend(o: {
  campaign: Campaign;
  shop: Shop;
  channel: Channel;
  to: { staffId: string; firstName: string; phone: string | null; email: string | null };
  templates?: Templates;
  /** A sequence step's coupon instead of the campaign's. */
  promo?: Promo | null;
  now?: Date;
}) {
  const now = o.now ?? new Date();
  const s = await loadMarketingSettings();
  const to = o.channel === "sms" ? o.to.phone : o.channel === "email" ? o.to.email : null;
  if (!to) return { ok: false as const, problem: o.channel === "push" ? "Test sends go by text or email" : `Your staff profile has no ${o.channel === "sms" ? "mobile number" : "email"}` };
  const promo = o.promo !== undefined ? o.promo : await promoById(o.campaign.promoId);
  const token = marketingToken();
  const base = appBaseUrl();
  const code = promo ? (promo.codeMode === "unique" ? uniqueCode(promo.code, () => "TEST00") : promo.code) : "";
  const values: MarketingValues = {
    first_name: o.to.firstName,
    shop: `Ray'z ${o.shop.name}`,
    barber: o.to.firstName,
    book_link: `${base}/m/${token}`,
    coupon_code: code,
    expiry: promo ? formatDate(issuedExpiry(todayLocal(now), promo.validDays, promo.endsOn, addDays) ?? addDays(todayLocal(now), 30), "MMM d") : "",
  };
  const m = render(o.templates ?? templatesOf(o.campaign.templates), values, { brand: BRAND_NAME, address: s.address || "(your postal address goes here)", unsubscribeUrl: `${base}/m/${token}/unsubscribe` });
  const [job] = await db.transaction(async (tx) => {
    const j = await tx
      .insert(notificationJobs)
      .values({ kind: "marketing", channel: o.channel, to, subject: o.channel === "email" ? `[Test] ${m.email.subject}` : null, body: o.channel === "sms" ? `[Test] ${m.sms}` : m.email.body, shopId: o.shop.id, runAt: now })
      .returning({ id: notificationJobs.id });
    await tx.insert(marketingSends).values({
      campaignId: o.campaign.id,
      shopId: o.shop.id,
      staffId: o.to.staffId,
      channel: o.channel,
      dedupeKey: `test:${o.campaign.id}:${token}`,
      status: "test",
      jobId: j[0].id,
      token,
      bookPath: bookPathFor(o.shop.slug, { coupon: code || null }),
      createdAt: now,
    });
    return j;
  });
  await processDueJobs({ ids: [job.id], now });
  return { ok: true as const, to };
}