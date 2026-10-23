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

/**
 * Adding or removing a block: your own time needs "Block out their own time" (or "for anyone"),
 * anyone else's needs "Block out time for anyone", and the shop rules above apply either way.
 */
export function blockChangeDenied(
  caller: Caller & { blocksOwn: boolean; blocksOthers: boolean },
  block: { staffId: string; shopId: string | null },
  barberShopIds: string[],
): string | null {
  if (block.staffId === caller.staffId) {
    if (!caller.blocksOwn && !caller.blocksOthers) return "You can't block out your own time";
  } else if (!caller.blocksOthers) return "You can only block out your own time";
  return timeBlockChangeDenied(caller, block, barberShopIds);
}

/**
 * Approving or denying time off: needs "Approve time off", never for yourself (the Brand Owner
 * excepted), and only for time at your shops. Time off at every shop for a barber who also works
 * at shops you don't run needs access to every shop.
 */
export function timeOffDecisionDenied(
  caller: Caller & { canApprove: boolean; isOwner: boolean },
  request: { staffId: string; shopId: string | null },
  barberShopIds: string[],
): string | null {
  if (!caller.canApprove) return "You can't approve or deny time off";
  if (request.staffId === caller.staffId && !caller.isOwner) return "You can't decide your own time off. Ask another manager.";
  if (caller.brandWide) return null;
  if (request.shopId) {
    if (!caller.shopIds.includes(request.shopId)) return "That shop is outside your access";
    return barberShopIds.includes(request.shopId) ? null : "That barber doesn't work at this shop";
  }
  return barberShopIds.every((s) => caller.shopIds.includes(s)) ? null : "This time off covers shops you don't manage too. Ask someone with access to every shop.";
}

/** The barber credited on a sale, or the barber an appointment moves to, must work at that shop. */
export function staffAtShopDenied(linkedShopIds: string[], shopId: string): string | null {
  return linkedShopIds.includes(shopId) ? null : "That barber doesn't work at this shop";
}
