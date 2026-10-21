/**
 * Granular staff permissions. Pure: the catalog, the role templates, how a user's effective
 * permissions are worked out, and who may grant what. Server code loads the rows and calls these.
 */

export const PERMISSION_GROUPS = ["Front desk", "Point of sale", "Clients", "Catalog and inventory", "Staff", "Settings and data"] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

interface PermissionDef {
  key: string;
  group: PermissionGroup;
  label: string;
  hint?: string;
  /** Only the Brand Owner role ever has it; it can't be put in another role or granted per user. */
  ownerOnly?: boolean;
  /** Works on records every shop shares, so it only takes effect for people with access to all shops. */
  brandOnly?: boolean;
}

export const FEATURE_PERMISSIONS = [
  { key: "calendar.manage", group: "Front desk", label: "Book, move and change any barber's appointments", hint: "Without it, people work only in their own column." },
  { key: "walkins.manage", group: "Front desk", label: "Run walk-ins and the waitlist" },
  { key: "schedules.edit", group: "Front desk", label: "Edit schedules and time off" },
  { key: "checkout.any", group: "Point of sale", label: "Open tickets and check out any barber's clients", hint: "Without it, people check out only their own clients." },
  { key: "pos.discount", group: "Point of sale", label: "Give manual discounts", hint: "Up to the role's discount limit." },
  { key: "pos.price_override", group: "Point of sale", label: "Change a menu price on a ticket" },
  { key: "sales.view", group: "Point of sale", label: "See every ticket at their shops" },
  { key: "sales.refund", group: "Point of sale", label: "Refund and void tickets" },
  { key: "drawer.manage", group: "Point of sale", label: "Open and close the cash drawer" },
  { key: "promos.manage", group: "Point of sale", label: "Create and turn off promo codes" },
  { key: "giftcards.issue", group: "Point of sale", label: "Issue comp gift cards" },
  { key: "giftcards.void", group: "Point of sale", label: "Void gift cards" },
  { key: "clients.view_all", group: "Clients", label: "Look up any client in the brand", hint: "Without it, only clients of their shops, and full profiles only for clients they've served." },
  { key: "clients.contact", group: "Clients", label: "See client phone numbers and emails" },
  { key: "clients.edit", group: "Clients", label: "Add clients and edit client details" },
  { key: "clients.merge", group: "Clients", label: "Merge duplicate clients", brandOnly: true },
  { key: "clients.rate", group: "Clients", label: "Rate clients" },
  { key: "clients.ratings_all", group: "Clients", label: "See every rating and note, and rate any visit at their shops", hint: "Without it, people see their own ratings and rate only visits they served." },
  { key: "clients.ratings_moderate", group: "Clients", label: "Remove anyone's rating" },
  { key: "loyalty.grant", group: "Clients", label: "Grant courtesy loyalty rewards" },
  { key: "catalog.prices", group: "Catalog and inventory", label: "Edit services and prices at their shops" },
  { key: "catalog.manage", group: "Catalog and inventory", label: "Manage the brand catalog, bulk upload items, and push them to shops", brandOnly: true },
  {
    key: "inventory.manage",
    group: "Catalog and inventory",
    label: "Set par levels and reorder points, and send low-stock alerts at their shops",
    hint: "With access to all shops, also the brand defaults and the purchase order approval limit.",
  },
  { key: "inventory.adjust", group: "Catalog and inventory", label: "Adjust stock by hand: damage, theft, back bar, count corrections" },
  { key: "inventory.transfer", group: "Catalog and inventory", label: "Transfer stock between their shops" },
  { key: "inventory.stocktake", group: "Catalog and inventory", label: "Run cycle counts and full stocktakes" },
  { key: "vendors.manage", group: "Catalog and inventory", label: "Add and edit vendors and what they sell", brandOnly: true },
  { key: "po.create", group: "Catalog and inventory", label: "Create and edit purchase orders" },
  { key: "po.approve", group: "Catalog and inventory", label: "Approve purchase orders over the approval limit" },
  { key: "po.send", group: "Catalog and inventory", label: "Send purchase orders to vendors" },
  { key: "po.receive", group: "Catalog and inventory", label: "Receive deliveries against purchase orders" },
  { key: "staff.manage", group: "Staff", label: "Add and edit staff profiles" },
  { key: "permissions.manage", group: "Staff", label: "Manage roles, permissions and shop access" },
  { key: "logins.manage", group: "Staff", label: "Create and disable shop logins and reset their passwords", hint: "For the shops in their access." },
  {
    key: "reports.all_staff",
    group: "Staff",
    label: "See every barber's numbers in reports",
    hint: "Without it, reports that break down by barber show only the person's own tickets, appointments, tips and ratings.",
  },
  { key: "barber_groups.manage", group: "Staff", label: "Create and edit saved barber groups for reports", brandOnly: true },
  { key: "settings.shop", group: "Settings and data", label: "Edit shop info, weekday hours, closures and booking rules" },
  { key: "settings.taxes", group: "Settings and data", label: "Edit tax rates and card fees" },
  { key: "settings.brand", group: "Settings and data", label: "Change brand-level settings: loyalty program, new shops, Sunday hours", ownerOnly: true },
  { key: "import.run", group: "Settings and data", label: "Run the Squire import", brandOnly: true },
  { key: "notifications.view", group: "Settings and data", label: "See the notification outbox" },
  { key: "notifications.send", group: "Settings and data", label: "Send due notifications now" },
  { key: "locations.manage", group: "Settings and data", label: "Create and edit saved location groups for reports", brandOnly: true },
] as const satisfies readonly PermissionDef[];

export type FeaturePermission = (typeof FEATURE_PERMISSIONS)[number]["key"];

/** Every report is its own permission, with CSV export granted separately from viewing. */
export const REPORTS = [
  { key: "my_sales", label: "My sales and tips", href: "/admin/reports/my-sales", hint: "The signed-in person's own tickets only." },
  { key: "sales_summary", label: "Sales summary", href: "/admin/reports/sales" },
  { key: "sales_by_barber", label: "Barber performance", href: "/admin/reports/barbers" },
  { key: "services_vs_products", label: "Services vs products", href: "/admin/reports/services-products" },
  { key: "tips_payroll", label: "Tips and payroll export", href: "/admin/payroll" },
  { key: "card_vs_cash", label: "Card vs cash", href: "/admin/reports/tender" },
  { key: "discounts_refunds", label: "Discounts and refunds", href: "/admin/reports/discounts-refunds" },
  { key: "inventory", label: "Inventory valuation", href: "/admin/reports/inventory" },
  { key: "inventory_movement", label: "Stock movement and shrink", href: "/admin/reports/inventory-movement" },
  { key: "sell_through", label: "Sell-through", href: "/admin/reports/sell-through" },
  { key: "low_stock", label: "Low stock", href: "/admin/reports/low-stock" },
  { key: "purchasing", label: "Purchase orders and vendor spend", href: "/admin/reports/purchasing" },
  { key: "gift_cards", label: "Gift cards", href: "/admin/reports/gift-cards" },
  { key: "loyalty", label: "Loyalty", href: "/admin/reports/loyalty" },
  { key: "client_ratings", label: "Client ratings", href: "/admin/reports/ratings" },
  { key: "kpis", label: "Retention and rebook KPIs", href: "/admin/reports/kpis" },
  { key: "heatmap", label: "Busiest times heatmap", href: "/admin/reports/heatmap" },
  { key: "cash_drawer", label: "Cash drawer", href: "/admin/reports/cash-drawer" },
  { key: "audit_log", label: "Audit log", href: "/admin/audit" },
] as const;

export type ReportKey = (typeof REPORTS)[number]["key"];
export type ReportPermission = `report.${ReportKey}.view` | `report.${ReportKey}.export`;
export type Permission = FeaturePermission | ReportPermission;

export const reportView = (r: ReportKey): ReportPermission => `report.${r}.view`;
export const reportExport = (r: ReportKey): ReportPermission => `report.${r}.export`;

export const REPORT_PERMISSIONS: ReportPermission[] = REPORTS.flatMap((r) => [reportView(r.key), reportExport(r.key)]);
export const ALL_PERMISSIONS: Permission[] = [...FEATURE_PERMISSIONS.map((p) => p.key), ...REPORT_PERMISSIONS];
const KNOWN = new Set<string>(ALL_PERMISSIONS);
export const OWNER_ONLY = new Set<Permission>(FEATURE_PERMISSIONS.filter((p) => "ownerOnly" in p && p.ownerOnly).map((p) => p.key));
export const BRAND_ONLY = new Set<Permission>(FEATURE_PERMISSIONS.filter((p) => "brandOnly" in p && p.brandOnly).map((p) => p.key));

export const isPermission = (s: unknown): s is Permission => typeof s === "string" && KNOWN.has(s);

export function permissionLabel(p: Permission): string {
  const f = FEATURE_PERMISSIONS.find((x) => x.key === p);
  if (f) return f.label;
  const m = p.match(/^report\.(.+)\.(view|export)$/);
  const r = m && REPORTS.find((x) => x.key === m[1]);
  return r ? `${r.label}: ${m![2] === "view" ? "view" : "export CSV"}` : p;
}

// ───────────────────────────── Shop scope ─────────────────────────────

export const SHOP_SCOPES = ["all", "selected", "one"] as const;
export type ShopScope = (typeof SHOP_SCOPES)[number];
export const SCOPE_LABEL: Record<ShopScope, string> = { all: "All shops", selected: "Selected shops", one: "One shop" };

export function scopeProblem(scope: ShopScope, shopIds: string[]): string | null {
  if (scope === "all") return null;
  if (scope === "one" && shopIds.length !== 1) return "Pick exactly one shop";
  if (scope === "selected" && shopIds.length === 0) return "Pick at least one shop";
  return null;
}

// ───────────────────────────── Roles ─────────────────────────────

export const OWNER_ROLE_KEY = "brand_owner";

export const ROLE_TEMPLATE_KEYS = ["brand_owner", "brand_admin", "regional_manager", "shop_manager", "front_desk", "barber"] as const;
export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];

export interface RoleDef {
  /** Template key, or null for a custom role. */
  key: string | null;
  name: string;
  permissions: readonly string[];
  /** Largest manual discount allowed, in whole percent. */
  maxDiscountPct: number;
}

const reports = (keys: ReportKey[], exportToo = true): ReportPermission[] => keys.flatMap((k) => (exportToo ? [reportView(k), reportExport(k)] : [reportView(k)]));
const ALL_REPORTS = REPORTS.map((r) => r.key);
const MANAGER_FEATURES: FeaturePermission[] = [
  "calendar.manage",
  "walkins.manage",
  "schedules.edit",
  "checkout.any",
  "pos.discount",
  "pos.price_override",
  "sales.view",
  "sales.refund",
  "drawer.manage",
  "promos.manage",
  "giftcards.issue",
  "clients.view_all",
  "clients.contact",
  "clients.edit",
  "clients.rate",
  "clients.ratings_all",
  "catalog.prices",
  "inventory.manage",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.stocktake",
  "po.create",
  "po.send",
  "po.receive",
  "staff.manage",
  "settings.shop",
  "notifications.view",
  "reports.all_staff",
];
/** Regional managers also approve big orders and run the shop logins for their shops. */
const REGIONAL_FEATURES: FeaturePermission[] = [...MANAGER_FEATURES, "logins.manage", "po.approve"];

export interface RoleTemplate extends RoleDef {
  key: RoleTemplateKey;
  description: string;
  defaultScope: ShopScope;
}

/** Starting points. Every template except Brand Owner can be edited; "Reset" puts these back. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: "brand_owner",
    name: "Brand Owner",
    description: "Everything, at every shop. The only role that can grant Brand Owner or change brand-level settings.",
    defaultScope: "all",
    permissions: [...ALL_PERMISSIONS],
    maxDiscountPct: 100,
  },
  {
    key: "brand_admin",
    name: "Brand Admin",
    description: "Runs the whole brand day to day. Everything except brand-level settings and granting Brand Owner.",
    defaultScope: "all",
    permissions: ALL_PERMISSIONS.filter((p) => !OWNER_ONLY.has(p)),
    maxDiscountPct: 100,
  },
  {
    key: "regional_manager",
    name: "Regional Manager",
    description: "Manages several shops: front desk, POS, clients, staff and shop settings, with every report for those shops.",
    defaultScope: "selected",
    permissions: [...REGIONAL_FEATURES, "giftcards.void", ...reports(ALL_REPORTS)],
    maxDiscountPct: 100,
  },
  {
    key: "shop_manager",
    name: "Shop Manager",
    description: "Manages one shop: front desk, POS, clients, staff and shop settings, with that shop's reports.",
    defaultScope: "one",
    permissions: [...MANAGER_FEATURES, ...reports(ALL_REPORTS)],
    maxDiscountPct: 100,
  },
  {
    key: "front_desk",
    name: "Front Desk",
    description: "Books and checks out every barber's clients, runs walk-ins and the drawer. Small discounts only.",
    defaultScope: "one",
    permissions: [
      "calendar.manage",
      "walkins.manage",
      "checkout.any",
      "pos.discount",
      "sales.view",
      "drawer.manage",
      "clients.view_all",
      "clients.contact",
      "clients.edit",
      "reports.all_staff",
      "po.receive",
      "inventory.stocktake",
      ...reports(["card_vs_cash", "cash_drawer"], false),
    ],
    maxDiscountPct: 10,
  },
  {
    key: "barber",
    name: "Barber",
    description: "Their own column, their own clients and their own sales.",
    defaultScope: "selected",
    permissions: ["clients.rate", ...reports(["my_sales"])],
    maxDiscountPct: 0,
  },
];

export const templateFor = (key: string | null | undefined) => ROLE_TEMPLATES.find((t) => t.key === key) ?? null;

/** Template rows as stored. Brand Owner's list stays empty: it always has everything, including permissions added later. */
export const templateRow = (t: RoleTemplate) => ({
  key: t.key,
  name: t.name,
  description: t.description,
  permissions: t.key === OWNER_ROLE_KEY ? [] : [...t.permissions],
  maxDiscountPct: t.maxDiscountPct,
  defaultScope: t.defaultScope,
  sortOrder: (ROLE_TEMPLATES.indexOf(t) + 1) * 10,
});

// ───────────────────────────── Effective permissions ─────────────────────────────

/** Per-user overrides: true grants on top of the role, false takes away. */
export type Overrides = Partial<Record<Permission, boolean>>;

export interface Access {
  isOwner: boolean;
  permissions: Set<Permission>;
  maxDiscountPct: number;
}

export function cleanOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) if (isPermission(k) && typeof v === "boolean") out[k] = v;
  return out;
}

const clampPct = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0);

/**
 * The role's permissions with the user's overrides applied. Owner-only permissions come only from
 * the Brand Owner role, brand-only ones only with access to all shops, and exporting a report
 * needs viewing it too. Without a scope it's what the role grants at every shop.
 */
export function effectiveAccess(role: RoleDef, overrides: Overrides = {}, maxDiscountOverride: number | null = null, scope: ShopScope = "all"): Access {
  if (role.key === OWNER_ROLE_KEY) return { isOwner: true, permissions: new Set(ALL_PERMISSIONS), maxDiscountPct: 100 };
  const perms = new Set<Permission>(role.permissions.filter(isPermission));
  for (const [k, v] of Object.entries(cleanOverrides(overrides))) {
    if (v) perms.add(k as Permission);
    else perms.delete(k as Permission);
  }
  for (const p of OWNER_ONLY) perms.delete(p);
  if (scope !== "all") for (const p of BRAND_ONLY) perms.delete(p);
  for (const r of REPORTS) if (!perms.has(reportView(r.key))) perms.delete(reportExport(r.key));
  const maxDiscountPct = perms.has("pos.discount") ? clampPct(maxDiscountOverride ?? role.maxDiscountPct) : 0;
  return { isOwner: false, permissions: perms, maxDiscountPct };
}

// ───────────────────────────── Per-shop roles ─────────────────────────────

export const sameAccess = (a: Access, b: Access) =>
  a.isOwner === b.isOwner && a.maxDiscountPct === b.maxDiscountPct && a.permissions.size === b.permissions.size && [...a.permissions].every((p) => b.permissions.has(p));

/** Everything granted at any of these shops, with the highest discount limit: what someone can do somewhere. */
export function unionAccess(list: readonly Access[]): Access {
  const permissions = new Set<Permission>();
  for (const a of list) for (const p of a.permissions) permissions.add(p);
  return { isOwner: list.some((a) => a.isOwner), permissions, maxDiscountPct: Math.max(0, ...list.map((a) => a.maxDiscountPct)) };
}

/**
 * Someone assigned to several shops can hold a different role at each. Their access at a shop is
 * that shop's role (or their main role) with their personal overrides on top. When it isn't the
 * same at every shop, they work in one shop at a time.
 */
export function accessByShop<R extends RoleDef & { id: string }>(
  main: R,
  shops: readonly { shopId: string; role: R | null }[],
  overrides: Overrides,
  maxDiscountOverride: number | null,
  scope: ShopScope,
): { byShop: Map<string, Access & { role: R }>; union: Access; uniform: boolean } {
  const byShop = new Map<string, Access & { role: R }>();
  for (const s of shops) {
    const role = scope !== "all" && s.role && s.role.key !== OWNER_ROLE_KEY ? s.role : main;
    byShop.set(s.shopId, { ...effectiveAccess(role, overrides, maxDiscountOverride, scope), role });
  }
  const list = [...byShop.values()];
  if (!list.length) return { byShop, union: effectiveAccess(main, overrides, maxDiscountOverride, scope), uniform: true };
  return { byShop, union: unionAccess(list), uniform: list.every((a) => sameAccess(a, list[0])) };
}

// ───────────────────────────── Granting ─────────────────────────────

export interface Grantor {
  staffId: string;
  isOwner: boolean;
  permissions: ReadonlySet<Permission>;
  maxDiscountPct: number;
  scope: ShopScope;
  shopIds: readonly string[];
}

const missing = (caller: Grantor, perms: Iterable<Permission>) => [...perms].filter((p) => !caller.permissions.has(p));
const youLack = (p: Permission[]) =>
  `You can't grant or remove ${p.length === 1 ? `"${permissionLabel(p[0])}"` : `${p.length} permissions`} because you don't have ${p.length === 1 ? "it" : "them"} yourself`;

/** Creating, editing or deleting a role (before null = create, after null = delete). */
export function roleChangeDenied(caller: Grantor, before: RoleDef | null, after: RoleDef | null): string | null {
  if (!caller.permissions.has("permissions.manage")) return "You can't manage permissions";
  if (caller.scope !== "all") return "Roles apply at every shop, so only people with access to all shops can edit them";
  if (before?.key === OWNER_ROLE_KEY || after?.key === OWNER_ROLE_KEY) return "The Brand Owner role always has every permission and can't be changed";
  if (before?.key && !after) return "Built-in roles can't be deleted. Reset it instead.";
  const next = new Set((after?.permissions ?? []).filter(isPermission));
  const owner = [...next].filter((p) => OWNER_ONLY.has(p));
  if (owner.length) return `Only the Brand Owner can ${permissionLabel(owner[0]).replace(/^Change/, "change")}`;
  const prev = new Set((before?.permissions ?? []).filter(isPermission));
  const changed = [...new Set([...next, ...prev])].filter((p) => next.has(p) !== prev.has(p));
  const lack = missing(caller, changed);
  if (lack.length) return youLack(lack);
  const nextMax = after?.maxDiscountPct ?? 0;
  if (after && nextMax !== (before?.maxDiscountPct ?? 0) && nextMax > caller.maxDiscountPct) return `You can't set a discount limit above your own (${caller.maxDiscountPct}%)`;
  return null;
}

export interface UserAccessState {
  staffId: string;
  isOwner: boolean;
  permissions: ReadonlySet<Permission>;
  maxDiscountPct: number;
  scope: ShopScope;
  shopIds: readonly string[];
}

/** Changing someone's role, per-user overrides or shop access. */
export function userAccessChangeDenied(
  caller: Grantor,
  current: UserAccessState,
  next: UserAccessState & { overrides: Overrides },
  opts: { activeOwners: number },
): string | null {
  if (!caller.permissions.has("permissions.manage")) return "You can't manage permissions";
  if (current.staffId === caller.staffId) return "You can't change your own access. Ask another admin.";
  if (current.isOwner && !caller.isOwner) return "Only the Brand Owner can change a Brand Owner's access";
  if (next.isOwner && !current.isOwner && !caller.isOwner) return "Only the Brand Owner can grant Brand Owner";
  if (current.isOwner && !next.isOwner && opts.activeOwners <= 1) return "This is the only Brand Owner. Make someone else Brand Owner first.";
  if (!caller.isOwner && missing(caller, current.permissions).length) return "This person has access you don't, so ask someone above them";
  const ownerOverride = Object.keys(next.overrides).find((k) => OWNER_ONLY.has(k as Permission) && next.overrides[k as Permission]);
  if (ownerOverride) return "Brand-level settings come only with the Brand Owner role";
  const problem = scopeProblem(next.scope, [...next.shopIds]);
  if (problem) return problem;
  if (caller.scope !== "all") {
    if (current.scope === "all" || current.shopIds.some((s) => !caller.shopIds.includes(s))) return "This person has access to shops outside yours";
    if (next.scope === "all") return "Only people with access to all shops can grant it";
    if (next.shopIds.some((s) => !caller.shopIds.includes(s))) return "You can only give access to your own shops";
  }
  const gained = [...next.permissions].filter((p) => !current.permissions.has(p));
  const lack = missing(caller, gained);
  if (lack.length) return youLack(lack);
  if (next.maxDiscountPct > current.maxDiscountPct && next.maxDiscountPct > caller.maxDiscountPct) return `You can't set a discount limit above your own (${caller.maxDiscountPct}%)`;
  return null;
}

/**
 * Editing someone's profile (name, login, password, shops, active). You can't edit the Brand Owner
 * unless you are one, or anyone who has access you don't, so nobody can lock out or reset a
 * person above them.
 */
export function staffEditDenied(caller: Grantor, target: UserAccessState & { workShopIds: readonly string[] }): string | null {
  if (target.staffId === caller.staffId) return null;
  if (target.isOwner && !caller.isOwner) return "Only the Brand Owner can edit a Brand Owner";
  if (caller.isOwner) return null;
  if (missing(caller, target.permissions).length) return "This person has access you don't, so ask someone above them";
  if (caller.scope !== "all") {
    const theirs = [...new Set([...target.shopIds, ...target.workShopIds])];
    if (target.scope === "all" || !theirs.some((s) => caller.shopIds.includes(s))) return "That person isn't on your shops' team";
  }
  return null;
}

/** Roles this person may give a new hire: no more than they have themselves, and never Brand Owner. */
export function assignableRoles<R extends RoleDef & { id: string }>(caller: Grantor, roles: R[]): R[] {
  return roles.filter((r) => {
    if (r.key === OWNER_ROLE_KEY) return caller.isOwner;
    const a = effectiveAccess(r, {}, null, caller.scope === "all" ? "all" : "selected");
    return missing(caller, a.permissions).length === 0 && a.maxDiscountPct <= caller.maxDiscountPct;
  });
}

export function diffPermissions(before: Iterable<Permission>, after: Iterable<Permission>) {
  const b = new Set(before);
  const a = new Set(after);
  return { added: [...a].filter((p) => !b.has(p)), removed: [...b].filter((p) => !a.has(p)) };
}
