import "server-only";
import { sql } from "drizzle-orm";
import { type ClientCounts, clientKey } from "@/domain/pph";
import type { LocalDate } from "@/lib/time";
import { type ReportScope, rows, staffFilter, uuids } from "./report-sql";

/**
 * Completed service tickets, the clients in clients per hour (src/domain/pph.ts): paid tickets, or
 * partly refunded ones, with a service on them that wasn't refunded (or, on a ticket imported from
 * Squire without its lines, service sales). A fully refunded or voided ticket isn't one. Each is
 * credited to the ticket's barber on its business day, as payroll credits its sales, and tickets
 * imported from Squire count like the rest. A family ticket is one ticket.
 */
export async function serviceTicketDays(
  s: Pick<ReportScope, "shopIds" | "staffId" | "staffIds">,
  from: LocalDate,
  to: LocalDate,
): Promise<{ staffId: string; shopId: string; date: LocalDate; n: number }[]> {
  if (!s.shopIds.length) return [];
  return rows<{ staffId: string; shopId: string; date: LocalDate; n: number }>(sql`
    select s.staff_id "staffId", s.shop_id "shopId", s.business_date::text date, count(*)::int n
    from sales s
    where s.shop_id in ${uuids(s.shopIds)} and s.business_date between ${from} and ${to} and s.status in ('paid','partially_refunded')
      and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
      and (exists (select 1 from sale_items i where i.sale_id = s.id and i.kind = 'service' and i.refunded_qty < i.qty)
        or (s.service_net_cents > 0 and not exists (select 1 from sale_items i where i.sale_id = s.id)))
    group by 1, 2, 3`);
}

/** Completed service tickets per person and shop over [from, to], keyed by clientKey. */
export async function serviceTickets(s: Pick<ReportScope, "shopIds" | "staffId" | "staffIds">, from: LocalDate, to: LocalDate): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await serviceTicketDays(s, from, to)) out.set(clientKey(r.staffId, r.shopId), (out.get(clientKey(r.staffId, r.shopId)) ?? 0) + r.n);
  return out;
}

/** Each Payroll Report block's tickets over its own pay period (only these people's, given staffIds): one read per period among the blocks. */
export async function blockTickets(blocks: readonly { shopId: string; period: { start: LocalDate; end: LocalDate } }[], staffIds?: string[]): Promise<ClientCounts> {
  const byPeriod = new Map<string, { start: LocalDate; end: LocalDate; shopIds: string[] }>();
  for (const b of blocks) {
    const k = `${b.period.start}_${b.period.end}`;
    const p = byPeriod.get(k) ?? { start: b.period.start, end: b.period.end, shopIds: [] };
    p.shopIds.push(b.shopId);
    byPeriod.set(k, p);
  }
  const out = new Map<string, number>();
  for (const m of await Promise.all([...byPeriod.values()].map((p) => serviceTickets({ shopIds: p.shopIds, staffIds }, p.start, p.end)))) for (const [k, n] of m) out.set(k, (out.get(k) ?? 0) + n);
  return out;
}
