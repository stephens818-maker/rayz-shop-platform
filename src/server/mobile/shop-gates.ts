import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { shopPaymentAccounts, shops } from "@/db/schema";
import { effectiveLaunch, type LaunchState } from "@/server/launch";
import { connectMode } from "@/server/payments/connect";

export type BookingGate = "native" | "external" | "closed";

export interface ShopGateFields {
  id: string;
  shopId: string;
  slug: string;
  launched: boolean;
  launchAt: string | null;
  booking: BookingGate;
  externalBookingUrl: string | null;
  payments: boolean;
  /** Staff clock is not on this API. Always false until core ships it. */
  clockIn: false;
  /** The shop kill switch. A destination charge still keeps the tip in the shop transfer. */
  tipTransfers: boolean;
}

type ShopRow = {
  id: string;
  slug: string;
  launchAt: Date | null;
  bookingEnabled: boolean;
  bookingMode: "native" | "external" | "closed";
  externalBookingUrl: string | null;
  tipToBarber: boolean;
};

/** A shop takes app cards only after its own gate is open and its connected account can charge. */
export function shopTakesCards(
  launched: boolean,
  account: { chargesEnabled: boolean; deauthorizedAt: Date | null; simulated: boolean } | null,
): boolean {
  if (!launched || !account || !account.chargesEnabled || account.deauthorizedAt) return false;
  if (connectMode() === "stripe" && account.simulated) return false;
  return true;
}

export function bookingGate(shop: Pick<ShopRow, "bookingEnabled" | "bookingMode" | "externalBookingUrl">, launched: boolean): BookingGate {
  if (!launched || !shop.bookingEnabled) {
    return shop.bookingMode === "external" && shop.externalBookingUrl ? "external" : "closed";
  }
  return shop.bookingMode;
}

export async function shopGateRows(brand: LaunchState, now = new Date()): Promise<ShopGateFields[]> {
  const rows = await db
    .select({
      id: shops.id,
      slug: shops.slug,
      launchAt: shops.launchAt,
      bookingEnabled: shops.bookingEnabled,
      bookingMode: shops.bookingMode,
      externalBookingUrl: shops.externalBookingUrl,
      tipToBarber: shops.tipToBarber,
    })
    .from(shops)
    .where(eq(shops.active, true))
    .orderBy(asc(shops.slug));
  const accounts = rows.length
    ? await db
        .select({
          shopId: shopPaymentAccounts.shopId,
          chargesEnabled: shopPaymentAccounts.chargesEnabled,
          deauthorizedAt: shopPaymentAccounts.deauthorizedAt,
          simulated: shopPaymentAccounts.simulated,
        })
        .from(shopPaymentAccounts)
    : [];
  return rows.map((row) => {
    const state = effectiveLaunch(row.launchAt, brand, now);
    const account = accounts.find((a) => a.shopId === row.id) ?? null;
    const booking = bookingGate(row, state.launched);
    return {
      id: row.id,
      shopId: row.id,
      slug: row.slug,
      launched: state.launched,
      launchAt: state.launchAt,
      booking,
      externalBookingUrl: booking === "external" ? row.externalBookingUrl : null,
      payments: shopTakesCards(state.launched, account),
      clockIn: false,
      tipTransfers: row.tipToBarber,
    };
  });
}
