import { sql } from "drizzle-orm";
import type { DBorTx } from "@/db";

/**
 * After the profile, a child's profile or a new client writes customers.notes: who wrote the record
 * note. Only a record note the trigger just wrote (updated_by cleared, updated_at now) is stamped,
 * and they're its author only if the trigger created it in this transaction.
 */
export async function stampRecordNote(tx: DBorTx, customerId: string, staffId: string | null | undefined, shopId: string | null) {
  if (!staffId) return;
  await tx.execute(sql`
    update client_notes set updated_by = ${staffId},
      author_staff_id = case when author_staff_id is null and author_label is null and created_at = updated_at and created_at = now() then ${staffId}::uuid else author_staff_id end,
      shop_id = coalesce(shop_id, ${shopId}::uuid)
    where customer_id = ${customerId} and source = 'record' and deleted_at is null and updated_by is null and updated_at > now() - interval '1 minute'`);
}
