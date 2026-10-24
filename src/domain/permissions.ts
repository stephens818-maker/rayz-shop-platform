/**
 * Granular staff permissions. Pure: the catalog, the role templates, how a user's effective
 * permissions are worked out, and who may grant what. Server code loads the rows and calls these.
 */

export const PERMISSION_GROUPS = [
  "Front desk",
  "Point of sale",
  "Clients",
  "Campaign Center",
  "Catalog and inventory",
  "Staff",
  "Payroll and time clock",
  "Compensation",
  "Tip payouts",
  "Users and sign-in",
  "Custom reports",
  "Settings and data",
  "Banking and Stripe",
  "Locations",
  "Rayz Assistant",
] as const;
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
  /**
   * Takes client lists or full client contact details out of the system, so only brand-level roles
   * hold it, with access to all shops. A shop or staff role, a per-person override and a shop login
   * never carry it; the brand gives it to them only with a contact access grant (contact-grants.ts).
   */
  brandLevel?: boolean;
  /** Never in a role or an override: it comes only with a contact access grant (or the Brand Owner role). */
  grantOnly?: boolean;
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
  {
    key: "sales.refund",
    group: "Point of sale",
    label: "Refund and void tickets",
    hint: "Without it, a manager who has it approves each refund or void with their time clock PIN. Shop logins always need a manager's PIN.",
  },
  {
    key: "sales.reassign",
    group: "Point of sale",
    label: "Reassign a paid ticket to another barber",
    hint: "Moves the ticket's sales and tips to the other barber, with a reason. Without it, a manager approves with their PIN. Not once that pay period is locked.",
  },
  { key: "drawer.manage", group: "Point of sale", label: "Open, count and close the cash drawer, and record cash paid in and out" },
  { key: "promos.manage", group: "Point of sale", label: "Create and turn off promo codes", hint: "The Campaign Center's coupons. Brand only unless granted." },
  { key: "giftcards.issue", group: "Point of sale", label: "Issue comp gift cards" },
  { key: "giftcards.void", group: "Point of sale", label: "Void gift cards" },
  { key: "clients.view_all", group: "Clients", label: "Look up any client in the brand", hint: "Without it, only clients of their shops, and full profiles only for clients they've served." },
  {
    key: "clients.reveal",
    group: "Clients",
    label: "Reveal a masked client detail, with a reason",
    hint: "Which details are masked or hidden is set under Client data. Phone, email and address are never revealed this way; the brand gives full contact details with a contact access grant. Every reveal is logged with the reason.",
  },
  { key: "clients.message", group: "Clients", label: "Call and text clients through the shop line", hint: "The number stays hidden; calls and texts go through the system." },
  {
    key: "badges.settings",
    group: "Clients",
    label: "Set up client badges: which show, their thresholds, custom badges and which roles see each",
    hint: "Spend and other sensitive badges start shown to brand-level roles only. A badge never shows a client detail the person can't see.",
    brandOnly: true,
  },
  {
    key: "clients.contact_full",
    group: "Clients",
    label: "See client phone, email and address in full",
    hint: "Off for shop logins and staff. The brand gives it per location or per person under Client data protection → Contact access, and can revoke it at any time. Brand-level roles see contact details as Client data sets them.",
    grantOnly: true,
  },
  {
    key: "clients.export",
    group: "Clients",
    label: "Export the client list",
    hint: "Brand-level roles, off for everyone but the Brand Owner unless granted. Shop logins and staff only with a contact access grant, for their locations' clients. Every export is logged.",
    brandOnly: true,
    brandLevel: true,
  },
  { key: "clients.edit", group: "Clients", label: "Add clients and edit client details", hint: "Which details they can add or edit is set in Client data protection, apart from which they can see." },
  {
    key: "clients.family",
    group: "Clients",
    label: "Add and edit family members (children) on a client's account",
    hint: "At booking, check-in and on the client profile. Children have no contact details of their own; messages go to the parent.",
  },
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
  {
    key: "notes.view",
    group: "Clients",
    label: "See client notes",
    hint: "Profile and cut notes, written at any location, on the profile, the calendar, Today and checkout. Only where Client data protection shows them client notes in full.",
  },
  { key: "notes.write", group: "Clients", label: "Write client notes, and edit or remove their own", hint: "Profile notes, pinned notes and cut notes with before and after photos." },
  { key: "notes.edit_any", group: "Clients", label: "Edit, pin or remove anyone's client notes", hint: "Notes written at their shops, and the client's record note." },
  { key: "notes.private", group: "Clients", label: "See and write private manager notes", hint: "Never on a shop login. Shown only to people with this permission." },
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
    hint: "Export a campaign audience's contact list. Brand-level roles only, and off for everyone but the Brand Owner unless granted. Details are exported as Client data lets them see them, and every export is logged.",
    brandOnly: true,
    brandLevel: true,
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
  {
    key: "staff.contact",
    group: "Staff",
    label: "See staff phone numbers and email addresses",
    hint: "Without it they're masked on staff profiles and lists. People always see their own. Never on shop logins.",
  },
  { key: "permissions.manage", group: "Users and sign-in", label: "Manage roles, permissions and shop access" },
  { key: "logins.manage", group: "Users and sign-in", label: "Create and disable shop logins and reset their passwords", hint: "For the shops in their access." },
  {
    key: "access.remote",
    group: "Users and sign-in",
    label: "Can access remotely: sign in from anywhere, even at locations that only allow sign-in from the shop",
    hint: "Exempt from each location's network and device rule. Only the Brand Admin role has it to start; give it to the managers who work from home.",
  },
  {
    key: "devices.approve",
    group: "Users and sign-in",
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
    group: "Payroll and time clock",
    label: "Run payroll: hours, pay rates, iSolved numbers, pay groups and calendars, overrides and the iSolved downloads",
    hint: "Sees every barber's pay at every shop. Downloads open once a period is approved and locked.",
    brandOnly: true,
  },
  { key: "payroll.approve", group: "Payroll and time clock", label: "Approve and lock a pay period", hint: "Blocked while any total doesn't reconcile.", brandOnly: true },
  {
    key: "timeclock.punch",
    group: "Payroll and time clock",
    label: "Clock in and out and take breaks",
    hint: "From their own phone, held to the shop's device, GPS or network rule, or with their PIN on the shop's front-desk clock.",
  },
  { key: "timeclock.kiosk", group: "Payroll and time clock", label: "Open the shop's front-desk time clock", hint: "On a registered device, where staff punch with their own PIN." },
  { key: "timesheet.own", group: "Payroll and time clock", label: "See and sign off their own timesheet", hint: "Their punches, breaks, scheduled against actual hours and overtime." },
  {
    key: "timesheet.edit",
    group: "Payroll and time clock",
    label: "Fix punches at their shops: edit, add or void, with a reason",
    hint: "Never their own. Every change is logged with the before and after, and clears that timesheet's approvals.",
  },
  {
    key: "timesheet.approve",
    group: "Payroll and time clock",
    label: "Approve timesheets and lock pay periods at their shops",
    hint: "Never their own. A period locks once every timesheet in it is approved; then nobody can punch into it or edit it.",
  },
  { key: "payroll.rates", group: "Payroll and time clock", label: "See pay rates and labor cost", hint: "Hourly rates, labor cost and labor % of sales in reports. Without it, reports show hours only." },
  { key: "payroll.export", group: "Payroll and time clock", label: "Download the payroll export (CSV and the iSolved layout)", hint: "Per pay period, per employee and shop. Every download is logged." },
  {
    key: "compensation.view",
    group: "Compensation",
    label: "See employees' compensation: pay plans, their history and the brand's employee fields",
    hint: "Off unless the brand turns compensation fields on. People at their shops only, never their own. Brand Owner and Brand Admin to start.",
  },
  {
    key: "compensation.edit",
    group: "Compensation",
    label: "Change employees' compensation and employee fields",
    hint: "A change is a new version from a date after the last locked pay period; past payroll never changes. Never their own, and only people who work at none of the shops outside theirs.",
  },
  {
    key: "compensation.settings",
    group: "Compensation",
    label: "Turn compensation fields on or off, choose what payroll and the iSolved file use, and add employee fields",
    brandOnly: true,
  },
  {
    key: "compensation.own",
    group: "Compensation",
    label: "See their own pay: commission earned and (where the brand shows it) this period's pay estimate",
    hint: "Only their own, never anyone else's. In no role to start.",
  },
  { key: "tips.own", group: "Tip payouts", label: "See their own tips and payouts, and choose how they're paid", hint: "Tips today, pending, paid out and history; Stripe payout setup where the brand allows it." },
  {
    key: "tips.approve",
    group: "Tip payouts",
    label: "Review and approve tip payouts at their shops",
    hint: "Build and approve batches, hold or adjust a payout with a reason, and pay cash tips from the drawer at close. Every change is logged.",
  },
  {
    key: "tips.settings",
    group: "Tip payouts",
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
  {
    key: "analytics.events",
    group: "Custom reports",
    label: "Use the event log in custom reports and Rayz Assistant",
    hint: "Count and total any logged action (bookings and their funnel, check-in to checkout times, ticket edits, refunds, tips, stock, clock punches, block-outs, messages, calls) on their own locations and barbers. Ids and numbers only; no contact details.",
  },
  {
    key: "analytics.export",
    group: "Settings and data",
    label: "Download the raw event log (CSV)",
    hint: "Every event at every location, for a BI tool. Brand-level roles only, and only the Brand Owner can grant it. Every download is logged.",
    brandOnly: true,
    brandLevel: true,
    ownerGrants: true,
  },
  {
    key: "analytics.settings",
    group: "Settings and data",
    label: "Event log settings: post-visit rating and the nightly warehouse copy",
    hint: "Whether receipts ask \"How was your visit?\" 1-5, and whether new events are copied each night to the brand's warehouse.",
    brandOnly: true,
  },
  {
    key: "settings.shop",
    group: "Settings and data",
    label: "Edit every shop setting: details, hours and closures, booking rules, checkout and the phone line",
    hint: "Or grant the parts one at a time with the shop settings permissions below.",
  },
  { key: "settings.shop_details", group: "Settings and data", label: "Shop settings: name, address, phone, email and description" },
  { key: "settings.shop_hours", group: "Settings and data", label: "Shop settings: weekday hours and closures" },
  {
    key: "settings.shop_booking",
    group: "Settings and data",
    label: "Shop settings: booking rules",
    hint: "Online booking on or off, the cancellation cutoff, how soon and how far ahead clients can book, and the gap between appointments.",
  },
  {
    key: "settings.shop_checkout",
    group: "Settings and data",
    label: "Shop settings: checkout",
    hint: "The customer screen, card readers, receipts and the cash drawer's opening balance.",
  },
  { key: "settings.shop_phone", group: "Settings and data", label: "Shop settings: the phone line and the phone operator", hint: "The shop's Twilio number and how the phone operator answers." },
  { key: "settings.taxes", group: "Settings and data", label: "Edit tax rates and card fees" },
  {
    key: "scheduling.timing",
    group: "Settings and data",
    label: "Set booking slot intervals and service timing at their shops",
    hint: "Each shop's and barber's interval, service durations, buffers and per-barber times. With access to all shops, also the brand default interval and the brand service timing.",
  },
  {
    key: "payments.accounts",
    group: "Banking and Stripe",
    label: "Set up each shop's Stripe account for card payments and payouts, and choose who owns each shop",
    hint: "Sees each shop's payment setup and Stripe status, refreshes it, and manages owner entities. Connecting or changing a shop's bank or Stripe account needs the banking permission.",
    brandOnly: true,
  },
  {
    key: "payments.banking",
    group: "Banking and Stripe",
    label: "Connect or change a shop's banking and Stripe account",
    hint: "Choose the brand account, the shop's own account or cash only; start or redo Stripe onboarding (legal entity, EIN, owner, bank account); open the shop's Stripe dashboard; set the statement descriptor. Only the Brand Owner can grant it.",
    ownerGrants: true,
  },
  { key: "settings.brand", group: "Settings and data", label: "Change brand-level settings: loyalty program, new shops, Sunday hours", ownerOnly: true },
  { key: "import.run", group: "Settings and data", label: "Run the Squire import", hint: "Brand-level roles only: it reads whole client files.", brandOnly: true, brandLevel: true },
  {
    key: "clients.privacy",
    group: "Settings and data",
    label: "Set which client details each role and person sees, and see who viewed client data",
    hint: "Brand-level roles only.",
    brandOnly: true,
    brandLevel: true,
  },
  { key: "notifications.view", group: "Settings and data", label: "See the notification outbox" },
  { key: "notifications.send", group: "Settings and data", label: "Send due notifications now" },
  { key: "locations.manage", group: "Locations", label: "Create and edit saved location groups for reports", brandOnly: true },
  {
    key: "locations.setup",
    group: "Locations",
    label: "Add, open, temporarily close and archive locations",
    hint: "The Add Location wizard, go-live and archiving. Archived shops keep their history in reports.",
    brandOnly: true,
  },
  { key: "settings.lists", group: "Settings and data", label: "Edit client message wording, pick lists and the Morning Dashboard email", brandOnly: true },
  {
    key: "checkout_prompts.manage",
    group: "Settings and data",
    label: "Set up the checkout prompts: rebook and product suggestions",
    hint: "Turn each prompt on or off for the brand, a location, a role or a barber, make it skippable or required, and set each service's rebook interval and suggested products.",
    brandOnly: true,
  },
  {
    key: "handoff.settings",
    group: "Settings and data",
    label: "Set the brand's tip presets for the customer screen",
    hint: "The percent or dollar buttons every location uses unless it sets its own. Each location's screen rules are shop settings.",
    brandOnly: true,
  },
  {
    key: "network.settings",
    group: "Users and sign-in",
    label: "Set where staff can sign in from: each location's allowed networks and devices",
    hint: "Turn each location's sign-in restriction on or off, edit its allowed IPs, approve or remove devices at any shop, and set the blocked sign-in alert.",
    brandOnly: true,
  },
  {
    key: "assistant.settings",
    group: "Rayz Assistant",
    label: "Turn Rayz Assistant on or off for each role and set its limits",
    hint: "Which roles get the assistant, how many questions a person may ask a minute and a day, and whether it may draft blasts and purchase orders. The assistant only ever answers with what the person asking could open themselves.",
    brandOnly: true,
  },
] as const satisfies readonly PermissionDef[];

export type FeaturePermission = (typeof FEATURE_PERMISSIONS)[number]["key"];

/** Every report is its own permission, with CSV export granted separately from viewing. */
export const REPORTS = [
  { key: "my_sales", label: "My sales and tips", href: "/admin/reports/my-sales", hint: "The signed-in person's own tickets only." },
  { key: "sales_summary", label: "Sales summary", href: "/admin/reports/sales" },
  {
    key: "end_of_day",
    label: "End of day",
    href: "/admin/reports/end-of-day",
    hint: "One day's close in one place: sales, tax, tips, how it was paid, refunds, the cash drawer and each barber's tickets.",
  },
  { key: "sales_by_barber", label: "Barber performance", href: "/admin/reports/barbers" },
  {
    key: "leaderboard",
    label: "Leaderboard",
    href: "/admin/reports/leaderboard",
    hint: "Barbers ranked on service and product sales, productivity, average ticket, new clients and tickets with retail, with the top services and products.",
  },
  { key: "services_vs_products", label: "Services vs products", href: "/admin/reports/services-products" },
  { key: "tips_payroll", label: "Tips and payroll export", href: "/admin/payroll" },
  { key: "card_vs_cash", label: "Card vs cash", href: "/admin/reports/tender" },
  {
    key: "sales_tax",
    label: "Sales tax by state",
    href: "/admin/reports/sales-tax",
    hint: "Taxable sales and tax collected per state, location and month or quarter, after refunds, for each state's filing.",
  },
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
  {
    key: "operations",
    label: "Operations KPIs",
    href: "/admin/reports/operations",
    hint: "Utilization, rebooked at checkout, retention by first-visit month, client lifetime value, average ticket, retail per service ticket, revenue per chair hour, wait time, on-time starts and post-visit rating, by location and barber.",
  },
  {
    key: "checkout_prompts",
    label: "Checkout prompts",
    href: "/admin/reports/checkout-prompts",
    hint: "How often the rebook prompt books the next visit and the product prompt adds a product that's paid for, with the reasons clients gave, by location and barber.",
  },
  {
    key: "retention",
    label: "Client retention",
    href: "/admin/reports/retention",
    hint: "Of the clients with 1, 2 or 3+ visits in the prior period, how many new and existing clients came back, and how many saw another barber instead.",
  },
  {
    key: "acquisition",
    label: "Acquisition channels",
    href: "/admin/reports/acquisition",
    hint: "New clients by how they found us and how they first booked, with how many came back for a second visit.",
  },
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
    key: "phone_operator",
    label: "Phone operator",
    href: "/admin/reports/phone-operator",
    hint: "Calls to each shop's number: answered by staff or by the phone operator, booking links texted, the bookings and dollars that followed, the book rate and staff minutes saved.",
  },
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
  {
    key: "commission_payout",
    label: "Commission payout",
    href: "/admin/reports/commission-payout",
    hint: "Service and product commission per barber and location from each one's pay plan, net of discounts and refunds, by month, with booth rent due. Only while compensation fields are on.",
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
/** Reports whose rows are named clients, so exporting one is downloading a client list. */
export const CLIENT_LIST_REPORTS: readonly ReportKey[] = ["client_ratings"];
/** Client lists and full contact details leave the system only through these; see PermissionDef.brandLevel. */
export const BRAND_LEVEL_ONLY = new Set<Permission>([
  ...FEATURE_PERMISSIONS.filter((p) => "brandLevel" in p && p.brandLevel).map((p) => p.key),
  ...CLIENT_LIST_REPORTS.map(reportExport),
]);
export const BRAND_ONLY = new Set<Permission>([...FEATURE_PERMISSIONS.filter((p) => "brandOnly" in p && p.brandOnly).map((p) => p.key), ...BRAND_LEVEL_ONLY]);
/** See PermissionDef.grantOnly. */
export const GRANT_ONLY = new Set<Permission>(FEATURE_PERMISSIONS.filter((p) => "grantOnly" in p && p.grantOnly).map((p) => p.key));
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

export const ROLE_TEMPLATE_KEYS = ["brand_owner", "brand_admin", "regional_manager", "shop_manager", "front_desk", "shop_login", "barber"] as const;
export const SHOP_LOGIN_ROLE_KEY = "shop_login";
export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];

export interface RoleDef {
  /** Template key, or null for a custom role. */
  key: string | null;
  name: string;
  permissions: readonly string[];
  /** Largest manual discount allowed, in whole percent. */
  maxDiscountPct: number;
  /** A custom role the Brand Owner made brand-level; see isBrandLevelRole. */
  brandLevel?: boolean;
}

const TEMPLATE_KEYS = new Set<string>(ROLE_TEMPLATE_KEYS);

/**
 * Brand-level roles may see client contact details in full and take client lists out: the Brand
 * Owner, Brand Admin, and custom roles the Brand Owner marks brand-level. Every other template is a
 * shop or staff role and never is, whatever it's been given.
 */
export function isBrandLevelRole(r: Pick<RoleDef, "key" | "brandLevel">): boolean {
  if (r.key === OWNER_ROLE_KEY || r.key === BRAND_ADMIN_ROLE_KEY) return true;
  if (r.key && TEMPLATE_KEYS.has(r.key)) return false;
  return !!r.brandLevel;
}

/** A person (not a shared shop login) in a brand-level role with access to all shops. */
export const isBrandLevelPerson = (p: { kind: "person" | "shop"; scope: ShopScope; role: Pick<RoleDef, "key" | "brandLevel"> }) =>
  p.kind === "person" && p.scope === "all" && isBrandLevelRole(p.role);

const BRAND_LEVEL_LABEL = "brand-level roles (Brand Owner, Brand Admin and the brand-level roles the Brand Owner creates)";
const CONTACT_ACCESS = "Client data protection → Contact access";
const notBrandLevel = (p: Permission) =>
  `"${permissionLabel(p)}" is only for ${BRAND_LEVEL_LABEL}, with access to all shops. For a shop login or someone in a shop or staff role, give it per location or per person under ${CONTACT_ACCESS}.`;
const grantOnlyDenied = (p: Permission) => `"${permissionLabel(p)}" isn't part of a role or an override. Give it per location or per person under ${CONTACT_ACCESS}.`;

const reports = (keys: ReportKey[], exportToo = true): ReportPermission[] => keys.flatMap((k) => (exportToo ? [reportView(k), reportExport(k)] : [reportView(k)]));
const ALL_REPORTS = REPORTS.map((r) => r.key);
/** Pay that's the brand's to show: no location role has these reports to start. */
const BRAND_PAY_REPORTS: readonly ReportKey[] = ["commission_payout"];
const LOCATION_REPORTS = ALL_REPORTS.filter((k) => !BRAND_CAMPAIGN_CENTER.has(reportView(k)) && !BRAND_PAY_REPORTS.includes(k));
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
  "sales.reassign",
  "drawer.manage",
  "giftcards.issue",
  "clients.view_all",
  "clients.reveal",
  "clients.message",
  "clients.edit",
  "clients.family",
  "clients.rate",
  "clients.ratings_all",
  "clients.filters",
  "clients.saved_searches",
  "notes.view",
  "notes.write",
  "notes.edit_any",
  "notes.private",
  "catalog.prices",
  "inventory.manage",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.stocktake",
  "po.create",
  "po.send",
  "po.receive",
  "staff.manage",
  "staff.contact",
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

const TEMPLATES: RoleTemplate[] = [
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
    permissions: ALL_PERMISSIONS.filter((p) => !OWNER_ONLY.has(p) && !OWNER_GRANTS.has(p) && !GRANT_ONLY.has(p) && p !== "clients.export" && p !== "campaign_center.export"),
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
      "clients.family",
      "clients.filters",
      "clients.saved_searches",
      "notes.view",
      "notes.write",
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
      ...reports(["card_vs_cash", "cash_drawer", "end_of_day", "staffing", "openings"], false),
    ],
    maxDiscountPct: 10,
  },
  {
    key: "shop_login",
    name: "Shop Login",
    description:
      "The shared front-desk login for one shop: the calendar, waitlist, checkout, the drawer, clients with masked contact details, the front-desk clock and the shop's reports. Refunds, voids and reassigning tickets need a manager's PIN; no exports.",
    defaultScope: "one",
    permissions: [
      "calendar.manage",
      "walkins.manage",
      "blocks.others",
      "checkout.any",
      "pos.discount",
      "sales.view",
      "drawer.manage",
      "clients.view_all",
      "clients.message",
      "clients.edit",
      "clients.family",
      "clients.filters",
      "notes.view",
      "notes.write",
      "reports.all_staff",
      "callins.outreach",
      "inbox.view",
      "timeclock.kiosk",
      "campaign_center.openings",
      ...reports(
        [
          "sales_summary",
          "end_of_day",
          "sales_by_barber",
          "leaderboard",
          "services_vs_products",
          "tips_payroll",
          "card_vs_cash",
          "sales_tax",
          "discounts_refunds",
          "gift_cards",
          "kpis",
          "operations",
          "checkout_prompts",
          "retention",
          "acquisition",
          "staffing",
          "phone_operator",
          "attendance",
          "cash_drawer",
        ],
        false,
      ),
    ],
    maxDiscountPct: 10,
  },
  {
    key: "barber",
    name: "Barber",
    description: "Their own column, their own clients and their own sales.",
    defaultScope: "selected",
    permissions: ["clients.rate", "clients.message", "notes.view", "notes.write", "blocks.own", "timeoff.request", "timeclock.punch", "timesheet.own", "tips.own", ...reports(["my_sales", "service_times"])],
    maxDiscountPct: 0,
  },
];

/** Starting points. Every template except Brand Owner can be edited; "Reset" puts these back. Shop and staff templates never hold brand-level permissions. */
export const ROLE_TEMPLATES: RoleTemplate[] = TEMPLATES.map((t) => (isBrandLevelRole(t) ? t : { ...t, permissions: t.permissions.filter((p) => !BRAND_LEVEL_ONLY.has(p as Permission)) }));

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
  for (const p of GRANT_ONLY) perms.delete(p);
  if (scope !== "all") for (const p of BRAND_ONLY) perms.delete(p);
  if (!isBrandLevelRole(role)) for (const p of BRAND_LEVEL_ONLY) perms.delete(p);
  if (role.key === BRAND_ADMIN_ROLE_KEY && scope === "all") for (const p of BRAND_ADMIN_ALWAYS) perms.add(p);
  for (const r of REPORTS) if (!perms.has(reportView(r.key))) perms.delete(reportExport(r.key));
  if (!perms.has("report_builder.view") && !perms.has("report_builder.build")) perms.delete("report_builder.export");
  const maxDiscountPct = perms.has("pos.discount") ? clampPct(maxDiscountOverride ?? role.maxDiscountPct) : 0;
  return { isOwner: false, permissions: perms, maxDiscountPct };
}

// ───────────────────────────── Shop logins ─────────────────────────────

/**
 * A shop login is shared by everyone at the desk, so nothing it does can be traced to one person.
 * Whatever its role or overrides say, it never refunds, voids or reassigns a ticket on its own (a
 * manager's PIN approves those), never reveals client details, never sees staff contact details,
 * and never manages people, pay or sign-in. Its role can't let it export clients either: only a
 * contact access grant to it or its location does (contact-grants.ts), added after this list.
 */
export const SHOP_LOGIN_NEVER: ReadonlySet<Permission> = new Set<Permission>([
  ...BRAND_LEVEL_ONLY,
  "sales.refund",
  "sales.reassign",
  "clients.reveal",
  "clients.export",
  "clients.merge",
  "campaign_center.export",
  "report_builder.export",
  "staff.contact",
  "staff.manage",
  "permissions.manage",
  "logins.manage",
  "devices.approve",
  "access.remote",
  "payroll.rates",
  "payroll.export",
  "compensation.view",
  "compensation.edit",
  "compensation.settings",
  "compensation.own",
  "report.commission_payout.view",
  "report.commission_payout.export",
  "payments.banking",
  "timesheet.edit",
  "timesheet.approve",
  "tips.approve",
  "notes.private",
  "notes.edit_any",
]);

export const sharedLoginAccess = <A extends Access>(a: A): A => ({ ...a, isOwner: false, permissions: new Set([...a.permissions].filter((p) => !SHOP_LOGIN_NEVER.has(p))) });

// ───────────────────────────── Shop settings, part by part ─────────────────────────────

export const SHOP_SETTING_PARTS = ["details", "hours", "booking", "checkout", "phone"] as const;
export type ShopSettingPart = (typeof SHOP_SETTING_PARTS)[number];
export const SHOP_PART_PERMISSION: Record<ShopSettingPart, Permission> = {
  details: "settings.shop_details",
  hours: "settings.shop_hours",
  booking: "settings.shop_booking",
  checkout: "settings.shop_checkout",
  phone: "settings.shop_phone",
};

/** Each shop setting and the part that gates it. "Edit every shop setting" covers them all. */
export const SHOP_SETTING_FIELDS = {
  name: "details",
  address: "details",
  city: "details",
  state: "details",
  zip: "details",
  phone: "details",
  email: "details",
  description: "details",
  twilioNumber: "phone",
  bookingEnabled: "booking",
  cancelCutoffMinutes: "booking",
  minLeadMinutes: "booking",
  bookingWindowDays: "booking",
  bufferMinutes: "booking",
  drawerOpeningCents: "checkout",
} as const satisfies Record<string, ShopSettingPart>;
export type ShopSettingField = keyof typeof SHOP_SETTING_FIELDS;

export const canEditShopPart = (perms: ReadonlySet<Permission>, part: ShopSettingPart) => perms.has("settings.shop") || perms.has(SHOP_PART_PERMISSION[part]);
export const editableShopParts = (perms: ReadonlySet<Permission>) => SHOP_SETTING_PARTS.filter((p) => canEditShopPart(perms, p));

/** The changed fields this person may not edit; empty when the change is allowed. */
export function shopSettingsDenied(perms: ReadonlySet<Permission>, before: Partial<Record<ShopSettingField, unknown>>, after: Partial<Record<ShopSettingField, unknown>>): ShopSettingField[] {
  return (Object.keys(after) as ShopSettingField[]).filter((f) => f in SHOP_SETTING_FIELDS && (after[f] ?? null) !== (before[f] ?? null) && !canEditShopPart(perms, SHOP_SETTING_FIELDS[f]));
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
  if (after && !!after.brandLevel !== !!before?.brandLevel) {
    if (after.key) return "Built-in roles can't be made brand-level or shop-level. Create a custom role.";
    if (!caller.isOwner) return "Only the Brand Owner can make a role brand-level, or stop it being brand-level";
  }
  const grantOnly = [...next].find((p) => GRANT_ONLY.has(p));
  if (grantOnly) return grantOnlyDenied(grantOnly);
  const shopLevel = after && !isBrandLevelRole(after) && [...next].find((p) => BRAND_LEVEL_ONLY.has(p));
  if (shopLevel) return notBrandLevel(shopLevel);
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
  /** brandLevel: whether they'd be a brand-level person (isBrandLevelPerson) after the change. */
  next: UserAccessState & { overrides: Overrides; brandLevel?: boolean },
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
  const grantOnly = (Object.keys(next.overrides) as Permission[]).find((k) => GRANT_ONLY.has(k) && next.overrides[k]);
  if (grantOnly) return grantOnlyDenied(grantOnly);
  const shopLevel = !next.brandLevel && (Object.keys(next.overrides) as Permission[]).find((k) => BRAND_LEVEL_ONLY.has(k) && next.overrides[k]);
  if (shopLevel) return notBrandLevel(shopLevel);
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
