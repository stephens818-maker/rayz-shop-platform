import { eq, inArray, isNull, or, type SQL } from "drizzle-orm";
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

/**
 * Audit entries someone may read. People with access to every shop also see brand-level entries
 * (no shop); everyone else sees only entries for their shops.
 */
export function auditScope(v: { brandWide: boolean; currentShopId: string | null; shopIds: string[] }): SQL | undefined {
  if (v.brandWide) return v.currentShopId ? or(eq(auditLog.shopId, v.currentShopId), isNull(auditLog.shopId)) : undefined;
  return inArray(auditLog.shopId, v.currentShopId ? [v.currentShopId] : v.shopIds.length ? v.shopIds : ["00000000-0000-0000-0000-000000000000"]);
}
