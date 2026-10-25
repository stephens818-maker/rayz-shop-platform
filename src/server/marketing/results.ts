/**
 * How campaigns did: the funnel per campaign for the list and its "most successful" sort, the
 * Campaign Center's KPI tiles, and one campaign's results by location, barber and A/B variant with
 * its holdout lift. Every number comes from sendOutcomes, so the list, the results page and the
 * report always agree.
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { metricDefinitions, type Funnel, type Lift } from "@/domain/campaign-metrics";
import { abOf, type AbTest } from "@/domain/campaign-schedule";
import { StaffContext } from "../auth/staff";
import { funnelOf, sendOutcomes, type SendRow } from "./report";
import { loadMarketingSettings } from "./settings";

const uuidList = (xs: readonly string[]) => sql.join(xs.length ? xs.map((s) => sql`${s}::uuid`) : [sql`null::uuid`], sql`, `);

export interface CampaignResult {
  funnel: Funnel;
  lift: Lift;
}

/** Each campaign's funnel and lift, all time. Only messages at these shops count, so a manager sees their own shops' share. */
export async function campaignFunnels(campaignIds: readonly string[], shopIds?: readonly string[]): Promise<Map<string, CampaignResult>> {
  const out = new Map<string, CampaignResult>();
  if (!campaignIds.length) return out;
  const s = await loadMarketingSettings();
  const rows = await sendOutcomes(sql`ms.campaign_id in (${uuidList(campaignIds)}) ${shopIds ? sql`and ms.shop_id in (${uuidList(shopIds)})` : sql``}`, { days: s.attributionDays, basis: s.attributeOn });
  const by = new Map<string, SendRow[]>();
  for (const r of rows) by.set(r.campaign_id, [...(by.get(r.campaign_id) ?? []), r]);
  for (const id of campaignIds) out.set(id, funnelOf(by.get(id) ?? []));
  return out;
}

/** The Campaign Center's tiles: every message at these shops in the last `days` days. */
export async function centerKpis(shopIds: readonly string[], now = new Date(), days = 30): Promise<CampaignResult & { days: number; definitions: ReturnType<typeof metricDefinitions> }> {
  const s = await loadMarketingSettings();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = shopIds.length ? await sendOutcomes(sql`ms.shop_id in (${uuidList(shopIds)}) and ms.created_at >= ${since}`, { days: s.attributionDays, basis: s.attributeOn }) : [];
  return { ...funnelOf(rows), days, definitions: metricDefinitions(s.attributionDays, s.attributeOn) };
}

export interface Breakdown {
  key: string;
  label: string;
  funnel: Funnel;
}

export interface CampaignResults {
  overall: CampaignResult;
  byShop: Breakdown[];
  byBarber: Breakdown[];
  byVariant: Breakdown[];
  ab: AbTest | null;
  definitions: ReturnType<typeof metricDefinitions>;
  attributionDays: number;
}

/** One campaign's results at the person's shops: overall, by location, by barber and by A/B variant, with its lift. */
export async function campaignResults(ctx: StaffContext, c: { id: string; ab: unknown }): Promise<CampaignResults> {
  const s = await loadMarketingSettings();
  const shopIds = ctx.brandWide ? null : ctx.shopIds;
  const rows = await sendOutcomes(sql`ms.campaign_id = ${c.id}::uuid ${shopIds ? sql`and ms.shop_id in (${uuidList(shopIds)})` : sql``}`, { days: s.attributionDays, basis: s.attributeOn });
  const shopName = new Map(ctx.shops.map((x) => [x.id, x.name]));
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((x): x is string => !!x))];
  const names = staffIds.length ? await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, staffIds)) : [];
  const barber = new Map(names.map((x) => [x.id, x.label]));
  const group = (key: (r: SendRow) => string | null, label: (k: string) => string): Breakdown[] => {
    const by = new Map<string, SendRow[]>();
    for (const r of rows) {
      const k = key(r);
      if (k !== null) by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by]
      .map(([k, rs]) => ({ key: k, label: label(k), funnel: funnelOf(rs).funnel }))
      .filter((b) => b.funnel.sent > 0)
      .sort((a, b) => b.funnel.revenueCents - a.funnel.revenueCents || b.funnel.sent - a.funnel.sent || a.label.localeCompare(b.label));
  };
  return {
    overall: funnelOf(rows),
    byShop: group(
      (r) => r.shop_id,
      (k) => shopName.get(k) ?? "Another location",
    ),
    byBarber: group(
      (r) => r.staff_id ?? "none",
      (k) => (k === "none" ? "No barber" : (barber.get(k) ?? "A former barber")),
    ),
    byVariant: group(
      (r) => r.variant,
      (k) => `Variant ${k.toUpperCase()}`,
    ),
    ab: abOf(c.ab),
    definitions: metricDefinitions(s.attributionDays, s.attributeOn),
    attributionDays: s.attributionDays,
  };
}
