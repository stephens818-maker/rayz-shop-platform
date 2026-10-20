import { db, DBorTx } from "@/db";
import { auditLog } from "@/db/schema";

export interface Actor {
  staffId?: string | null;
  label: string;
}

export const SYSTEM: Actor = { staffId: null, label: "system" };
export const customerActor = (name: string): Actor => ({ staffId: null, label: `customer:${name}` });

export async function audit(
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
  shopId: string | null = null,
  tx: DBorTx = db,
) {
  await tx.insert(auditLog).values({
    actorStaffId: actor.staffId ?? null,
    actorLabel: actor.label,
    shopId,
    action,
    entity,
    entityId,
    details,
  });
}
