import "server-only";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, notificationJobs, shops } from "@/db/schema";
import { costCents } from "@/domain/marketing";
import { CLIENT_MESSAGE_KINDS, DELIVERY_LABEL, MESSAGE_KIND_LABEL, OPT_OUT_REASON, deliveryState, type DeliveryState } from "@/domain/notification-delivery";
import type { StaffContext } from "./auth/staff";
import { clientPolicy } from "./client-privacy";
import { loadMarketingSettings } from "./marketing/settings";
import { inShops } from "./tenant";

const jobShop = sql`coalesce(${notificationJobs.shopId}, ${appointments.shopId})`;

/** The shops whose messages this person sees: their current shop, their shops, or (brand-wide) all. */
export function messageScope(ctx: Pick<StaffContext, "brandWide" | "currentShopId" | "shopIds">): SQL | undefined {
  return ctx.brandWide && !ctx.currentShopId ? undefined : inShops({ shopIds: ctx.currentShopId ? [ctx.currentShopId] : ctx.shopIds }, jobShop);
}

export interface MessageLine {
  id: string;
  kind: string;
  label: string;
  channel: string;
  /** The number or email as this person may see it (masked or hidden by their client field rules). */
  to: string;
  state: DeliveryState;
  stateLabel: string;
  at: Date;
  shop: string | null;
  error: string | null;
}

/**
 * Messages sent (or held back) to one client or about one appointment, newest first, in the viewer's
 * shops. No message text: only what it was, the channel, and where it got to.
 */
export async function messageHistory(ctx: StaffContext, by: { customerId: string } | { appointmentId: string }, limit = 25): Promise<MessageLine[]> {
  const policy = await clientPolicy(ctx);
  const rows = await db
    .select({ j: notificationJobs, shop: shops.name })
    .from(notificationJobs)
    .leftJoin(appointments, eq(appointments.id, notificationJobs.appointmentId))
    .leftJoin(shops, eq(shops.id, jobShop))
    .where(
      and(
        "customerId" in by ? eq(notificationJobs.customerId, by.customerId) : eq(notificationJobs.appointmentId, by.appointmentId),
        inArray(notificationJobs.kind, [...CLIENT_MESSAGE_KINDS].filter((k) => k !== "otp")),
        messageScope(ctx),
      ),
    )
    .orderBy(desc(notificationJobs.runAt))
    .limit(limit);
  return rows.map(({ j, shop }) => {
    const state = deliveryState(j);
    return {
      id: j.id,
      kind: j.kind,
      label: MESSAGE_KIND_LABEL[j.kind] ?? j.kind,
      channel: j.channel,
      to: policy.show(j.channel === "email" ? "email" : "phone", j.to) ?? "hidden",
      state,
      stateLabel: DELIVERY_LABEL[state],
      at: j.sentAt ?? j.runAt,
      shop,
      error: state === "failed" || state === "opted_out" ? j.lastError : null,
    };
  });
}

export interface ShopChannelRow {
  shopId: string | null;
  shop: string;
  channel: string;
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  optedOut: number;
  notSent: number;
  /** Text segments sent (160 plain characters, or 70 with emoji or accents; longer texts are split at 153 / 67). */
  segments: number;
  costCents: number;
}

/**
 * The notifications report: messages to clients and staff by shop and channel since a date, where
 * they got to, and the estimated cost at Campaign Center's per-message rates.
 */
export async function notificationsByShop(ctx: StaffContext, since: Date): Promise<ShopChannelRow[]> {
  const optOut = Object.values(OPT_OUT_REASON);
  const unicode = sql`${notificationJobs.body} ~ '[^\\x0A\\x0D\\x20-\\x7E]'`;
  const len = sql`char_length(${notificationJobs.body})`;
  const rows = await db
    .select({
      shopId: sql<string | null>`${jobShop}`,
      shop: sql<string>`coalesce(${shops.name}, 'Brand')`,
      channel: notificationJobs.channel,
      total: sql<number>`count(*)::int`,
      queued: sql<number>`count(*) filter (where ${notificationJobs.status} = 'pending')::int`,
      sent: sql<number>`count(*) filter (where ${notificationJobs.status} = 'sent' and ${notificationJobs.deliveredAt} is null)::int`,
      delivered: sql<number>`count(*) filter (where ${notificationJobs.status} = 'sent' and ${notificationJobs.deliveredAt} is not null)::int`,
      failed: sql<number>`count(*) filter (where ${notificationJobs.status} = 'failed')::int`,
      optedOut: sql<number>`count(*) filter (where ${notificationJobs.status} = 'suppressed' and ${notificationJobs.lastError} in ${optOut})::int`,
      notSent: sql<number>`count(*) filter (where ${notificationJobs.status} = 'suppressed' and (${notificationJobs.lastError} is null or ${notificationJobs.lastError} not in ${optOut}))::int`,
      segments: sql<number>`coalesce(sum(case when ${notificationJobs.channel} = 'sms' and ${notificationJobs.status} = 'sent' then
        case when ${unicode} then (case when ${len} <= 70 then 1 else ceil(${len} / 67.0) end)
             else (case when ${len} <= 160 then 1 else ceil(${len} / 153.0) end) end
        else 0 end), 0)::int`,
    })
    .from(notificationJobs)
    .leftJoin(appointments, eq(appointments.id, notificationJobs.appointmentId))
    .leftJoin(shops, eq(shops.id, jobShop))
    .where(and(gte(notificationJobs.runAt, since), messageScope(ctx)))
    .groupBy(jobShop, shops.name, notificationJobs.channel)
    .orderBy(sql`coalesce(${shops.name}, 'Brand')`, notificationJobs.channel);
  const rates = await loadMarketingSettings();
  return rows.map((r) => {
    const sentCount = r.sent + r.delivered;
    const cost = r.channel === "sms" ? r.segments * costCents("sms", rates) : r.channel === "email" ? sentCount * costCents("email", rates) : r.channel === "push" ? sentCount * costCents("push", rates) : 0;
    return { ...r, costCents: Math.round(cost * 100) / 100 };
  });
}
