import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { marketingCampaigns, marketingSteps, staff } from "@/db/schema";
import { LAPSED_BUCKETS, LAPSED_MAX_DAYS, bucketOf, stepLabel } from "@/domain/marketing";
import { Cell, Column, ListRow, ViewCtx, listTable } from "@/domain/report-views";
import { endOfLocalDay, formatDate, startOfLocalDay, todayLocal } from "@/lib/time";
import type { ReportData } from "../report-data";
import { ReportScope, staffSelection } from "../reports";
import { consentColumns } from "./consent";
import { loadMarketingSettings } from "./settings";

const DAY = 86_400_000;
const int = (label: string): Column => ({ label, kind: "int" });
const pct = (label: string): Column => ({ label, kind: "pct", sum: false });
const uuids = (xs: readonly string[]) => sql`(${sql.join(xs.length ? xs.map((i) => sql`${i}::uuid`) : [sql`null::uuid`], sql`, `)})`;

/** Lapsed messages: lapsed sequences, "We miss you", win-back and barbers' own outreach. */
const LAPSED_TRIGGERS = sql.raw("('lapsed', 'win_back', 'barber_outreach')");

const BUCKETS = LAPSED_BUCKETS.length;
const MSG_COLUMNS = [int("Lapsed messages"), int("Clients messaged"), int("Rebooked"), pct("Rebook rate")];
/** Cells after the label: the buckets, lapsed, then messages, clients, rebooked, rate. */
const deriveBarber = (c: Cell[]): Cell[] => {
  const n = (i: number) => Number(c[i]) || 0;
  const lapsed = Array.from({ length: BUCKETS }, (_, i) => n(1 + i)).reduce((a, x) => a + x, 0);
  const at = 1 + BUCKETS + 1;
  return [...c.slice(0, 1 + BUCKETS), lapsed, n(at), n(at + 1), n(at + 2), n(at + 1) ? n(at + 2) / n(at + 1) : null];
};
const deriveCampaign = (c: Cell[]): Cell[] => {
  const n = (i: number) => Number(c[i]) || 0;
  return [c[0], n(1), n(2), n(3), n(2) ? n(3) / n(2) : null];
};

interface SendRow {
  id: string;
  customer_id: string;
  shop_id: string | null;
  staff_id: string | null;
  campaign_id: string;
  step_id: string | null;
  rebooked: boolean;
}

/**
 * Lapsed clients by barber: each barber's clients (by primary barber, the preferred barber or the
 * last one who cut them) whose last visit was two weeks to a year before the end of the period with
 * nothing booked since, by weeks since; and the lapsed messages sent in the period with how many of
 * those clients booked within the attribution window after one.
 */
export async function lapsedReportData(scope: ReportScope, loc: ViewCtx, now = new Date()): Promise<ReportData> {
  if (!scope.shopIds.length) return { stats: [], tables: [] };
  const asOf = scope.to >= todayLocal(now) ? now : endOfLocalDay(scope.to);
  const from = startOfLocalDay(scope.from).toISOString();
  const to = endOfLocalDay(scope.to).toISOString();
  const { attributionDays: days } = await loadMarketingSettings();
  const sel = staffSelection(scope);
  const cols = await consentColumns();
  const ago = (d: number) => new Date(asOf.getTime() - d * DAY).toISOString();
  const [lapsed, sends] = await Promise.all([
    db.execute(sql`
      with v as (
        select a.customer_id, max(a.starts_at) last_at,
          (array_agg(a.shop_id order by a.starts_at desc))[1] last_shop,
          (array_agg(a.staff_id order by a.starts_at desc))[1] last_staff
        from appointments a where a.status = 'completed' and a.customer_id is not null and a.starts_at <= ${asOf.toISOString()}
        group by a.customer_id
      ), l as (
        select v.last_shop shop_id, coalesce(c.preferred_staff_id, v.last_staff) staff_id,
          floor(extract(epoch from (${asOf.toISOString()}::timestamptz - v.last_at)) / 86400)::int since
        from v join customers c on c.id = v.customer_id
        where v.last_shop in ${uuids(scope.shopIds)} and v.last_at < ${ago(LAPSED_BUCKETS[0].from)} and v.last_at >= ${ago(LAPSED_MAX_DAYS)}
          ${cols.deleted ? sql`and c.deleted_at is null` : sql``}
          and not exists (select 1 from appointments b where b.customer_id = c.id and b.status not in ('cancelled', 'no_show') and b.starts_at > v.last_at and b.created_at <= ${asOf.toISOString()})
      )
      select shop_id, staff_id, since, count(*)::int n from l
      where true ${sel ? sql`and staff_id in ${uuids(sel)}` : sql``}
      group by 1, 2, 3`) as unknown as Promise<{ shop_id: string; staff_id: string | null; since: number; n: number }[]>,
    db.execute(sql`
      with s as (
        select ms.id, ms.customer_id, ms.shop_id, ms.staff_id, ms.campaign_id, ms.step_id, ms.created_at
        from marketing_sends ms join marketing_campaigns mc on mc.id = ms.campaign_id
        where ms.status = 'queued' and ms.customer_id is not null and ms.shop_id in ${uuids(scope.shopIds)}
          and ms.created_at >= ${from} and ms.created_at <= ${to}
          and (mc.kind = 'sequence' or mc.trigger in ${LAPSED_TRIGGERS})
          ${sel ? sql`and ms.staff_id in ${uuids(sel)}` : sql``}
      )
      select s.id, s.customer_id, s.shop_id, s.staff_id, s.campaign_id, s.step_id,
        exists (select 1 from appointments a where a.customer_id = s.customer_id and a.status <> 'cancelled'
          and a.created_at > s.created_at and a.created_at <= s.created_at + make_interval(days => ${days})) rebooked
      from s`) as unknown as Promise<SendRow[]>,
  ]);

  const staffIds = [...new Set([...lapsed.map((r) => r.staff_id), ...sends.map((r) => r.staff_id)].filter((x): x is string => !!x))];
  const campaignIds = [...new Set(sends.map((r) => r.campaign_id))];
  const stepIds = [...new Set(sends.map((r) => r.step_id).filter((x): x is string => !!x))];
  const [labels, names, steps] = await Promise.all([
    staffIds.length ? db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(inArray(staff.id, staffIds)) : [],
    campaignIds.length ? db.select({ id: marketingCampaigns.id, name: marketingCampaigns.name }).from(marketingCampaigns).where(inArray(marketingCampaigns.id, campaignIds)) : [],
    stepIds.length ? db.select({ id: marketingSteps.id, campaignId: marketingSteps.campaignId, afterDays: marketingSteps.afterDays }).from(marketingSteps).where(inArray(marketingSteps.campaignId, campaignIds)) : [],
  ]);
  const barber = new Map(labels.map((s) => [s.id, s.label]));
  const campaign = new Map(names.map((c) => [c.id, c.name]));
  const stepName = new Map(
    steps.map((x) => {
      const mine = steps.filter((y) => y.campaignId === x.campaignId).sort((a, b) => a.afterDays - b.afterDays);
      return [x.id, stepLabel(x.afterDays, mine[mine.length - 1]?.id === x.id)];
    }),
  );

  // One group per location and barber: bucket counts and the messages' clients.
  type Group = { shopId: string; staffId: string | null; buckets: number[]; messages: number; clients: Set<string>; rebooked: Set<string> };
  const groups = new Map<string, Group>();
  const group = (shopId: string, staffId: string | null) => {
    const k = `${shopId}|${staffId ?? ""}`;
    const g = groups.get(k) ?? { shopId, staffId, buckets: Array(BUCKETS).fill(0), messages: 0, clients: new Set<string>(), rebooked: new Set<string>() };
    groups.set(k, g);
    return g;
  };
  for (const r of lapsed) {
    const b = bucketOf(r.since);
    if (b >= 0) group(r.shop_id, r.staff_id).buckets[b] += r.n;
  }
  for (const s of sends) {
    if (!s.shop_id) continue;
    const g = group(s.shop_id, s.staff_id);
    g.messages++;
    g.clients.add(s.customer_id);
    if (s.rebooked) g.rebooked.add(s.customer_id);
  }
  const barberRows: ListRow[] = [...groups.values()].map((g) => ({
    shopId: g.shopId,
    staffId: g.staffId,
    key: g.staffId ?? "none",
    cells: deriveBarber([g.staffId ? (barber.get(g.staffId) ?? "") : "No barber", ...g.buckets, 0, g.messages, g.clients.size, g.rebooked.size, null]),
  }));

  const byCampaign = new Map<string, { shopId: string; staffId: string | null; label: string; key: string; messages: number; clients: Set<string>; rebooked: Set<string> }>();
  for (const s of sends) {
    if (!s.shop_id) continue;
    const key = `${s.campaign_id}|${s.step_id ?? ""}`;
    const k = `${key}|${s.shop_id}|${s.staff_id ?? ""}`;
    const label = `${campaign.get(s.campaign_id) ?? ""}${s.step_id && stepName.has(s.step_id) ? ` · ${stepName.get(s.step_id)}` : ""}`;
    const g = byCampaign.get(k) ?? { shopId: s.shop_id, staffId: s.staff_id, label, key, messages: 0, clients: new Set<string>(), rebooked: new Set<string>() };
    g.messages++;
    g.clients.add(s.customer_id);
    if (s.rebooked) g.rebooked.add(s.customer_id);
    byCampaign.set(k, g);
  }
  const campaignRows: ListRow[] = [...byCampaign.values()].map((g) => ({ shopId: g.shopId, staffId: g.staffId, key: g.key, cells: deriveCampaign([g.label, g.messages, g.clients.size, g.rebooked.size, null]) }));

  const total = (f: (g: Group) => number) => [...groups.values()].reduce((a, g) => a + f(g), 0);
  const lapsedNow = total((g) => g.buckets.reduce((a, x) => a + x, 0));
  const messaged = new Set(sends.map((s) => s.customer_id));
  const rebooked = new Set(sends.filter((s) => s.rebooked).map((s) => s.customer_id));
  const bySize = (i: number) => (a: Cell[], b: Cell[]) => Number(b[i]) - Number(a[i]) || String(a[0]).localeCompare(String(b[0]));
  return {
    stats: [
      { label: "Lapsed clients", value: String(lapsedNow), hint: `2 weeks to a year, as of ${formatDate(asOf, "MMM d")}` },
      { label: "Lapsed messages", value: String(sends.length), hint: `${messaged.size} clients` },
      { label: "Rebooked", value: String(rebooked.size), hint: `Within ${days} days of a message` },
      { label: "Rebook rate", value: messaged.size ? `${Math.round((rebooked.size / messaged.size) * 100)}%` : "—" },
    ],
    tables: [
      listTable(loc, {
        id: "barbers",
        title: "Lapsed clients by barber",
        subtitle: `Clients by weeks since their last visit as of ${formatDate(asOf, "MMM d, yyyy")}, with the lapsed messages sent in the period.`,
        columns: [{ label: "Barber" }, ...LAPSED_BUCKETS.map((b) => int(b.label)), int("Lapsed"), ...MSG_COLUMNS],
        rows: barberRows,
        merge: true,
        derive: deriveBarber,
        sort: bySize(1 + BUCKETS),
      }),
      listTable(loc, {
        id: "campaigns",
        title: "By campaign and step",
        columns: [{ label: "Campaign" }, ...MSG_COLUMNS],
        rows: campaignRows,
        merge: true,
        derive: deriveCampaign,
        sort: bySize(1),
      }),
    ],
    notes: [
      "A barber's lapsed clients are the clients whose primary barber they are: the preferred barber on the client's profile, or the barber of their last visit when none is set. A client counts at the location of their last visit.",
      `Lapsed means the last completed visit was 2 weeks to a year before the end of the period (or now, for a period that includes today) and nothing is booked since. A booking that was cancelled or not shown up for doesn't count.`,
      `Lapsed messages are those from lapsed sequences, "We miss you", win-back and "From your barber" sent in the period. Rebooked is how many of the clients messaged made a booking (not cancelled since) within ${days} days of one of those messages; the rebook rate is that over the clients messaged.`,
    ],
  };
}
