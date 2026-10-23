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
  createdAt: createdAt(),
}, (t) => [check("shops_status", sql`${t.status} in ('setup', 'live', 'closed', 'archived') AND ${t.active} = (${t.status} <> 'archived')`)]);
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
  /** Set when the account owner disconnects it from the platform. */
  deauthorizedAt: ts("deauthorized_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Payouts from a shop's connected account to its bank, as Stripe reports them. */
export const shopPayouts = pgTable(
  "shop_payouts",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    stripeAccountId: text("stripe_account_id").notNull(),
    stripePayoutId: text("stripe_payout_id").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(), // pending | in_transit | paid | failed | canceled
    arrivalDate: date("arrival_date").notNull(),
    failureMessage: text("failure_message"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("shop_payouts_shop_arrival_idx").on(t.shopId, t.arrivalDate)],
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
    usedFor: text("used_for").$type<"blocks" | "time_off" | "both">().notNull().default("both"),
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
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_blocks_staff_time_idx").on(t.staffId, t.startsAt),
    uniqueIndex("time_blocks_series_start_unique").on(t.seriesId, t.startsAt),
    index("time_blocks_request_idx").on(t.requestId),
  ],
);
export type BlockCategory = "lunch" | "other" | "time_off";

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
    createdAt: createdAt(),
  },
  (t) => [
    index("payments_shop_date_idx").on(t.shopId, t.businessDate),
    index("payments_account_idx").on(t.stripeAccountId),
    index("payments_sale_idx").on(t.saleId),
    uniqueIndex("payments_stripe_pi_uq").on(t.stripePaymentIntentId),
  ],
);

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
    expectedCents: integer("expected_cents").notNull().default(0),
    countedCents: integer("counted_cents"),
    varianceCents: integer("variance_cents"),
    notes: text("notes"),
    closedBy: uuid("closed_by"),
    closedAt: ts("closed_at"),
  },
  (t) => [uniqueIndex("cash_drawers_uq").on(t.shopId, t.businessDate)],
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
    channel: text("channel").notNull(), // sms | email | voice
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
  (t) => [index("audit_shop_at_idx").on(t.shopId, t.at), index("audit_entity_idx").on(t.entity, t.entityId)],
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
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_entries_starts_idx").on(t.startsAt),
    index("time_entries_staff_idx").on(t.staffId),
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
