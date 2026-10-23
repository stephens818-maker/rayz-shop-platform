import { Permission, REPORTS, ReportKey, reportExport, reportView } from "./permissions";

/** Anyone who works with stock can see it. */
const STOCK_VIEW: Permission[] = ["inventory.manage", "inventory.adjust", "inventory.transfer", "inventory.stocktake", "po.create", "po.receive", "catalog.manage", "catalog.prices"];
const PURCHASING: Permission[] = ["po.create", "po.approve", "po.send", "po.receive"];
const CALL_INS: Permission[] = ["callins.mark", "callins.mark_own", "callins.outreach", "callins.voice"];
const TIMESHEETS: Permission[] = ["timesheet.own", "timesheet.edit", "timesheet.approve", "payroll.export"];
const MARKETING: Permission[] = ["marketing.view", "marketing.location", "marketing.manage"];

/**
 * What each admin page needs: any one of the listed permissions, or null for any signed-in staff
 * member (those pages limit what they show instead). Pages call requirePage(PAGE_ACCESS[...]) and
 * the sidebar is built from the same table, so the two can't drift.
 */
export const PAGE_ACCESS = {
  "/admin": null,
  "/admin/calendar": null,
  "/admin/customers": null,
  "/admin/customers/[id]": null,
  "/admin/checkout/[saleId]": null,
  "/admin/customers/new": ["clients.edit"],
  "/admin/customers/duplicates": ["clients.merge"],
  "/admin/my-time": ["blocks.own", "timeoff.request"],
  "/admin/time-off": ["timeoff.approve", "blocks.others", "schedules.edit"],
  "/admin/call-ins": CALL_INS,
  "/admin/call-ins/[id]": CALL_INS,
  "/admin/inbox": ["inbox.view"],
  "/admin/inbox/[id]": ["inbox.view"],
  "/admin/walk-ins": ["walkins.manage"],
  "/admin/sales": ["sales.view"],
  "/admin/sales/[id]": null,
  "/admin/drawer": ["drawer.manage"],
  "/admin/my-tips": ["tips.own"],
  "/admin/my-banking": ["tips.own"],
  "/admin/tips": ["tips.approve"],
  "/admin/tips/[id]": ["tips.approve"],
  "/admin/tips/settings": ["tips.settings"],
  "/admin/staff": ["staff.manage", "schedules.edit"],
  "/admin/staff/[id]": ["staff.manage", "schedules.edit"],
  "/admin/permissions": ["permissions.manage"],
  "/admin/permissions/roles/[id]": ["permissions.manage"],
  "/admin/permissions/people/[id]": ["permissions.manage"],
  "/admin/shop-logins": ["logins.manage"],
  "/admin/sign-in-security": ["network.settings", "devices.approve"],
  "/admin/services": ["catalog.prices", "catalog.manage"],
  "/admin/inventory": STOCK_VIEW,
  "/admin/inventory/[id]": STOCK_VIEW,
  "/admin/inventory/low-stock": STOCK_VIEW,
  "/admin/inventory/counts": ["inventory.stocktake"],
  "/admin/inventory/counts/[id]": ["inventory.stocktake"],
  "/admin/inventory/transfers": ["inventory.transfer", "po.receive"],
  "/admin/inventory/transfers/[id]": ["inventory.transfer", "po.receive"],
  "/admin/inventory/settings": ["inventory.manage", "settings.shop"],
  "/admin/vendors": ["vendors.manage", "po.create"],
  "/admin/vendors/[id]": ["vendors.manage", "po.create"],
  "/admin/purchase-orders": PURCHASING,
  "/admin/purchase-orders/[id]": PURCHASING,
  "/admin/purchase-orders/[id]/receive": ["po.receive"],
  "/admin/catalog": ["catalog.manage", "inventory.manage"],
  "/admin/promos": ["promos.manage", "giftcards.issue", "giftcards.void"],
  "/admin/settings": ["settings.shop", "settings.taxes", "settings.brand"],
  "/admin/booking-times": ["scheduling.timing"],
  "/admin/block-reasons": ["blocks.reasons"],
  "/admin/lists": ["settings.lists"],
  "/admin/messages": ["settings.lists"],
  "/admin/digest": ["settings.lists"],
  "/admin/setup": ["payments.accounts", "locations.setup"],
  "/admin/setup/new": ["locations.setup"],
  "/admin/setup/simulated-onboarding": ["payments.banking"],
  "/admin/payouts": ["report.shop_accounts.view"],
  "/admin/import": ["import.run"],
  "/admin/client-data": ["clients.privacy"],
  "/admin/client-data/access": ["clients.privacy"],
  "/admin/location-groups": ["locations.manage"],
  "/admin/barber-groups": ["barber_groups.manage"],
  "/admin/notifications": ["notifications.view", "notifications.send"],
  "/admin/notifications/simulator": ["notifications.send"],
  "/admin/payroll/report": ["payroll.run", "payroll.approve"],
  "/admin/payroll/hours": ["payroll.run"],
  "/admin/payroll/setup": ["payroll.run"],
  "/admin/clock": ["timeclock.punch"],
  "/admin/clock/kiosk": ["timeclock.kiosk", "settings.shop"],
  "/admin/timesheets": TIMESHEETS,
  "/admin/timesheets/[staffId]": TIMESHEETS,
  "/admin/time-clock": ["payroll.run", "settings.shop"],
  "/admin/marketing": MARKETING,
  "/admin/marketing/automations/[id]": MARKETING,
  "/admin/marketing/blasts": MARKETING,
  "/admin/marketing/blasts/[id]": MARKETING,
  "/admin/marketing/settings": ["marketing.manage"],
  "/admin/reports": REPORTS.map((r) => reportView(r.key)),
  ...(Object.fromEntries(REPORTS.map((r) => [r.href, [reportView(r.key)]])) as Record<(typeof REPORTS)[number]["href"], Permission[]>),
} satisfies Record<string, readonly Permission[] | null>;

export type AdminPage = keyof typeof PAGE_ACCESS;

export const reportFor = (key: ReportKey) => REPORTS.find((r) => r.key === key)!;

export const pageAllowed = (perms: ReadonlySet<Permission>, page: AdminPage) => {
  const need = PAGE_ACCESS[page] as readonly Permission[] | null;
  return !need || need.some((p) => perms.has(p));
};

export interface NavItem {
  href: string;
  label: string;
}

const SECTIONS: { title: string; items: { href: AdminPage; label: string }[] }[] = [
  {
    title: "Front desk",
    items: [
      { href: "/admin", label: "Today" },
      { href: "/admin/calendar", label: "Calendar" },
      { href: "/admin/clock", label: "Time clock" },
      { href: "/admin/clock/kiosk", label: "Front-desk clock" },
      { href: "/admin/my-time", label: "My time" },
      { href: "/admin/my-tips", label: "My tips" },
      { href: "/admin/my-banking", label: "My banking" },
      { href: "/admin/time-off", label: "Time off" },
      { href: "/admin/call-ins", label: "Call-ins" },
      { href: "/admin/walk-ins", label: "Walk-ins & waitlist" },
      { href: "/admin/sales", label: "Sales & checkout" },
      { href: "/admin/drawer", label: "Cash drawer" },
      { href: "/admin/customers", label: "Clients" },
      { href: "/admin/inbox", label: "Inbox" },
    ],
  },
  {
    title: "Inventory",
    items: [
      { href: "/admin/inventory", label: "Stock" },
      { href: "/admin/inventory/low-stock", label: "Low stock" },
      { href: "/admin/purchase-orders", label: "Purchase orders" },
      { href: "/admin/vendors", label: "Vendors" },
      { href: "/admin/inventory/transfers", label: "Transfers" },
      { href: "/admin/inventory/counts", label: "Counts" },
      { href: "/admin/inventory/settings", label: "Inventory settings" },
    ],
  },
  {
    title: "Marketing",
    items: [
      { href: "/admin/marketing", label: "Campaigns" },
      { href: "/admin/marketing/blasts", label: "Blasts" },
      { href: "/admin/marketing/settings", label: "Marketing rules" },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/admin/reports", label: "Reports" },
      { href: "/admin/payouts", label: "Payouts" },
    ],
  },
  {
    title: "Payroll",
    items: [
      { href: "/admin/timesheets", label: "Timesheets" },
      { href: "/admin/payroll/report", label: "Payroll report" },
      { href: "/admin/tips", label: "Tip payouts" },
      { href: "/admin/tips/settings", label: "Tip payout settings" },
      { href: "/admin/payroll/hours", label: "Hours" },
      { href: "/admin/payroll/setup", label: "Payroll setup" },
      { href: "/admin/time-clock", label: "Time clock setup" },
    ],
  },
  {
    title: "Setup",
    items: [
      { href: "/admin/staff", label: "Staff & schedules" },
      { href: "/admin/permissions", label: "Permissions" },
      { href: "/admin/client-data", label: "Client data protection" },
      { href: "/admin/client-data/access", label: "Client data access" },
      { href: "/admin/shop-logins", label: "Shop logins" },
      { href: "/admin/sign-in-security", label: "Sign-in security" },
      { href: "/admin/services", label: "Services" },
      { href: "/admin/catalog", label: "Bulk upload" },
      { href: "/admin/promos", label: "Promos & gift cards" },
      { href: "/admin/settings", label: "Shop settings" },
      { href: "/admin/setup", label: "Location setup" },
      { href: "/admin/booking-times", label: "Booking times" },
      { href: "/admin/block-reasons", label: "Block reasons" },
      { href: "/admin/lists", label: "Picklists" },
      { href: "/admin/messages", label: "Client messages" },
      { href: "/admin/digest", label: "Morning digest" },
      { href: "/admin/location-groups", label: "Location groups" },
      { href: "/admin/barber-groups", label: "Barber groups" },
      { href: "/admin/import", label: "Squire import" },
      { href: "/admin/notifications", label: "Notifications" },
    ],
  },
];

/** The sidebar for someone with these permissions. Pages they can't open aren't listed. */
export function navFor(perms: ReadonlySet<Permission>): { title: string; items: NavItem[] }[] {
  return SECTIONS.map((s) => ({ title: s.title, items: s.items.filter((i) => pageAllowed(perms, i.href)) })).filter((s) => s.items.length > 0);
}

/** Reports this person can open, in catalog order, with whether they may export each. */
export function reportsFor(perms: ReadonlySet<Permission>) {
  return REPORTS.filter((r) => perms.has(reportView(r.key))).map((r) => ({ ...r, canExport: perms.has(reportExport(r.key)) }));
}
