import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const appointmentStatus = pgEnum("appointment_status", [
  "booked",
  "confirmed",
  "checked_in",
  "in_service",
  "completed",
  "cancelled",
  "no_show",
]);
export const appointmentSource = pgEnum("appointment_source", ["online", "api", "staff", "walk_in", "import", "rebook"]);
export const serviceKind = pgEnum("service_kind", ["service", "addon"]);
export const saleStatus = pgEnum("sale_status", ["open", "paid", "voided", "refunded", "partially_refunded"]);
export const lineKind = pgEnum("line_kind", ["service", "addon", "product", "gift_card"]);
export const paymentMethod = pgEnum("payment_method", ["card", "cash", "gift_card"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed", "voided", "refunded", "partially_refunded"]);
export const waitlistStatus = pgEnum("waitlist_status", ["waiting", "notified", "serving", "done", "left"]);
export const notificationStatus = pgEnum("notification_status", ["pending", "sent", "failed", "suppressed", "cancelled"]);
export const poStatus = pgEnum("po_status", ["draft", "approved", "sent", "partially_received", "received", "cancelled"]);
export const transferStatus = pgEnum("transfer_status", ["draft", "sent", "received", "cancelled"]);
export const countStatus = pgEnum("count_status", ["open", "posted", "cancelled"]);

// ───────────────────────────── Brand & shops ─────────────────────────────

export const brandSettings = pgTable("brand_settings", {
  id: smallint("id").primaryKey().default(1),
  name: text("name").notNull().default("Ray'z Barber Shop"),
  loyalty: jsonb("loyalty").notNull(),
  /** Purchase orders above this total need someone with "Approve purchase orders" before they can be sent. Null: no approval step. */
  poApprovalThresholdCents: integer("po_approval_threshold_cents"),
  /** Client lookup limits (LookupLimits in src/domain/client-privacy.ts); missing keys use the defaults. */
  clientLookupLimits: jsonb("client_lookup_limits").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  /** Brand default booking slot interval. Shops, barbers and a barber at one shop can override it (src/domain/timing.ts). */
  slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
  /** Payroll settings (PayrollSettings in src/domain/payroll/calc.ts); missing keys use the defaults. */
  payroll: jsonb("payroll").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Lunch, block and time off rules (StaffTimeRules in src/domain/staff-time.ts); missing keys use the defaults. */
  staffTime: jsonb("staff_time").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Call-in outreach rules (OutreachRules in src/domain/outreach.ts); missing keys use the defaults. */
  outreach: jsonb("outreach").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The brand's edits to client message wording, by message kind (src/domain/message-templates.ts); missing kinds use the built-in text. */
  messageTemplates: jsonb("message_templates").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Pick lists staff choose from (src/domain/lookups.ts); missing lists use the defaults. */
  lookups: jsonb("lookups").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The morning digest email (DigestSettings in src/domain/digest.ts); missing keys use the defaults. */
  digest: jsonb("digest").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Time clock rules for the brand (ClockRules in src/domain/time-clock.ts): breaks, forgotten clock-outs, the export layout. */
  timeClock: jsonb("time_clock").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Tip payout policy for the brand (BrandTipPolicy in src/domain/tips.ts): allowed methods, employee choice, instant payouts. */
  tipPayouts: jsonb("tip_payouts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Sign-in restriction settings for the brand (BrandNetworkSettings in src/domain/network-access.ts): the blocked sign-in alert. */
  networkAccess: jsonb("network_access").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The brand's tip presets for the customer screen (BrandHandoff in src/domain/handoff.ts); missing keys use the defaults. */
  handoff: jsonb("handoff").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** When the Google review link is shown (ReviewRules in src/domain/reviews.ts): from visit N, and the pause after a tap. */
  reviews: jsonb("reviews").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Campaign Center settings (MarketingSettings in src/domain/marketing.ts): quiet hours, frequency caps, the postal address, attribution, costs. */
  marketing: jsonb("marketing").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Who owns a shop's business: the brand today, a franchisee later. One owner entity can own several
 * shops; each shop still has its own Stripe connected account, so its revenue, fees and payouts stay its own.
 */
export const ownerEntities = pgTable("owner_entities", {
  id: id(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  kind: text("kind").$type<OwnerEntityKind>().notNull().default("brand"),
  contactEmail: text("contact_email"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type OwnerEntityKind = "brand" | "franchisee";

export const shops = pgTable("shops", {
  id: id(),
  ownerEntityId: uuid("owner_entity_id").references(() => ownerEntities.id),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  zip: text("zip").notNull().default(""),
  phone: text("phone"),
  /** The shop's Twilio number (E.164): calls to it ring the shop phone, texts from clients land in the shop inbox, and the shop's texts and calls go out from it. */
  twilioNumber: text("twilio_number").unique(),
  email: text("email"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  /** False only once archived. Kept in step with status for code that only asks "is it still open for business". */
  active: boolean("active").notNull().default(true),
  /** setup: hidden from clients while it's configured; live: open; closed: temporarily closed; archived: retired, history kept. */
  status: text("status").$type<ShopStatus>().notNull().default("live"),
  /** Temporarily closed until (and including) this date; null = until reopened by hand. */
  closedUntil: date("closed_until"),
  /** What clients are told while it's temporarily closed. */
  closedNote: text("closed_note"),
  wentLiveAt: ts("went_live_at"),
  archivedAt: ts("archived_at"),
  /** Online booking switch for a live shop. Clients can book only when the shop is live and this is on. */
  bookingEnabled: boolean("booking_enabled").notNull().default(true),
  /** #rrggbb for this location's booking page; null uses the brand's. */
  accentColor: text("accent_color"),
  logoUrl: text("logo_url"),
  /** Fractions (0.07 = 7%). Configured per shop; never hard-coded. */
  serviceTaxRate: numeric("service_tax_rate", { precision: 7, scale: 5 }).notNull().default("0"),
  productTaxRate: numeric("product_tax_rate", { precision: 7, scale: 5 }).notNull().default("0"),
  taxRatesVerified: boolean("tax_rates_verified").notNull().default(false),
  cardFeeEnabled: boolean("card_fee_enabled").notNull().default(true),
  cardFeeRate: numeric("card_fee_rate", { precision: 6, scale: 5 }).notNull().default("0.03"),
  cardFeeAppliesToTip: boolean("card_fee_applies_to_tip").notNull().default(false),
  /** Superseded by handoff.tips, and kept in step with it while the presets are percents. */
  tipPresets: jsonb("tip_presets").$type<number[]>().notNull().default(sql`'[20,25,30]'::jsonb`),
  cancelCutoffMinutes: integer("cancel_cutoff_minutes").notNull().default(30),
  /** Null follows the brand default. */
  slotIntervalMinutes: integer("slot_interval_minutes"),
  minLeadMinutes: integer("min_lead_minutes").notNull().default(15),
  bookingWindowDays: integer("booking_window_days").notNull().default(60),
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  description: text("description"),
  /** block: a sale or adjustment that would take on-hand below zero is refused. warn: it goes through with a warning. */
  negativeStock: text("negative_stock").$type<NegativeStockPolicy>().notNull().default("block"),
  /** Where low-stock alerts go. Falls back to the shop email. */
  inventoryAlertEmail: text("inventory_alert_email"),
  /** This shop's changes to the brand's staff time rules; missing keys follow the brand. */
  staffTime: jsonb("staff_time").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Where card money settles (src/domain/connect.ts): the brand's own Stripe account, the shop's own connected account, or no cards at all. */
  paymentsMode: text("payments_mode").$type<PaymentsMode>().notNull().default("connected"),
  /** What clients see on their card statement. On a connected account it's the account's own descriptor; on the brand account it's the suffix after the brand's prefix. */
  statementDescriptor: text("statement_descriptor"),
  /** Receipt branding (ReceiptBranding in src/domain/connect.ts); missing keys use the defaults. */
  receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The shop's Stripe Terminal Location (tml_…, or sim_tml_… in the simulator). Its card readers are registered to it. */
  stripeTerminalLocationId: text("stripe_terminal_location_id").unique(),
  /** Where the shop is, for the time clock's GPS geofence. */
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  /** How staff may punch here (ShopClockSettings in src/domain/time-clock.ts); missing keys use the defaults. */
  timeClock: jsonb("time_clock").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** When and how this shop pays out tips (ShopTipSettings in src/domain/tips.ts); missing keys use the defaults. */
  tipPayouts: jsonb("tip_payouts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Where staff may sign in to this shop from (ShopNetworkRule in src/domain/network-access.ts); empty is no restriction. */
  networkAccess: jsonb("network_access").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The customer screen at checkout (ShopHandoff in src/domain/handoff.ts): tip presets, tips on the reader, signature, unlock PIN; missing keys use the defaults. */
  handoff: jsonb("handoff").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}, (t) => [
  check("shops_status", sql`${t.status} in ('setup', 'live', 'closed', 'archived') AND ${t.active} = (${t.status} <> 'archived')`),
  check("shops_payments_mode", sql`${t.paymentsMode} in ('brand', 'connected', 'cash_only')`),
]);
export type PaymentsMode = "brand" | "connected" | "cash_only";
export type NegativeStockPolicy = "block" | "warn";
export type ShopStatus = "setup" | "live" | "closed" | "archived";

/** Stripe Terminal card readers at a shop. Without a Stripe reader ID it's a placeholder until the reader is registered. */
export const terminalReaders = pgTable(
  "terminal_readers",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    label: text("label").notNull(),
    serialNumber: text("serial_number"),
    stripeReaderId: text("stripe_reader_id").unique(),
    /** As Stripe reports it, e.g. bbpos_wisepos_e or simulated_wisepos_e. */
    deviceType: text("device_type"),
    /** The Terminal Location it was registered to: always its shop's. */
    stripeLocationId: text("stripe_location_id"),
    registeredAt: ts("registered_at"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("terminal_readers_shop_idx").on(t.shopId)],
);

/**
 * Each shop's Stripe Connect connected account (Express dashboard, Stripe-hosted onboarding). Card
 * charges are destination charges on the Ray'z platform account, settled on behalf of this account.
 */
export const shopPaymentAccounts = pgTable("shop_payment_accounts", {
  shopId: uuid("shop_id")
    .primaryKey()
    .references(() => shops.id),
  stripeAccountId: text("stripe_account_id").notNull().unique(),
  /** sim_acct_… accounts belong to the no-keys simulator and never reach Stripe. */
  simulated: boolean("simulated").notNull().default(false),
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  /** Stripe's requirements.currently_due, plus past_due ones, as field names. */
  requirementsDue: jsonb("requirements_due").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  disabledReason: text("disabled_reason"),
  /** settings.payouts.schedule as Stripe last reported it. Display only: the schedule is changed in Stripe. */
  payoutSchedule: jsonb("payout_schedule").$type<PayoutSchedule>(),
  /** Set when the account owner disconnects it from the platform. */
  deauthorizedAt: ts("deauthorized_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export interface PayoutSchedule {
  interval: string;
  delayDays: number | null;
  weeklyAnchor?: string | null;
  monthlyAnchor?: number | null;
}

/**
 * Payouts to a bank, as Stripe reports them: from a shop's connected account (shop_id set), or from
 * the brand's own account (stripe_account_id 'platform', no shop) for every shop on the brand account.
 */
export const shopPayouts = pgTable(
  "shop_payouts",
  {
    id: id(),
    shopId: uuid("shop_id").references(() => shops.id),
    stripeAccountId: text("stripe_account_id").notNull(),
    stripePayoutId: text("stripe_payout_id").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(), // pending | in_transit | paid | failed | canceled
    arrivalDate: date("arrival_date").notNull(),
    failureMessage: text("failure_message"),
    /** What the payout is made of, from its balance transactions. Null until Stripe has itemized it. */
    grossCents: integer("gross_cents"),
    feeCents: integer("fee_cents"),
    refundCents: integer("refund_cents"),
    itemCount: integer("item_count"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("shop_payouts_shop_arrival_idx").on(t.shopId, t.arrivalDate), check("shop_payouts_owner", sql`${t.shopId} is not null or ${t.stripeAccountId} = 'platform'`)],
);

export const shopHours = pgTable(
  "shop_hours",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(), // 0 = Sunday
    openMin: integer("open_min").notNull(),
    closeMin: integer("close_min").notNull(),
  },
  (t) => [index("shop_hours_shop_idx").on(t.shopId)],
);

export const shopClosures = pgTable(
  "shop_closures",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    reason: text("reason"),
  },
  (t) => [uniqueIndex("shop_closures_uq").on(t.shopId, t.date)],
);

// ───────────────────────────── Staff ─────────────────────────────

/** Permission roles. Templates (key set) can be edited but not deleted; custom roles have no key. */
export const roles = pgTable("roles", {
  id: id(),
  key: text("key").unique(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  /** Permission keys from src/domain/permissions.ts. */
  permissions: jsonb("permissions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  maxDiscountPct: smallint("max_discount_pct").notNull().default(0),
  /** Suggested shop access for people given this role. */
  defaultScope: text("default_scope").$type<"all" | "selected" | "one">().notNull().default("one"),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const staff = pgTable("staff", {
  id: id(),
  /** Short human-friendly unique staff ID (e.g. "S-0007"). */
  staffCode: text("staff_code").notNull().unique(),
  firstName: text("first_name").notNull(),
  /** Private. Never exposed publicly or used in URLs. */
  lastName: text("last_name"),
  /** Admin-set label shown everywhere first names collide, e.g. "Taylor R.". */
  displayLabel: text("display_label").notNull(),
  /** URL-safe, surname-free slug used in booking links. */
  publicSlug: text("public_slug").notNull().unique(),
  email: text("email").unique(),
  phone: text("phone"),
  color: text("color").notNull().default("#64748b"),
  roleId: uuid("role_id")
    .notNull()
    .references(() => roles.id),
  /** all = every shop; selected / one = the shops in staff_access_shops. */
  shopScope: text("shop_scope").$type<"all" | "selected" | "one">().notNull().default("selected"),
  /** Per-person changes on top of the role: { "pos.discount": true, "sales.refund": false }. */
  permissionOverrides: jsonb("permission_overrides").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
  /** Replaces the role's discount limit for this person. */
  maxDiscountPct: smallint("max_discount_pct"),
  isBookable: boolean("is_bookable").notNull().default(true),
  /** This barber's slot interval at every shop; null follows each shop. staff_shops can override it per shop. */
  slotIntervalMinutes: integer("slot_interval_minutes"),
  active: boolean("active").notNull().default(true),
  passwordHash: text("password_hash"),
  squireName: text("squire_name"),
  /** "shop": a shared login for one shop (its front desk), not a person; never bookable. */
  kind: text("kind").$type<"person" | "shop">().notNull().default("person"),
  lastSignInAt: ts("last_sign_in_at"),
  /** Sessions started before this are signed out (a password reset or a disabled login). */
  sessionsValidAfter: ts("sessions_valid_after"),
  /** bcrypt of their time clock PIN, for punching on a shop's shared device. */
  clockPinHash: text("clock_pin_hash"),
  clockPinFailures: smallint("clock_pin_failures").notNull().default(0),
  clockPinLockedUntil: ts("clock_pin_locked_until"),
  /** They allow clocking in early to open earlier slots that day, where the shop turns that on. */
  clockOpensEarly: boolean("clock_opens_early").notNull().default(false),
  createdAt: createdAt(),
});

export const staffShops = pgTable(
  "staff_shops",
  {
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    visibleOnline: boolean("visible_online").notNull().default(true),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** This barber's slot interval at this shop; null follows the barber, then the shop, then the brand. */
    slotIntervalMinutes: integer("slot_interval_minutes"),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.shopId] })],
);

/**
 * The shops a person is assigned to, when their scope isn't "all": the only shops they may see and
 * act on. Separate from where they're bookable (staff_shops).
 */
export const staffAccessShops = pgTable(
  "staff_access_shops",
  {
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    /** Their role at this shop; null = their main role. Per-person overrides apply on top at every shop. */
    roleId: uuid("role_id").references(() => roles.id),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.shopId] }), index("staff_access_shops_shop_idx").on(t.shopId)],
);

/** Saved sets of shops for report filters, e.g. "Quad Cities". Brand-wide; each viewer sees only their shops in them. */
export const locationGroups = pgTable(
  "location_groups",
  {
    id: id(),
    name: text("name").notNull(),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("location_groups_name_unique").on(sql`lower(${t.name})`)],
);

export const locationGroupShops = pgTable(
  "location_group_shops",
  {
    groupId: uuid("group_id").notNull().references(() => locationGroups.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.shopId] })],
);

/** Saved sets of barbers for report filters, e.g. "Floaters". Brand-wide; each viewer sees only the barbers in them they can see. */
export const staffGroups = pgTable(
  "staff_groups",
  {
    id: id(),
    name: text("name").notNull(),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_groups_name_unique").on(sql`lower(${t.name})`)],
);

export const staffGroupMembers = pgTable(
  "staff_group_members",
  {
    groupId: uuid("group_id").notNull().references(() => staffGroups.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.staffId] })],
);

export const staffSchedules = pgTable(
  "staff_schedules",
  {
    id: id(),
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
  },
  (t) => [index("staff_schedules_staff_idx").on(t.staffId), index("staff_schedules_shop_idx").on(t.shopId)],
);

/**
 * The brand's reasons for blocked time and time off (Lunch, Bank, Doctor...), each with its calendar
 * color. Private reasons are shown as "Blocked" or "Time off" to staff without "See private reasons".
 * Archived, not deleted, so old entries keep theirs.
 */
export const blockReasons = pgTable(
  "block_reasons",
  {
    id: id(),
    key: text("key").notNull().unique(),
    label: text("label").notNull(),
    color: text("color").notNull(),
    /** "clock": written by the time clock only (Clocked out, Not in yet), never offered in a picker. */
    usedFor: text("used_for").$type<"blocks" | "time_off" | "both" | "clock">().notNull().default("both"),
    countsAsLunch: boolean("counts_as_lunch").notNull().default(false),
    noticeExempt: boolean("notice_exempt").notNull().default(false),
    private: boolean("private").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(100),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("block_reasons_label_unique").on(sql`lower(${t.label})`).where(sql`${t.archivedAt} IS NULL`)],
);

export const timeBlocks = pgTable(
  "time_blocks",
  {
    id: id(),
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    /** null = all shops (e.g. a day off). */
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    kind: text("kind").notNull().default("block"), // block | day_off
    /** lunch (held to the lunch limit) | other | time_off (from an approved request or a manager's time off). */
    category: text("category").$type<BlockCategory>().notNull().default("other"),
    reasonId: uuid("reason_id").references(() => blockReasons.id),
    /** The reason's label when it was saved (null reason_id: entries from before the list). */
    reason: text("reason").notNull(),
    note: text("note"),
    /** One occurrence of a recurring block. */
    seriesId: uuid("series_id").references(() => timeBlockSeries.id, { onDelete: "set null" }),
    /** The approved time off request this block is. */
    requestId: uuid("request_id").references(() => timeOffRequests.id, { onDelete: "set null" }),
    /** "clock": written by the time clock from punches (src/server/clock-blocks.ts), not by a person. */
    source: text("source").$type<BlockSource>().notNull().default("manual"),
    /** Which clock event it is ("break:<punch>", "out:<punch>", "not_in:<staff>:<shop>:<start>"), so each punch has one block. */
    clockKey: text("clock_key"),
    /** The punch that started it (the break start or the clock-out). */
    punchId: uuid("punch_id").references((): AnyPgColumn => timePunches.id, { onDelete: "set null" }),
    /** The punch that ended it (the break end, or the clock-in after). */
    endPunchId: uuid("end_punch_id").references((): AnyPgColumn => timePunches.id, { onDelete: "set null" }),
    /** Still going: the end follows the clock until the punch that ends it. */
    clockOpen: boolean("clock_open").notNull().default(false),
    /** A manager set its times by hand: the clock stops moving it. */
    overriddenAt: ts("overridden_at"),
    overriddenBy: uuid("overridden_by"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_blocks_staff_time_idx").on(t.staffId, t.startsAt),
    uniqueIndex("time_blocks_series_start_unique").on(t.seriesId, t.startsAt),
    index("time_blocks_request_idx").on(t.requestId),
    uniqueIndex("time_blocks_clock_key_unique").on(t.clockKey),
    index("time_blocks_punch_idx").on(t.punchId),
    index("time_blocks_clock_open_idx").on(t.endsAt).where(sql`${t.clockOpen}`),
    check("time_blocks_source", sql`${t.source} in ('manual', 'clock')`),
  ],
);
export type BlockCategory = "lunch" | "other" | "time_off";
export type BlockSource = "manual" | "clock";

/** Clock blocks a manager took off the calendar: the time clock won't write that one again. */
export const clockBlockReleases = pgTable("clock_block_releases", {
  clockKey: text("clock_key").primaryKey(),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => staff.id, { onDelete: "cascade" }),
  shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
  releasedBy: uuid("released_by"),
  releasedAt: ts("released_at").notNull().defaultNow(),
  note: text("note"),
});

/**
 * A recurring block, e.g. lunch every weekday 12:00–12:30. Its occurrences are written to
 * time_blocks ahead of time (through materialized_through), so availability and the calendar
 * read one table. Ending the series removes the occurrences that haven't started.
 */
export const timeBlockSeries = pgTable(
  "time_block_series",
  {
    id: id(),
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    /** null = all of the barber's shops. */
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    category: text("category").$type<BlockCategory>().notNull(),
    reasonId: uuid("reason_id").references(() => blockReasons.id),
    reason: text("reason").notNull(),
    note: text("note"),
    /** 0 = Sunday … 6 = Saturday. */
    weekdays: smallint("weekdays").array().notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
    startsOn: date("starts_on").notNull(),
    /** Last day it applies; null = until it's ended. */
    endsOn: date("ends_on"),
    materializedThrough: date("materialized_through").notNull(),
    endedAt: ts("ended_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("time_block_series_staff_idx").on(t.staffId), check("time_block_series_order", sql`${t.startMin} < ${t.endMin}`)],
);

export type TimeOffStatus = "pending" | "approved" | "denied" | "cancelled";

/**
 * A barber's request for time off: whole days (from_date..to_date) or part of one day
 * (start_min..end_min on from_date). Pending requests hold the time off online booking;
 * approval writes the time_blocks row that blocks it everywhere.
 */
export const timeOffRequests = pgTable(
  "time_off_requests",
  {
    id: id(),
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    /** null = all of the barber's shops. */
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    /** Both null for whole days; both set for part of one day. */
    startMin: integer("start_min"),
    endMin: integer("end_min"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    reasonId: uuid("reason_id").references(() => blockReasons.id),
    /** The reason's label when it was asked for. */
    reason: text("reason").notNull(),
    note: text("note"),
    status: text("status").$type<TimeOffStatus>().notNull().default("pending"),
    /** "auto" when the shop's rules approved it on submission. */
    decidedVia: text("decided_via").$type<"auto" | "manager">(),
    requestedBy: uuid("requested_by"),
    decidedBy: uuid("decided_by"),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("time_off_requests_staff_idx").on(t.staffId, t.startsAt),
    index("time_off_requests_status_idx").on(t.status, t.startsAt),
    check("time_off_requests_order", sql`${t.startsAt} < ${t.endsAt} AND ${t.fromDate} <= ${t.toDate}`),
    check("time_off_requests_partial", sql`(${t.startMin} IS NULL) = (${t.endMin} IS NULL) AND (${t.startMin} IS NULL OR ${t.fromDate} = ${t.toDate})`),
  ],
);

// ───────────────────────────── Catalog ─────────────────────────────

/** Which of the shop's tax rates applies to an item. */
export type TaxCategory = "service" | "product" | "exempt";

export const services = pgTable("services", {
  id: id(),
  slug: text("slug").notNull().unique(),
  /** Matches rows on bulk upload. Unique across services and products (checked by the app). */
  sku: text("sku").unique(),
  name: text("name").notNull(),
  kind: serviceKind("kind").notNull().default("service"),
  category: text("category").notNull().default("Haircuts"),
  description: text("description"),
  defaultPriceCents: integer("default_price_cents").notNull(),
  defaultDurationMin: integer("default_duration_min").notNull(),
  /** Every duration for this service (default, shop, barber) is a multiple of this: 5, 10, 15, 20 or 30. */
  durationStepMin: integer("duration_step_min").notNull().default(5),
  /** Start times for this service step by this instead of the barber's interval. Null: the barber's interval. */
  bookingIncrementMin: integer("booking_increment_min"),
  /** Prep before and cleanup after, held on the barber's calendar. Add-ons' buffers add to the main service's. */
  bufferBeforeMin: integer("buffer_before_min").notNull().default(0),
  bufferAfterMin: integer("buffer_after_min").notNull().default(0),
  taxCategory: text("tax_category").$type<TaxCategory>().notNull().default("service"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: createdAt(),
});

export const shopServices = pgTable(
  "shop_services",
  {
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    bookableOnline: boolean("bookable_online").notNull().default(true),
    priceCents: integer("price_cents"),
    durationMin: integer("duration_min"),
    nameOverride: text("name_override"),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.serviceId] })],
);

/** How long a service takes one barber: at one shop (shop_id set) or everywhere (null). Beats the shop and brand durations. */
export const staffServiceDurations = pgTable(
  "staff_service_durations",
  {
    id: id(),
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    durationMin: integer("duration_min").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("staff_service_durations_uq").on(t.staffId, t.serviceId, t.shopId).nullsNotDistinct(), index("staff_service_durations_staff_idx").on(t.staffId)],
);

export const products = pgTable("products", {
  id: id(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  /** The maker, e.g. "Reuzel". */
  brand: text("brand").notNull(),
  category: text("category").notNull().default("Styling"),
  barcode: text("barcode").unique(),
  taxCategory: text("tax_category").$type<TaxCategory>().notNull().default("product"),
  /** Brand-level cost and price; each shop starts from these and can override its price. */
  costCents: integer("cost_cents").notNull().default(0),
  priceCents: integer("price_cents").notNull().default(0),
  /** Brand default reorder point: low stock at or below this. Shops can override it. */
  lowStockThreshold: integer("low_stock_threshold").notNull().default(3),
  /** Brand default par: suggested orders fill up to this. Shops can override it. */
  parLevel: integer("par_level").notNull().default(6),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const shopProducts = pgTable(
  "shop_products",
  {
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    /** Average cost of what's on the shelf; receiving at a new cost moves it. */
    costCents: integer("cost_cents").notNull(),
    priceCents: integer("price_cents").notNull(),
    /** On hand. Maintained by a trigger from inventory_ledger and can't be written directly (drizzle/0012_inventory.sql). */
    stock: integer("stock").notNull().default(0),
    /** Shop override of the brand reorder point; null follows the brand. */
    lowStockThreshold: integer("low_stock_threshold"),
    /** Shop override of the brand par level; null follows the brand. */
    parLevel: integer("par_level"),
    active: boolean("active").notNull().default(true),
    /** When a low-stock alert last went out; cleared once stock is back above the reorder point. */
    lowAlertedAt: ts("low_alerted_at"),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.productId] })],
);

export type LedgerKind = "opening" | "sale" | "refund" | "void" | "receive" | "transfer_out" | "transfer_in" | "adjust" | "stocktake" | "upload";
export type AdjustReason = "damage" | "theft" | "count_correction" | "back_bar" | "found" | "other";

/**
 * Every change to stock, append-only. Inserting a row moves shop_products.stock and records the
 * balance after it; rows can't be updated or deleted, so on-hand is always the sum of the ledger.
 */
export const inventoryLedger = pgTable(
  "inventory_ledger",
  {
    id: id(),
    /** Posting order. balance_after follows it. */
    seq: integer("seq").generatedAlwaysAsIdentity(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    productId: uuid("product_id").notNull().references(() => products.id),
    delta: integer("delta").notNull(),
    kind: text("kind").$type<LedgerKind>().notNull(),
    /** Manual adjustments only. */
    reason: text("reason").$type<AdjustReason>(),
    note: text("note"),
    /** Cost of each unit moved, for valuing receipts, transfers and shrink. */
    unitCostCents: integer("unit_cost_cents"),
    /** Set by the trigger: on-hand at this shop right after this entry. */
    balanceAfter: integer("balance_after").notNull().default(0),
    saleId: uuid("sale_id"),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    receiptId: uuid("receipt_id").references(() => poReceipts.id),
    transferId: uuid("transfer_id").references(() => stockTransfers.id),
    countId: uuid("count_id").references(() => stockCounts.id),
    staffId: uuid("staff_id"),
    createdAt: createdAt(),
  },
  (t) => [index("inventory_ledger_shop_product_idx").on(t.shopId, t.productId, t.seq), index("inventory_ledger_shop_at_idx").on(t.shopId, t.createdAt)],
);

// ───────────────────────────── Purchasing ─────────────────────────────

export const vendors = pgTable(
  "vendors",
  {
    id: id(),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    accountNumber: text("account_number"),
    paymentTerms: text("payment_terms"),
    leadTimeDays: integer("lead_time_days").notNull().default(7),
    minimumOrderCents: integer("minimum_order_cents").notNull().default(0),
    /** Attach a CSV of the lines as well as the PDF when emailing a purchase order. */
    sendCsv: boolean("send_csv").notNull().default(false),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vendors_name_unique").on(sql`lower(${t.name})`)],
);

/** The vendors a shop orders from, with the shop's own account number there. No rows: every active vendor. */
export const shopVendors = pgTable(
  "shop_vendors",
  {
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
    accountNumber: text("account_number"),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.vendorId] })],
);

/** Who sells a product, at what cost and case pack. At most one preferred vendor per product. */
export const vendorProducts = pgTable(
  "vendor_products",
  {
    vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    vendorSku: text("vendor_sku"),
    casePack: integer("case_pack").notNull().default(1),
    /** Per unit. */
    costCents: integer("cost_cents").notNull(),
    preferred: boolean("preferred").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.vendorId, t.productId] }), uniqueIndex("vendor_products_preferred_uq").on(t.productId).where(sql`preferred`)],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    number: integer("number").generatedAlwaysAsIdentity({ startWith: 1001 }),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
    status: poStatus("status").notNull().default("draft"),
    /** POs created together for several shops share a batch. */
    batchId: uuid("batch_id"),
    expectedOn: date("expected_on"),
    /** Printed on the PO for the vendor. */
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => staff.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    sentBy: uuid("sent_by").references(() => staff.id, { onDelete: "set null" }),
    sentAt: ts("sent_at"),
    sentTo: text("sent_to"),
    cancelledBy: uuid("cancelled_by").references(() => staff.id, { onDelete: "set null" }),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
    /** Closed before everything arrived; the rest is no longer on order. */
    closedShort: boolean("closed_short").notNull().default(false),
    receivedAt: ts("received_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("purchase_orders_shop_status_idx").on(t.shopId, t.status), index("purchase_orders_vendor_idx").on(t.vendorId, t.createdAt)],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: id(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    vendorSku: text("vendor_sku"),
    casePack: integer("case_pack").notNull().default(1),
    /** Units, not cases. */
    qtyOrdered: integer("qty_ordered").notNull(),
    unitCostCents: integer("unit_cost_cents").notNull(),
    qtyReceived: integer("qty_received").notNull().default(0),
  },
  (t) => [uniqueIndex("purchase_order_lines_uq").on(t.purchaseOrderId, t.productId)],
);

export const poReceipts = pgTable(
  "po_receipts",
  {
    id: id(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    note: text("note"),
    receivedBy: uuid("received_by").references(() => staff.id, { onDelete: "set null" }),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [index("po_receipts_po_idx").on(t.purchaseOrderId)],
);

export const poReceiptLines = pgTable(
  "po_receipt_lines",
  {
    id: id(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => poReceipts.id, { onDelete: "cascade" }),
    lineId: uuid("line_id")
      .notNull()
      .references(() => purchaseOrderLines.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    qty: integer("qty").notNull(),
    /** What the vendor actually charged per unit; may differ from the PO. */
    unitCostCents: integer("unit_cost_cents").notNull(),
  },
  (t) => [index("po_receipt_lines_receipt_idx").on(t.receiptId)],
);

export const stockTransfers = pgTable(
  "stock_transfers",
  {
    id: id(),
    number: integer("number").generatedAlwaysAsIdentity({ startWith: 501 }),
    fromShopId: uuid("from_shop_id")
      .notNull()
      .references(() => shops.id),
    toShopId: uuid("to_shop_id")
      .notNull()
      .references(() => shops.id),
    status: transferStatus("status").notNull().default("draft"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    sentBy: uuid("sent_by").references(() => staff.id, { onDelete: "set null" }),
    sentAt: ts("sent_at"),
    receivedBy: uuid("received_by").references(() => staff.id, { onDelete: "set null" }),
    receivedAt: ts("received_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [index("stock_transfers_from_idx").on(t.fromShopId, t.status), index("stock_transfers_to_idx").on(t.toShopId, t.status)],
);

export const stockTransferLines = pgTable(
  "stock_transfer_lines",
  {
    id: id(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    qty: integer("qty").notNull(),
    /** Set on receipt; short of qty is lost in transit. */
    qtyReceived: integer("qty_received"),
    /** Source shop's cost when it was sent. */
    unitCostCents: integer("unit_cost_cents"),
  },
  (t) => [uniqueIndex("stock_transfer_lines_uq").on(t.transferId, t.productId)],
);

/** A cycle count (some products) or full stocktake (everything the shop carries). */
export const stockCounts = pgTable(
  "stock_counts",
  {
    id: id(),
    number: integer("number").generatedAlwaysAsIdentity({ startWith: 101 }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    kind: text("kind").$type<"cycle" | "full">().notNull(),
    status: countStatus("status").notNull().default("open"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    postedBy: uuid("posted_by").references(() => staff.id, { onDelete: "set null" }),
    postedAt: ts("posted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("stock_counts_shop_idx").on(t.shopId, t.createdAt)],
);

export const stockCountLines = pgTable(
  "stock_count_lines",
  {
    id: id(),
    countId: uuid("count_id")
      .notNull()
      .references(() => stockCounts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    /** On hand when the count started, for reference. */
    expectedAtStart: integer("expected_at_start").notNull(),
    counted: integer("counted"),
    /** Set when posted: on hand at that moment, and counted minus it. */
    onHandAtPost: integer("on_hand_at_post"),
    variance: integer("variance"),
    unitCostCents: integer("unit_cost_cents"),
  },
  (t) => [uniqueIndex("stock_count_lines_uq").on(t.countId, t.productId)],
);

// ───────────────────────────── Customers & auth ─────────────────────────────

export const customers = pgTable(
  "customers",
  {
    id: id(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    /** E.164, e.g. +13195551234 */
    phone: text("phone"),
    email: text("email"),
    /** One line: "street, city, state zip". */
    address: text("address"),
    birthday: date("birthday"),
    notes: text("notes"),
    /** Values of the brand's custom client fields, by client_fields.id. */
    customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** Consent is opt-in: nothing is sent until the client (or their Squire record) says yes. */
    smsOptIn: boolean("sms_opt_in").notNull().default(false),
    emailOptIn: boolean("email_opt_in").notNull().default(false),
    homeShopId: uuid("home_shop_id").references(() => shops.id),
    preferredStaffId: uuid("preferred_staff_id").references(() => staff.id, { onDelete: "set null" }),
    /** When their barber calls in, the appointment may be moved to a barber at another shop. */
    allowOtherShop: boolean("allow_other_shop").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // Not unique: Squire data has families sharing one phone number.
    index("customers_phone_idx").on(t.phone),
    index("customers_email_idx").on(t.email),
    index("customers_name_idx").on(t.firstName, t.lastName),
    index("customers_home_shop_idx").on(t.homeShopId),
    // Trigram indexes for substring search live in drizzle/0006_client_search.sql.
  ],
);

/** Client fields the brand adds, e.g. "Instagram" or "Allergies". Their visibility is set like the built-in ones. */
export const clientFields = pgTable("client_fields", {
  id: id(),
  label: text("label").notNull().unique(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: createdAt(),
});

/**
 * Who sees a client field, and how: hidden, masked or full. For a role or one person, brand-wide
 * (shop_id null) or at one shop. Resolved by resolveLevel in src/domain/client-privacy.ts; with no
 * rule the role's built-in default applies.
 */
export const clientFieldRules = pgTable(
  "client_field_rules",
  {
    id: id(),
    /** A built-in field key, or custom:<client_fields.id>. */
    field: text("field").notNull(),
    /** view: who sees it (level hidden, masked or full); add and edit: who may enter it (allow or deny). */
    setting: text("setting").$type<"view" | "add" | "edit">().notNull().default("view"),
    level: text("level").$type<"hidden" | "masked" | "full" | "allow" | "deny">().notNull(),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("client_field_rules_uq").on(t.field, t.setting, t.roleId, t.staffId, t.shopId).nullsNotDistinct(), index("client_field_rules_staff_idx").on(t.staffId), index("client_field_rules_role_idx").on(t.roleId)],
);

/**
 * Every look at client data that the data-access report shows: profiles opened, searches, reveals
 * of masked details (with the reason), exports, calls and texts, and lookups paused by the limit.
 * Values are never stored here, only which field.
 */
export const clientAccessLog = pgTable(
  "client_access_log",
  {
    id: id(),
    at: ts("at").notNull().defaultNow(),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    actorLabel: text("actor_label").notNull(),
    /** The shop they were working in; null when working across shops. */
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "set null" }),
    /** No foreign key: the entry outlives the client record (a merge repoints it). */
    customerId: uuid("customer_id"),
    kind: text("kind").$type<"view" | "search" | "list" | "reveal" | "export" | "contact" | "blocked">().notNull(),
    field: text("field"),
    reason: text("reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  (t) => [index("client_access_staff_at_idx").on(t.staffId, t.at), index("client_access_customer_idx").on(t.customerId, t.at), index("client_access_at_idx").on(t.at)],
);

/** Unusual lookups, for brand admins: someone opened many profiles or ran many searches in a short time. */
export const clientAccessAlerts = pgTable(
  "client_access_alerts",
  {
    id: id(),
    at: ts("at").notNull().defaultNow(),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
    actorLabel: text("actor_label").notNull(),
    /** unusual: over the alert level; paused: over the limit, so their lookups stopped. */
    kind: text("kind").$type<"unusual" | "paused">().notNull(),
    profiles: integer("profiles").notNull().default(0),
    searches: integer("searches").notNull().default(0),
    windowMinutes: integer("window_minutes").notNull(),
    acknowledgedBy: uuid("acknowledged_by").references(() => staff.id, { onDelete: "set null" }),
    acknowledgedAt: ts("acknowledged_at"),
  },
  (t) => [index("client_access_alerts_at_idx").on(t.at), index("client_access_alerts_staff_idx").on(t.staffId, t.at)],
);

/** One client can carry several Squire client IDs (the same person was a separate record at two shops). */
export const customerSquireIds = pgTable(
  "customer_squire_ids",
  {
    squireId: text("squire_id").primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id),
    createdAt: createdAt(),
  },
  (t) => [index("customer_squire_ids_customer_idx").on(t.customerId)],
);

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: id(),
    identifier: text("identifier").notNull(), // normalized phone or email
    codeHash: text("code_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: ts("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("otp_identifier_idx").on(t.identifier, t.createdAt)],
);

export const refreshTokens = pgTable("refresh_tokens", {
  id: id(),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  deviceName: text("device_name"),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  replacedBy: uuid("replaced_by"),
  createdAt: createdAt(),
});

// ───────────────────────────── Appointments & walk-ins ─────────────────────────────

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    /** Unguessable public reference used in customer links (no names in URLs). */
    code: text("code").notNull().unique(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    customerId: uuid("customer_id").references(() => customers.id),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    /** Held after the service when booked: the services' cleanup plus the shop's gap between appointments. */
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    /** Held before the service when booked: the services' prep time. */
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    /**
     * Set by a trigger: starts_at - buffer_before_minutes and ends_at + buffer_minutes. The database refuses
     * overlapping service times always, and overlapping buffers unless the booking was squeezed in (drizzle/0019_slot_timing.sql).
     */
    busyFrom: ts("busy_from"),
    busyUntil: ts("busy_until"),
    /** Booked by staff off the grid, into buffer time or outside hours, with the "Squeeze in" permission. */
    squeezed: boolean("squeezed").notNull().default(false),
    status: appointmentStatus("status").notNull().default("booked"),
    source: appointmentSource("source").notNull().default("online"),
    anyBarber: boolean("any_barber").notNull().default(false),
    estimateCents: integer("estimate_cents").notNull().default(0),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key").unique(),
    rebookedFromId: uuid("rebooked_from_id"),
    squireId: text("squire_id").unique(),
    /** False for Squire rows whose export had no booked-at time; created_at is then a stand-in and rebook KPIs skip them. */
    bookedAtKnown: boolean("booked_at_known").notNull().default(true),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: text("cancelled_by"),
    checkedInAt: ts("checked_in_at"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("appointments_shop_time_idx").on(t.shopId, t.startsAt),
    index("appointments_staff_time_idx").on(t.staffId, t.startsAt),
    index("appointments_customer_idx").on(t.customerId, t.startsAt),
  ],
);

export const appointmentItems = pgTable(
  "appointment_items",
  {
    id: id(),
    appointmentId: uuid("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id),
    kind: serviceKind("kind").notNull(),
    name: text("name").notNull(),
    priceCents: integer("price_cents").notNull(),
    durationMin: integer("duration_min").notNull(),
  },
  (t) => [index("appointment_items_appt_idx").on(t.appointmentId)],
);

export const timingFinishedVia = pgEnum("timing_finished_via", ["finish", "checkout", "correction"]);
export const timingReview = pgEnum("timing_review", ["include", "exclude"]);

/**
 * When an appointment's client arrived, the service started and ended, and they checked out, each
 * with who recorded it. Checkout stands in for the end when Finish wasn't tapped. Managers can
 * correct times (logged) and count or leave out a flagged time.
 */
export const appointmentTimes = pgTable(
  "appointment_times",
  {
    appointmentId: uuid("appointment_id")
      .primaryKey()
      .references(() => appointments.id, { onDelete: "cascade" }),
    arrivedAt: ts("arrived_at"),
    arrivedBy: uuid("arrived_by").references(() => staff.id),
    startedAt: ts("started_at"),
    startedBy: uuid("started_by").references(() => staff.id),
    finishedAt: ts("finished_at"),
    finishedBy: uuid("finished_by").references(() => staff.id),
    finishedVia: timingFinishedVia("finished_via"),
    checkedOutAt: ts("checked_out_at"),
    checkedOutBy: uuid("checked_out_by").references(() => staff.id),
    review: timingReview("review"),
    reviewNote: text("review_note"),
    correctedAt: ts("corrected_at"),
    correctedBy: uuid("corrected_by").references(() => staff.id),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("appointment_times_started_idx").on(t.startedAt),
    check("appointment_times_order", sql`${t.finishedAt} is null or (${t.startedAt} is not null and ${t.finishedAt} > ${t.startedAt})`),
  ],
);

export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    customerId: uuid("customer_id").references(() => customers.id),
    name: text("name").notNull(),
    phone: text("phone"),
    serviceId: uuid("service_id").references(() => services.id),
    preferredStaffId: uuid("preferred_staff_id").references(() => staff.id),
    status: waitlistStatus("status").notNull().default("waiting"),
    quotedWaitMin: integer("quoted_wait_min"),
    appointmentId: uuid("appointment_id"),
    notes: text("notes"),
    joinedAt: ts("joined_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("waitlist_shop_idx").on(t.shopId, t.status, t.joinedAt)],
);

// ───────────────────────────── POS ─────────────────────────────

export const promoCodes = pgTable("promo_codes", {
  id: id(),
  code: text("code").notNull().unique(),
  description: text("description"),
  type: text("type").notNull(), // percent | amount
  value: integer("value").notNull(), // percent (whole) or cents
  appliesTo: text("applies_to").notNull().default("services"),
  shopId: uuid("shop_id").references(() => shops.id),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  maxRedemptions: integer("max_redemptions"),
  redemptions: integer("redemptions").notNull().default(0),
  active: boolean("active").notNull().default(true),
  /** free_item coupons: the add-on, service or product that's free (one of it). */
  freeItemKind: text("free_item_kind").$type<"service" | "addon" | "product">(),
  freeItemId: uuid("free_item_id"),
  /** Only these services and add-ons, and these products; both empty is whatever applies_to allows. */
  serviceIds: jsonb("service_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  productIds: jsonb("product_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Valid at these locations; empty (and shop_id null) is every location. */
  shopIds: jsonb("shop_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  minSpendCents: integer("min_spend_cents"),
  maxPerCustomer: integer("max_per_customer"),
  /** shared: everyone uses `code`. unique: campaigns issue single-use codes (coupon_codes), `code` is their prefix. */
  codeMode: text("code_mode").$type<"shared" | "unique">().notNull().default("shared"),
  /** Single-use codes stop working this many days after they're sent. */
  validDays: integer("valid_days"),
  firstVisitOnly: boolean("first_visit_only").notNull().default(false),
  /** Combines with other coupons and manual discounts. Existing promo codes always did. */
  stackable: boolean("stackable").notNull().default(true),
  /** Applied at checkout, without a code, when the client is eligible. */
  autoApply: boolean("auto_apply").notNull().default(false),
  createdAt: createdAt(),
});

/** Single-use codes a campaign issued for one client. */
export const couponCodes = pgTable(
  "coupon_codes",
  {
    id: id(),
    promoId: uuid("promo_id")
      .notNull()
      .references(() => promoCodes.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id"),
    expiresOn: date("expires_on"),
    redeemedAt: ts("redeemed_at"),
    saleId: uuid("sale_id"),
    createdAt: createdAt(),
  },
  (t) => [index("coupon_codes_customer_idx").on(t.customerId, t.promoId)],
);

/** Every coupon used on a ticket, for limits, attribution and the report. Reversed when the ticket is fully refunded or voided. */
export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: id(),
    promoId: uuid("promo_id")
      .notNull()
      .references(() => promoCodes.id),
    couponCodeId: uuid("coupon_code_id").references(() => couponCodes.id),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    staffId: uuid("staff_id"),
    campaignId: uuid("campaign_id"),
    discountCents: integer("discount_cents").notNull(),
    /** How it got on the ticket: typed at the POS, held from an online booking, or applied automatically. */
    via: text("via").$type<"code" | "booking" | "auto">().notNull(),
    reversedAt: ts("reversed_at"),
    createdAt: createdAt(),
  },
  (t) => [unique("coupon_redemptions_sale_promo_uq").on(t.saleId, t.promoId), index("coupon_redemptions_customer_idx").on(t.customerId, t.promoId), index("coupon_redemptions_campaign_idx").on(t.campaignId)],
);

/** A coupon a client entered when booking online, held for checkout. */
export const appointmentCoupons = pgTable("appointment_coupons", {
  appointmentId: uuid("appointment_id")
    .primaryKey()
    .references(() => appointments.id, { onDelete: "cascade" }),
  promoId: uuid("promo_id")
    .notNull()
    .references(() => promoCodes.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  createdAt: createdAt(),
});

export const giftCards = pgTable("gift_cards", {
  id: id(),
  code: text("code").notNull().unique(),
  initialCents: integer("initial_cents").notNull(),
  balanceCents: integer("balance_cents").notNull(),
  issuedShopId: uuid("issued_shop_id").references(() => shops.id),
  customerId: uuid("customer_id").references(() => customers.id),
  status: text("status").notNull().default("active"), // pending | active | void
  source: text("source").notNull().default("sold"), // sold | import | promo
  /** The ticket line that sold this card, so refunding that line voids it. */
  saleItemId: uuid("sale_item_id"),
  expiresAt: ts("expires_at"),
  createdAt: createdAt(),
});

export const giftCardLedger = pgTable("gift_card_ledger", {
  id: id(),
  giftCardId: uuid("gift_card_id").notNull().references(() => giftCards.id),
  saleId: uuid("sale_id"),
  deltaCents: integer("delta_cents").notNull(),
  kind: text("kind").notNull(), // issue | redeem | refund | void | import | adjust
  staffId: uuid("staff_id"),
  createdAt: createdAt(),
});

export const sales = pgTable(
  "sales",
  {
    id: id(),
    number: integer("number").generatedAlwaysAsIdentity(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    customerId: uuid("customer_id").references(() => customers.id),
    /** Barber credited with the ticket (services + tip). */
    staffId: uuid("staff_id").references(() => staff.id),
    status: saleStatus("status").notNull().default("open"),
    businessDate: date("business_date").notNull(),
    serviceGrossCents: integer("service_gross_cents").notNull().default(0),
    productGrossCents: integer("product_gross_cents").notNull().default(0),
    giftCardSalesCents: integer("gift_card_sales_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    serviceNetCents: integer("service_net_cents").notNull().default(0),
    productNetCents: integer("product_net_cents").notNull().default(0),
    serviceTaxCents: integer("service_tax_cents").notNull().default(0),
    productTaxCents: integer("product_tax_cents").notNull().default(0),
    tipCents: integer("tip_cents").notNull().default(0),
    cardFeeCents: integer("card_fee_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    /** Snapshot of rates/fee config used, for receipts and audits. */
    pricing: jsonb("pricing"),
    promoCodeId: uuid("promo_code_id").references(() => promoCodes.id),
    loyaltyEarnedCents: integer("loyalty_earned_cents").notNull().default(0),
    createdBy: uuid("created_by"),
    paidAt: ts("paid_at"),
    voidedAt: ts("voided_at"),
    voidReason: text("void_reason"),
    isImported: boolean("is_imported").notNull().default(false),
    /** Squire transaction ID (or a content hash when the export has none), so re-imports don't duplicate. */
    squireRef: text("squire_ref").unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_shop_date_idx").on(t.shopId, t.businessDate),
    index("sales_staff_date_idx").on(t.staffId, t.businessDate),
    index("sales_date_idx").on(t.businessDate),
    index("sales_customer_idx").on(t.customerId),
    uniqueIndex("sales_appointment_open_uq").on(t.appointmentId).where(sql`status <> 'voided'`),
  ],
);

export const saleItems = pgTable(
  "sale_items",
  {
    id: id(),
    saleId: uuid("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
    kind: lineKind("kind").notNull(),
    refId: uuid("ref_id"),
    name: text("name").notNull(),
    staffId: uuid("staff_id").references(() => staff.id),
    qty: integer("qty").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    grossCents: integer("gross_cents").notNull(),
    discountCents: integer("discount_cents").notNull().default(0),
    netCents: integer("net_cents").notNull(),
    taxCents: integer("tax_cents").notNull().default(0),
    /** Shop menu price at checkout; differs from unitPriceCents only on a manager override. */
    catalogPriceCents: integer("catalog_price_cents"),
    overrideReason: text("override_reason"),
    refundedQty: integer("refunded_qty").notNull().default(0),
  },
  (t) => [index("sale_items_sale_idx").on(t.saleId)],
);

export const payments = pgTable(
  "payments",
  {
    id: id(),
    saleId: uuid("sale_id").notNull().references(() => sales.id),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date").notNull(),
    method: paymentMethod("method").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    /** Total collected by this tender (incl. tip and card fee). */
    amountCents: integer("amount_cents").notNull(),
    tipCents: integer("tip_cents").notNull().default(0),
    cardFeeCents: integer("card_fee_cents").notNull().default(0),
    cashTenderedCents: integer("cash_tendered_cents"),
    /** Card data is never stored — only Stripe references and display metadata. */
    processor: text("processor"), // stripe | simulator | stripe_terminal_sim
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    cardFunding: text("card_funding"),
    entryMode: text("entry_mode"), // keyed | terminal
    giftCardId: uuid("gift_card_id").references(() => giftCards.id),
    refundedCents: integer("refunded_cents").notNull().default(0),
    /** The shop's connected account this card charge settled to (on_behalf_of + transfer_data.destination). */
    stripeAccountId: text("stripe_account_id"),
    /** What the platform kept to cover processing: the shop's processing fee for this charge. */
    applicationFeeCents: integer("application_fee_cents").notNull().default(0),
    /** What Stripe actually charged the platform, from the balance transaction, when known. */
    processorFeeCents: integer("processor_fee_cents"),
    stripeChargeId: text("stripe_charge_id"),
    stripeTransferId: text("stripe_transfer_id"),
    /** Card charges only: platform = settled in the brand's own Stripe account; connected = in stripeAccountId. Null for history from before Connect. */
    settlement: text("settlement").$type<"platform" | "connected">(),
    /** The card reader that took it, always one of the shop's. */
    terminalReaderId: uuid("terminal_reader_id").references(() => terminalReaders.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("payments_settlement", sql`${t.settlement} is null or ${t.settlement} in ('platform', 'connected')`),
    index("payments_shop_date_idx").on(t.shopId, t.businessDate),
    index("payments_account_idx").on(t.stripeAccountId),
    index("payments_sale_idx").on(t.saleId),
    uniqueIndex("payments_stripe_pi_uq").on(t.stripePaymentIntentId),
  ],
);

/**
 * A ticket with more than one barber on its services: how its tip is split between them. Each
 * payment's tip, and each tip refund, goes to them in proportion to the weights (the
 * tip_split_shares view). Tickets without rows here credit the whole tip to sales.staff_id.
 */
export const saleTipShares = pgTable(
  "sale_tip_shares",
  {
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    /** Their services' net in cents, or 1 for an even split. */
    weight: integer("weight").notNull(),
  },
  (t) => [primaryKey({ name: "sale_tip_shares_pk", columns: [t.saleId, t.staffId] }), index("sale_tip_shares_staff_idx").on(t.staffId), check("sale_tip_shares_weight", sql`${t.weight} > 0`)],
);

/**
 * A ticket handed to the client on the checkout device. While it's active (and, after paying, until
 * the thank-you screen ends) that browser shows only the customer screen for this ticket.
 */
export const checkoutHandoffs = pgTable(
  "checkout_handoffs",
  {
    id: id(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => staff.id),
    /** active: with the client. paid: paid on the customer screen. returned: taken back by staff before paying. */
    status: text("status").$type<HandoffStatus>().notNull().default("active"),
    /** The ticket as staff handed it over (HandoffDraft in src/server/handoff.ts); the client can't change it. */
    draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
    tipCents: integer("tip_cents"),
    /** Which button: p20, a500, custom, none, or reader. */
    tipChoice: text("tip_choice"),
    tipSource: text("tip_source").$type<"screen" | "reader">(),
    /** SVG path data in a 600×200 box. */
    signature: text("signature"),
    signedAt: ts("signed_at"),
    receiptChannel: text("receipt_channel").$type<"sms" | "email" | "none">(),
    /** Where to send it, until it's queued; then cleared, leaving only the masked form. */
    receiptTo: text("receipt_to"),
    receiptMasked: text("receipt_masked"),
    /** The client chose to pay cash, so the counter takes it from here. */
    cashRequested: boolean("cash_requested").notNull().default(false),
    startedAt: ts("started_at").notNull().defaultNow(),
    paidAt: ts("paid_at"),
    /** When the device stops being locked: null while it is. After paying it's the end of the thank-you screen. */
    endedAt: ts("ended_at"),
    endedBy: uuid("ended_by").references(() => staff.id, { onDelete: "set null" }),
  },
  (t) => [
    check("checkout_handoffs_status", sql`${t.status} in ('active', 'paid', 'returned')`),
    check("checkout_handoffs_tip_source", sql`${t.tipSource} is null or ${t.tipSource} in ('screen', 'reader')`),
    check("checkout_handoffs_receipt_channel", sql`${t.receiptChannel} is null or ${t.receiptChannel} in ('sms', 'email', 'none')`),
    check("checkout_handoffs_tip", sql`${t.tipCents} is null or ${t.tipCents} >= 0`),
    uniqueIndex("checkout_handoffs_active_uq").on(t.saleId).where(sql`${t.status} = 'active'`),
    index("checkout_handoffs_sale_idx").on(t.saleId, t.startedAt),
  ],
);
export type HandoffStatus = "active" | "paid" | "returned";

/**
 * Every digital receipt sent for a ticket, and the client's "no receipt" choice. A sent receipt has
 * its own link to the receipt page (only the SHA-256 of the token is kept); every link shows the
 * ticket as it is now, so an old link shows refunds too.
 */
export const receiptDeliveries = pgTable(
  "receipt_deliveries",
  {
    id: id(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    channel: text("channel").$type<"sms" | "email" | "none">().notNull(),
    /** E.164 phone or lowercased email; null for "no receipt". Refund and void updates go here. */
    destination: text("destination"),
    masked: text("masked"),
    /** ReceiptPurpose in src/domain/receipts.ts. */
    purpose: text("purpose").$type<"counter" | "handoff" | "refund" | "void" | "resend" | "request" | "review">().notNull(),
    tokenHash: text("token_hash").unique(),
    jobId: uuid("job_id").references(() => notificationJobs.id, { onDelete: "set null" }),
    /**
     * Not sent: opted_out (STOP, or receipt emails off) or no_consent; for a review request also recent
     * (asked lately), few_visits (before the client's Nth visit) or snoozed (tapped the link lately).
     */
    skipped: text("skipped").$type<"opted_out" | "no_consent" | "recent" | "few_visits" | "snoozed">(),
    sentBy: uuid("sent_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("receipt_deliveries_channel", sql`${t.channel} in ('sms', 'email', 'none')`),
    check("receipt_deliveries_purpose", sql`${t.purpose} in ('counter', 'handoff', 'refund', 'void', 'resend', 'request', 'review')`),
    check("receipt_deliveries_skipped", sql`${t.skipped} is null or ${t.skipped} in ('opted_out', 'no_consent', 'recent', 'few_visits', 'snoozed')`),
    check("receipt_deliveries_destination", sql`(${t.channel} = 'none') = (${t.destination} is null)`),
    index("receipt_deliveries_sale_idx").on(t.saleId, t.createdAt),
    index("receipt_deliveries_destination_idx").on(t.destination, t.createdAt),
    index("receipt_deliveries_customer_idx").on(t.customerId, t.shopId, t.purpose, t.createdAt),
  ],
);

/**
 * A client opening the location's Google review link: "Leave a review" on the receipt page, or the
 * link in the follow-up. Counted per location and per the ticket's barber. Link previews and email
 * scanners aren't recorded. Google doesn't say whether a review was posted, so these are clicks.
 */
export const reviewClicks = pgTable(
  "review_clicks",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    /** The ticket's barber when it was clicked. */
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id").references(() => receiptDeliveries.id, { onDelete: "set null" }),
    source: text("source").$type<"receipt" | "follow_up">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("review_clicks_source", sql`${t.source} in ('receipt', 'follow_up')`),
    index("review_clicks_shop_idx").on(t.shopId, t.createdAt),
    index("review_clicks_staff_idx").on(t.staffId, t.createdAt),
    index("review_clicks_sale_idx").on(t.saleId),
  ],
);

/** Emails that turned off receipt emails from the receipt page. Texts use contact_opt_outs (STOP). */
export const receiptOptOuts = pgTable("receipt_opt_outs", {
  email: text("email").primaryKey(),
  createdAt: createdAt(),
});

export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    saleId: uuid("sale_id").notNull().references(() => sales.id),
    paymentId: uuid("payment_id").references(() => payments.id),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date").notNull(),
    method: paymentMethod("method").notNull(),
    amountCents: integer("amount_cents").notNull(),
    serviceNetCents: integer("service_net_cents").notNull().default(0),
    productNetCents: integer("product_net_cents").notNull().default(0),
    giftCardSalesCents: integer("gift_card_sales_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    tipCents: integer("tip_cents").notNull().default(0),
    cardFeeCents: integer("card_fee_cents").notNull().default(0),
    reason: text("reason").notNull(),
    kind: text("kind").notNull().default("refund"), // refund | void
    /** staff = issued from the POS; stripe_dashboard = picked up from a charge.refunded webhook. */
    source: text("source").notNull().default("staff"),
    /** Lines refunded, for receipts: [{ saleItemId, name, qty, cents }]. */
    items: jsonb("items"),
    stripeRefundId: text("stripe_refund_id"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("refunds_shop_date_idx").on(t.shopId, t.businessDate), index("refunds_sale_idx").on(t.saleId)],
);

export const cashDrawers = pgTable(
  "cash_drawers",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date").notNull(),
    openingFloatCents: integer("opening_float_cents").notNull().default(0),
    cashSalesCents: integer("cash_sales_cents").notNull().default(0),
    cashRefundsCents: integer("cash_refunds_cents").notNull().default(0),
    payoutsCents: integer("payouts_cents").notNull().default(0),
    /** Cash tip payouts acknowledged by the employee out of this drawer. */
    tipPayoutsCents: integer("tip_payouts_cents").notNull().default(0),
    expectedCents: integer("expected_cents").notNull().default(0),
    countedCents: integer("counted_cents"),
    varianceCents: integer("variance_cents"),
    notes: text("notes"),
    closedBy: uuid("closed_by"),
    closedAt: ts("closed_at"),
  },
  (t) => [uniqueIndex("cash_drawers_uq").on(t.shopId, t.businessDate)],
);

// ───────────────────────────── Tip payouts ─────────────────────────────

export type TipBatchKind = "end_of_night" | "daily_delay" | "weekly" | "manual" | "payroll" | "opening";
export type TipBatchStatus = "draft" | "approved" | "completed" | "cancelled";
export type TipPayoutMethod = "cash" | "stripe" | "payroll" | "prior";
export type TipPayoutStatus = "pending" | "held" | "approved" | "processing" | "paid" | "failed" | "cancelled";
export type TipLedgerKind = "tip" | "refund" | "adjust";

/** A manager reviews and approves each batch: one shop, everything available up to the cutoff date. One draft per shop at a time. */
export const tipPayoutBatches = pgTable(
  "tip_payout_batches",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    kind: text("kind").$type<TipBatchKind>().notNull(),
    cutoffDate: date("cutoff_date").notNull(),
    status: text("status").$type<TipBatchStatus>().notNull().default("draft"),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    approvedBy: uuid("approved_by"),
    approvedAt: ts("approved_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    check("tip_payout_batches_kind", sql`${t.kind} in ('end_of_night', 'daily_delay', 'weekly', 'manual', 'payroll', 'opening')`),
    check("tip_payout_batches_status", sql`${t.status} in ('draft', 'approved', 'completed', 'cancelled')`),
    uniqueIndex("tip_payout_batches_one_draft").on(t.shopId).where(sql`${t.status} = 'draft'`),
    index("tip_payout_batches_shop_idx").on(t.shopId, t.cutoffDate),
  ],
);

/**
 * One employee's payout from one batch. Its tips are the ledger entries pointing at it; a trigger
 * keeps an entry from moving to another payout, or leaving one that's approved, sent or paid.
 */
export const tipPayouts = pgTable(
  "tip_payouts",
  {
    id: id(),
    batchId: uuid("batch_id").notNull().references(() => tipPayoutBatches.id),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    /** prior = tips rung up before tip payouts, already paid outside the platform. */
    method: text("method").$type<TipPayoutMethod>().notNull(),
    status: text("status").$type<TipPayoutStatus>().notNull().default("pending"),
    /** Tips less tip refunds in the payout. */
    grossCents: integer("gross_cents").notNull().default(0),
    /** Card processing fee netted from card tips, where the shop nets it. */
    feeCents: integer("fee_cents").notNull().default(0),
    /** Manager adjustments, each a ledger entry with a reason. */
    adjustCents: integer("adjust_cents").notNull().default(0),
    /** gross − fee + adjust: what leaves the drawer or the Stripe balance. */
    netCents: integer("net_cents").notNull().default(0),
    instant: boolean("instant").notNull().default(false),
    /** Stripe's instant payout fee, estimated and shown before sending; the employee receives net − this. */
    instantFeeCents: integer("instant_fee_cents").notNull().default(0),
    stripeAccountId: text("stripe_account_id"),
    /** The account debit that moved the money from the shop's own connected account to the platform first. */
    stripeDebitId: text("stripe_debit_id"),
    stripeTransferId: text("stripe_transfer_id"),
    stripePayoutId: text("stripe_payout_id"),
    failureMessage: text("failure_message"),
    /** Cash: the business date of the drawer it came out of. */
    drawerDate: date("drawer_date"),
    acknowledgedAt: ts("acknowledged_at"),
    ackMethod: text("ack_method").$type<"pin" | "name">(),
    ackName: text("ack_name"),
    holdReason: text("hold_reason"),
    heldBy: uuid("held_by"),
    heldAt: ts("held_at"),
    /** Payroll: the pay period it was paid in. */
    payrollPeriodStart: date("payroll_period_start"),
    sentAt: ts("sent_at"),
    paidAt: ts("paid_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("tip_payouts_method", sql`${t.method} in ('cash', 'stripe', 'payroll', 'prior')`),
    check("tip_payouts_status", sql`${t.status} in ('pending', 'held', 'approved', 'processing', 'paid', 'failed', 'cancelled')`),
    check("tip_payouts_ack", sql`${t.ackMethod} is null or ${t.ackMethod} in ('pin', 'name')`),
    check("tip_payouts_held", sql`${t.status} <> 'held' or ${t.holdReason} is not null`),
    uniqueIndex("tip_payouts_batch_staff_uq").on(t.batchId, t.staffId),
    uniqueIndex("tip_payouts_transfer_uq").on(t.stripeTransferId),
    uniqueIndex("tip_payouts_payout_uq").on(t.stripePayoutId),
    index("tip_payouts_staff_idx").on(t.staffId, t.createdAt),
    index("tip_payouts_drawer_idx").on(t.shopId, t.drawerDate).where(sql`${t.method} = 'cash'`),
  ],
);

/**
 * Every tip per employee, shop and ticket, append-only: a tip per payment, a reversal per refund or
 * void that gave tip back, and manager adjustments. Synced from payments and refunds (syncTipLedger).
 * Amounts and fees are signed; business_date is the sale's for tips and the refund's for reversals, as payroll counts them.
 */
export const tipLedger = pgTable(
  "tip_ledger",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    saleId: uuid("sale_id").references(() => sales.id),
    paymentId: uuid("payment_id").references(() => payments.id),
    refundId: uuid("refund_id").references(() => refunds.id),
    kind: text("kind").$type<TipLedgerKind>().notNull(),
    method: text("method").$type<"card" | "cash" | "gift_card" | "adjust">().notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** This tip's share of the card processing fee, pro rata to the charge; applied only where the shop nets it. */
    feeCents: integer("fee_cents").notNull().default(0),
    businessDate: date("business_date").notNull(),
    payoutId: uuid("payout_id").references(() => tipPayouts.id),
    reason: text("reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    check("tip_ledger_kind", sql`${t.kind} in ('tip', 'refund', 'adjust')`),
    check("tip_ledger_method", sql`${t.method} in ('card', 'cash', 'gift_card', 'adjust')`),
    check(
      "tip_ledger_source",
      sql`(${t.kind} = 'tip' and ${t.paymentId} is not null) or (${t.kind} = 'refund' and ${t.refundId} is not null) or (${t.kind} = 'adjust' and ${t.reason} is not null)`,
    ),
    // A split ticket's tip is one entry per barber.
    uniqueIndex("tip_ledger_payment_uq").on(t.paymentId, t.staffId).where(sql`${t.kind} = 'tip'`),
    uniqueIndex("tip_ledger_refund_uq").on(t.refundId, t.staffId).where(sql`${t.kind} = 'refund'`),
    index("tip_ledger_staff_date_idx").on(t.staffId, t.businessDate),
    index("tip_ledger_shop_date_idx").on(t.shopId, t.businessDate),
    index("tip_ledger_payout_idx").on(t.payoutId),
    index("tip_ledger_unpaid_idx").on(t.shopId, t.staffId).where(sql`${t.payoutId} is null`),
  ],
);

/**
 * How each employee is paid tips, and their own Stripe Connect Express account for card or bank
 * payouts. Onboarding is Stripe-hosted: no bank or card details are ever stored here.
 */
export const staffPayoutAccounts = pgTable(
  "staff_payout_accounts",
  {
    staffId: uuid("staff_id")
      .primaryKey()
      .references(() => staff.id, { onDelete: "cascade" }),
    /** Their choice where the brand lets employees choose; null follows the shop's default. */
    method: text("method").$type<"cash" | "stripe" | "payroll">(),
    /** Ask for instant payouts to a debit card where eligible (Stripe's fee is shown first). */
    instant: boolean("instant").notNull().default(false),
    stripeAccountId: text("stripe_account_id").unique(),
    simulated: boolean("simulated").notNull().default(false),
    payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
    detailsSubmitted: boolean("details_submitted").notNull().default(false),
    /** Has a debit card that takes instant payouts. */
    instantEligible: boolean("instant_eligible").notNull().default(false),
    requirementsDue: jsonb("requirements_due").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Submitted, and Stripe is still checking them. */
    requirementsPending: jsonb("requirements_pending").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    requirementsDeadline: ts("requirements_deadline"),
    disabledReason: text("disabled_reason"),
    /** What Stripe returns about where payouts go: never the full account or card number. */
    destinationType: text("destination_type").$type<"bank_account" | "card">(),
    destinationLast4: text("destination_last4"),
    /** The bank's name, or the card's brand. */
    destinationName: text("destination_name"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("staff_payout_accounts_method", sql`${t.method} is null or ${t.method} in ('cash', 'stripe', 'payroll')`),
    check("staff_payout_accounts_destination_type", sql`${t.destinationType} is null or ${t.destinationType} in ('bank_account', 'card')`),
    check("staff_payout_accounts_last4", sql`${t.destinationLast4} is null or ${t.destinationLast4} ~ '^[0-9]{4}$'`),
  ],
);

// ───────────────────────────── Loyalty ─────────────────────────────

export const loyaltyAccounts = pgTable("loyalty_accounts", {
  customerId: uuid("customer_id").primaryKey().references(() => customers.id, { onDelete: "cascade" }),
  progressCents: integer("progress_cents").notNull().default(0),
  lifetimeEarnedCents: integer("lifetime_earned_cents").notNull().default(0),
  lastEarnAt: ts("last_earn_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const loyaltyRewards = pgTable(
  "loyalty_rewards",
  {
    id: id(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    issuedAt: ts("issued_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    redeemedAt: ts("redeemed_at"),
    redeemedSaleId: uuid("redeemed_sale_id"),
    sourceSaleId: uuid("source_sale_id"),
    source: text("source").notNull().default("earned"), // earned | import | manual
  },
  (t) => [index("loyalty_rewards_customer_idx").on(t.customerId)],
);

export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: id(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id"),
    kind: text("kind").notNull(), // earn | reverse | reward_issued | reward_redeemed | import | expire
    progressDeltaCents: integer("progress_delta_cents").notNull().default(0),
    rewardCents: integer("reward_cents").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("loyalty_ledger_customer_idx").on(t.customerId, t.createdAt)],
);

// ───────────────────────────── Notifications (job queue) ─────────────────────────────

export const notificationJobs = pgTable(
  "notification_jobs",
  {
    id: id(),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id),
    /** The shop the message is from. Only sign-in codes, which are brand-level, have none. */
    shopId: uuid("shop_id").references(() => shops.id),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    kind: text("kind").notNull(), // confirmation | reminder_24h | reminder_2h | cancellation | reschedule | otp | waitlist_ready | purchase_order | low_stock | staff_text | staff_call | privacy_alert | digest | …
    channel: text("channel").notNull(), // sms | email | voice | push
    to: text("to").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    attachments: jsonb("attachments").$type<EmailAttachment[]>(),
    runAt: ts("run_at").notNull(),
    status: notificationStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    sentAt: ts("sent_at"),
    /** The provider reported it delivered (texts) or answered (calls). */
    deliveredAt: ts("delivered_at"),
    /** The call-in outreach this message is part of. */
    outreachId: uuid("outreach_id").references((): AnyPgColumn => appointmentOutreach.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notification_jobs_due_idx").on(t.status, t.runAt),
    index("notification_jobs_appt_idx").on(t.appointmentId),
    index("notification_jobs_provider_msg_idx").on(t.providerMessageId),
    index("notification_jobs_outreach_idx").on(t.outreachId),
  ],
);

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Base64. */
  content: string;
}

// ───────────────────────────── Audit & imports ─────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    at: ts("at").notNull().defaultNow(),
    actorStaffId: uuid("actor_staff_id"),
    actorLabel: text("actor_label"),
    shopId: uuid("shop_id"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    details: jsonb("details"),
  },
  (t) => [
    index("audit_shop_at_idx").on(t.shopId, t.at),
    index("audit_entity_idx").on(t.entity, t.entityId),
    index("audit_network_at_idx").on(t.at).where(sql`${t.action} like 'network.%'`),
  ],
);

export interface ImportRowError {
  row: number;
  reason: string;
  message: string;
  /** The original CSV row, so the error file can be fixed and re-imported. */
  data?: Record<string, string>;
}

export const importRuns = pgTable("import_runs", {
  id: id(),
  kind: text("kind").notNull(),
  filename: text("filename"),
  dryRun: boolean("dry_run").notNull().default(false),
  totalRows: integer("total_rows").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errors: jsonb("errors").$type<ImportRowError[]>().notNull().default(sql`'[]'::jsonb`),
  /** Reconciliation counts (see ImportStats in server/importer.ts). */
  stats: jsonb("stats").$type<Record<string, number>>(),
  staffId: uuid("staff_id"),
  createdAt: createdAt(),
});

/**
 * Staff-only rating of a client for one visit (an appointment, or a ticket with no appointment).
 * Never part of any customer-facing payload. One rating per rater per visit.
 */
export const clientRatings = pgTable(
  "client_ratings",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id").references(() => sales.id, { onDelete: "set null" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    stars: smallint("stars").notNull(),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("client_ratings_customer_idx").on(t.customerId),
    index("client_ratings_shop_customer_idx").on(t.shopId, t.customerId),
    uniqueIndex("client_ratings_staff_appt_uq").on(t.staffId, t.appointmentId).where(sql`appointment_id is not null`),
    uniqueIndex("client_ratings_staff_sale_uq").on(t.staffId, t.saleId).where(sql`appointment_id is null and sale_id is not null`),
  ],
);

export type Shop = typeof shops.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Sale = typeof sales.$inferSelect;

// ───────────────────────────── Payroll ─────────────────────────────

/**
 * Each shop is an iSolved pay group with its own pay calendar (Dubuque's differs from the rest).
 * The label is whatever Charles calls the pay group; no iSolved IDs are stored in the repo.
 * Shops of the same legal entity (one FEIN) share overtime across shops.
 */
export const payGroups = pgTable(
  "pay_groups",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .unique()
      .references(() => shops.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    legalEntity: text("legal_entity").notNull().default("Ray'z Inc."),
    /** The workbook tab this shop's export copies: its sheet name and formatting. */
    exportTab: text("export_tab").notNull(),
    /** First day of a known period, and that period's number in iSolved. */
    anchorStart: date("anchor_start", { mode: "string" }).notNull(),
    anchorNumber: integer("anchor_number").notNull(),
    periodDays: integer("period_days").notNull().default(14),
    checkOffsetDays: integer("check_offset_days").notNull().default(6),
    numberResetsYearly: boolean("number_resets_yearly").notNull().default(true),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("pay_groups_period_days", sql`${t.periodDays} in (7, 14)`)],
);

/** Payroll identity. The iSolved Employee Number is the export's Key and lives only in the database. */
export const payrollProfiles = pgTable("payroll_profiles", {
  staffId: uuid("staff_id")
    .primaryKey()
    .references(() => staff.id, { onDelete: "cascade" }),
  employeeNumber: text("employee_number"),
  /** The Key cell is text, not a number, in the workbook (kept exactly as it is). */
  keyIsText: boolean("key_is_text").notNull().default(false),
  /** Column B of the export, as iSolved spells the name. */
  isolvedName: text("isolved_name"),
  /** Row order in the shop export (the workbook's order); ties and blanks go by name. */
  exportPosition: integer("export_position"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Pay rates per barber, for every shop (shop null) or one shop. */
export const payrollRates = pgTable(
  "payroll_rates",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    hourlyRate: doublePrecision("hourly_rate").notNull().default(0),
    servicePct: doublePrecision("service_pct").notNull().default(0),
    productPct: doublePrecision("product_pct").notNull().default(0.15),
    /** Null: training is paid at the hourly rate. */
    trainingRate: doublePrecision("training_rate"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("payroll_rates_uq").on(t.staffId, t.shopId).nullsNotDistinct()],
);

export const timeEntryKind = pgEnum("time_entry_kind", ["worked", "training", "pto"]);

/** Clocked or imported time, by shop. Payroll and overtime are worked out from these. */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    kind: timeEntryKind("kind").notNull().default("worked"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    source: text("source").$type<"clock" | "import" | "manual">().notNull().default("manual"),
    note: text("note"),
    /** The clock-in punch this was worked out from. Rewritten whenever that shift's punches change. */
    punchInId: uuid("punch_in_id").references((): AnyPgColumn => timePunches.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_entries_starts_idx").on(t.startsAt),
    index("time_entries_staff_idx").on(t.staffId),
    index("time_entries_punch_idx").on(t.punchInId),
    check("time_entries_order", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

/** A value typed over the computed one for one barber, shop and pay period, with the reason. */
export const payrollOverrides = pgTable(
  "payroll_overrides",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    value: doublePrecision("value").notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [unique("payroll_overrides_uq").on(t.shopId, t.periodStart, t.staffId, t.field)],
);

/**
 * An approved and locked pay period for one pay group: the report rows, totals and export rows as
 * they were approved, which is what the download serves from then on.
 */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: id(),
    payGroupId: uuid("pay_group_id")
      .notNull()
      .references(() => payGroups.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    periodNumber: integer("period_number").notNull(),
    checkDate: date("check_date", { mode: "string" }).notNull(),
    settings: jsonb("settings").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    lockedAt: ts("locked_at").notNull().defaultNow(),
    lockedBy: uuid("locked_by").references(() => staff.id),
  },
  (t) => [unique("payroll_runs_uq").on(t.payGroupId, t.periodStart)],
);

/** OT hours (hundredths) a locked period kept for one slice of a workweek, so a later period can't move them. */
export const payrollLockedOt = pgTable(
  "payroll_locked_ot",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    otCenti: integer("ot_centi").notNull(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.shopId, t.periodStart, t.weekStart] })],
);

// ───────────────────────────── Time clock ─────────────────────────────

export type PunchType = "in" | "out" | "break_start" | "break_end";
export type PunchSource = "self" | "kiosk" | "manager";
export type PunchMethod = "device" | "gps" | "network" | "none" | "manager";

/** A shop's registered front-desk device. The browser keeps the token in a cookie; only its hash is stored. */
export const clockDevices = pgTable("clock_devices", {
  id: id(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  registeredBy: uuid("registered_by").references(() => staff.id),
  lastSeenAt: ts("last_seen_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
});

export type TrustedDeviceStatus = "pending" | "approved" | "declined" | "revoked";

/**
 * A browser approved for signing in at a shop whose sign-in restriction accepts devices. The browser
 * holds a signed long-lived cookie with the device's ID and a secret; only the secret's hash is
 * stored, so a database copy can't be turned into a cookie, and revoking the row ends it at once.
 */
export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** One browser approved for two shops has a row for each, with the same hash. */
    tokenHash: text("token_hash").notNull(),
    status: text("status").$type<TrustedDeviceStatus>().notNull().default("pending"),
    /** Who asked for it (a blocked sign-in on this browser), or who approved it while signed in on it. */
    requestedBy: uuid("requested_by").references(() => staff.id, { onDelete: "set null" }),
    requestedIp: text("requested_ip"),
    userAgent: text("user_agent"),
    decidedBy: uuid("decided_by").references(() => staff.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    lastSeenAt: ts("last_seen_at"),
    lastIp: text("last_ip"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("trusted_devices_token_shop_uq").on(t.tokenHash, t.shopId),
    index("trusted_devices_shop_idx").on(t.shopId, t.status),
    check("trusted_devices_status", sql`${t.status} in ('pending', 'approved', 'declined', 'revoked')`),
  ],
);

/**
 * One clock punch: in, out, or a break starting or ending, at the shop where it happened, with how it
 * was verified and where. Never deleted: a manager's correction edits it (logged in time_punch_edits)
 * or voids it.
 */
export const timePunches = pgTable(
  "time_punches",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    type: text("type").$type<PunchType>().notNull(),
    at: ts("at").notNull(),
    source: text("source").$type<PunchSource>().notNull(),
    method: text("method").$type<PunchMethod>().notNull(),
    deviceId: uuid("device_id").references(() => clockDevices.id),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    accuracyM: doublePrecision("accuracy_m"),
    /** How far from the shop the phone said it was. */
    distanceM: doublePrecision("distance_m"),
    ip: text("ip"),
    hasPhoto: boolean("has_photo").notNull().default(false),
    /** late, early_in, early_out, late_out, during_time_off, forgot_out… (PunchFlag in src/domain/time-clock.ts). */
    flags: jsonb("flags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Minutes off the schedule (+ late, − early) when this was an in or out. */
    offScheduleMin: integer("off_schedule_min"),
    /** When an open shift was flagged as a forgotten clock-out and the managers told. */
    forgotFlaggedAt: ts("forgot_flagged_at"),
    /** A break start's reason (block_reasons; null is Break), for the block it writes. */
    reasonId: uuid("reason_id").references(() => blockReasons.id),
    /** A break start's planned length in minutes: the block runs that long unless the break ends first or runs on. */
    plannedMin: integer("planned_min"),
    /** The time as first punched, before any edit. */
    originalAt: ts("original_at").notNull(),
    editedAt: ts("edited_at"),
    voidedAt: ts("voided_at"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_punches_staff_at_idx").on(t.staffId, t.at),
    index("time_punches_shop_at_idx").on(t.shopId, t.at),
    check("time_punches_type", sql`${t.type} in ('in', 'out', 'break_start', 'break_end')`),
    check("time_punches_source", sql`${t.source} in ('self', 'kiosk', 'manager')`),
    check("time_punches_method", sql`${t.method} in ('device', 'gps', 'network', 'none', 'manager')`),
  ],
);

/** The photo taken with a punch: a small JPEG data URL. Only people who edit or approve timesheets see it. */
export const timePunchPhotos = pgTable("time_punch_photos", {
  punchId: uuid("punch_id")
    .primaryKey()
    .references(() => timePunches.id, { onDelete: "cascade" }),
  dataUrl: text("data_url").notNull(),
  createdAt: createdAt(),
});

/**
 * Clock alerts already emailed to managers, so each goes out once: "late_in:<staff>:<shop>:<date>"
 * for not clocked in before the first appointment, "affected:<block key>:<appointment>" for each
 * client booked in a clock block.
 */
export const clockAlertLog = pgTable("clock_alert_log", {
  key: text("key").primaryKey(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  sentAt: ts("sent_at").notNull().defaultNow(),
});

/** Every manager change to a punch, with the reason and the values before and after. Append-only. */
export const timePunchEdits = pgTable(
  "time_punch_edits",
  {
    id: id(),
    punchId: uuid("punch_id")
      .notNull()
      .references(() => timePunches.id),
    action: text("action").$type<"edit" | "add" | "void">().notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason").notNull(),
    editedBy: uuid("edited_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [index("time_punch_edits_punch_idx").on(t.punchId), check("time_punch_edits_reason", sql`length(trim(${t.reason})) > 0`)],
);

/** One employee's hours at one shop for one pay period: their sign-off, then a manager's. */
export const timesheets = pgTable(
  "timesheets",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    employeeApprovedAt: ts("employee_approved_at"),
    managerApprovedAt: ts("manager_approved_at"),
    managerApprovedBy: uuid("manager_approved_by").references(() => staff.id),
    /** Set when a manager approved without the employee's sign-off, and why. */
    managerNote: text("manager_note"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("timesheets_uq").on(t.staffId, t.shopId, t.periodStart)],
);

/** A shop's pay period, closed to punches and edits once every timesheet in it is approved. */
export const timesheetLocks = pgTable(
  "timesheet_locks",
  {
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    lockedAt: ts("locked_at").notNull().defaultNow(),
    lockedBy: uuid("locked_by").references(() => staff.id),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.periodStart] })],
);

/** Someone's full-time or part-time status changed as of a workweek, by their rolling average. */
export const ftStatusChanges = pgTable(
  "ft_status_changes",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    /** The last full workweek in the average (a Sunday). */
    weekStart: date("week_start", { mode: "string" }).notNull(),
    fromStatus: text("from_status").$type<"full_time" | "part_time">().notNull(),
    toStatus: text("to_status").$type<"full_time" | "part_time">().notNull(),
    averageHours: doublePrecision("average_hours").notNull(),
    windowWeeks: integer("window_weeks").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("ft_status_changes_uq").on(t.staffId, t.weekStart)],
);

// ───────────────────────────── Call-ins, client outreach and the shop line ─────────────────────────────

export type CallInKind = "sick" | "emergency" | "other";

/**
 * A barber called in sick, with an emergency or for another reason: whole days, part of one day or a
 * range. Marking it writes the time off block; the booked appointments in it get outreach rows.
 */
export const callIns = pgTable(
  "call_ins",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    /** null = all of the barber's shops. */
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    kind: text("kind").$type<CallInKind>().notNull(),
    reasonId: uuid("reason_id").references(() => blockReasons.id),
    reason: text("reason").notNull(),
    note: text("note"),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    startMin: integer("start_min"),
    endMin: integer("end_min"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    blockId: uuid("block_id").references(() => timeBlocks.id, { onDelete: "set null" }),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: uuid("cancelled_by"),
  },
  (t) => [index("call_ins_staff_idx").on(t.staffId, t.startsAt), index("call_ins_starts_idx").on(t.startsAt)],
);

export type OutreachOption = "reassign" | "rebook" | "voice";
export type OutreachStatus = "pending" | "notified" | "delivered" | "rebooked" | "declined" | "no_response" | "unreachable" | "cancelled";

/** One booked appointment in a call-in, and what the shop did about it and how the client answered. */
export const appointmentOutreach = pgTable(
  "appointment_outreach",
  {
    id: id(),
    callInId: uuid("call_in_id")
      .notNull()
      .references(() => callIns.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    originalStartsAt: ts("original_starts_at").notNull(),
    originalStaffId: uuid("original_staff_id").notNull(),
    /** null until the shop picks one. */
    option: text("option").$type<OutreachOption>(),
    status: text("status").$type<OutreachStatus>().notNull().default("pending"),
    /** How it ended, in words: "Kept Delaney", "Moved to Fri 11:30 AM", "Cancelled by text". */
    resolution: text("resolution"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: ts("last_attempt_at"),
    /** When the follow-up runs: the retry after the first try, then the flag for staff. */
    nextActionAt: ts("next_action_at"),
    /** The time offered with "reply 1". */
    suggestedStartsAt: ts("suggested_starts_at"),
    suggestedStaffId: uuid("suggested_staff_id"),
    reassignedStaffId: uuid("reassigned_staff_id"),
    reassignedShopId: uuid("reassigned_shop_id"),
    /** A move to another shop books a new appointment there. */
    newAppointmentId: uuid("new_appointment_id"),
    flaggedAt: ts("flagged_at"),
    flagReason: text("flag_reason"),
    respondedAt: ts("responded_at"),
    sentBy: uuid("sent_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("appointment_outreach_uq").on(t.callInId, t.appointmentId),
    index("appointment_outreach_due_idx").on(t.status, t.nextActionAt),
    index("appointment_outreach_appt_idx").on(t.appointmentId),
    index("appointment_outreach_customer_idx").on(t.customerId),
  ],
);

/** A one-tap rebook link. Only the SHA-256 of the token is kept; it expires, and a newer link or a finished rebook ends it. */
export const rebookLinks = pgTable(
  "rebook_links",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    outreachId: uuid("outreach_id")
      .notNull()
      .references(() => appointmentOutreach.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("rebook_links_outreach_idx").on(t.outreachId)],
);

/** Numbers that replied STOP (texts) or pressed 9 on an automated call (calls). Checked before anything is sent. */
export const contactOptOuts = pgTable(
  "contact_opt_outs",
  {
    id: id(),
    phone: text("phone").notNull(),
    channel: text("channel").$type<"sms" | "voice">().notNull(),
    source: text("source").$type<"reply" | "keypad" | "staff">().notNull(),
    /** Clients whose "OK to text" this turned off, so START can turn it back on for them only. */
    customerIds: jsonb("customer_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [unique("contact_opt_outs_uq").on(t.phone, t.channel)],
);

/** A shop's text conversation with one phone number: the shop inbox. */
export const messageThreads = pgTable(
  "message_threads",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    lastMessageAt: ts("last_message_at").notNull().defaultNow(),
    lastInboundAt: ts("last_inbound_at"),
    unread: integer("unread").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique("message_threads_uq").on(t.shopId, t.phone), index("message_threads_recent_idx").on(t.shopId, t.lastMessageAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => messageThreads.id, { onDelete: "cascade" }),
    /** note: something the system did (texts turned off by STOP), shown in the thread but never sent. */
    direction: text("direction").$type<"in" | "out" | "note">().notNull(),
    body: text("body").notNull(),
    /** Who wrote it; null for the client or an automatic message. */
    staffId: uuid("staff_id"),
    auto: boolean("auto").notNull().default(false),
    jobId: uuid("job_id").references(() => notificationJobs.id, { onDelete: "set null" }),
    providerMessageId: text("provider_message_id"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.createdAt)],
);

export type CallDirection = "in" | "out";
export type CallKind = "inbound" | "outreach" | "click_to_call";
export type CallStatus = "ringing" | "answered" | "missed" | "after_hours" | "voicemail" | "no_answer" | "busy" | "failed" | "initiated" | "completed";

/** Calls on the shop line: incoming calls, automated call-in calls and click-to-call from a profile. */
export const callLogs = pgTable(
  "call_logs",
  {
    id: id(),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    direction: text("direction").$type<CallDirection>().notNull(),
    kind: text("kind").$type<CallKind>().notNull(),
    status: text("status").$type<CallStatus>().notNull(),
    durationSec: integer("duration_sec"),
    providerCallId: text("provider_call_id").unique(),
    staffId: uuid("staff_id"),
    outreachId: uuid("outreach_id").references(() => appointmentOutreach.id, { onDelete: "set null" }),
    /** The key pressed on an automated call. */
    digits: text("digits"),
    autoTextSent: boolean("auto_text_sent").notNull().default(false),
    createdAt: createdAt(),
    endedAt: ts("ended_at"),
  },
  (t) => [index("call_logs_phone_idx").on(t.phone, t.createdAt), index("call_logs_shop_idx").on(t.shopId, t.createdAt)],
);

/** A Today alert someone handled or snoozed, so it stays hidden for everyone until `until`. */
export const alertDismissals = pgTable(
  "alert_dismissals",
  {
    id: id(),
    /** The alert's key, e.g. "low_stock:<shop>:<date>". */
    alertKey: text("alert_key").notNull().unique(),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    until: ts("until").notNull(),
    staffId: uuid("staff_id"),
    createdAt: createdAt(),
  },
  (t) => [index("alert_dismissals_until_idx").on(t.until)],
);

export type NudgeKind = "fill" | "rebook" | "no_show_reminder" | "running_late";

/** Texts and emails sent from a Today action, so one client isn't nudged twice. */
export const clientNudges = pgTable(
  "client_nudges",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    kind: text("kind").$type<NudgeKind>().notNull(),
    channel: text("channel").notNull(),
    staffId: uuid("staff_id"),
    createdAt: createdAt(),
  },
  (t) => [index("client_nudges_customer_idx").on(t.customerId, t.kind, t.createdAt), index("client_nudges_appt_idx").on(t.appointmentId, t.kind)],
);

/** One row per person per day the morning digest went to, so the cron sends it once. */
export const digestSends = pgTable(
  "digest_sends",
  {
    date: date("date").notNull(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.date, t.staffId] })],
);

// ───────────────────────────── Campaign Center ─────────────────────────────

export type CampaignKind = "trigger" | "blast" | "sequence";
export type BlastStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled";

/**
 * A marketing campaign: one brand-level row per automated trigger (switched on per location in
 * marketing_location_settings), a one-off blast to a segment, or a lapsed sequence (its steps in
 * marketing_steps, its barbers in segment, its locations in shop_ids). Wording, settings and
 * segment are jsonb (Templates, trigger and sequence settings, Segment and SequenceAudience in
 * src/domain/marketing.ts).
 */
export const marketingCampaigns = pgTable(
  "marketing_campaigns",
  {
    id: id(),
    kind: text("kind").$type<CampaignKind>().notNull(),
    /** Trigger campaigns: which trigger (TriggerKey). One row per trigger. */
    trigger: text("trigger"),
    name: text("name").notNull(),
    /** Channels in the order tried: each client gets one message, on the first they can receive. */
    channels: jsonb("channels").$type<string[]>().notNull().default(sql`'["sms","email","push"]'::jsonb`),
    templates: jsonb("templates").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    settings: jsonb("settings").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    segment: jsonb("segment").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    promoId: uuid("promo_id").references(() => promoCodes.id, { onDelete: "set null" }),
    /** Blasts: the locations it's for; empty is every location (brand-wide). */
    shopIds: jsonb("shop_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Blasts only. Trigger campaigns run wherever a location has them on. */
    status: text("status").$type<BlastStatus>().notNull().default("draft"),
    /** Sequences: running or not. */
    enabled: boolean("enabled").notNull().default(false),
    scheduledAt: ts("scheduled_at"),
    sentAt: ts("sent_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("marketing_campaigns_trigger_uq").on(t.trigger).where(sql`${t.kind} = 'trigger'`), index("marketing_campaigns_due_idx").on(t.status, t.scheduledAt)],
);

/** One message of a lapsed sequence: when it goes (days since the client's last visit), its wording and its coupon. */
export const marketingSteps = pgTable(
  "marketing_steps",
  {
    id: id(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    afterDays: integer("after_days").notNull(),
    templates: jsonb("templates").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    promoId: uuid("promo_id").references(() => promoCodes.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("marketing_steps_position_uq").on(t.campaignId, t.position)],
);

/** A trigger campaign at one location: on or off, with optional wording and settings of its own. */
export const marketingLocationSettings = pgTable(
  "marketing_location_settings",
  {
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** Null follows the brand's wording and settings. */
    templates: jsonb("templates").$type<Record<string, string>>(),
    settings: jsonb("settings").$type<Record<string, number>>(),
    updatedBy: uuid("updated_by"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.shopId] })],
);

export type SendStatus = "queued" | "skipped" | "test";

/**
 * One client and one campaign occasion. The dedupe key is unique, so running the engine twice (or
 * two cron runs at once) can't send twice. The token is the tracked booking link and the email
 * unsubscribe link.
 */
export const marketingSends = pgTable(
  "marketing_sends",
  {
    id: id(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "set null" }),
    /** The barber it's about or the client's usual barber, for the report. */
    staffId: uuid("staff_id"),
    channel: text("channel").$type<"sms" | "email" | "push">(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    status: text("status").$type<SendStatus>().notNull(),
    /** Why it wasn't sent (SKIP_LABEL in src/domain/marketing.ts). */
    skipped: text("skipped"),
    jobId: uuid("job_id").references(() => notificationJobs.id, { onDelete: "set null" }),
    couponCodeId: uuid("coupon_code_id").references(() => couponCodes.id, { onDelete: "set null" }),
    token: text("token").notNull().unique(),
    /** Where the tracked link goes: the location's booking page, with the barber, service and coupon. */
    bookPath: text("book_path"),
    clicks: integer("clicks").notNull().default(0),
    firstClickAt: ts("first_click_at"),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    /** Lapsed sequences: which step it was. */
    stepId: uuid("step_id").references(() => marketingSteps.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("marketing_sends_campaign_idx").on(t.campaignId, t.createdAt), index("marketing_sends_customer_idx").on(t.customerId, t.createdAt)],
);

/** Unsubscribes from marketing, per channel: an email link, STOP to a marketing text, or staff. Checked before every marketing send. */
export const marketingUnsubscribes = pgTable(
  "marketing_unsubscribes",
  {
    id: id(),
    channel: text("channel").$type<"sms" | "email" | "push">().notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    email: text("email"),
    phone: text("phone"),
    source: text("source").$type<"link" | "stop" | "staff">().notNull(),
    campaignId: uuid("campaign_id").references(() => marketingCampaigns.id, { onDelete: "set null" }),
    sendId: uuid("send_id").references(() => marketingSends.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("marketing_unsubscribes_customer_idx").on(t.customerId), index("marketing_unsubscribes_email_idx").on(t.email), index("marketing_unsubscribes_phone_idx").on(t.phone)],
);

/** Online bookings started and not finished, for the "finish your booking" campaign. */
export const bookingDrafts = pgTable(
  "booking_drafts",
  {
    id: id(),
    /** Made by the booking page, so it can update its own draft without signing in. */
    token: text("token").notNull().unique(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    serviceId: uuid("service_id"),
    staffId: uuid("staff_id"),
    startsAt: ts("starts_at"),
    /** Set when the booking went through. */
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("booking_drafts_open_idx").on(t.updatedAt).where(sql`${t.appointmentId} is null`)],
);

/** Labels staff put on clients, e.g. "VIP" or "Student", for segments. */
export const customerTags = pgTable(
  "customer_tags",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.tag] }), index("customer_tags_tag_idx").on(t.tag)],
);
