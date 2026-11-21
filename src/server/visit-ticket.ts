import { sql } from "drizzle-orm";
import { appointments } from "@/db/schema";

/**
 * The visit's only tickets are voided. A direct ticket, a combined ticket, or a line that names the
 * visit all count. An open, paid, or refunded ticket keeps the visit on the book.
 */
export const onlyVoidedTicket = sql`exists (
  select 1 from sales vs
  where vs.status = 'voided' and (
    vs.appointment_id = ${appointments.id}
    or exists (select 1 from sale_appointments sa where sa.sale_id = vs.id and sa.appointment_id = ${appointments.id})
    or exists (select 1 from sale_items si where si.sale_id = vs.id and si.appointment_id = ${appointments.id})
  )
) and not exists (
  select 1 from sales ns
  where ns.status <> 'voided' and (
    ns.appointment_id = ${appointments.id}
    or exists (select 1 from sale_appointments sa where sa.sale_id = ns.id and sa.appointment_id = ${appointments.id})
    or exists (select 1 from sale_items si where si.sale_id = ns.id and si.appointment_id = ${appointments.id})
  )
)`;
