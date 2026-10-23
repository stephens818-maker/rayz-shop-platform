/**
 * Sends marketing. Run by the cron job (/api/cron/marketing) and the local worker. Every message is
 * one marketing_sends row whose dedupe key (campaign, client, occasion) is unique, so a second run,
 * or two at once, never sends twice. Only clients who agreed to marketing on a channel get it there,
 * never more than the brand's weekly and monthly caps, and never in quiet hours: a message due then
 * waits in the queue until quiet hours end in the location's time zone.
 */
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { clientNudges, couponCodes, marketingCampaigns, marketingLocationSettings, marketingSends, notificationJobs, promoCodes, shops, staff } from "@/db/schema";
import { issuedExpiry, uniqueCode } from "@/domain/coupons";
import {
  Channel,
  MarketingSettings,
  MarketingValues,
  SegmentSchema,
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
  triggerSettings,
} from "@/domain/marketing";
import { appBaseUrl } from "@/lib/deployment";
import { couponSuffix, marketingToken } from "@/lib/ids";
import { addDays, formatDate, todayLocal } from "@/lib/time";
import { processDueJobs } from "../notifications/queue";
import { Target, clientsOf, segmentMembers, triggerTargets } from "./audiences";
import { Contact, contactsFor } from "./consent";
import { loadMarketingSettings } from "./settings";

const DAY = 86_400_000;
export const BRAND_NAME = "Ray'z Barber Shop";

type Campaign = typeof marketingCampaigns.$inferSelect;
type Shop = typeof shops.$inferSelect;
type Promo = typeof promoCodes.$inferSelect;

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

/** Marketing this client got in the last 30 days (and Today's fill and rebook texts), for the caps. */
async function recentSends(customerId: string, now: Date, tx: DBorTx): Promise<Date[]> {
  const since = new Date(now.getTime() - 30 * DAY);
  const [a, b] = await Promise.all([
    tx
      .select({ at: marketingSends.createdAt })
      .from(marketingSends)
      .where(and(eq(marketingSends.customerId, customerId), eq(marketingSends.status, "queued"), gte(marketingSends.createdAt, since))),
    tx
      .select({ at: clientNudges.createdAt })
      .from(clientNudges)
      .where(and(eq(clientNudges.customerId, customerId), inArray(clientNudges.kind, ["fill", "rebook"]), gte(clientNudges.createdAt, since))),
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
  now: Date;
}

/** One message to one client, idempotently. */
export async function deliver(i: DeliverInput): Promise<DeliverResult> {
  const { campaign: c, shop, target: t, settings: s, now } = i;
  const key = dedupeKey(c.id, t.customerId, t.occasion);
  return db.transaction(async (tx): Promise<DeliverResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`marketing:${t.customerId}`}))`);
    const [dupe] = await tx.select({ id: marketingSends.id }).from(marketingSends).where(eq(marketingSends.dedupeKey, key)).limit(1);
    if (dupe) return { status: "dupe" } as const;
    const skip = async (reason: string): Promise<DeliverResult> => {
      if (i.recordSkips)
        await tx
          .insert(marketingSends)
          .values({ campaignId: c.id, customerId: t.customerId, shopId: shop.id, staffId: t.staffId, dedupeKey: key, status: "skipped", skipped: reason, token: marketingToken() })
          .onConflictDoNothing();
      return { status: "skipped", reason };
    };
    const reach = i.contact?.reach ?? { sms: false, email: false, push: false };
    // CAN-SPAM: no marketing email without the brand's postal address.
    const channel = pickChannel(i.channels, { ...reach, email: reach.email && !!s.address.trim() });
    if (!channel) return skip("no_consent");
    const cap = capProblem(await recentSends(t.customerId, now, tx), now, s);
    if (cap) return skip(cap);
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
            .values({ promoId: i.promo.id, code: uniqueCode(i.promo.code, (k) => couponSuffix(k)), customerId: t.customerId, campaignId: c.id, expiresOn })
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
        bookPath: bookPathFor(shop.slug, { ...t.link, coupon: code }),
        costCents: costCents(channel, s),
      })
      .onConflictDoNothing()
      .returning({ id: marketingSends.id });
    if (!send) throw new DupeRace();
    if (couponCodeId) await tx.update(couponCodes).set({ campaignId: c.id }).where(eq(couponCodes.id, couponCodeId));
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
    if (!isTriggerKey(c.trigger) || (o.keys && !o.keys.includes(c.trigger))) continue;
    try {
      const key = c.trigger;
      const targets = await triggerTargets({ key, shop, settings: triggerSettings(key, { ...c.settings, ...(l.settings ?? {}) }), clients: clients.get(shop.id) ?? [], now });
      const fresh = await unsent(c.id, targets);
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

/** The targets not already sent (one occasion per client; the first target wins). */
async function unsent(campaignId: string, targets: Target[]): Promise<Target[]> {
  const byKey = new Map<string, Target>();
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

/** The cron pass: automated campaigns, then due blasts. Delivery is the notification queue's job. */
export async function runMarketing(now = new Date()) {
  const triggers = await runTriggers(now);
  const blasts = await runBlasts(now);
  return { triggers, blasts };
}

/**
 * A test message to the person editing the campaign, on their own phone or email, with sample
 * values and a real link. Not counted in the report; quiet hours and consent don't apply because
 * it's to staff. Sent at once.
 */
export async function testSend(o: { campaign: Campaign; shop: Shop; channel: Channel; to: { staffId: string; firstName: string; phone: string | null; email: string | null }; templates?: Templates; now?: Date }) {
  const now = o.now ?? new Date();
  const s = await loadMarketingSettings();
  const to = o.channel === "sms" ? o.to.phone : o.channel === "email" ? o.to.email : null;
  if (!to) return { ok: false as const, problem: o.channel === "push" ? "Test sends go by text or email" : `Your staff profile has no ${o.channel === "sms" ? "mobile number" : "email"}` };
  const promo = await promoById(o.campaign.promoId);
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
    });
    return j;
  });
  await processDueJobs({ ids: [job.id], now });
  return { ok: true as const, to };
}