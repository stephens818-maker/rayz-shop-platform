import { AdminPage, NavItem, pageAllowed } from "./navigation";
import type { Permission } from "./permissions";

/**
 * A shop login is the front desk's POS on a tablet (Charles, Oct 28, as in Squire): a few large tabs
 * instead of the admin sidebar. Each tab shows only where the login may open the page; everything else
 * it can open is under More.
 */
export const FRONT_DESK_TABS = [
  { href: "/admin", label: "Front desk" },
  { href: "/admin/calendar", label: "Calendar" },
  { href: "/admin/sales", label: "Checkout" },
  { href: "/admin/customers", label: "Clients" },
  { href: "/admin/walk-ins", label: "Walk-ins" },
  { href: "/admin/clock/kiosk", label: "Time clock" },
  { href: "/admin/campaign-center/openings", label: "Openings" },
  { href: "/admin/reports", label: "Reports" },
] as const satisfies readonly { href: AdminPage; label: string }[];

export type FrontDeskTab = (typeof FRONT_DESK_TABS)[number];

const TAB_HREFS = new Set<string>(FRONT_DESK_TABS.map((t) => t.href));

export const frontDeskTabs = (perms: ReadonlySet<Permission>): FrontDeskTab[] => FRONT_DESK_TABS.filter((t) => pageAllowed(perms, t.href));

/** The other pages in their sidebar, for More. */
export const frontDeskMore = (sections: { items: NavItem[] }[]): NavItem[] => sections.flatMap((s) => s.items).filter((i) => !TAB_HREFS.has(i.href));

/** Where a sign-in lands. A shop login opens Checkout. An explicit /admin next link still wins. */
export function staffLandingPath(o: { kind: string; next: string; canSell: boolean }): string {
  if (o.next.startsWith("/admin")) return o.next;
  if (o.kind === "shop" && o.canSell) return "/admin/sales";
  return o.canSell ? "/admin" : "/admin/calendar";
}

/** Today's clients at the desk: who to check in, then who to check out. */
export type DeskStep = "check_in" | "check_out" | null;
export const deskStep = (status: string): DeskStep =>
  status === "booked" || status === "confirmed" ? "check_in" : status === "checked_in" || status === "in_service" ? "check_out" : null;
