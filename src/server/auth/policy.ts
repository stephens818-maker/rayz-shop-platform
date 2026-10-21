/**
 * Pure authorization rules, kept free of I/O so they can be unit-tested directly.
 * Server actions load the rows and call these before writing. Who may grant permissions lives
 * in src/domain/permissions.ts.
 */

export interface Caller {
  staffId: string;
  /** Access to every shop. */
  brandWide: boolean;
  shopIds: string[];
}

/**
 * Time blocks. A shop block needs access to that shop and a barber who works there. A block at every
 * shop (shopId null) is fine for your own time, or for a barber who only works at shops you run;
 * otherwise it would close someone else's book, so it needs access to every shop.
 */
export function timeBlockChangeDenied(
  caller: Caller,
  block: { staffId: string; shopId: string | null },
  barberShopIds: string[],
): string | null {
  if (caller.brandWide) return null;
  if (block.shopId) {
    if (!caller.shopIds.includes(block.shopId)) return "That shop is outside your access";
    return barberShopIds.includes(block.shopId) ? null : "That barber doesn't work at this shop";
  }
  if (block.staffId === caller.staffId) return null;
  return barberShopIds.every((s) => caller.shopIds.includes(s)) ? null : "This barber also works at shops you don't manage. Block this shop only, or ask someone with access to every shop.";
}

/** The barber credited on a sale, or the barber an appointment moves to, must work at that shop. */
export function staffAtShopDenied(linkedShopIds: string[], shopId: string): string | null {
  return linkedShopIds.includes(shopId) ? null : "That barber doesn't work at this shop";
}
