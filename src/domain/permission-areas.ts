import {
  BRAND_LEVEL_ONLY,
  BRAND_ONLY,
  GRANT_ONLY,
  INCLUDES,
  OWNER_GRANTS,
  OWNER_ONLY,
  OverrideExpiry,
  Overrides,
  Permission,
  REPORTS,
  ReportKey,
  SHOP_LOGIN_NEVER,
  ShopScope,
  permissionLabel,
  reportExport,
  reportView,
} from "./permissions";

/**
 * Every permission, grouped by area, with levels: none, own, view, edit, approve or export where a
 * row has them. A level holds its own permissions and every level below it, so picking one sets the
 * whole row. The permissions matrix, "view as" and the effective permissions view all read rows
 * from here; tests check that every permission is in exactly one row.
 */
export const LEVELS = ["none", "own", "view", "edit", "approve", "export", "on"] as const;
export type LevelKey = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<LevelKey, string> = { none: "None", own: "Own", view: "View", edit: "Edit", approve: "Approve", export: "Export", on: "On" };

/** Whose records a level reaches: the person's own, the shops they're assigned, or every shop. */
export const REACHES = ["own", "shops", "all"] as const;
export type Reach = (typeof REACHES)[number];
export const REACH_LABEL: Record<Reach, string> = { own: "Own data only", shops: "Assigned shops", all: "All shops" };

export interface AreaLevel {
  key: LevelKey;
  /** What the level means on this row, when the bare word isn't enough. */
  label: string;
  /** Permissions this level adds to the ones below it. */
  adds: readonly Permission[];
  /** Set where levelReach's rule of thumb would be wrong. */
  reach?: Reach;
}

export interface AreaRow {
  id: string;
  label: string;
  hint?: string;
  levels: readonly AreaLevel[];
}

export interface Area {
  key: string;
  label: string;
  hint?: string;
  rows: readonly AreaRow[];
}

const lv = (key: LevelKey, adds: readonly Permission[] = [], label: string = LEVEL_LABEL[key], reach?: Reach): AreaLevel => ({ key, label, adds, ...(reach ? { reach } : {}) });
const row = (id: string, label: string, levels: AreaLevel[], hint?: string): AreaRow => ({ id, label, levels, hint });
/** A yes/no row. */
const on = (p: Permission, label?: string, hint?: string): AreaRow => row(p, label ?? permissionLabel(p), [lv("none"), lv("on", [p])], hint);
const report = (k: ReportKey): AreaRow => {
  const r = REPORTS.find((x) => x.key === k)!;
  return row(`report.${k}`, r.label, [lv("none"), lv("view", [reportView(k)]), lv("export", [reportExport(k)], "View and export")], "hint" in r ? r.hint : undefined);
};

/** Which reports go in which report area. */
export const REPORT_TYPES = {
  sales: {
    label: "Reports: sales",
    keys: ["my_sales", "sales_summary", "end_of_day", "sales_by_barber", "leaderboard", "services_vs_products", "card_vs_cash", "sales_tax", "discounts_refunds", "gift_cards", "cash_drawer", "analytics", "morning_dashboard"],
  },
  pnl: { label: "Reports: P&L and payouts", keys: ["shop_accounts", "rollup", "tip_payouts"] },
  payroll: { label: "Reports: payroll and labor", keys: ["tips_payroll", "labor", "commission_payout", "attendance"] },
  payroll_pay: {
    label: "Reports: payroll (iSolved)",
    keys: ["payroll_report", "payroll_summary", "payroll_timesheets", "payroll_tips", "payroll_commission", "payroll_full_time", "payroll_aca", "payroll_labor", "payroll_overtime", "payroll_isolved", "payroll_tips_paid", "payroll_w2_codes", "payroll_fica_tip_credit", "payroll_paid_leave"],
  },
  card_fee: { label: "Reports: card fees", keys: ["card_fees"] },
  rebook: { label: "Reports: rebook and retention", keys: ["rebook_rate", "retention", "kpis", "checkout_prompts"] },
  clients: { label: "Reports: clients and marketing", keys: ["client_ratings", "loyalty", "acquisition", "google_reviews", "campaign_center", "openings", "lapsed_clients"] },
  inventory: { label: "Reports: inventory", keys: ["inventory", "inventory_movement", "sell_through", "low_stock", "purchasing"] },
  operations: { label: "Reports: operations", keys: ["operations", "heatmap", "service_times", "appointments", "staffing", "call_ins", "phone_operator", "milestones"] },
} as const satisfies Record<string, { label: string; keys: readonly ReportKey[] }>;

export const AREAS: readonly Area[] = [
  {
    key: "calendar",
    label: "Calendar and booking",
    hint: "Everyone sees and works their own column. All barbers is every column at their shops.",
    rows: [
      row("calendar", "Calendar", [lv("own", [], "Own column"), lv("view", ["calendar.view_all"], "All barbers: view"), lv("edit", ["calendar.manage"], "All barbers: book and change")]),
      on("calendar.squeeze_in", "Squeeze-ins off the grid"),
      on("walkins.manage", "Walk-ins and the waitlist"),
      on("schedules.edit", "Schedules and time off"),
      row("blocks", "Blocking out time", [lv("none"), lv("own", ["blocks.own"]), lv("edit", ["blocks.others"], "Anyone's")]),
      on("blocks.private", "Private block and time off reasons"),
      row("timeoff", "Time off requests", [lv("none"), lv("own", ["timeoff.request"], "Request"), lv("approve", ["timeoff.approve"])]),
      row("callins", "Call-ins", [lv("none"), lv("own", ["callins.mark_own"], "Their own"), lv("edit", ["callins.mark"], "Anyone's")]),
      on("callins.outreach", "Move a called-in barber's clients"),
      on("callins.voice", "Automated calls to clients"),
      on("service_times.correct", "Correct service times"),
    ],
  },
  {
    key: "checkout",
    label: "Checkout, refunds and voids",
    hint: "Dollar limits on discounts, refunds and voids, and card fee waivers are set on the role and per person.",
    rows: [
      row("checkout", "Checkout", [lv("own", [], "Own clients"), lv("edit", ["checkout.any"], "Any barber's clients")]),
      on("sales.view", "See every ticket"),
      on("pos.discount", "Manual discounts", "Up to the percent and dollar limits."),
      on("pos.price_override", "Change menu prices on a ticket"),
      on("pos.custom_charge", "Custom charges"),
      on("pos.waive_card_fee", "Card fee waivers", "Up to the waiver dollar limit."),
      row("refunds", "Refunds", [lv("none", [], "Manager's PIN"), lv("approve", ["sales.refund"])], "Up to the refund dollar limit; above it, a manager's PIN."),
      row("voids", "Voids", [lv("none", [], "Manager's PIN"), lv("approve", ["sales.void"])], "Up to the refund dollar limit; above it, a manager's PIN."),
      row("reassign", "Reassign paid tickets", [lv("none", [], "Manager's PIN"), lv("approve", ["sales.reassign"])]),
      on("handoff.unlock", "Take back a handed-off device"),
      row("giftcards", "Gift cards", [lv("none"), lv("edit", ["giftcards.issue"], "Issue comps"), lv("approve", ["giftcards.void"], "Issue and void")]),
      row("memberships", "Memberships", [lv("none"), lv("edit", ["memberships.sell"], "Sell and cancel"), lv("approve", ["memberships.manage"], "Set up plans")]),
    ],
  },
  {
    key: "drawer",
    label: "Cash drawer",
    rows: [on("drawer.manage", "Open, count and close the drawer"), on("drawer.no_sale", "Open the drawer with no sale")],
  },
  {
    key: "clients",
    label: "Client profiles, notes and contact info",
    hint: "Which client details each role sees is set under Client data protection. Every reveal and every view of contact details is logged.",
    rows: [
      row("client_lookup", "Client lookup", [lv("own", [], "Their shops' clients", "shops"), lv("view", ["clients.view_all"], "Every client", "all")]),
      row("client_edit", "Client profiles", [lv("view", [], "View", "shops"), lv("edit", ["clients.edit"])]),
      on("clients.family", "Family members"),
      on("clients.merge", "Merge duplicates"),
      row("notes", "Client notes", [lv("none"), lv("view", ["notes.view"]), lv("edit", ["notes.write"], "Write their own"), lv("approve", ["notes.edit_any"], "Manage anyone's")]),
      on("notes.private", "Private manager notes"),
      row("contact", "Contact info", [lv("none", [], "Masked or hidden"), lv("view", ["clients.reveal"], "Reveal with a reason"), lv("on", ["clients.contact_full"], "In full (contact access grant)")]),
      on("clients.message", "Call and text through the shop line"),
      on("inbox.view", "The shop's text inbox"),
      row("ratings", "Ratings", [lv("none"), lv("own", ["clients.rate"], "Rate their own visits"), lv("view", ["clients.ratings_all"], "Every rating"), lv("approve", ["clients.ratings_moderate"], "Remove ratings")]),
      on("clients.filters", "Advanced client filters"),
      on("clients.saved_searches", "Saved searches"),
      on("loyalty.grant", "Courtesy loyalty rewards"),
    ],
  },
  {
    key: "client_export",
    label: "Client export",
    hint: "Brand-level roles only. Anyone else only with a contact access grant.",
    rows: [on("clients.export", "Export the client list"), on("campaign_center.export", "Export a campaign audience")],
  },
  {
    key: "staff",
    label: "Staff profiles",
    rows: [
      row("staff", "Staff profiles", [lv("none"), lv("view", ["staff.view"]), lv("edit", ["staff.manage"])]),
      on("staff.contact", "Staff phone and email"),
      on("milestones.view", "Everyone's milestones"),
      on("barber_groups.manage", "Barber groups"),
    ],
  },
  {
    key: "pay",
    label: "Staff pay rates and commissions",
    hint: "Brand only to start: no location role has these.",
    rows: [
      on("payroll.rates", "Pay rates and labor cost"),
      row("compensation", "Employees' compensation", [lv("none"), lv("view", ["compensation.view"]), lv("edit", ["compensation.edit"])]),
      on("compensation.own", "Their own pay"),
      on("compensation.settings", "Compensation setup"),
    ],
  },
  {
    key: "time",
    label: "Time clock and timesheets",
    rows: [
      on("timeclock.punch", "Clock in and out"),
      on("timeclock.kiosk", "Front-desk clock"),
      row("timesheets", "Timesheets", [lv("none"), lv("own", ["timesheet.own"]), lv("edit", ["timesheet.edit"], "Fix punches"), lv("approve", ["timesheet.approve"], "Fix and approve")]),
      row("payroll", "Payroll", [lv("none"), lv("edit", ["payroll.run"], "Run payroll"), lv("approve", ["payroll.approve"], "Run, approve and lock")]),
    ],
  },
  {
    key: "tips",
    label: "Tip payouts",
    rows: [
      row("tips", "Tip payouts", [lv("none"), lv("own", ["tips.own"]), lv("approve", ["tips.approve"])]),
      on("tips.settings", "Tip payout settings"),
      row("payouts", "Payout tracker", [lv("none"), lv("view", ["payouts.view"]), lv("edit", ["payouts.manage"], "Manage")]),
      on("payouts.chain", "Payout tracker for every shop"),
    ],
  },
  {
    key: "inventory",
    label: "Inventory and products",
    rows: [
      on("inventory.manage", "Par levels and alerts"),
      on("inventory.adjust", "Adjust stock"),
      on("inventory.transfer", "Transfers"),
      on("inventory.stocktake", "Counts and stocktakes"),
      on("vendors.manage", "Vendors"),
      row("po", "Purchase orders", [lv("none"), lv("edit", ["po.create"]), lv("approve", ["po.approve"])]),
      on("po.send", "Send purchase orders"),
      on("po.receive", "Receive deliveries"),
    ],
  },
  {
    key: "services",
    label: "Services and pricing",
    rows: [
      row("catalog", "Services and prices", [lv("none"), lv("edit", ["catalog.prices"], "At their shops"), lv("approve", ["catalog.manage"], "The brand catalog")]),
      on("scheduling.timing", "Slot intervals and service timing"),
    ],
  },
  {
    key: "reports_scope",
    label: "Reports: whose numbers and dollar amounts",
    hint: "For every report below, custom reports, CSV downloads and Rayz Assistant. Which reports they open is set report by report.",
    rows: [
      row(
        "report_scope",
        "Report scope",
        [lv("own", [], "Own numbers", "own"), lv("view", ["reports.all_staff"], "Their shops", "shops"), lv("approve", ["reports.all_shops"], "Every shop", "all")],
        "Own numbers: reports that break down by barber show only theirs. Every shop: reports cover all shops even when they work at a few.",
      ),
      on("reports.money", "Dollar amounts", "Off: counts, rates and hours only, with every dollar amount hidden, on screen and in downloads."),
    ],
  },
  ...Object.entries(REPORT_TYPES).map(([key, t]) => ({ key: `reports_${key}`, label: t.label, rows: t.keys.map((k) => report(k)) })),
  {
    key: "custom_reports",
    label: "Reports: custom",
    rows: [
      row("report_builder", "Custom reports", [lv("none"), lv("view", ["report_builder.view"], "Open"), lv("edit", ["report_builder.build"], "Build and share"), lv("export", ["report_builder.export"], "Build and export")]),
      on("analytics.events", "Event log in custom reports"),
    ],
  },
  {
    key: "campaign_center",
    label: "Campaign Center",
    rows: [
      row("campaigns", "Campaigns and blasts", [lv("none"), lv("view", ["campaign_center.view"]), lv("edit", ["campaign_center.create"], "Create"), lv("approve", ["campaign_center.send"], "Create and send")]),
      on("campaign_center.openings", "We have openings"),
      on("campaign_center.own_clients", "Their own lapsed clients"),
      on("clients.campaigns", "Texts from Today"),
      on("promos.manage", "Promo codes"),
    ],
  },
  {
    key: "settings",
    label: "Settings",
    rows: [
      on("settings.shop", "Every shop setting"),
      on("settings.shop_details", "Shop details"),
      on("settings.shop_hours", "Hours and closures"),
      on("settings.shop_booking", "Booking rules"),
      on("settings.shop_checkout", "Checkout"),
      on("settings.shop_phone", "Phone line"),
      on("settings.taxes", "Tax rates"),
      on("settings.card_fee", "Credit card fee"),
      on("blocks.reasons", "Block reasons"),
      on("settings.lists", "Message wording and pick lists"),
      on("checkout_prompts.manage", "Checkout prompts"),
      on("handoff.settings", "Tip presets"),
      on("badges.settings", "Client badges"),
      on("milestones.settings", "Staff milestones"),
      on("analytics.settings", "Event log settings"),
      on("assistant.settings", "Rayz Assistant"),
      row("notifications", "Notification outbox", [lv("none"), lv("view", ["notifications.view"]), lv("edit", ["notifications.send"], "Send now")]),
      on("settings.brand", "Brand-level settings"),
    ],
  },
  {
    key: "app_config",
    label: "App config",
    rows: [on("settings.app", "Customer app switches")],
  },
  {
    key: "banking",
    label: "Stripe and banking",
    rows: [on("payments.accounts", "Payment setup and Stripe status"), on("payments.banking", "Connect or change bank and Stripe accounts")],
  },
  {
    key: "integrations",
    label: "Integrations and exports",
    rows: [
      on("payroll.export", "iSolved payroll export"),
      on("exports.accounting", "QuickBooks journal"),
      on("analytics.export", "Raw event log download"),
      on("import.run", "Squire import"),
    ],
  },
  {
    key: "locations",
    label: "Location wizard",
    rows: [on("locations.setup", "Add, open, close and archive locations"), on("locations.manage", "Location groups")],
  },
  {
    key: "access",
    label: "Roles and permissions",
    rows: [
      on("permissions.manage", "Roles, permissions and shop access"),
      on("logins.manage", "Shop logins"),
      on("clients.privacy", "Client data rules and who viewed client data"),
      on("network.settings", "Where staff can sign in from"),
      on("devices.approve", "Approve trusted devices"),
      on("access.remote", "Sign in remotely"),
    ],
  },
  { key: "audit", label: "Audit log", rows: [report("audit_log")] },
];

export const AREA_ROWS: readonly (AreaRow & { area: Area })[] = AREAS.flatMap((a) => a.rows.map((r) => ({ ...r, area: a })));

/** Every permission a row touches. */
export const rowPermissions = (r: AreaRow): Permission[] => r.levels.flatMap((l) => [...l.adds]);

/** The permissions a level holds: its own and every level below it. */
export const levelPermissions = (r: AreaRow, i: number): Permission[] => r.levels.slice(0, i + 1).flatMap((l) => [...l.adds]);

/**
 * How far a level reaches, or null when it gives nothing or reaches as far as the report scope row
 * says (reports). "Own" levels are the person's own; brand-only and Brand Owner permissions work
 * on every shop; the rest work at the shops they're assigned.
 */
export function levelReach(r: AreaRow, i: number): Reach | null {
  const l = r.levels[i];
  if (!l) return null;
  if (l.reach) return l.reach;
  if (l.key === "none") return null;
  if (l.key === "own") return "own";
  const perms = levelPermissions(r, i);
  if (!perms.length || perms.every(followsScope)) return null;
  return perms.some((p) => BRAND_ONLY.has(p) || OWNER_ONLY.has(p)) ? "all" : "shops";
}

/** The reports and dollar amounts reach as far as the report scope row says; custom reports stay at their shops. */
const followsScope = (p: Permission) => p.startsWith("report.") || p === "reports.money";
export const followsReportScope = (r: AreaRow) => rowPermissions(r).every(followsScope);

/** How far this row reaches with these permissions: its level's reach, or the report scope for reports. For someone with every shop, their shops are all shops. */
export function heldReach(r: AreaRow, perms: ReadonlySet<Permission>, brandWide = false): Reach | null {
  const i = levelIndex(r, perms);
  if (i <= 0 && r.levels[0]?.key === "none") return null;
  if (followsReportScope(r)) return reportReach(perms, brandWide);
  const reach = i < 0 ? null : levelReach(r, i);
  return brandWide && reach === "shops" ? "all" : reach;
}

/** Whose numbers and which shops their reports cover. */
export const reportReach = (perms: ReadonlySet<Permission>, brandWide = false): Reach =>
  !perms.has("reports.all_staff") && !perms.has("reports.all_shops") ? "own" : brandWide || perms.has("reports.all_shops") ? "all" : "shops";

/** The level these permissions match on the row, or -1 when they match none ("custom"). */
export function levelIndex(r: AreaRow, perms: ReadonlySet<Permission>): number {
  const held = new Set(rowPermissions(r).filter((p) => perms.has(p)));
  for (let i = r.levels.length - 1; i >= 0; i--) {
    const need = levelPermissions(r, i);
    if (need.length === held.size && need.every((p) => held.has(p))) return i;
  }
  return -1;
}

/** These permissions with the row set to one level. */
export function withLevel(r: AreaRow, perms: ReadonlySet<Permission>, i: number): Set<Permission> {
  const next = new Set(perms);
  for (const p of rowPermissions(r)) next.delete(p);
  for (const p of levelPermissions(r, i)) next.add(p);
  return next;
}

/** Why a level can't be picked for a role, if it can't: the first permission in it that may not be given. */
export function levelBlocked(r: AreaRow, i: number, blocked: (p: Permission) => string | null): string | null {
  for (const p of levelPermissions(r, i)) {
    const why = blocked(p);
    if (why) return why;
  }
  return null;
}

/** Search: a row matches on its label, its area, its levels or any of its permissions' labels and keys. */
export function rowMatches(r: AreaRow & { area: Area }, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const text = [r.label, r.hint ?? "", r.area.label, ...r.levels.map((l) => l.label), ...rowPermissions(r).flatMap((p) => [p, permissionLabel(p)])].join(" ").toLowerCase();
  return s.split(/\s+/).every((w) => text.includes(w));
}

export interface SourceContext {
  isOwner: boolean;
  /** Their final permissions at this shop. */
  held: ReadonlySet<Permission>;
  /** What the role itself lists (as this shop runs it). */
  fromRole: ReadonlySet<Permission>;
  overrides: Overrides;
  expires: OverrideExpiry;
  /** Permissions only a contact access grant gives them. */
  granted: ReadonlySet<Permission>;
  scope: ShopScope;
  brandLevel: boolean;
  shopLogin: boolean;
  /** Their role here belongs to an owner entity that doesn't own this shop. */
  ownerMismatch: boolean;
}

export type SourceKind = "owner" | "role" | "allowed" | "denied" | "grant" | "included" | "blocked" | "none";
export interface Source {
  kind: SourceKind;
  text: string;
}

/** Why a permission the role or an override gives isn't in force, if it isn't. */
export function blockedBecause(p: Permission, c: Pick<SourceContext, "held" | "scope" | "brandLevel" | "shopLogin" | "ownerMismatch">): string | null {
  if (c.ownerMismatch) return "their role here belongs to another owner";
  if (OWNER_ONLY.has(p)) return "Brand Owner only";
  if (GRANT_ONLY.has(p)) return "only with a contact access grant";
  if (BRAND_LEVEL_ONLY.has(p) && !c.brandLevel) return "brand-level roles only";
  if (BRAND_ONLY.has(p) && c.scope !== "all") return "needs access to all shops";
  if (c.shopLogin && SHOP_LOGIN_NEVER.has(p)) return "never for a shared shop login";
  const report = p.match(/^report\.(.+)\.export$/);
  if (report && !c.held.has(`report.${report[1]}.view` as Permission)) return "needs the report's view permission";
  if (p === "exports.accounting" && !c.held.has(reportView("sales_summary"))) return "needs the Sales summary report";
  if (p === "exports.accounting" && !c.held.has("reports.money")) return "needs dollar amounts in reports";
  if (p === "report_builder.export" && !c.held.has("report_builder.view") && !c.held.has("report_builder.build")) return "needs custom reports";
  return null;
}

/** Where a permission comes from at a shop: the role, an override (with its end date), a grant, or why it's off. */
export function permissionSource(p: Permission, c: SourceContext): Source {
  if (c.isOwner) return { kind: "owner", text: "Brand Owner: every permission" };
  const held = c.held.has(p);
  const o = c.overrides[p];
  const until = c.expires[p] ? ` until ${c.expires[p]}` : "";
  if (held && c.granted.has(p)) return { kind: "grant", text: "Contact access grant" };
  if (o === false) return { kind: "denied", text: `Denied for them${until}` };
  if (o === true) return held ? { kind: "allowed", text: `Allowed for them${until}` } : { kind: "blocked", text: `Allowed for them${until}, but off: ${blockedBecause(p, c) ?? "not available"}` };
  if (c.fromRole.has(p)) return held ? { kind: "role", text: "From the role" } : { kind: "blocked", text: `The role has it, but off: ${blockedBecause(p, c) ?? "not available"}` };
  if (held) {
    const via = INCLUDES.find(([q, x]) => x === p && c.held.has(q));
    return { kind: "included", text: via ? `Comes with "${permissionLabel(via[0])}"` : "Always on for this role" };
  }
  return { kind: "none", text: "Not given" };
}

/** A short tag for permissions with rules of their own. */
export function permissionTag(p: Permission): string | null {
  if (OWNER_ONLY.has(p)) return "Brand Owner only";
  if (GRANT_ONLY.has(p)) return "Contact access grant only";
  if (BRAND_LEVEL_ONLY.has(p)) return "Brand-level only";
  if (OWNER_GRANTS.has(p)) return "Brand Owner grants";
  if (BRAND_ONLY.has(p)) return "All shops only";
  return null;
}
