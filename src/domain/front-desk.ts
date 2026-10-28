import { AdminPage, NavItem, pageAllowed } from "./navigation";
import type { Permission } from "./permissions";

/**
 * A shop login is the front desk's POS on a tablet (Charles, Oct 28, as in Squire): a few large tabs
 * instead of the admin sidebar. Each tab shows only where the login may open the page; everything else
 * it can open is under More.
 */
export const FRONT_DESK_TABS = [
  { href: "/admin", label: "Front desk", hint: "Today's clients, check-in and checkout" },
  { href: "/admin/calendar", label: "Calendar", hint: "Book, move and check in" },
  { href: "/admin/sales", label: "Checkout", hint: "The checkout queue and today's tickets" },
  { href: "/admin/customers", label: "Clients", hint: "Look up a client" },
  { href: "/admin/walk-ins", label: "Walk-ins", hint: "The waitlist" },
  { href: "/admin/clock/kiosk", label: "Time clock", hint: "Clock in and out" },
  { href: "/admin/campaign-center/openings", label: "Openings", hint: "We have openings, per barber" },
  { href: "/admin/reports", label: "Reports", hint: "This shop's reports" },
] as const satisfies readonly { href: AdminPage; label: string; hint: string }[];

export type FrontDeskTab = (typeof FRONT_DESK_TABS)[number];

const TAB_HREFS = new Set<string>(FRONT_DESK_TABS.map((t) => t.href));

export const frontDeskTabs = (perms: ReadonlySet<Permission>): FrontDeskTab[] => FRONT_DESK_TABS.filter((t) => pageAllowed(perms, t.href));

/** The other pages in their sidebar, for More. */
export const frontDeskMore = (sections: { items: NavItem[] }[]): NavItem[] => sections.flatMap((s) => s.items).filter((i) => !TAB_HREFS.has(i.href));

/** Today's clients at the desk: who to check in, then who to check out. */
export type DeskStep = "check_in" | "check_out" | null;
export const deskStep = (status: string): DeskStep =>
  status === "booked" || status === "confirmed" ? "check_in" : status === "checked_in" || status === "in_service" ? "check_out" : null;
