/**
 * Granular staff permissions. Pure: the catalog, the role templates, how a user's effective
 * permissions are worked out, and who may grant what. Server code loads the rows and calls these.
 */

export const PERMISSION_GROUPS = ["Front desk", "Point of sale", "Clients", "Campaign Center", "Catalog and inventory", "Staff", "Custom reports", "Settings and data"] as const;
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
  /** Not in any role but Brand Owner to start, and only the Brand Owner can grant or remove it. */
  ownerGrants?: boolean;
}

export const FEATURE_PERMISSIONS = [
  { key: "calendar.manage", group: "Front desk", label: "Book, move and change any barber's appointments", hint: "Without it, people work only in their own column." },
  { key: "walkins.manage", group: "Front desk", label: "Run walk-ins and the waitlist" },
  { key: "schedules.edit", group: "Front desk", label: "Edit schedules and time off" },
  {
    key: "blocks.own",
    group: "Front desk",
    label: "Block out their own time: lunch, breaks, the bank, the doctor...",
    hint: "Within the shop's limits, such as the longest lunch. Every block is logged.",
  },
  { key: "blocks.others", group: "Front desk", label: "Block out time for anyone at their shops", hint: "Not held to the self-service limits. Every block is logged." },
  { key: "timeoff.request", group: "Front desk", label: "Request time off", hint: "With the shop's minimum notice. Requests wait for a manager unless the shop approves them automatically." },
  {
    key: "timeoff.approve",
    group: "Front desk",
    label: "Approve and deny time off requests at their shops",
    hint: "Never their own request. Shows the appointments the time off affects so they can be moved or the clients asked to reschedule.",
  },
  {
    key: "blocks.private",
    group: "Front desk",
    label: "See private block and time off reasons",
    hint: "Reasons marked private, such as Doctor, show as \"Blocked\" or \"Time off\" to everyone else. People always see their own.",
  },
  {
    key: "callins.mark",
    group: "Front desk",
    label: "Mark a barber as called in: sick, an emergency or another reason",
    hint: "For anyone at their shops. Writes the time off and lists every booked appointment in it.",
  },
  { key: "callins.mark_own", group: "Front desk", label: "Mark themselves as called in", hint: "Off for barbers unless granted. A manager handles the clients." },
  {
    key: "callins.outreach",
    group: "Front desk",
    label: "Move a called-in barber's clients and text or email them a rebook link",
    hint: "Reassigns to a free barber or sends a sorry message with a one-tap rebook link. Opt-ins and quiet hours always apply.",
  },
  { key: "callins.voice", group: "Front desk", label: "Place automated calls to a called-in barber's clients", hint: "A text-to-speech call: press 1 for the rebook link by text, 2 for the shop." },
  {
    key: "inbox.view",
    group: "Clients",
    label: "Read and answer the shop's text inbox",
    hint: "Replies go out from the shop number. The client's number is shown only as their phone setting in Client data allows.",
  },
  { key: "blocks.reasons", group: "Settings and data", label: "Edit the block reasons list", hint: "The reasons, their calendar colors and which are private. Brand-wide." },
  {
    key: "calendar.squeeze_in",
    group: "Front desk",
    label: "Squeeze in an appointment off the time grid, into buffer time or outside hours",
    hint: "Never on top of another appointment's service time or time off. Every squeeze-in is logged.",
  },
  {
    key: "service_times.correct",
    group: "Front desk",
    label: "Correct recorded service times and choose which count in reports",
    hint: "Arrival, start and finish times on any appointment at their shops. Every correction is logged with the reason.",
  },
  { key: "checkout.any", group: "Point of sale", label: "Open tickets and check out any barber's clients", hint: "Without it, people check out only their own clients." },
  { key: "pos.discount", group: "Point of sale", label: "Give manual discounts", hint: "Up to the role's discount limit." },
  { key: "pos.price_override", group: "Point of sale", label: "Change a menu price on a ticket" },
  {
    key: "handoff.unlock",
    group: "Point of sale",
    label: "Take back a device handed to a client, where the location asks for a manager PIN",
    hint: "With their own time clock PIN. Locations that accept any staff PIN don't need it.",
  },
  { key: "sales.view", group: "Point of sale", label: "See every ticket at their shops" },
  { key: "sales.refund", group: "Point of sale", label: "Refund and void tickets" },
  { key: "drawer.manage", group: "Point of sale", label: "Open and close the cash drawer" },
  { key: "promos.manage", group: "Point of sale", label: "Create and turn off promo codes", hint: "The Campaign Center's coupons. Brand only unless granted." },
  { key: "giftcards.issue", group: "Point of sale", label: "Issue comp gift cards" },
  { key: "giftcards.void", group: "Point of sale", label: "Void gift cards" },
  { key: "clients.view_all", group: "Clients", label: "Look up any client in the brand", hint: "Without it, only clients of their shops, and full profiles only for clients they've served." },
  {
    key: "clients.reveal",
    group: "Clients",
    label: "Reveal a masked client detail, with a reason",
    hint: "Which details are masked or hidden is set under Client data. Every reveal is logged with the reason.",
  },
  { key: "clients.message", group: "Clients", label: "Call and text clients through the shop line", hint: "The number stays hidden; calls and texts go through the system." },
  { key: "clients.export", group: "Clients", label: "Export the client list", hint: "Off for everyone but the Brand Owner unless granted. Every export is logged.", brandOnly: true },
  { key: "clients.edit", group: "Clients", label: "Add clients and edit client details", hint: "Which details they can add or edit is set in Client data protection, apart from which they can see." },
  { key: "clients.merge", group: "Clients", label: "Merge duplicate clients", brandOnly: true },
  {
    key: "clients.filters",
    group: "Clients",
    label: "Use advanced client filters",
    hint: "Visit history, barbers, locations, spend, loyalty, profile and messaging filters on the client list. A filter on a detail they can't see (birthday, address, rating...) isn't offered.",
  },
  {
    key: "clients.saved_searches",
    group: "Clients",
    label: "Save client searches and share them",
    hint: "Saved searches keep the search and its filters. Shared with their location, or with every location for people with access to all shops.",
  },
  { key: "clients.rate", group: "Clients", label: "Rate clients" },
  { key: "clients.ratings_all", group: "Clients", label: "See every rating and note, and rate any visit at their shops", hint: "Without it, people see their own ratings and rate only visits they served." },
  { key: "clients.ratings_moderate", group: "Clients", label: "Remove anyone's rating" },
  { key: "loyalty.grant", group: "Clients", label: "Grant courtesy loyalty rewards" },
  {
    key: "clients.campaigns",
    group: "Clients",
    label: "Text clients about open chairs and overdue rebooks",
    hint: "From Today. Only clients who agreed to marketing texts or emails, outside quiet hours, and never the same client twice in a week.",
  },
  {
    key: "campaign_center.openings",
    group: "Campaign Center",
    label: "Campaign Center: We have openings",
    hint: "Pick a barber and today or tomorrow, and text or email that barber's regulars and recent clients who agreed to marketing that they have openings, first come, first served. Counts only, never names, numbers or a list to export. Quiet hours, the brand's openings frequency cap and each location's send limits apply, and the brand can require its approval.",
  },
  {
    key: "campaign_center.view",
    group: "Campaign Center",
    label: "Campaign Center: view",
    hint: "See automated campaigns, blasts and what they sent at their shops. Counts only, never contact lists. Brand only unless granted.",
  },
  {
    key: "campaign_center.create",
    group: "Campaign Center",
    label: "Campaign Center: create",
    hint: "Write campaign wording, pick coupons, build segments, draft blasts and send tests. With access to all shops, also the brand's version of each campaign, blasts to every location and the Campaign Center settings: quiet hours, frequency limits, the postal address, and the We have openings rules. Brand only unless granted.",
  },
  {
    key: "campaign_center.send",
    group: "Campaign Center",
    label: "Campaign Center: send",
    hint: "Switch automated campaigns on or off at their shops, and send, schedule or cancel blasts. Only to clients who agreed to marketing, outside quiet hours and within the brand's frequency limits. With access to all shops, also approve locations' We have openings blasts when the brand requires it. Brand only unless granted.",
  },
  {
    key: "campaign_center.export",
    group: "Campaign Center",
    label: "Campaign Center: export",
    hint: "Export a campaign audience's contact list. Off for everyone but the Brand Owner unless granted. Details are exported as Client data lets them see them, and every export is logged.",
    brandOnly: true,
  },
  {
    key: "campaign_center.own_clients",
    group: "Campaign Center",
    label: "Campaign Center: own lapsed clients",
    hint: "See their own lapsed clients (first name, last visit, weeks since) and send them the brand's \"From your barber\" message, signed with their name. Never shows a phone number or email; only clients who agreed to marketing get it, within quiet hours and the frequency limits. Off for locations and barbers unless granted.",
  },
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
    key: "access.remote",
    group: "Staff",
    label: "Can access remotely: sign in from anywhere, even at locations that only allow sign-in from the shop",
    hint: "Exempt from each location's network and device rule. Only the Brand Admin role has it to start; give it to the managers who work from home.",
  },
  {
    key: "devices.approve",
    group: "Staff",
    label: "Approve trusted devices for signing in at their shops",
    hint: "For locations that accept approved devices. Never a device they asked for themselves.",
  },
  {
    key: "reports.all_staff",
    group: "Staff",
    label: "See every barber's numbers in reports",
    hint: "Without it, reports that break down by barber show only the person's own tickets, appointments, tips and ratings.",
  },
  { key: "barber_groups.manage", group: "Staff", label: "Create and edit saved barber groups for reports", brandOnly: true },
  {
    key: "payroll.run",
    group: "Staff",
    label: "Run payroll: hours, pay rates, iSolved numbers, pay groups and calendars, overrides and the iSolved downloads",
    hint: "Sees every barber's pay at every shop. Downloads open once a period is approved and locked.",
    brandOnly: true,
  },
  { key: "payroll.approve", group: "Staff", label: "Approve and lock a pay period", hint: "Blocked while any total doesn't reconcile.", brandOnly: true },
  {
    key: "timeclock.punch",
    group: "Staff",
    label: "Clock in and out and take breaks",
    hint: "From their own phone, held to the shop's device, GPS or network rule, or with their PIN on the shop's front-desk clock.",
  },
  { key: "timeclock.kiosk", group: "Staff", label: "Open the shop's front-desk time clock", hint: "On a registered device, where staff punch with their own PIN." },
  { key: "timesheet.own", group: "Staff", label: "See and sign off their own timesheet", hint: "Their punches, breaks, scheduled against actual hours and overtime." },
  {
    key: "timesheet.edit",
    group: "Staff",
    label: "Fix punches at their shops: edit, add or void, with a reason",
    hint: "Never their own. Every change is logged with the before and after, and clears that timesheet's approvals.",
  },
  {
    key: "timesheet.approve",
    group: "Staff",
    label: "Approve timesheets and lock pay periods at their shops",
    hint: "Never their own. A period locks once every timesheet in it is approved; then nobody can punch into it or edit it.",
  },
  { key: "payroll.rates", group: "Staff", label: "See pay rates and labor cost", hint: "Hourly rates, labor cost and labor % of sales in reports. Without it, reports show hours only." },
  { key: "payroll.export", group: "Staff", label: "Download the payroll export (CSV and the iSolved layout)", hint: "Per pay period, per employee and shop. Every download is logged." },
  { key: "tips.own", group: "Staff", label: "See their own tips and payouts, and choose how they're paid", hint: "Tips today, pending, paid out and history; Stripe payout setup where the brand allows it." },
  {
    key: "tips.approve",
    group: "Staff",
    label: "Review and approve tip payouts at their shops",
    hint: "Build and approve batches, hold or adjust a payout with a reason, and pay cash tips from the drawer at close. Every change is logged.",
  },
  {
    key: "tips.settings",
    group: "Staff",
    label: "Change tip payout settings",
    hint: "Each shop's payout schedule, card settlement delay, default method and card fee netting, and the brand's allowed methods.",
    brandOnly: true,
  },
  {
    key: "report_builder.view",
    group: "Custom reports",
    label: "Custom reports: open saved reports",
    hint: "Their own reports, reports shared with their role and the brand's templates. Each runs on their own locations and barbers, with client details as Client data lets them see them.",
  },
  {
    key: "report_builder.build",
    group: "Custom reports",
    label: "Custom reports: build, save, share and schedule reports",
    hint: "Pick the columns, filters, grouping and totals, save the report for themselves or share it with roles, and email it on a schedule. With access to all shops, also the brand's templates.",
  },
  {
    key: "report_builder.export",
    group: "Custom reports",
    label: "Custom reports: export to CSV, Excel and PDF",
    hint: "Also what a scheduled email attaches. Customer reports also need \"Export the client list\". Every export is logged.",
  },
  { key: "settings.shop", group: "Settings and data", label: "Edit shop info, weekday hours, closures and booking rules" },
  { key: "settings.taxes", group: "Settings and data", label: "Edit tax rates and card fees" },
  {
    key: "scheduling.timing",
    group: "Settings and data",
    label: "Set booking slot intervals and service timing at their shops",
    hint: "Each shop's and barber's interval, service durations, buffers and per-barber times. With access to all shops, also the brand default interval and the brand service timing.",
  },
  {
    key: "payments.accounts",
    group: "Settings and data",
    label: "Set up each shop's Stripe account for card payments and payouts, and choose who owns each shop",
    hint: "Sees each shop's payment setup and Stripe status, refreshes it, and manages owner entities. Connecting or changing a shop's bank or Stripe account needs the banking permission.",
    brandOnly: true,
  },
  {
    key: "payments.banking",
    group: "Settings and data",
    label: "Connect or change a shop's banking and Stripe account",
    hint: "Choose the brand account, the shop's own account or cash only; start or redo Stripe onboarding (legal entity, EIN, owner, bank account); open the shop's Stripe dashboard; set the statement descriptor. Only the Brand Owner can grant it.",
    ownerGrants: true,
  },
  { key: "settings.brand", group: "Settings and data", label: "Change brand-level settings: loyalty program, new shops, Sunday hours", ownerOnly: true },
  { key: "import.run", group: "Settings and data", label: "Run the Squire import", brandOnly: true },
  {
    key: "clients.privacy",
    group: "Settings and data",
    label: "Set which client details each role and person sees, and see who viewed client data",
    brandOnly: true,
  },
  { key: "notifications.view", group: "Settings and data", label: "See the notification outbox" },
  { key: "notifications.send", group: "Settings and data", label: "Send due notifications now" },
  { key: "locations.manage", group: "Settings and data", label: "Create and edit saved location groups for reports", brandOnly: true },
  {
    key: "locations.setup",
    group: "Settings and data",
    label: "Add, open, temporarily close and archive locations",
    hint: "The Add Location wizard, go-live and archiving. Archived shops keep their history in reports.",
    brandOnly: true,
  },
  { key: "settings.lists", group: "Settings and data", label: "Edit client message wording, pick lists and the Morning Dashboard email", brandOnly: true },
  {
    key: "handoff.settings",
    group: "Settings and data",
    label: "Set the brand's tip presets for the customer screen",
    hint: "The percent or dollar buttons every location uses unless it sets its own. Each location's screen rules are shop settings.",
    brandOnly: true,
  },
  {
    key: "network.settings",
    group: "Settings and data",
    label: "Set where staff can sign in from: each location's allowed networks and devices",
    hint: "Turn each location's sign-in restriction on or off, edit its allowed IPs, approve or remove devices at any shop, and set the blocked sign-in alert.",
    brandOnly: true,
  },
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
  { key: "shop_accounts", label: "Shop P&L by Stripe account", href: "/admin/reports/shop-accounts", hint: "Each shop's card sales, fees, refunds, tips and payouts through its own connected account, grouped by owner." },
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
  {
    key: "service_times",
    label: "Service times",
    href: "/admin/reports/service-times",
    hint: "Actual time in the chair against the booked time, per barber, service and shop, with wait times and suggested booked durations.",
  },
  { key: "staffing", label: "Who's working, off and blocked", href: "/admin/reports/staffing", hint: "Per day, shop and barber: scheduled hours, time off, blocked time and bookings." },
  { key: "call_ins", label: "Call-ins and client outreach", href: "/admin/reports/call-ins", hint: "Call-ins by shop and barber, the appointments they hit, and how many clients were moved, rebooked, declined or never answered." },
  {
    key: "google_reviews",
    label: "Google review links",
    href: "/admin/reports/reviews",
    hint: "Review follow-ups sent and clicks on each location's Google review link, from receipts and follow-ups, by location and barber.",
  },
  {
    key: "campaign_center",
    label: "Campaign Center",
    href: "/admin/reports/campaign-center",
    hint: "Per campaign, location and barber: messages sent and delivered, clicks, bookings, coupon redemptions, attributed revenue, ROI and unsubscribes.",
  },
  {
    key: "openings",
    label: "We have openings",
    href: "/admin/reports/openings",
    hint: "Each openings blast: the barber and days, who sent it, open times at send, messages sent, clicks, and the bookings recipients made with that barber in those days.",
  },
  {
    key: "lapsed_clients",
    label: "Lapsed clients by barber",
    href: "/admin/reports/lapsed-clients",
    hint: "Per barber and location: lapsed clients by weeks since their last visit, lapsed messages sent, and how many of those clients rebooked.",
  },
  {
    key: "labor",
    label: "Labor hours and cost",
    href: "/admin/reports/labor",
    hint: "Clocked hours per shop and barber, sales per labor hour, and (with pay rates) labor cost and labor % of sales.",
  },
  { key: "attendance", label: "Attendance", href: "/admin/reports/attendance", hint: "Late clock-ins, early clock-outs, missed punches and forgotten clock-outs against the schedule." },
  { key: "cash_drawer", label: "Cash drawer", href: "/admin/reports/cash-drawer" },
  {
    key: "tip_payouts",
    label: "Tip payouts",
    href: "/admin/reports/tip-payouts",
    hint: "Tips earned, refunded and adjusted per shop and employee, and how they were paid: cash, Stripe or payroll, with what's still pending.",
  },
  {
    key: "morning_dashboard",
    label: "Morning Dashboard",
    href: "/admin/morning",
    hint: "Yesterday's numbers with week to date and the same day last week, today's schedule and the exceptions to handle, in the app and as the morning email. Each section shows only what the person's other reports allow; export is the PDF.",
  },
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
export const OWNER_GRANTS = new Set<Permission>(FEATURE_PERMISSIONS.filter((p) => "ownerGrants" in p && p.ownerGrants).map((p) => p.key));
/**
 * A Brand Admin with access to all shops always has these: every client, every search field and
 * filter, the Campaign Center and every report, at every location. Exports stay the Brand Owner's to give.
 */
export const BRAND_ADMIN_ALWAYS = new Set<Permission>([
  "clients.view_all",
  "clients.filters",
  "clients.saved_searches",
  "reports.all_staff",
  "campaign_center.openings",
  "campaign_center.view",
  "campaign_center.create",
  "campaign_center.send",
  "campaign_center.own_clients",
  "report_builder.view",
  "report_builder.build",
  ...REPORTS.map((r) => reportView(r.key)),
]);

/**
 * The Campaign Center beyond "We have openings": coupons, automated campaigns, segments, blasts,
 * exports and barbers' own outreach, with its reports. No location role has these to start; the
 * brand grants them in a role or per person.
 */
export const BRAND_CAMPAIGN_CENTER = new Set<Permission>([
  "promos.manage",
  "campaign_center.view",
  "campaign_center.create",
  "campaign_center.send",
  "campaign_center.export",
  "campaign_center.own_clients",
  "report.campaign_center.view",
  "report.campaign_center.export",
  "report.lapsed_clients.view",
  "report.lapsed_clients.export",
]);

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
export const BRAND_ADMIN_ROLE_KEY = "brand_admin";

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
const LOCATION_REPORTS = ALL_REPORTS.filter((k) => !BRAND_CAMPAIGN_CENTER.has(reportView(k)));
const MANAGER_FEATURES: FeaturePermission[] = [
  "calendar.manage",
  "walkins.manage",
  "schedules.edit",
  "checkout.any",
  "pos.discount",
  "pos.price_override",
  "handoff.unlock",
  "sales.view",
  "sales.refund",
  "drawer.manage",
  "giftcards.issue",
  "clients.view_all",
  "clients.reveal",
  "clients.message",
  "clients.edit",
  "clients.rate",
  "clients.ratings_all",
  "clients.filters",
  "clients.saved_searches",
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
  "scheduling.timing",
  "calendar.squeeze_in",
  "service_times.correct",
  "blocks.own",
  "blocks.others",
  "timeoff.request",
  "timeoff.approve",
  "blocks.private",
  "blocks.reasons",
  "callins.mark",
  "callins.outreach",
  "callins.voice",
  "inbox.view",
  "notifications.view",
  "reports.all_staff",
  "clients.campaigns",
  "campaign_center.openings",
  "timeclock.punch",
  "timeclock.kiosk",
  "timesheet.own",
  "timesheet.edit",
  "timesheet.approve",
  "tips.own",
  "tips.approve",
  "devices.approve",
  "report_builder.view",
  "report_builder.build",
  "report_builder.export",
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
    permissions: ALL_PERMISSIONS.filter((p) => !OWNER_ONLY.has(p) && !OWNER_GRANTS.has(p) && p !== "clients.export" && p !== "campaign_center.export"),
    maxDiscountPct: 100,
  },
  {
    key: "regional_manager",
    name: "Regional Manager",
    description: "Manages several shops: front desk, POS, clients, staff and shop settings, the Campaign Center's We have openings, with every report for those shops but the brand's marketing reports.",
    defaultScope: "selected",
    permissions: [...REGIONAL_FEATURES, "giftcards.void", ...reports(LOCATION_REPORTS)],
    maxDiscountPct: 100,
  },
  {
    key: "shop_manager",
    name: "Shop Manager",
    description: "Manages one shop: front desk, POS, clients, staff and shop settings, the Campaign Center's We have openings, with that shop's reports but the brand's marketing reports.",
    defaultScope: "one",
    permissions: [...MANAGER_FEATURES, ...reports(LOCATION_REPORTS)],
    maxDiscountPct: 100,
  },
  {
    key: "front_desk",
    name: "Front Desk",
    description: "Books and checks out every barber's clients, runs walk-ins and the drawer, and sends We have openings. Small discounts only.",
    defaultScope: "one",
    permissions: [
      "calendar.manage",
      "walkins.manage",
      "checkout.any",
      "pos.discount",
      "sales.view",
      "drawer.manage",
      "clients.view_all",
      "clients.message",
      "clients.edit",
      "clients.filters",
      "clients.saved_searches",
      "reports.all_staff",
      "po.receive",
      "inventory.stocktake",
      "blocks.own",
      "blocks.others",
      "timeoff.request",
      "callins.outreach",
      "inbox.view",
      "timeclock.punch",
      "timeclock.kiosk",
      "timesheet.own",
      "tips.own",
      "campaign_center.openings",
      ...reports(["card_vs_cash", "cash_drawer", "staffing", "openings"], false),
    ],
    maxDiscountPct: 10,
  },
  {
    key: "barber",
    name: "Barber",
    description: "Their own column, their own clients and their own sales.",
    defaultScope: "selected",
    permissions: ["clients.rate", "clients.message", "blocks.own", "timeoff.request", "timeclock.punch", "timesheet.own", "tips.own", ...reports(["my_sales", "service_times"])],
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
  if (role.key === BRAND_ADMIN_ROLE_KEY && scope === "all") for (const p of BRAND_ADMIN_ALWAYS) perms.add(p);
  for (const r of REPORTS) if (!perms.has(reportView(r.key))) perms.delete(reportExport(r.key));
  if (!perms.has("report_builder.view") && !perms.has("report_builder.build")) perms.delete("report_builder.export");
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
  if (after?.key === BRAND_ADMIN_ROLE_KEY) {
    const kept = [...BRAND_ADMIN_ALWAYS].find((p) => !next.has(p));
    if (kept) return `Brand Admins always have "${permissionLabel(kept)}"`;
  }
  const prev = new Set((before?.permissions ?? []).filter(isPermission));
  const changed = [...new Set([...next, ...prev])].filter((p) => next.has(p) !== prev.has(p));
  const ownerGrant = changed.find((p) => OWNER_GRANTS.has(p));
  if (ownerGrant && !caller.isOwner) return `Only the Brand Owner can grant or remove "${permissionLabel(ownerGrant)}"`;
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
  const ownerGrant = [...gained, ...[...current.permissions].filter((p) => !next.permissions.has(p))].find((p) => OWNER_GRANTS.has(p));
  if (ownerGrant && !caller.isOwner) return `Only the Brand Owner can grant or remove "${permissionLabel(ownerGrant)}"`;
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
