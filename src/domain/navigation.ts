import { Permission, REPORTS, ReportKey, reportExport, reportView } from "./permissions";

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
  "/admin/walk-ins": ["walkins.manage"],
  "/admin/sales": ["sales.view"],
  "/admin/sales/[id]": null,
  "/admin/drawer": ["drawer.manage"],
  "/admin/staff": ["staff.manage", "schedules.edit"],
  "/admin/staff/[id]": ["staff.manage", "schedules.edit"],
  "/admin/permissions": ["permissions.manage"],
  "/admin/permissions/roles/[id]": ["permissions.manage"],
  "/admin/permissions/people/[id]": ["permissions.manage"],
  "/admin/services": ["catalog.prices", "catalog.manage"],
  "/admin/inventory": ["inventory.manage", "catalog.manage"],
  "/admin/catalog": ["catalog.manage", "inventory.manage"],
  "/admin/promos": ["promos.manage", "giftcards.issue", "giftcards.void"],
  "/admin/settings": ["settings.shop", "settings.taxes", "settings.brand"],
  "/admin/import": ["import.run"],
  "/admin/notifications": ["notifications.view", "notifications.send"],
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
      { href: "/admin/walk-ins", label: "Walk-ins & waitlist" },
      { href: "/admin/sales", label: "Sales & checkout" },
      { href: "/admin/drawer", label: "Cash drawer" },
      { href: "/admin/customers", label: "Clients" },
    ],
  },
  { title: "Insights", items: [{ href: "/admin/reports", label: "Reports" }] },
  {
    title: "Setup",
    items: [
      { href: "/admin/staff", label: "Staff & schedules" },
      { href: "/admin/permissions", label: "Permissions" },
      { href: "/admin/services", label: "Services" },
      { href: "/admin/inventory", label: "Inventory" },
      { href: "/admin/catalog", label: "Bulk upload" },
      { href: "/admin/promos", label: "Promos & gift cards" },
      { href: "/admin/settings", label: "Shop settings" },
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
