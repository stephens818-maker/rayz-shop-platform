import { Permission, REPORTS, ReportKey, reportExport, reportView } from "./permissions";

/** Anyone who works with stock can see it. */
const STOCK_VIEW: Permission[] = ["inventory.manage", "inventory.adjust", "inventory.transfer", "inventory.stocktake", "po.create", "po.receive", "catalog.manage", "catalog.prices"];
const PURCHASING: Permission[] = ["po.create", "po.approve", "po.send", "po.receive"];
const CALL_INS: Permission[] = ["callins.mark", "callins.mark_own", "callins.outreach", "callins.voice"];
const TIMESHEETS: Permission[] = ["timesheet.own", "timesheet.edit", "timesheet.approve", "payroll.export"];
const CAMPAIGN_CENTER: Permission[] = ["campaign_center.view", "campaign_center.create", "campaign_center.send"];
const CUSTOM_REPORTS: Permission[] = ["report_builder.view", "report_builder.build"];

/**
 * What each admin page needs: any one of the listed permissions, or null for any signed-in staff
 * member (those pages limit what they show instead). Pages call requirePage(PAGE_ACCESS[...]) and
 * the sidebar is built from the same table, so the two can't drift.
 */
export const PAGE_ACCESS = {
  "/admin": null,
  "/admin/calendar": null,
  "/admin/calendar/board": ["calendar.manage"],
  "/admin/customers": null,
  "/admin/customers/[id]": null,
  "/admin/checkout/[saleId]": null,
  "/admin/customers/new": ["clients.edit"],
  "/admin/customers/duplicates": ["clients.merge"],
  "/admin/customers/sign-in-help": ["clients.merge"],
  "/admin/my-time": ["blocks.own", "timeoff.request"],
  "/admin/my-security": null,
  "/admin/verify": null,
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
  "/admin/my-pay": ["compensation.own"],
  "/admin/tips": ["tips.approve"],
  "/admin/tips/[id]": ["tips.approve"],
  "/admin/tips/settings": ["tips.settings", "tips.barber_payouts"],
  "/admin/tips/onboarding": ["tips.approve"],
  "/admin/tips/tracker": ["payouts.view"],
  "/admin/staff": ["staff.view", "staff.manage", "schedules.edit"],
  "/admin/staff/[id]": ["staff.view", "staff.manage", "schedules.edit"],
  "/admin/staff/[id]/compensation": ["compensation.view", "compensation.edit"],
  "/admin/milestones": null,
  "/admin/milestones/settings": ["milestones.settings"],
  "/admin/compensation": ["compensation.settings"],
  "/admin/analytics": ["analytics.settings", "analytics.export"],
  "/admin/users": ["permissions.manage"],
  "/admin/users/[id]": ["permissions.manage"],
  "/admin/permissions": ["permissions.manage"],
  "/admin/permissions/roles/[id]": ["permissions.manage"],
  "/admin/permissions/people/[id]": ["permissions.manage"],
  "/admin/permissions/matrix": ["permissions.manage"],
  "/admin/permissions/view-as": ["permissions.manage"],
  "/admin/shop-logins": ["logins.manage"],
  "/admin/sign-in-security": ["network.settings", "devices.approve"],
  "/admin/app-switches": ["settings.app"],
  "/admin/sync-status": ["settings.brand", "settings.app", "catalog.manage", "settings.card_fee", "settings.taxes", "handoff.settings", "checkout_prompts.manage", "milestones.settings", "campaign_center.create", "permissions.manage"],
  "/admin/services": ["catalog.prices", "catalog.manage"],
  "/admin/services/menu": ["checkout.any", "calendar.manage", "catalog.prices", "catalog.manage"],
  "/admin/products": ["catalog.manage", "inventory.manage"],
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
  "/admin/promos": ["promos.manage"],
  "/admin/gift-cards": ["checkout.any", "giftcards.issue", "giftcards.void"],
  "/admin/memberships": ["memberships.manage", "memberships.sell"],
  "/admin/settings": ["settings.shop", "settings.shop_details", "settings.shop_hours", "settings.shop_booking", "settings.shop_checkout", "settings.shop_phone", "settings.taxes", "settings.brand"],
  "/admin/taxes": ["settings.taxes"],
  "/admin/card-fee": ["settings.card_fee"],
  "/admin/bulk-edit": ["staff.manage", "schedules.edit", "catalog.manage", "catalog.prices"],
  "/admin/brand-defaults": ["settings.brand", "settings.shop", "settings.shop_booking", "settings.shop_details"],
  "/admin/booking-times": ["scheduling.timing"],
  "/admin/block-reasons": ["blocks.reasons"],
  "/admin/lists": ["settings.lists"],
  "/admin/messages": ["settings.lists"],
  "/admin/digest": ["settings.lists"],
  "/admin/checkout-prompts": ["checkout_prompts.manage"],
  "/admin/setup": ["payments.accounts", "locations.setup"],
  "/admin/setup/new": ["locations.setup"],
  "/admin/setup/simulated-onboarding": ["payments.banking"],
  "/admin/payouts": ["report.shop_accounts.view"],
  "/admin/phone-agent": ["report.phone_operator.view", "settings.shop_phone"],
  "/admin/import": ["import.run"],
  "/admin/cutover": ["import.run"],
  "/admin/cutover/[shopId]": ["import.run"],
  "/admin/rollout": ["settings.brand", "payroll.run"],
  "/admin/assistant/settings": ["assistant.settings"],
  "/admin/client-badges": ["badges.settings"],
  "/admin/client-data": ["clients.privacy"],
  "/admin/client-data/access": ["clients.privacy"],
  "/admin/client-data/contact-access": ["clients.privacy"],
  "/admin/location-groups": ["locations.manage"],
  "/admin/barber-groups": ["barber_groups.manage"],
  "/admin/notifications": ["notifications.view", "notifications.send"],
  "/admin/notifications/simulator": ["notifications.send"],
  "/admin/payroll": ["report.tips_payroll.view"],
  "/admin/payroll/report": ["payroll.run", "payroll.approve"],
  "/admin/payroll/tips": ["payroll.run", "payroll.approve"],
  "/admin/payroll/hours": ["payroll.run"],
  "/admin/payroll/final-pay": ["payroll.run", "payroll.approve"],
  "/admin/payroll/setup": ["payroll.run"],
  "/admin/clock": ["timeclock.punch"],
  "/admin/clock/kiosk": ["timeclock.kiosk", "settings.shop"],
  "/admin/timesheets": TIMESHEETS,
  "/admin/pay-questions": ["timesheet.own", "timesheet.approve", "payroll.run", "payroll.export", "payroll.approve"],
  "/admin/timesheets/[staffId]": TIMESHEETS,
  "/admin/time-clock": ["payroll.run", "settings.shop"],
  "/admin/campaign-center": CAMPAIGN_CENTER,
  "/admin/campaign-center/automations/[id]": CAMPAIGN_CENTER,
  "/admin/campaign-center/blasts": CAMPAIGN_CENTER,
  "/admin/campaign-center/blasts/[id]": CAMPAIGN_CENTER,
  "/admin/campaign-center/calendar": CAMPAIGN_CENTER,
  "/admin/campaign-center/templates": CAMPAIGN_CENTER,
  "/admin/campaign-center/settings": CAMPAIGN_CENTER,
  "/admin/campaign-center/sequences/[id]": CAMPAIGN_CENTER,
  "/admin/campaign-center/my-clients": ["campaign_center.own_clients"],
  "/admin/campaign-center/openings": ["campaign_center.openings", "campaign_center.send"],
  "/admin/reports": [...REPORTS.map((r) => reportView(r.key)), ...CUSTOM_REPORTS],
  "/admin/reports/custom": CUSTOM_REPORTS,
  "/admin/reports/custom/new": ["report_builder.build"],
  "/admin/reports/custom/[id]": CUSTOM_REPORTS,
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
      { href: "/admin/calendar/board", label: "All-shops day board" },
      { href: "/admin/clock", label: "Time clock" },
      { href: "/admin/clock/kiosk", label: "Front-desk clock" },
      { href: "/admin/my-time", label: "My time" },
      { href: "/admin/my-tips", label: "My tips" },
      { href: "/admin/my-banking", label: "My banking" },
      { href: "/admin/my-pay", label: "My pay" },
      { href: "/admin/milestones", label: "Milestones" },
      { href: "/admin/time-off", label: "Time off" },
      { href: "/admin/call-ins", label: "Call-ins" },
      { href: "/admin/walk-ins", label: "Walk-ins & waitlist" },
      { href: "/admin/sales", label: "Sales & checkout" },
      { href: "/admin/drawer", label: "Cash drawer" },
      { href: "/admin/gift-cards", label: "Gift cards" },
      { href: "/admin/services/menu", label: "Service menu" },
      { href: "/admin/memberships", label: "Memberships" },
      { href: "/admin/customers", label: "Clients" },
      { href: "/admin/customers/sign-in-help", label: "App sign-in help" },
      { href: "/admin/inbox", label: "Inbox" },
      { href: "/admin/phone-agent", label: "Phone agent" },
    ],
  },
  {
    title: "Inventory",
    items: [
      { href: "/admin/products", label: "Products" },
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
    title: "Campaign Center",
    items: [
      { href: "/admin/campaign-center/openings", label: "We have openings" },
      { href: "/admin/campaign-center", label: "Campaigns" },
      { href: "/admin/campaign-center/blasts", label: "Blasts" },
      { href: "/admin/campaign-center/calendar", label: "Calendar" },
      { href: "/admin/campaign-center/templates", label: "Templates" },
      { href: "/admin/campaign-center/my-clients", label: "My lapsed clients" },
      { href: "/admin/campaign-center/settings", label: "Settings" },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/admin/morning", label: "Morning Dashboard" },
      { href: "/admin/reports", label: "Reports" },
      { href: "/admin/payouts", label: "Payouts" },
      { href: "/admin/analytics", label: "Event log" },
    ],
  },
  {
    title: "Payroll",
    items: [
      { href: "/admin/timesheets", label: "Timesheets" },
      { href: "/admin/pay-questions", label: "Pay questions" },
      { href: "/admin/payroll/report", label: "Payroll report" },
      { href: "/admin/payroll/tips", label: "Payroll tip report" },
      { href: "/admin/tips", label: "Tip payouts" },
      { href: "/admin/tips/onboarding", label: "Payout onboarding" },
      { href: "/admin/tips/tracker", label: "Payout tracker" },
      { href: "/admin/tips/settings", label: "Tip payout settings" },
      { href: "/admin/payroll/hours", label: "Hours" },
      { href: "/admin/payroll/final-pay", label: "Final pay" },
      { href: "/admin/payroll/setup", label: "Payroll setup" },
      { href: "/admin/compensation", label: "Compensation" },
      { href: "/admin/time-clock", label: "Time clock setup" },
    ],
  },
  {
    title: "Setup",
    items: [
      { href: "/admin/staff", label: "Staff & schedules" },
      { href: "/admin/milestones/settings", label: "Staff milestones" },
      { href: "/admin/users", label: "Users" },
      { href: "/admin/permissions", label: "Permissions" },
      { href: "/admin/permissions/matrix", label: "Permissions matrix" },
      { href: "/admin/client-data", label: "Client data protection" },
      { href: "/admin/client-data/contact-access", label: "Contact access" },
      { href: "/admin/client-data/access", label: "Client data access" },
      { href: "/admin/shop-logins", label: "Shop logins" },
      { href: "/admin/sign-in-security", label: "Sign-in security" },
      { href: "/admin/app-switches", label: "App switches" },
      { href: "/admin/services", label: "Services" },
      { href: "/admin/bulk-edit", label: "Bulk edit" },
      { href: "/admin/catalog", label: "Bulk upload" },
      { href: "/admin/promos", label: "Promos" },
      { href: "/admin/brand-defaults", label: "Brand defaults" },
      { href: "/admin/sync-status", label: "Sync status" },
      { href: "/admin/settings", label: "Shop settings" },
      { href: "/admin/taxes", label: "Taxes & card fees" },
      { href: "/admin/card-fee", label: "Credit card fee" },
      { href: "/admin/setup", label: "Location setup" },
      { href: "/admin/booking-times", label: "Booking times" },
      { href: "/admin/checkout-prompts", label: "Checkout prompts" },
      { href: "/admin/block-reasons", label: "Block reasons" },
      { href: "/admin/lists", label: "Picklists" },
      { href: "/admin/messages", label: "Client messages" },
      { href: "/admin/digest", label: "Morning Dashboard email" },
      { href: "/admin/location-groups", label: "Location groups" },
      { href: "/admin/barber-groups", label: "Barber groups" },
      { href: "/admin/assistant/settings", label: "Rayz Assistant" },
      { href: "/admin/client-badges", label: "Client badges" },
      { href: "/admin/import", label: "Squire import" },
      { href: "/admin/cutover", label: "Squire cutover" },
      { href: "/admin/rollout", label: "Rollout" },
      { href: "/admin/notifications", label: "Notifications" },
    ],
  },
];

/** Pages that only exist for direct Stripe tip payouts to employees, left out while that rail is switched off. */
export const STRIPE_PAYOUT_PAGES: readonly AdminPage[] = ["/admin/tips/onboarding"];

/** The sidebar for someone with these permissions. Pages they can't open, or that are switched off, aren't listed. */
export function navFor(perms: ReadonlySet<Permission>, o: { hide?: readonly string[] } = {}): { title: string; items: NavItem[] }[] {
  const hide = new Set(o.hide ?? []);
  return SECTIONS.map((s) => ({ title: s.title, items: s.items.filter((i) => pageAllowed(perms, i.href) && !hide.has(i.href)) })).filter((s) => s.items.length > 0);
}

/** Reports this person can open, in catalog order, with whether they may export each. */
export function reportsFor(perms: ReadonlySet<Permission>) {
  return REPORTS.filter((r) => perms.has(reportView(r.key))).map((r) => ({ ...r, canExport: perms.has(reportExport(r.key)) }));
}
