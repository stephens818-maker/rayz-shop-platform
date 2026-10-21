/**
 * Pure authorization rules, kept free of I/O so they can be unit-tested directly.
 * Server actions load the rows and call these before writing.
 */

type Role = "brand_admin" | "shop_manager" | "barber";

export interface Caller {
  staffId: string;
  isAdmin: boolean;
  shopIds: string[];
}

/** Returns a reason the change is forbidden, or null if it's allowed. */
export function staffProfileChangeDenied(
  caller: Caller,
  current: { role: Role; managerShopId: string | null; shopIds: string[] } | null,
  next: { role: Role; managerShopId: string | null; shopIds: string[] },
): string | null {
  if (caller.isAdmin) return null;
  const added = next.shopIds.filter((s) => !current?.shopIds.includes(s));
  if (added.some((s) => !caller.shopIds.includes(s))) return "You can only add people to your own shop";
  if (!current) {
    return next.role !== "barber" || next.managerShopId ? "Only the brand admin can assign manager or admin roles" : null;
  }
  if (current.role === "brand_admin") return "Only the brand admin can edit a brand admin";
  // Role and managed shop are brand-admin decisions, including on your own record.
  if (next.role !== current.role || (next.managerShopId ?? null) !== (current.managerShopId ?? null)) {
    return "Only the brand admin can change roles or which shop a manager runs";
  }
  return null;
}

/**
 * Time blocks. A shop block needs access to that shop and a barber who works there. A block at every
 * shop (shopId null) is fine for your own time, or for a barber who only works at shops you run;
 * otherwise it would close someone else's book, so it's brand-admin only.
 */
export function timeBlockChangeDenied(
  caller: Caller,
  block: { staffId: string; shopId: string | null },
  barberShopIds: string[],
): string | null {
  if (caller.isAdmin) return null;
  if (block.shopId) {
    if (!caller.shopIds.includes(block.shopId)) return "That shop is outside your access";
    return barberShopIds.includes(block.shopId) ? null : "That barber doesn't work at this shop";
  }
  if (block.staffId === caller.staffId) return null;
  return barberShopIds.every((s) => caller.shopIds.includes(s)) ? null : "This barber also works at shops you don't manage. Block this shop only, or ask the brand admin.";
}

/** The barber credited on a sale, or the barber an appointment moves to, must work at that shop. */
export function staffAtShopDenied(linkedShopIds: string[], shopId: string): string | null {
  return linkedShopIds.includes(shopId) ? null : "That barber doesn't work at this shop";
}
