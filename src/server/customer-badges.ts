import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  marketingCampaigns,
  marketingLocationSettings,
  marketingSends,
  promoCodes,
  shops,
  staff,
} from "@/db/schema";
import {
  customKey,
  type BadgeKey,
  type BadgeProgressFacts,
  type StoredBadge,
} from "@/domain/badges";
import {
  badgeMessage,
  customerView,
  customerWording,
  notifies,
  type BadgeChange,
  type CustomerBadges,
} from "@/domain/customer-badges";
import { triggerSettings } from "@/domain/marketing";
import { appBaseUrl } from "@/lib/deployment";
import { listCustomBadges, loadBadgeSettings } from "./badge-settings";
import { storedBadges } from "./badges";
import { ensureTriggerCampaigns } from "./marketing/campaigns";
import { contactsFor } from "./marketing/consent";
import {
  bookPathFor,
  channelsOf,
  deliver,
  templatesOf,
} from "./marketing/engine";
import { loadMarketingSettings } from "./marketing/settings";

const DAY = 86_400_000;
/** A notice nobody could send within this long is dropped: old news. */
const NOTICE_DAYS = 3;
const rowsOf = async <T>(q: Promise<unknown>) => (await q) as unknown as T[];

/** Where a client books: their home location (or where they were last), with their barber. */
async function homeOf(customerId: string) {
  const [c] = await db
    .select({
      homeShopId: customers.homeShopId,
      barber: staff.publicSlug,
      barberActive: staff.active,
      barberId: customers.preferredStaffId,
    })
    .from(customers)
    .leftJoin(staff, eq(staff.id, customers.preferredStaffId))
    .where(eq(customers.id, customerId));
  let shopId = c?.homeShopId ?? null;
  if (!shopId) {
    const [last] = await rowsOf<{ shop_id: string }>(
      db.execute(
        sql`select shop_id from appointments where customer_id = ${customerId}::uuid and status = 'completed' order by starts_at desc limit 1`,
      ),
    );
    shopId = last?.shop_id ?? null;
  }
  const [shop] = shopId
    ? await db.select().from(shops).where(eq(shops.id, shopId))
    : [];
  return {
    shop: shop ?? null,
    barber: c?.barberActive ? c.barber : null,
    staffId: c?.barberActive ? c.barberId : null,
  };
}

/** The customer's own badges and progress: only what the brand shows customers. */
export async function customerBadges(
  customerId: string,
  now = new Date(),
): Promise<CustomerBadges> {
  const [stored, home] = await Promise.all([
    storedBadges([customerId], now),
    homeOf(customerId),
  ]);
  const [settings, custom] = await Promise.all([
    loadBadgeSettings(home.shop?.id),
    listCustomBadges({ active: true, shopId: home.shop?.id }),
  ]);
  const [row] = await rowsOf<{
    since: Record<string, string>;
    progress: BadgeProgressFacts | Record<string, never>;
  }>(
    db.execute(
      sql`select since, progress from client_badges where customer_id = ${customerId}::uuid`,
    ),
  );
  const progress =
    row?.progress && "visits" in row.progress
      ? (row.progress as BadgeProgressFacts)
      : null;
  const bookUrl = `${appBaseUrl()}${home.shop && home.shop.status === "live" ? bookPathFor(home.shop.slug, { barber: home.barber }) : "/book"}`;
  return customerView(stored.get(customerId) ?? [], {
    since: row?.since ?? {},
    progress,
    settings,
    custom,
    bookUrl,
  });
}

export interface NoticeStats {
  queued: number;
  skipped: number;
}

const TIER_RANK: Record<string, number> = { bronze: 1, silver: 2, gold: 3 };

/**
 * Badge news: a message for each badge a customer earned or lost that they can see and the brand
 * messages about, through the Campaign Center's "Badge news" automation at their location. So it
 * only goes where that's on, on a channel they agreed to marketing on, within the brand's caps
 * and this campaign's own one-per-N-days, and never in quiet hours.
 */
export async function sendBadgeNotices(
  now = new Date(),
  o: { limit?: number } = {},
): Promise<NoticeStats> {
  const stats: NoticeStats = { queued: 0, skipped: 0 };
  await db.execute(sql`update client_badge_notices set status = 'skipped', reason = 'stale', handled_at = now()
    where status = 'pending' and created_at < ${new Date(now.getTime() - NOTICE_DAYS * DAY).toISOString()}`);
  const pending = await rowsOf<{
    id: string;
    customer_id: string;
    badge_key: string;
    change: BadgeChange;
    occurred_on: string;
  }>(
    db.execute(sql`select id, customer_id, badge_key, change, to_char(occurred_on, 'YYYY-MM-DD') occurred_on from client_badge_notices
      where status = 'pending' order by created_at, (change = 'lost'), id limit ${o.limit ?? 500}`),
  );
  if (!pending.length) return stats;
  await ensureTriggerCampaigns();
  const [[campaign], settings, badgeSettings, custom] = await Promise.all([
    db
      .select()
      .from(marketingCampaigns)
      .where(
        and(
          eq(marketingCampaigns.kind, "trigger"),
          eq(marketingCampaigns.trigger, "badge_news"),
        ),
      ),
    loadMarketingSettings(),
    loadBadgeSettings(),
    listCustomBadges({ active: true }),
  ]);
  const customBy = new Map(custom.map((c) => [customKey(c.id), c]));
  const [promo] = campaign.promoId
    ? await db
        .select()
        .from(promoCodes)
        .where(eq(promoCodes.id, campaign.promoId))
    : [];
  const done = async (
    id: string,
    status: "queued" | "skipped",
    reason: string | null,
    sendId: string | null = null,
  ) => {
    await db.execute(
      sql`update client_badge_notices set status = ${status}, reason = ${reason}, send_id = ${sendId}::uuid, handled_at = now() where id = ${id}::uuid`,
    );
    stats[status]++;
  };
  const contacts = await contactsFor([
    ...new Set(pending.map((p) => p.customer_id)),
  ]);
  const current = await storedBadges(
    pending.map((p) => p.customer_id),
    now,
  );
  for (const n of pending) {
    const has = current.get(n.customer_id) ?? [];
    const keys = new Set(has.map((b) => b.k));
    if (
      n.change === "earned" ? !keys.has(n.badge_key) : keys.has(n.badge_key)
    ) {
      await done(n.id, "skipped", "no_longer");
      continue;
    }
    if (
      n.change === "lost" &&
      TIER_RANK[n.badge_key] &&
      [...keys].some((k) => (TIER_RANK[k] ?? 0) > TIER_RANK[n.badge_key])
    ) {
      await done(n.id, "skipped", "moved_up");
      continue;
    }
    const c = customBy.get(n.badge_key);
    if (!notifies(badgeSettings, n.badge_key, n.change, c)) {
      await done(n.id, "skipped", "off");
      continue;
    }
    const home = await homeOf(n.customer_id);
    if (!home.shop || home.shop.status !== "live") {
      await done(n.id, "skipped", "no_location");
      continue;
    }
    const [loc] = await db
      .select()
      .from(marketingLocationSettings)
      .where(
        and(
          eq(marketingLocationSettings.campaignId, campaign.id),
          eq(marketingLocationSettings.shopId, home.shop.id),
        ),
      );
    if (!loc?.enabled) {
      await done(n.id, "skipped", "off_at_location");
      continue;
    }
    const capDays = triggerSettings("badge_news", {
      ...campaign.settings,
      ...(loc.settings ?? {}),
    }).capDays;
    const [recent] = await db
      .select({ id: marketingSends.id })
      .from(marketingSends)
      .where(
        and(
          eq(marketingSends.campaignId, campaign.id),
          eq(marketingSends.customerId, n.customer_id),
          eq(marketingSends.status, "queued"),
          gte(
            marketingSends.createdAt,
            new Date(now.getTime() - capDays * DAY),
          ),
        ),
      )
      .limit(1);
    if (recent) {
      await done(n.id, "skipped", "badge_cap");
      continue;
    }
    const stored: StoredBadge | undefined = has.find(
      (b) => b.k === n.badge_key,
    );
    const w = c
      ? { name: c.label, text: c.tooltip || c.label }
      : customerWording(n.badge_key as BadgeKey, stored?.d ?? {});
    const r = await deliver({
      campaign,
      shop: home.shop,
      target: {
        customerId: n.customer_id,
        shopId: home.shop.id,
        staffId: home.staffId,
        occasion: `${n.badge_key}:${n.change}:${n.occurred_on}`,
        values: {
          badge: w.name,
          badge_message: badgeMessage(
            n.badge_key,
            n.change,
            w.name,
            n.change === "earned" ? w.text : "",
          ),
        },
        link: { barber: home.barber },
      },
      contact: contacts.get(n.customer_id),
      templates: templatesOf(campaign.templates, loc.templates),
      channels: channelsOf(campaign.channels),
      settings,
      promo: promo ?? null,
      recordSkips: true,
      now,
    });
    if (r.status === "queued") await done(n.id, "queued", null, r.sendId);
    else await done(n.id, "skipped", r.status === "dupe" ? "dupe" : r.reason);
  }
  return stats;
}
