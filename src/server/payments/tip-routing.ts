import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shops } from "@/db/schema";

/**
 * Whether this shop wants card tips paid to the barber's recipient account.
 * The transfer itself waits until chargeCard returns a separate charge with no transfer_data.
 * The source of truth is `shops.tip_to_barber` (core's per-shop kill switch).
 * Default is on. `FEATURE_TIP_TO_BARBER` is not read.
 */
export async function shopTipsToBarber(shopId: string): Promise<boolean> {
  const row = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { tipToBarber: true } });
  return row?.tipToBarber ?? true;
}

/** Alias for callers that still say "enabled". Same column. Requires the shop. */
export async function tipToBarberEnabled(shopId: string): Promise<boolean> {
  return shopTipsToBarber(shopId);
}
