import "server-only";
import { sql } from "drizzle-orm";
import { clientKey } from "@/domain/pph";
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

/**
 * The clients behind product sales per client (src/domain/pph.ts): each completed ticket's client,
 * once per person, shop and business day. A completed ticket is paid or partly refunded, with a
 * service or product on it that wasn't refunded (or, imported from Squire without its lines, service
 * or product sales); a fully refunded, voided or gift-card-only ticket isn't one. Its client is the
 * ticket's client (a family ticket's is the one who paid), or the ticket itself for a walk-in with
 * none, so walk-ins count once per ticket.
 */
export async function clientVisits(
  s: Pick<ReportScope, "shopIds" | "staffId" | "staffIds">,
  from: LocalDate,
  to: LocalDate,
): Promise<{ staffId: string; shopId: string; date: LocalDate; client: string }[]> {
  if (!s.shopIds.length) return [];
  return rows<{ staffId: string; shopId: string; date: LocalDate; client: string }>(sql`
    select distinct s.staff_id "staffId", s.shop_id "shopId", s.business_date::text date, coalesce('c:' || s.customer_id::text, 't:' || s.id::text) client
    from sales s
    where s.shop_id in ${uuids(s.shopIds)} and s.business_date between ${from} and ${to} and s.status in ('paid','partially_refunded')
      and s.staff_id is not null ${staffFilter(sql`s.staff_id`, s)}
      and (exists (select 1 from sale_items i where i.sale_id = s.id and i.kind in ('service','product') and i.refunded_qty < i.qty)
        or (s.service_net_cents + s.product_net_cents > 0 and not exists (select 1 from sale_items i where i.sale_id = s.id)))`);
}

/** Completed service tickets per person and shop over [from, to], keyed by clientKey. */
export async function serviceTickets(s: Pick<ReportScope, "shopIds" | "staffId" | "staffIds">, from: LocalDate, to: LocalDate): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await serviceTicketDays(s, from, to)) out.set(clientKey(r.staffId, r.shopId), (out.get(clientKey(r.staffId, r.shopId)) ?? 0) + r.n);
  return out;
}