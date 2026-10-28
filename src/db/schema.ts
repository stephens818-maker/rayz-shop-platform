import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
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
  /** Customer app kill switches (AppSwitches in src/server/app-switches.ts); missing keys are on. */
  appSwitches: jsonb("app_switches").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Lunch, block and time off rules (StaffTimeRules in src/domain/staff-time.ts); missing keys use the defaults. */
  staffTime: jsonb("staff_time").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Call-in outreach rules (OutreachRules in src/domain/outreach.ts); missing keys use the defaults. */
  outreach: jsonb("outreach").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The brand's edits to client message wording, by message kind (src/domain/message-templates.ts); missing kinds use the built-in text. */
  messageTemplates: jsonb("message_templates").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Pick lists staff choose from (src/domain/lookups.ts); missing lists use the defaults. */
  lookups: jsonb("lookups").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The Morning Dashboard email (MorningSettings in src/domain/morning-dashboard.ts); missing keys use the defaults. */
  digest: jsonb("digest").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Time clock rules for the brand (ClockRules in src/domain/time-clock.ts): breaks, forgotten clock-outs, the export layout. */
  timeClock: jsonb("time_clock").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Tip payout policy for the brand (BrandTipPolicy in src/domain/tips.ts): allowed methods, employee choice, instant payouts. */
  tipPayouts: jsonb("tip_payouts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Staff payouts (StaffPayoutSettings in src/domain/staff-payouts.ts): the barbers' Stripe accounts, owed tips, refunds, the tip date, tax forms. */
  staffPayouts: jsonb("staff_payouts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Sign-in restriction settings for the brand (BrandNetworkSettings in src/domain/network-access.ts): the blocked sign-in alert. */
  networkAccess: jsonb("network_access").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The brand's tip presets for the customer screen (BrandHandoff in src/domain/handoff.ts); missing keys use the defaults. */
  handoff: jsonb("handoff").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** When the Google review link is shown (ReviewRules in src/domain/reviews.ts): from visit N, and the pause after a tap. */
  reviews: jsonb("reviews").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Campaign Center settings (MarketingSettings in src/domain/marketing.ts): quiet hours, frequency caps, the postal address, attribution, costs. */
  marketing: jsonb("marketing").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Rayz Assistant (AssistantSettings in src/domain/assistant.ts): on or off per role, the limits, drafting; missing keys use the defaults. */
  assistant: jsonb("assistant").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Shop logins: `clientContact` caps the client contact details they see (ShopLoginCap in src/domain/client-privacy.ts). */
  shopLogin: jsonb("shop_login").$type<{ clientContact?: unknown }>().notNull().default(sql`'{}'::jsonb`),
  /** How often each state's sales tax is filed, by state code: "monthly" or "quarterly" (src/domain/sales-tax.ts). */
  taxFiling: jsonb("tax_filing").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Client badges (BadgeSettings in src/domain/badges.ts): which are on, the thresholds, which roles see which. */
  badges: jsonb("badges").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Family accounts (FamilySettings in src/domain/family.ts): children per parent, household or individual loyalty, the age a child can get their own account. */
  family: jsonb("family").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Compensation fields (CompensationSettings in src/domain/compensation.ts): off by default; payroll, the export and My pay use them only when turned on. */
  compensation: jsonb("compensation").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Event log options: the post-visit 1-5 question and the nightly warehouse copy (src/domain/analytics.ts). */
  analytics: jsonb("analytics").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Checkout prompts: rebook and product, each on or off, skippable or required (src/domain/checkout-prompts.ts). */
  checkoutPrompts: jsonb("checkout_prompts").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Staff milestones (MilestoneSettings in src/domain/milestones.ts): alerts, congratulations, birthdays, the team feed. */
  milestones: jsonb("milestones").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** What every location inherits (LocationDefaults in src/domain/location-defaults.ts); missing keys use the built-in values. */
  locationDefaults: jsonb("location_defaults").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The credit card fee policy (CardFeePolicy in src/domain/card-fee-policy.ts); missing keys use the defaults. Shops can override parts of it. */
  cardFee: jsonb("card_fee").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Memberships (src/server/memberships.ts) are optional: off, no plans are sold and checkout doesn't offer them. */
  membershipsEnabled: boolean("memberships_enabled").notNull().default(false),
  /** The brand setting `time_format`, shared with the customer API: how times of day read. 12-hour (9:05 AM) by default. */
  timeFormat: text("time_format").$type<"12h" | "24h">().notNull().default("12h"),
  /** How payroll hours read (`payrollHours` in DisplaySettings, src/domain/display.ts): decimal by default. */
  display: jsonb("display").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * The legal business that owns a shop: Ray'z Corporate (the default, kind brand), another corporate
 * LLC, or a franchisee. An entity can own several shops. Its Stripe account
 * (entity_payment_accounts) is optional: each shop picks its own, the entity's, or the brand's.
 */
export const ownerEntities = pgTable(
  "owner_entities",
  {
    id: id(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    kind: text("kind").$type<OwnerEntityKind>().notNull().default("brand"),
    contactEmail: text("contact_email"),
    /** Ray'z Corporate: exactly one, always kind brand. Shops added without an owner go to it. */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("owner_entities_kind", sql`${t.kind} in ('brand', 'franchisee')`),
    check("owner_entities_default_brand", sql`not ${t.isDefault} or ${t.kind} = 'brand'`),
    uniqueIndex("owner_entities_one_default").on(t.isDefault).where(sql`${t.isDefault}`),
  ],
);
export type OwnerEntityKind = "brand" | "franchisee";

/** An owner entity's Stripe Connect account (Express, Stripe-hosted onboarding). Shops in payments mode "entity" settle here. */
export const entityPaymentAccounts = pgTable("entity_payment_accounts", {
  ownerEntityId: uuid("owner_entity_id")
    .primaryKey()
    .references(() => ownerEntities.id),
  stripeAccountId: text("stripe_account_id").notNull().unique(),
  simulated: boolean("simulated").notNull().default(false),
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  requirementsDue: jsonb("requirements_due").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  disabledReason: text("disabled_reason"),
  payoutSchedule: jsonb("payout_schedule").$type<PayoutSchedule>(),
  deauthorizedAt: ts("deauthorized_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** An optional grouping of locations (a market such as "Quad Cities") for brand rollups. A location is in one region at most. */
export const regions = pgTable("regions", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: createdAt(),
});

export const shops = pgTable("shops", {
  id: id(),
  /** Not null in the database; a trigger puts a shop inserted without one under Ray'z Corporate. */
  ownerEntityId: uuid("owner_entity_id").references(() => ownerEntities.id),
  regionId: uuid("region_id").references((): AnyPgColumn => regions.id, { onDelete: "set null" }),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  address: text("address").notNull().default(""),
  /** Suite or unit. */
  address2: text("address2").notNull().default(""),
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
  /** ST-I19: the Demo Shop for Apple and Google app review. Left out of brand-wide access, so no report, payroll or admin list sees it. */
  isDemo: boolean("is_demo").notNull().default(false),
  /** Online booking switch for a live shop. Clients can book only when the shop is live and this is on. */
  bookingEnabled: boolean("booking_enabled").notNull().default(true),
  /** platform: clients book here. external: online booking here is off and the website and app send clients to externalBookingUrl (the old booking site while shops move over one at a time). */
  bookingMode: text("booking_mode").$type<BookingMode>().notNull().default("platform"),
  /** https only; required when bookingMode is external. */
  externalBookingUrl: text("external_booking_url"),
  /** #rrggbb for this location's booking page; null uses the brand's. */
  accentColor: text("accent_color"),
  logoUrl: text("logo_url"),
  /** Fractions (0.07 = 7%). Configured per shop; never hard-coded. */
  serviceTaxRate: numeric("service_tax_rate", { precision: 7, scale: 5 }).notNull().default("0"),
  productTaxRate: numeric("product_tax_rate", { precision: 7, scale: 5 }).notNull().default("0"),
  taxRatesVerified: boolean("tax_rates_verified").notNull().default(false),
  /** The shop's card fee as it stands (the brand policy with card_fee_override), kept in step on every save for the tax and fee summary. Checkout reads the policy. */
  cardFeeEnabled: boolean("card_fee_enabled").notNull().default(true),
  cardFeeRate: numeric("card_fee_rate", { precision: 6, scale: 5 }).notNull().default("0.03"),
  cardFeeAppliesToTip: boolean("card_fee_applies_to_tip").notNull().default(false),
  /** This shop's changes to the brand's card fee policy (CardFeeOverride in src/domain/card-fee-policy.ts); null follows the brand. */
  cardFeeOverride: jsonb("card_fee_override").$type<Record<string, unknown>>(),
  /** When what this shop charges last changed: its own setting, a brand change that reached it, or the brand turning it on or off here. */
  cardFeeChangedAt: timestamp("card_fee_changed_at", { withTimezone: true }),
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
  /** Tips to barbers' Stripe accounts here (I10, FEATURE_TIP_TO_BARBER): the Brand Owner's kill switch for this shop. Off, its card tips stay in the shop's transfer and are paid through payroll. */
  tipToBarber: boolean("tip_to_barber").notNull().default(true),
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
  /** What the cash drawer opens with unless the person opening it counts something else. */
  drawerOpeningCents: integer("drawer_opening_cents").notNull().default(30_000),
  /** How the phone operator answers this shop's number (PhoneOperator in src/domain/phone-operator.ts); missing keys use the defaults. */
  phoneOperator: jsonb("phone_operator").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** The public profile (src/domain/location-profile.ts): Google Place ID, social links (SocialLinks), parking and directions, amenity keys, and the sales-tax jurisdiction (never public). */
  googlePlaceId: text("google_place_id"),
  social: jsonb("social").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  directions: text("directions"),
  amenities: jsonb("amenities").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  taxJurisdiction: jsonb("tax_jurisdiction").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** This shop's own values for brand defaults ("this shop only"); missing keys follow the brand (src/domain/location-defaults.ts). */
  brandOverrides: jsonb("brand_overrides").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** Where latitude/longitude came from: an address lookup (google, census), the ZIP centre (approximate), or placed by hand. */
  geocodeSource: text("geocode_source").$type<GeocodeSource>(),
  geocodedAt: ts("geocoded_at"),
  /** The legal entity (one FEIN) the shop's staff work for: its pay group's employer, kept in step by a trigger. Null until it has a pay group. */
  legalEntityId: uuid("legal_entity_id").references((): AnyPgColumn => payrollEmployers.id),
  createdAt: createdAt(),
}, (t) => [
  check("shops_status", sql`${t.status} in ('setup', 'live', 'closed', 'archived') AND ${t.active} = (${t.status} <> 'archived')`),
  check("shops_payments_mode", sql`${t.paymentsMode} in ('brand', 'connected', 'entity', 'cash_only')`),
  index("shops_region_idx").on(t.regionId),
  index("shops_owner_entity_idx").on(t.ownerEntityId),
  index("shops_legal_entity_idx").on(t.legalEntityId),
]);
export type PaymentsMode = "brand" | "connected" | "entity" | "cash_only";
export type NegativeStockPolicy = "block" | "warn";
export type ShopStatus = "setup" | "live" | "closed" | "archived";
export type BookingMode = "platform" | "external";
export type GeocodeSource = "google" | "census" | "zip" | "manual";

/** A location's photos and uploaded logo (one per shop), as data URLs like client_photos; served from /locations/<slug>/photos/<id>. */
export const shopPhotos = pgTable(
  "shop_photos",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"photo" | "logo">().notNull().default("photo"),
    dataUrl: text("data_url").notNull(),
    alt: text("alt"),
    sortOrder: integer("sort_order").notNull().default(100),
    createdBy: uuid("created_by").references((): AnyPgColumn => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("shop_photos_shop_idx").on(t.shopId, t.kind, t.sortOrder),
    uniqueIndex("shop_photos_one_logo")
      .on(t.shopId)
      .where(sql`${t.kind} = 'logo'`),
    check("shop_photos_kind", sql`${t.kind} in ('photo', 'logo')`),
  ],
);

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
 * Payouts to a bank, as Stripe reports them: from a shop's connected account (shop_id set), from an
 * owner entity's account (owner_entity_id set) for every shop of theirs on it, or from the brand's
 * own account (stripe_account_id 'platform', neither) for every shop on the brand account.
 */
export const shopPayouts = pgTable(
  "shop_payouts",
  {
    id: id(),
    shopId: uuid("shop_id").references(() => shops.id),
    ownerEntityId: uuid("owner_entity_id").references(() => ownerEntities.id),
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
  (t) => [
    index("shop_payouts_shop_arrival_idx").on(t.shopId, t.arrivalDate),
    index("shop_payouts_entity_arrival_idx").on(t.ownerEntityId, t.arrivalDate),
    check("shop_payouts_owner", sql`${t.shopId} is not null or ${t.ownerEntityId} is not null or ${t.stripeAccountId} = 'platform'`),
  ],
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
  /** Dollar limits in cents ({ discountCents, refundCents, waiverCents }); a missing key is no limit. */
  moneyLimits: jsonb("money_limits").$type<Partial<Record<"discountCents" | "refundCents" | "waiverCents", number | null>>>().notNull().default(sql`'{}'::jsonb`),
  /** Suggested shop access for people given this role. */
  defaultScope: text("default_scope").$type<"all" | "entity" | "region" | "selected" | "one">().notNull().default("one"),
  /** Custom roles only, set by the Brand Owner: may see client contact details in full and export client lists. */
  brandLevel: boolean("brand_level").notNull().default(false),
  /** A custom role of one owner entity (a franchisee's own role): it gives nothing at shops that entity doesn't own. Null is the brand's. */
  ownerEntityId: uuid("owner_entity_id").references((): AnyPgColumn => ownerEntities.id),
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
  /**
   * all = every shop; entity = every shop of scope_entity_id; region = every shop of
   * scope_region_id; selected / one = the shops in staff_access_shops. An entity or region
   * person's staff_access_shops rows are kept to exactly those shops by database triggers, so a
   * shop added to the entity or region is in reach at once.
   */
  shopScope: text("shop_scope").$type<"all" | "entity" | "region" | "selected" | "one">().notNull().default("selected"),
  scopeEntityId: uuid("scope_entity_id").references((): AnyPgColumn => ownerEntities.id),
  scopeRegionId: uuid("scope_region_id").references((): AnyPgColumn => regions.id),
  /** Per-person changes on top of the role: { "pos.discount": true, "sales.refund": false }. */
  permissionOverrides: jsonb("permission_overrides").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
  /** The last day an override counts, per permission ({ "sales.refund": "2026-11-02" }); none is no end. */
  permissionOverrideExpires: jsonb("permission_override_expires").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  /** Replaces the role's discount limit for this person. */
  maxDiscountPct: smallint("max_discount_pct"),
  /** Replaces the role's dollar limits for this person, key by key; null is no limit. */
  moneyLimits: jsonb("money_limits").$type<Partial<Record<"discountCents" | "refundCents" | "waiverCents", number | null>>>().notNull().default(sql`'{}'::jsonb`),
  isBookable: boolean("is_bookable").notNull().default(true),
  /** ST-I19: the app review login. Signs in only while FEATURE_STAFF_REVIEW_LOGIN is on; sees the Demo Shop only; no money moves. */
  isDemo: boolean("is_demo").notNull().default(false),
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
  /** Sign-in needs an authenticator code; without one set up they set it up at their next sign-in. */
  twoFactorRequired: boolean("two_factor_required").notNull().default(false),
  /** Their authenticator secret, encrypted with AUTH_SECRET (src/lib/secret-box.ts); null until set up. */
  totpSecret: text("totp_secret"),
  totpEnabledAt: ts("totp_enabled_at"),
  /** The last 30-second step a code was accepted for, so a code works once. */
  totpLastStep: integer("totp_last_step"),
  totpFailures: smallint("totp_failures").notNull().default(0),
  totpLockedUntil: ts("totp_locked_until"),
  /** Wrong passwords in a row (web and staff app); every 10 locks the account for longer (src/domain/staff-auth.ts). */
  passwordFailures: smallint("password_failures").notNull().default(0),
  passwordLockedUntil: ts("password_locked_until"),
  /** Invited by email and not signed up yet while there's no password. */
  invitedAt: ts("invited_at"),
  /** Removed from the brand portal: kept for history, never signs in again. */
  removedAt: ts("removed_at"),
  /** Work anniversaries count from this (src/domain/milestones.ts). */
  hireDate: date("hire_date"),
  /** Optional birthday: month and day only, never a year. */
  birthdayMonth: smallint("birthday_month"),
  birthdayDay: smallint("birthday_day"),
  /** Their milestones may show in the team feed, when the brand turns it on. */
  milestonesShared: boolean("milestones_shared").notNull().default(true),
  /** Booking options at every shop they work at (src/domain/staff-booking.ts); staff_shops can override per shop. */
  bookingOptions: jsonb("booking_options").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  /** How they hear about their clients' bookings, and when their clients are reminded (src/domain/staff-notifications.ts). */
  notificationPrefs: jsonb("notification_prefs").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});

/** Email invites to the brand portal. Only the token's hash is stored; a link works once, until it expires. */
export const staffInvites = pgTable(
  "staff_invites",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** portal: the brand portal's set-your-password email. staff_app: the staff app's sign-in link, by text or email. */
    purpose: text("purpose").$type<"portal" | "staff_app">().notNull().default("portal"),
    channel: text("channel").$type<"sms" | "email">(),
    expiresAt: ts("expires_at").notNull(),
    createdBy: uuid("created_by").references((): AnyPgColumn => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("staff_invites_staff_idx").on(t.staffId)],
);

/**
 * The brand's explicit exceptions to "shop logins and staff never see full client contact details
 * or export client lists": to one person, or to everyone working at one location. Revoking keeps
 * the row, so the history stays.
 */
export const clientContactGrants = pgTable(
  "client_contact_grants",
  {
    id: id(),
    kind: text("kind").$type<"full_contact" | "export">().notNull(),
    staffId: uuid("staff_id").references((): AnyPgColumn => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    note: text("note"),
    expiresAt: ts("expires_at"),
    grantedBy: uuid("granted_by").references((): AnyPgColumn => staff.id, { onDelete: "set null" }),
    grantedByLabel: text("granted_by_label").notNull(),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references((): AnyPgColumn => staff.id, { onDelete: "set null" }),
    revokedByLabel: text("revoked_by_label"),
  },
  (t) => [
    index("client_contact_grants_staff_idx").on(t.staffId),
    index("client_contact_grants_shop_idx").on(t.shopId),
    check("client_contact_grants_kind", sql`${t.kind} in ('full_contact', 'export')`),
    check("client_contact_grants_target", sql`(${t.staffId} is null) <> (${t.shopId} is null)`),
  ],
);

export const staffShops = pgTable(
  "staff_shops",
  {
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    visibleOnline: boolean("visible_online").notNull().default(true),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** This barber's slot interval at this shop; null follows the barber, then the shop, then the brand. */
    slotIntervalMinutes: integer("slot_interval_minutes"),
    /** "This shop only" booking options, over the barber's all-shops ones. */
    bookingOptions: jsonb("booking_options").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.shopId] })],
);

/**
 * A day on: a date a barber works outside their weekly schedule (a Sunday event, covering a shift).
 * Bookable like scheduled hours. Removing one keeps the row, so the history of days on stays.
 */
export const staffDaysOn = pgTable(
  "staff_days_on",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references((): AnyPgColumn => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    removedAt: ts("removed_at"),
    removedBy: uuid("removed_by").references((): AnyPgColumn => staff.id, { onDelete: "set null" }),
  },
  (t) => [
    index("staff_days_on_staff_date_idx").on(t.staffId, t.date),
    check("staff_days_on_span", sql`${t.startMin} >= 0 and ${t.endMin} <= 1440 and ${t.endMin} > ${t.startMin}`),
  ],
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
  /** The checkout rebook prompt's interval for a client with no visit history yet. Null: the brand's default. */
  rebookDays: integer("rebook_days"),
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
  /** Brand default overstock line: above this is more than the shop should hold. Null: no limit. */
  highStockThreshold: integer("high_stock_threshold"),
  /** Bought centrally and not yet at any shop. Moves only with a brand_stock_moves row. */
  unallocatedStock: integer("unallocated_stock").notNull().default(0),
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
    /** Shop override of the brand overstock line; null follows the brand. */
    highStockThreshold: integer("high_stock_threshold"),
    active: boolean("active").notNull().default(true),
    /** When a low-stock alert last went out; cleared once stock is back above the reorder point. */
    lowAlertedAt: ts("low_alerted_at"),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.productId] })],
);

/** Brand stock in and out: received centrally, allocated to a shop (into its ledger), or corrected. Append-only. */
export const brandStockMoves = pgTable(
  "brand_stock_moves",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    delta: integer("delta").notNull(),
    kind: text("kind").$type<"receive" | "allocate" | "adjust">().notNull(),
    shopId: uuid("shop_id").references(() => shops.id),
    unitCostCents: integer("unit_cost_cents"),
    note: text("note"),
    balanceAfter: integer("balance_after").notNull(),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("brand_stock_moves_product_idx").on(t.productId, t.createdAt)],
);

/** Category order for the brand catalog: services and products each have their own list. */
export const catalogCategories = pgTable("catalog_categories", {
  id: id(),
  kind: text("kind").$type<"service" | "product">().notNull(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

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
    /** The client's own note to their barber, written in the app or account page. Separate from staff notes; scrubbed and contact-redacted by triggers. */
    preferencesNote: text("preferences_note"),
    preferencesUpdatedAt: ts("preferences_updated_at"),
    /** Set only after a code sent to this address was entered. Only verified emails sign in or match a profile; imported emails start unverified. */
    emailVerifiedAt: ts("email_verified_at"),
    /** An imported profile's first app sign-in passed the light check (last name or last shop). Loyalty redemption is hidden until then. */
    identityVerifiedAt: ts("identity_verified_at"),
    identityCheckFailures: integer("identity_check_failures").notNull().default(0),
    lastAppSignInAt: ts("last_app_sign_in_at"),
    /** The client deleted their account: the row stays so sales add up, with every identifying detail cleared. */
    deletedAt: ts("deleted_at"),
    /** Values of the brand's custom client fields, by client_fields.id. */
    customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** Consent is opt-in: nothing is sent until the client (or their Squire record) says yes. */
    smsOptIn: boolean("sms_opt_in").notNull().default(false),
    emailOptIn: boolean("email_opt_in").notNull().default(false),
    /** Marketing is its own yes per channel, never implied by the appointment consent above or by a Squire import. Every change is a consent_events row. */
    smsMarketingOptIn: boolean("sms_marketing_opt_in").notNull().default(false),
    emailMarketingOptIn: boolean("email_marketing_opt_in").notNull().default(false),
    pushMarketing: boolean("push_marketing").notNull().default(false),
    /** App push about their own appointments and receipts, to their customer_devices. */
    pushTransactional: boolean("push_transactional").notNull().default(false),
    /** The client's standing receipt choice (C9): sent on paying with nothing asked at the counter. Null: asked at checkout. */
    receiptDelivery: text("receipt_delivery").$type<"email" | "app">(),
    /** The platform-level Stripe Customer holding this account holder's saved cards (C6). Never on a child. */
    stripeCustomerId: text("stripe_customer_id"),
    /** I14: a web guest booking that matched someone else's profile landed here instead. Folded into the profile once the phone signs in with a code. */
    unverifiedGuestAt: ts("unverified_guest_at"),
    /** I15: "Secure my profile": a phone sign-in also needs a code to the verified email. */
    securedAt: ts("secured_at"),
    /** I16: when the account holder said they're 13 or older. */
    ageConfirmedAt: ts("age_confirmed_at"),
    homeShopId: uuid("home_shop_id").references(() => shops.id),
    preferredStaffId: uuid("preferred_staff_id").references(() => staff.id, { onDelete: "set null" }),
    /** When their barber calls in, the appointment may be moved to a barber at another shop. */
    allowOtherShop: boolean("allow_other_shop").notNull().default(false),
    createdAt: createdAt(),
    /** The client number staff read out and the loyalty QR carries, from 10001. */
    number: integer("number").generatedAlwaysAsIdentity({ startWith: 10001 }),
    nickname: text("nickname"),
    /** How they found us, from the "Client sources" picklist (or "Squire import"). */
    source: text("source"),
    referredById: uuid("referred_by_id").references((): AnyPgColumn => customers.id, { onDelete: "set null" }),
    /** First, last and nickname, lowercased: fuzzy search matches its words in any order. */
    searchName: text("search_name").generatedAlwaysAs(sql`lower(first_name || ' ' || coalesce(last_name, '') || ' ' || coalesce(nickname, ''))`),
    addressZip: text("address_zip").generatedAlwaysAs(sql`substring(address from '(\\d{5})(?:-\\d{4})?\\s*$')`),
    addressCity: text("address_city").generatedAlwaysAs(sql`nullif(btrim(lower(substring(address from '([^,]+),[^,]*$'))), '')`),
    /**
     * SHA-256 of the normalized detail, set by a trigger (drizzle/core_0044_client_search.sql). Someone
     * who doesn't see a detail finds a client by the exact value through these, never by part of it.
     */
    phoneHash: text("phone_hash"),
    emailHash: text("email_hash"),
    birthdayHash: text("birthday_hash"),
    addressHash: text("address_hash"),
    /**
     * Set on a child profile: the parent or guardian whose account it sits under. A child (a
     * dependent) keeps a first name and an optional birth year only (I16): a trigger clears phone,
     * email, consent, last name, full birthday, address and nickname. Messages go to the guardian.
     */
    guardianId: uuid("guardian_id").references((): AnyPgColumn => customers.id, { onDelete: "set null" }),
    /** A child's age when the full birthday isn't known. */
    birthYear: integer("birth_year"),
    /** The guardian a child profile sat under before it became its own account. */
    formerGuardianId: uuid("former_guardian_id").references((): AnyPgColumn => customers.id, { onDelete: "set null" }),
    ownAccountAt: ts("own_account_at"),
  },
  (t) => [
    // Not unique: Squire data has families sharing one phone number.
    index("customers_phone_idx").on(t.phone),
    index("customers_email_idx").on(t.email),
    index("customers_name_idx").on(t.firstName, t.lastName),
    index("customers_home_shop_idx").on(t.homeShopId),
    uniqueIndex("customers_stripe_customer_idx").on(t.stripeCustomerId).where(sql`${t.stripeCustomerId} is not null`),
    index("customers_unverified_guest_idx").on(t.phone).where(sql`${t.unverifiedGuestAt} is not null`),
    // Trigram, hash, zip and city indexes live in drizzle/0006_client_search.sql and core_0044_client_search.sql;
    // the created-at and preferred-barber ones for custom reports in core_0047_report_builder.sql.
  ],
);

/** One photo per client so the desk can tell two Mike S.'s apart. Shown only to people who see "Photo". */
export const clientPhotos = pgTable("client_photos", {
  customerId: uuid("customer_id")
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  dataUrl: text("data_url").notNull(),
  updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Notes on a client, seen at every location they visit (src/server/client-notes.ts). The one with
 * source "record" is customers.notes, kept in step by trigger; "squire_visit" ones come from imported
 * appointments. Contact details are removed by trigger, whoever writes the row. See core_0057_client_notes.sql.
 */
export const clientNotes = pgTable(
  "client_notes",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"profile" | "visit" | "private">().notNull(),
    pinned: boolean("pinned").notNull().default(false),
    body: text("body").notNull().default(""),
    /** Cut notes: guard numbers, style and products used. */
    details: jsonb("details").$type<{ guard?: string; style?: string; products?: string[] }>(),
    appointmentId: uuid("appointment_id").references((): AnyPgColumn => appointments.id, { onDelete: "set null" }),
    /** Where it was written. */
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "set null" }),
    authorStaffId: uuid("author_staff_id").references(() => staff.id, { onDelete: "set null" }),
    /** For notes no staff member wrote, e.g. "Squire". */
    authorLabel: text("author_label"),
    source: text("source").$type<"staff" | "record" | "squire_visit">().notNull().default("staff"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
    deletedAt: ts("deleted_at"),
    deletedBy: uuid("deleted_by").references(() => staff.id, { onDelete: "set null" }),
  },
  (t) => [
    index("client_notes_customer_idx")
      .on(t.customerId, t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    index("client_notes_appointment_idx")
      .on(t.appointmentId)
      .where(sql`${t.appointmentId} is not null`),
    uniqueIndex("client_notes_one_record")
      .on(t.customerId)
      .where(sql`${t.source} = 'record'`),
    uniqueIndex("client_notes_one_squire_visit")
      .on(t.appointmentId)
      .where(sql`${t.source} = 'squire_visit'`),
    check("client_notes_kind", sql`${t.kind} in ('profile', 'visit', 'private')`),
    check("client_notes_source", sql`${t.source} in ('staff', 'record', 'squire_visit')`),
    check("client_notes_record_is_profile", sql`${t.source} <> 'record' or ${t.kind} = 'profile'`),
    check("client_notes_author_label", sql`${t.authorLabel} is null or char_length(${t.authorLabel}) <= 40`),
  ],
);

/** Before and after photos on a cut note, as data URLs like client_photos. */
export const clientNotePhotos = pgTable(
  "client_note_photos",
  {
    id: id(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => clientNotes.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"before" | "after">().notNull(),
    dataUrl: text("data_url").notNull(),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("client_note_photos_note_idx").on(t.noteId), check("client_note_photos_kind", sql`${t.kind} in ('before', 'after')`)],
);

/** A client list search and its filters, kept by one person, shared with a location, or with the brand. */
export const savedClientSearches = pgTable(
  "saved_client_searches",
  {
    id: id(),
    name: text("name").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    visibility: text("visibility").$type<"private" | "shop" | "brand">().notNull().default("private"),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    term: text("term").notNull().default(""),
    filter: jsonb("filter").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("saved_client_searches_owner_idx").on(t.ownerId)],
);

/** Pairs someone checked and marked "not the same person", so the duplicates tool stops offering them. a_id < b_id. */
export const customerDuplicateDismissals = pgTable(
  "customer_duplicate_dismissals",
  {
    aId: uuid("a_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    bId: uuid("b_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    dismissedBy: uuid("dismissed_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.aId, t.bId], name: "customer_duplicate_dismissals_pk" })],
);

/** Zip code centers, for "within N miles of a location". Loaded from the Census ZCTA gazetteer (scripts/load-zip-points.ts). */
export const zipPoints = pgTable("zip_points", {
  zip: text("zip").primaryKey(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
});

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
    /** local: our own code, sent through the SMS or email provider. twilio_verify: Twilio Verify holds the code (codeHash is a placeholder). */
    provider: text("provider").notNull().default("local"),
    /** sign_in, email_change (identifier is "<customerId>:<new email>"), step_up or delete. */
    purpose: text("purpose").notNull().default("sign_in"),
  },
  (t) => [index("otp_identifier_idx").on(t.identifier, t.createdAt)],
);

/** "I can't sign in" and failed identity checks: a staff task to confirm who the person is and merge or fix the profile. */
export const identityHelpRequests = pgTable("identity_help_requests", {
  id: id(),
  phone: text("phone"),
  email: text("email"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  message: text("message"),
  reason: text("reason").$type<"identity_check" | "idle_number" | "cant_sign_in" | "child_claim">().notNull(),
  candidateIds: jsonb("candidate_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  status: text("status").$type<"open" | "resolved" | "dismissed">().notNull().default("open"),
  createdAt: createdAt(),
  resolvedAt: ts("resolved_at"),
  resolvedBy: uuid("resolved_by").references(() => staff.id, { onDelete: "set null" }),
  resolution: text("resolution"),
});

/** A phone or tablet signed in to the customer app, with its push token. Signing out or deleting the account revokes it. */
export const customerDevices = pgTable(
  "customer_devices",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    platform: text("platform").$type<"ios" | "android">().notNull(),
    provider: text("provider").$type<"apns" | "fcm" | "expo">().notNull(),
    token: text("token").notNull(),
    appVersion: text("app_version"),
    osVersion: text("os_version"),
    locale: text("locale"),
    /** The phone's notification permission, as the app last reported it. */
    pushEnabled: boolean("push_enabled").notNull().default(true),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    /** The sign-in it was registered from; ending that session revokes the device. */
    sessionId: uuid("session_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("customer_devices_token_uq").on(t.token),
    index("customer_devices_customer_idx").on(t.customerId),
    index("customer_devices_session_idx").on(t.sessionId).where(sql`${t.sessionId} is not null`),
  ],
);

export type ConsentChannel = "sms_transactional" | "sms_marketing" | "email" | "email_marketing" | "push_transactional" | "push_marketing";
export type ConsentSource = "ios" | "android" | "web" | "pos" | "import" | "sms" | "email";

/** Every consent given or taken back, with the wording's version, where and when. Append-only (a trigger refuses edits and deletes). */
export const consentEvents = pgTable(
  "consent_events",
  {
    id: id(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    phone: text("phone"),
    email: text("email"),
    channel: text("channel").$type<ConsentChannel>().notNull(),
    action: text("action").$type<"granted" | "revoked">().notNull(),
    /** CONSENT_TEXTS[channel].version for a grant; STOP, START, an import's or a staff edit's own marker otherwise. */
    textVersion: text("text_version").notNull(),
    source: text("source").$type<ConsentSource>().notNull(),
    appVersion: text("app_version"),
    ip: text("ip"),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("consent_events_customer_idx").on(t.customerId, t.createdAt), index("consent_events_phone_idx").on(t.phone)],
);

/** One row per counted request (OTP starts per IP, per number); old rows are pruned as they're read. */
export const apiRateEvents = pgTable(
  "api_rate_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("api_rate_events_lookup_idx").on(t.bucket, t.key, t.createdAt)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: id(),
    customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
    /** The sign-in this token belongs to: the first token's id, carried through every rotation (I12). */
    sessionId: uuid("session_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    deviceName: text("device_name"),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    replacedBy: uuid("replaced_by"),
    createdAt: createdAt(),
  },
  (t) => [index("refresh_tokens_session_idx").on(t.sessionId).where(sql`${t.revokedAt} is null`), index("refresh_tokens_customer_live_idx").on(t.customerId).where(sql`${t.revokedAt} is null`)],
);

/** The staff app's sign-ins (/api/staff/v1): rotating refresh tokens, apart from the customer app's. */
export const staffAppTokens = pgTable(
  "staff_app_tokens",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    /** The first token's id, carried through every rotation. */
    sessionId: uuid("session_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    deviceName: text("device_name"),
    /** The app install that signed in (its own random id); a refresh from another install is refused. */
    deviceId: text("device_id"),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    replacedBy: uuid("replaced_by"),
    /** On the session's first row: when they last proved it's them (sign-in or step-up), for reveal, export and refund. */
    stepUpAt: ts("step_up_at"),
    createdAt: createdAt(),
  },
  (t) => [index("staff_app_tokens_session_idx").on(t.sessionId).where(sql`${t.revokedAt} is null`), index("staff_app_tokens_staff_live_idx").on(t.staffId).where(sql`${t.revokedAt} is null`)],
);

/**
 * One web sign-in per browser (ST-C0c): the session cookie names its row, so each can be listed and
 * signed out on its own. The browser is known by the hash of a long-lived random cookie, never the id.
 */
export const staffWebSessions = pgTable(
  "staff_web_sessions",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    deviceHash: text("device_hash"),
    /** The browser and system, from its user agent ("Chrome on Windows"). */
    deviceLabel: text("device_label"),
    ip: text("ip"),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    /** When they last proved it's them (sign-in or step-up), for reveal, export and refund. */
    stepUpAt: ts("step_up_at"),
    createdAt: createdAt(),
  },
  (t) => [index("staff_web_sessions_staff_live_idx").on(t.staffId).where(sql`${t.revokedAt} is null`)],
);

/** Every browser and app install someone has signed in on, so a sign-in anywhere new emails them (ST-C0c). */
export const staffKnownDevices = pgTable(
  "staff_known_devices",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    via: text("via").$type<"web" | "app">().notNull(),
    deviceHash: text("device_hash").notNull(),
    deviceLabel: text("device_label"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_known_devices_uq").on(t.staffId, t.deviceHash), check("staff_known_devices_via", sql`${t.via} in ('web', 'app')`)],
);

/** The staff app's phones, for booking pushes. Signing out of the app revokes its device. */
export const staffDevices = pgTable(
  "staff_devices",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    platform: text("platform").$type<"ios" | "android">().notNull(),
    provider: text("provider").$type<"apns" | "fcm" | "expo">().notNull(),
    token: text("token").notNull(),
    appVersion: text("app_version"),
    osVersion: text("os_version"),
    pushEnabled: boolean("push_enabled").notNull().default(true),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    sessionId: uuid("session_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("staff_devices_token_uq").on(t.token),
    index("staff_devices_staff_idx").on(t.staffId),
    index("staff_devices_session_idx").on(t.sessionId).where(sql`${t.sessionId} is not null`),
  ],
);

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
    /** A tip the client chose while booking or on the confirmation page; filled in on the ticket at checkout. */
    bookingTipCents: integer("booking_tip_cents").notNull().default(0),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key").unique(),
    rebookedFromId: uuid("rebooked_from_id"),
    /** A family booked together: one link, one confirmation and one set of reminders for the group. */
    groupId: uuid("group_id").references((): AnyPgColumn => bookingGroups.id, { onDelete: "set null" }),
    squireId: text("squire_id").unique(),
    /** False for Squire rows whose export had no booked-at time; created_at is then a stand-in and rebook KPIs skip them. */
    bookedAtKnown: boolean("booked_at_known").notNull().default(true),
    cancelledAt: ts("cancelled_at"),
    cancelledBy: text("cancelled_by"),
    /** Why it was cancelled, when given (scrubbed of card and ID numbers). */
    cancelReason: text("cancel_reason"),
    checkedInAt: ts("checked_in_at"),
    completedAt: ts("completed_at"),
    /** The barber (or the desk) sent it to checkout: it's on its ticket and waiting to be paid. */
    checkoutReadyAt: ts("checkout_ready_at"),
    checkoutReadyBy: uuid("checkout_ready_by").references((): AnyPgColumn => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("appointments_shop_time_idx").on(t.shopId, t.startsAt),
    index("appointments_staff_time_idx").on(t.staffId, t.startsAt),
    index("appointments_customer_idx").on(t.customerId, t.startsAt),
    index("appointments_group_idx").on(t.groupId).where(sql`group_id is not null`),
    // appointments_customer_status_idx (custom reports) lives in core_0047_report_builder.sql.
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
  /** Only on these days (0 Sunday to 6 Saturday) and between these local times; empty and null is any time. */
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  timeFrom: text("time_from"),
  timeTo: text("time_to"),
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
    /** The card surcharge staff waived on this ticket: what it would have been. */
    cardFeeWaivedCents: integer("card_fee_waived_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    /** Snapshot of rates/fee config used, for receipts and audits. */
    pricing: jsonb("pricing"),
    promoCodeId: uuid("promo_code_id").references(() => promoCodes.id),
    loyaltyEarnedCents: integer("loyalty_earned_cents").notNull().default(0),
    createdBy: uuid("created_by"),
    paidAt: ts("paid_at"),
    voidedAt: ts("voided_at"),
    voidReason: text("void_reason"),
    /** The manager whose PIN approved the void, when the person voiding couldn't on their own. */
    voidApprovedBy: uuid("void_approved_by"),
    isImported: boolean("is_imported").notNull().default(false),
    /** Squire transaction ID (or a content hash when the export has none), so re-imports don't duplicate. */
    squireRef: text("squire_ref").unique(),
    /** Combined into another open ticket at checkout: this one is voided and its people and lines are there. */
    mergedIntoSaleId: uuid("merged_into_sale_id").references((): AnyPgColumn => sales.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("sales_shop_date_idx").on(t.shopId, t.businessDate),
    index("sales_staff_date_idx").on(t.staffId, t.businessDate),
    index("sales_date_idx").on(t.businessDate),
    index("sales_customer_idx").on(t.customerId),
    // sales_customer_date_idx (custom reports) lives in core_0047_report_builder.sql.
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
    /** On a family ticket, the appointment (and so the family member) the line was for. */
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
  },
  (t) => [index("sale_items_sale_idx").on(t.saleId)],
);

/** Family ticket: further appointments paid on one sale besides sales.appointment_id. */
export const saleAppointments = pgTable(
  "sale_appointments",
  {
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.saleId, t.appointmentId] }), index("sale_appointments_appointment_idx").on(t.appointmentId)],
);

/**
 * A parent and their children booked together (core_0055_booking_groups.sql). The group's code is
 * the one cancel/reschedule link; its deposit and no-show rule cover everyone in it. A deposit taken
 * is held as a gift card with source "deposit" and applied at the group's checkout.
 */
export const bookingGroups = pgTable(
  "booking_groups",
  {
    id: id(),
    code: text("code").notNull().unique(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    guardianId: uuid("guardian_id").notNull().references(() => customers.id),
    plan: text("plan").$type<"same_barber" | "together" | "earliest_finish" | "custom" | "walk_in">().notNull(),
    source: appointmentSource("source").notNull(),
    depositCents: integer("deposit_cents").notNull().default(0),
    depositStatus: text("deposit_status").$type<"none" | "due" | "held" | "applied" | "forfeited" | "refund_due" | "refunded" | "waived">().notNull().default("none"),
    depositSaleId: uuid("deposit_sale_id").references(() => sales.id, { onDelete: "set null" }),
    depositGiftCardId: uuid("deposit_gift_card_id").references(() => giftCards.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").unique(),
    createdBy: uuid("created_by"),
    cancelledAt: ts("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [index("booking_groups_guardian_idx").on(t.guardianId)],
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
    /** The credit card surcharge in amountCents: the payment's fee_amount. */
    cardFeeCents: integer("card_fee_cents").notNull().default(0),
    /** Card payments: the surcharge's percent part as applied (after any state limit); 0 for a flat fee. */
    feeRate: numeric("fee_rate", { precision: 6, scale: 5 }),
    feeFlatCents: integer("fee_flat_cents"),
    /** What the surcharge was on: charge_excluding_tip or charge_including_tip. */
    feeBasis: text("fee_basis").$type<"charge_excluding_tip" | "charge_including_tip">(),
    /** The amount the surcharge was worked out on. */
    feeBasisCents: integer("fee_basis_cents"),
    /** Why there's no surcharge when there isn't (CardFeeResult reason): not_credit, waived, state_not_allowed and so on. */
    feeReason: text("fee_reason"),
    /** Where the charge was taken: pos, app, deposit or card_on_file. */
    feeChannel: text("fee_channel"),
    feeWaived: boolean("fee_waived").notNull().default(false),
    /** What the waived surcharge would have been. */
    feeWaivedCents: integer("fee_waived_cents").notNull().default(0),
    feeWaivedBy: uuid("fee_waived_by").references(() => staff.id, { onDelete: "set null" }),
    feeWaivedReason: text("fee_waived_reason"),
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
    /** The shop's connected account this card charge's shop portion goes to (payment_transfers), or, for a destination charge, settled to. */
    stripeAccountId: text("stripe_account_id"),
    /** separate (I10, 2026-10-28): charged on the platform, then transferred (payment_transfers). destination: before that, settled to stripeAccountId. Null for non-card. */
    chargeType: text("charge_type").$type<"destination" | "separate">(),
    /** The charge's Stripe transfer_group; its transfers carry it too. */
    transferGroup: text("transfer_group"),
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
    /** Split payment: who paid this part, one of the people on the ticket or a short label ("Grandma"). */
    payerCustomerId: uuid("payer_customer_id").references(() => customers.id, { onDelete: "set null" }),
    payerLabel: text("payer_label"),
    createdAt: createdAt(),
  },
  (t) => [
    check("payments_payer_label", sql`${t.payerLabel} is null or char_length(${t.payerLabel}) <= 40`),
    check("payments_settlement", sql`${t.settlement} is null or ${t.settlement} in ('platform', 'connected')`),
    check("payments_charge_type", sql`${t.chargeType} is null or ${t.chargeType} in ('destination', 'separate')`),
    check("payments_fee_basis", sql`${t.feeBasis} is null or ${t.feeBasis} in ('charge_excluding_tip', 'charge_including_tip')`),
    check("payments_fee_channel", sql`${t.feeChannel} is null or ${t.feeChannel} in ('pos', 'app', 'deposit', 'card_on_file')`),
    check("payments_fee_waived", sql`not ${t.feeWaived} or (${t.method} = 'card' and ${t.cardFeeCents} = 0 and ${t.feeWaivedCents} > 0 and ${t.feeWaivedReason} is not null)`),
    index("payments_shop_date_idx").on(t.shopId, t.businessDate),
    index("payments_account_idx").on(t.stripeAccountId),
    index("payments_sale_idx").on(t.saleId),
    uniqueIndex("payments_stripe_pi_uq").on(t.stripePaymentIntentId),
  ],
);

export type PaymentTransferKind = "shop" | "tip";
export type PaymentTransferStatus = "pending" | "sent" | "failed" | "cancelled";

/**
 * Separate charges and transfers (I10): what a card charge on the platform sends on. One shop row,
 * the shop's portion to its connected account; one tip row per barber whose tip goes to their Stripe
 * account (FEATURE_TIP_TO_BARBER). Each is created with source_transaction, idempotent on the row's
 * id. Refunds and disputes reverse the shop row only (payment_transfer_reversals); a trigger keeps a
 * tip row's amount, barber and account fixed, and reversed_cents stays 0 on tip rows.
 */
export const paymentTransfers = pgTable(
  "payment_transfers",
  {
    id: id(),
    paymentId: uuid("payment_id").notNull().references(() => payments.id),
    saleId: uuid("sale_id").notNull().references(() => sales.id),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    kind: text("kind").$type<PaymentTransferKind>().notNull(),
    staffId: uuid("staff_id").references(() => staff.id),
    destinationAccount: text("destination_account").notNull(),
    amountCents: integer("amount_cents").notNull(),
    transferGroup: text("transfer_group").notNull(),
    /** pending until Stripe has it (retried by the cron), then sent; failed after the last try; cancelled when a refund before it was sent took it all. */
    status: text("status").$type<PaymentTransferStatus>().notNull().default("pending"),
    stripeTransferId: text("stripe_transfer_id"),
    /** Stripe's idempotency key: {saleId}:shop and {saleId}:tip (saleTransferKeys). Rows from before core_0137 keep sale-transfer-{id}. */
    idempotencyKey: text("idempotency_key"),
    /** Shop rows only: what refunds and disputes have taken back. */
    reversedCents: integer("reversed_cents").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("payment_transfers_kind", sql`${t.kind} in ('shop', 'tip')`),
    check("payment_transfers_staff", sql`(${t.kind} = 'tip') = (${t.staffId} is not null)`),
    check("payment_transfers_status", sql`${t.status} in ('pending', 'sent', 'failed', 'cancelled')`),
    check("payment_transfers_amount", sql`${t.amountCents} >= 0 and (${t.amountCents} > 0 or ${t.status} = 'cancelled')`),
    check("payment_transfers_sent", sql`(${t.status} = 'sent') = (${t.stripeTransferId} is not null)`),
    check("payment_transfers_reversed", sql`${t.reversedCents} >= 0 and ${t.reversedCents} <= ${t.amountCents}`),
    check("payment_transfers_tips_kept", sql`${t.kind} = 'shop' or ${t.reversedCents} = 0`),
    check("payment_transfers_idempotency_key", sql`${t.idempotencyKey} is null or char_length(${t.idempotencyKey}) between 1 and 255`),
    uniqueIndex("payment_transfers_idempotency_uq").on(t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex("payment_transfers_shop_uq").on(t.paymentId).where(sql`${t.kind} = 'shop'`),
    uniqueIndex("payment_transfers_tip_uq").on(t.paymentId, t.staffId).where(sql`${t.kind} = 'tip'`),
    uniqueIndex("payment_transfers_stripe_uq").on(t.stripeTransferId),
    index("payment_transfers_sale_idx").on(t.saleId),
    index("payment_transfers_pending_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
  ],
);

export type TransferReversalKind = "refund" | "dispute" | "dispute_won";
export type TransferReversalStatus = "pending" | "sent" | "netted" | "failed" | "none";

/**
 * What a refund or dispute took back from a shop's transfer, and what a won dispute sent back. Always
 * a shop row (a trigger refuses a tip row). netted: the transfer hadn't gone yet, so it was lowered
 * instead; none: nothing of the shop's transfer was left. uncovered_cents is what the shop's transfer
 * couldn't cover (a tip already with the barber), which the platform carries.
 */
export const paymentTransferReversals = pgTable(
  "payment_transfer_reversals",
  {
    id: id(),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => paymentTransfers.id),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    kind: text("kind").$type<TransferReversalKind>().notNull(),
    refundId: uuid("refund_id").references(() => refunds.id),
    stripeDisputeId: text("stripe_dispute_id"),
    amountCents: integer("amount_cents").notNull(),
    uncoveredCents: integer("uncovered_cents").notNull().default(0),
    status: text("status").$type<TransferReversalStatus>().notNull().default("pending"),
    /** The transfer reversal (trr_), or for a won dispute the new transfer (tr_). */
    stripeId: text("stripe_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("payment_transfer_reversals_kind", sql`${t.kind} in ('refund', 'dispute', 'dispute_won')`),
    check("payment_transfer_reversals_source", sql`(${t.kind} = 'refund') = (${t.refundId} is not null) and (${t.kind} = 'refund') = (${t.stripeDisputeId} is null)`),
    check("payment_transfer_reversals_dispute_id", sql`${t.stripeDisputeId} is null or ${t.stripeDisputeId} ~ '^(dp|du|sim)_[A-Za-z0-9_]{1,80}$'`),
    check("payment_transfer_reversals_status", sql`${t.status} in ('pending', 'sent', 'netted', 'failed', 'none')`),
    check("payment_transfer_reversals_amounts", sql`${t.amountCents} >= 0 and ${t.uncoveredCents} >= 0`),
    check("payment_transfer_reversals_sent", sql`(${t.status} = 'sent') = (${t.stripeId} is not null)`),
    uniqueIndex("payment_transfer_reversals_refund_uq").on(t.refundId).where(sql`${t.refundId} is not null`),
    uniqueIndex("payment_transfer_reversals_dispute_uq").on(t.stripeDisputeId, t.kind).where(sql`${t.stripeDisputeId} is not null`),
    index("payment_transfer_reversals_transfer_idx").on(t.transferId),
    index("payment_transfer_reversals_pending_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
  ],
);

export type PlatformLossKind = "refund" | "dispute_lost";
export type PlatformLossBearer = "platform" | "shop";

/**
 * Tips are never clawed back, so a refund or lost dispute bigger than what's left of the shop's
 * portion is a platform loss: `cents` in all, of which `tip_cents` was a tip already with the barber
 * (the rest, the processing fee). `bearer` is who carries the tip part (the brand's
 * tipRefundOverflow): the platform, or the shop, recovered from its next transfers
 * (platform_loss_recoveries). The fee part is always the platform's.
 */
export const platformLosses = pgTable(
  "platform_losses",
  {
    id: id(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    kind: text("kind").$type<PlatformLossKind>().notNull(),
    refundId: uuid("refund_id").references(() => refunds.id),
    stripeDisputeId: text("stripe_dispute_id"),
    cents: integer("cents").notNull(),
    tipCents: integer("tip_cents").notNull().default(0),
    bearer: text("bearer").$type<PlatformLossBearer>().notNull().default("platform"),
    recoveredCents: integer("recovered_cents").notNull().default(0),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("platform_losses_kind", sql`${t.kind} in ('refund', 'dispute_lost')`),
    check("platform_losses_source", sql`(${t.kind} = 'refund') = (${t.refundId} is not null) and (${t.kind} = 'refund') = (${t.stripeDisputeId} is null)`),
    check("platform_losses_bearer", sql`${t.bearer} in ('platform', 'shop')`),
    check("platform_losses_amounts", sql`${t.cents} > 0 and ${t.tipCents} >= 0 and ${t.tipCents} <= ${t.cents}`),
    check("platform_losses_recovered", sql`${t.recoveredCents} >= 0 and ${t.recoveredCents} <= ${t.tipCents} and (${t.bearer} = 'shop' or ${t.recoveredCents} = 0)`),
    uniqueIndex("platform_losses_refund_uq").on(t.refundId).where(sql`${t.refundId} is not null`),
    uniqueIndex("platform_losses_dispute_uq").on(t.stripeDisputeId).where(sql`${t.stripeDisputeId} is not null`),
    index("platform_losses_payment_idx").on(t.paymentId),
    index("platform_losses_open_idx").on(t.shopId, t.createdAt).where(sql`${t.bearer} = 'shop' and ${t.recoveredCents} < ${t.tipCents}`),
    index("platform_losses_date_idx").on(t.businessDate),
  ],
);

/** What a shop-borne platform loss took from one of the shop's later transfers; negative when a refund of that sale reopened it. A trigger refuses a tip row. */
export const platformLossRecoveries = pgTable(
  "platform_loss_recoveries",
  {
    id: id(),
    lossId: uuid("loss_id")
      .notNull()
      .references(() => platformLosses.id),
    transferId: uuid("transfer_id")
      .notNull()
      .references(() => paymentTransfers.id),
    cents: integer("cents").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("platform_loss_recoveries_cents", sql`${t.cents} <> 0`),
    index("platform_loss_recoveries_loss_idx").on(t.lossId),
    index("platform_loss_recoveries_transfer_idx").on(t.transferId),
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
    /** The client tipped each barber on their own line: [{ staffId, cents }] adding up to tipCents. */
    tipByStaff: jsonb("tip_by_staff").$type<{ staffId: string; cents: number }[]>(),
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
    /** device: a customer screen at the counter. app: sent to the client's phone to pay in the app (C7). */
    via: text("via").$type<"device" | "app">().notNull().default("device"),
  },
  (t) => [
    check("checkout_handoffs_via", sql`${t.via} in ('device', 'app')`),
    check("checkout_handoffs_status", sql`${t.status} in ('active', 'paid', 'returned')`),
    check("checkout_handoffs_tip_source", sql`${t.tipSource} is null or ${t.tipSource} in ('screen', 'reader')`),
    check("checkout_handoffs_receipt_channel", sql`${t.receiptChannel} is null or ${t.receiptChannel} in ('sms', 'email', 'none')`),
    check("checkout_handoffs_tip", sql`${t.tipCents} is null or ${t.tipCents} >= 0`),
    uniqueIndex("checkout_handoffs_active_uq").on(t.saleId).where(sql`${t.status} = 'active'`),
    index("checkout_handoffs_sale_idx").on(t.saleId, t.startedAt),
  ],
);
export type HandoffStatus = "active" | "paid" | "returned";

export type AppPaymentStatus = "pending" | "requires_action" | "succeeded" | "failed" | "refunded";

/**
 * A payment from the app for a ticket sent there (C7). Kept so a payment that needed the bank's
 * check (3-D Secure) can be finished by the payment_intent webhook if the app never comes back.
 */
export const appPayments = pgTable(
  "app_payments",
  {
    id: id(),
    handoffId: uuid("handoff_id")
      .notNull()
      .references(() => checkoutHandoffs.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    payerCustomerId: uuid("payer_customer_id").references(() => customers.id, { onDelete: "set null" }),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    /** The saved card (pm_...) or the app's ConfirmationToken (ctoken_...) it was paid with. */
    paymentMethodRef: text("payment_method_ref").notNull(),
    amountCents: integer("amount_cents").notNull(),
    cardFeeCents: integer("card_fee_cents").notNull().default(0),
    tipCents: integer("tip_cents").notNull(),
    tipChoice: text("tip_choice"),
    tipByStaff: jsonb("tip_by_staff").$type<{ staffId: string; cents: number }[]>(),
    cardFunding: text("card_funding"),
    wallet: text("wallet"),
    status: text("status").$type<AppPaymentStatus>().notNull().default("pending"),
    failureCode: text("failure_code"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("app_payments_status", sql`${t.status} in ('pending', 'requires_action', 'succeeded', 'failed', 'refunded')`),
    uniqueIndex("app_payments_intent_idx").on(t.stripePaymentIntentId).where(sql`${t.stripePaymentIntentId} is not null`),
    index("app_payments_sale_idx").on(t.saleId),
  ],
);

/**
 * A client's saved cards (C6), on their platform-level Stripe Customer so one card works at every
 * shop. A child's cards are the parent's: only the account holder has any. Stripe keeps the card;
 * this is what the app lists, and what a payment is checked against.
 */
export const customerCards = pgTable(
  "customer_cards",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    stripePaymentMethodId: text("stripe_payment_method_id").notNull(),
    brand: text("brand").notNull(),
    last4: text("last4").notNull(),
    funding: text("funding").$type<"credit" | "debit" | "prepaid" | "unknown">().notNull(),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    wallet: text("wallet"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    detachedAt: ts("detached_at"),
  },
  (t) => [
    unique("customer_cards_pm_unique").on(t.customerId, t.stripePaymentMethodId),
    check("customer_cards_funding", sql`${t.funding} in ('credit', 'debit', 'prepaid', 'unknown')`),
    index("customer_cards_pm_idx").on(t.stripePaymentMethodId),
    uniqueIndex("customer_cards_one_default").on(t.customerId).where(sql`${t.isDefault} and ${t.detachedAt} is null`),
  ],
);

/** Every Stripe webhook event once (I11): a redelivery of one already handled is a no-op. */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    account: text("account"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    attempts: integer("attempts").notNull().default(1),
    outcome: text("outcome"),
  },
  (t) => [index("stripe_events_unprocessed_idx").on(t.receivedAt).where(sql`${t.processedAt} is null`)],
);

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
    channel: text("channel").$type<"sms" | "email" | "app" | "none">().notNull(),
    /** E.164 phone, lowercased email, or for the app the account holder's customer ID; null for "no receipt". Refund and void updates go here. */
    destination: text("destination"),
    masked: text("masked"),
    /** ReceiptPurpose in src/domain/receipts.ts. */
    purpose: text("purpose").$type<"counter" | "handoff" | "refund" | "void" | "resend" | "request" | "review" | "standing">().notNull(),
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
    check("receipt_deliveries_channel", sql`${t.channel} in ('sms', 'email', 'app', 'none')`),
    check("receipt_deliveries_purpose", sql`${t.purpose} in ('counter', 'handoff', 'refund', 'void', 'resend', 'request', 'review', 'standing')`),
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
    /** The manager whose PIN approved it, when the person issuing it couldn't on their own. */
    approvedBy: uuid("approved_by"),
    /**
     * Money back on the card with nothing said about what for (a Stripe dashboard refund): the
     * components stay zero, and loyalty and gift cards are untouched, until staff assign lines.
     */
    awaitingLines: boolean("awaiting_lines").notNull().default(false),
    linesAssignedAt: ts("lines_assigned_at"),
    linesAssignedBy: uuid("lines_assigned_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("refunds_shop_date_idx").on(t.shopId, t.businessDate),
    index("refunds_sale_idx").on(t.saleId),
    index("refunds_awaiting_idx").on(t.shopId).where(sql`${t.awaitingLines}`),
  ],
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
    openedBy: uuid("opened_by"),
    openedAt: ts("opened_at"),
    closedBy: uuid("closed_by"),
    closedAt: ts("closed_at"),
  },
  (t) => [uniqueIndex("cash_drawers_uq").on(t.shopId, t.businessDate)],
);

/** Cash put into or taken out of a shop's drawer during the day, other than sales, refunds and tip payouts. */
export const cashDrawerMoves = pgTable(
  "cash_drawer_moves",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date").notNull(),
    /** no_sale: the drawer was opened without a sale (amount 0), with "Open the cash drawer". */
    kind: text("kind").$type<"paid_in" | "paid_out" | "no_sale">().notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    staffId: uuid("staff_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("cash_drawer_moves_kind", sql`${t.kind} in ('paid_in', 'paid_out', 'no_sale')`),
    check("cash_drawer_moves_amount", sql`(${t.kind} = 'no_sale' and ${t.amountCents} = 0) or (${t.kind} <> 'no_sale' and ${t.amountCents} > 0)`),
    index("cash_drawer_moves_shop_date_idx").on(t.shopId, t.businessDate),
  ],
);

/** A paid ticket moved from one barber to another: its sales, lines and tips go with it. */
export const saleReassignments = pgTable(
  "sale_reassignments",
  {
    id: id(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    fromStaffId: uuid("from_staff_id").references(() => staff.id),
    toStaffId: uuid("to_staff_id")
      .notNull()
      .references(() => staff.id),
    reason: text("reason").notNull(),
    tipCents: integer("tip_cents").notNull().default(0),
    createdBy: uuid("created_by"),
    approvedBy: uuid("approved_by"),
    createdAt: createdAt(),
  },
  (t) => [index("sale_reassignments_sale_idx").on(t.saleId), index("sale_reassignments_shop_idx").on(t.shopId, t.createdAt)],
);

// ───────────────────────────── Tip payouts ─────────────────────────────

export type TipBatchKind = "end_of_night" | "daily_delay" | "weekly" | "manual" | "payroll" | "opening";
export type TipBatchStatus = "draft" | "approved" | "completed" | "cancelled";
export type TipPayoutMethod = "cash" | "stripe" | "payroll" | "prior";
export type TipPayoutStatus = "pending" | "held" | "approved" | "processing" | "paid" | "failed" | "cancelled";
export type TipHoldKind = "manager" | "stripe_setup" | "transfers_pending";
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
    /** Always 0 (ST-C18): the shop pays card fees, never the tip. Older paid payouts may show a fee netted before that rule. */
    feeCents: integer("fee_cents").notNull().default(0),
    /** Manager adjustments, each a ledger entry with a reason. */
    adjustCents: integer("adjust_cents").notNull().default(0),
    /** gross + adjust: what leaves the drawer or the Stripe balance. */
    netCents: integer("net_cents").notNull().default(0),
    instant: boolean("instant").notNull().default(false),
    /** Stripe's instant payout fee, estimated and shown before sending. */
    instantFeeCents: integer("instant_fee_cents").notNull().default(0),
    /** Who pays it, by the brand's policy when the payout was built: the employee receives net − fee, or the shop pays net + fee. */
    instantFeePaidBy: text("instant_fee_paid_by").$type<"employee" | "shop">().notNull().default("employee"),
    /** Where Stripe sent it: the card or bank's type and last 4, never its number. */
    destinationType: text("destination_type").$type<"bank_account" | "card">(),
    destinationLast4: text("destination_last4"),
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
    /** manager = held by hand; stripe_setup = waiting for the employee to finish Stripe payout setup, released on its own when they do; transfers_pending = can't be transferred yet: live keys before MONEY_MOVEMENT_LIVE, or the shop's card tips aren't on the platform (owed, paid through payroll at the cutoff). */
    holdKind: text("hold_kind").$type<TipHoldKind>(),
    heldBy: uuid("held_by"),
    heldAt: ts("held_at"),
    /** Payroll: the pay period it was paid in. */
    payrollPeriodStart: date("payroll_period_start"),
    /** The shop's employer when the payout was built; a trigger sets it and it never changes. */
    employerId: uuid("employer_id").references((): AnyPgColumn => payrollEmployers.id),
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
    check("tip_payouts_instant_fee_paid_by", sql`${t.instantFeePaidBy} in ('employee', 'shop')`),
    check("tip_payouts_destination", sql`(${t.destinationType} is null or ${t.destinationType} in ('bank_account', 'card')) and (${t.destinationLast4} is null or ${t.destinationLast4} ~ '^[0-9]{4}$')`),
    check("tip_payouts_hold_kind", sql`${t.holdKind} is null or ${t.holdKind} in ('manager', 'stripe_setup', 'transfers_pending')`),
    check("tip_payouts_no_fee_on_open", sql`${t.feeCents} = 0 or ${t.status} not in ('pending', 'held')`),
    index("tip_payouts_stripe_setup").on(t.staffId).where(sql`${t.status} = 'held' and ${t.holdKind} = 'stripe_setup'`),
    uniqueIndex("tip_payouts_batch_staff_uq").on(t.batchId, t.staffId),
    uniqueIndex("tip_payouts_transfer_uq").on(t.stripeTransferId),
    uniqueIndex("tip_payouts_payout_uq").on(t.stripePayoutId),
    index("tip_payouts_staff_idx").on(t.staffId, t.createdAt),
    index("tip_payouts_drawer_idx").on(t.shopId, t.drawerDate).where(sql`${t.method} = 'cash'`),
    index("tip_payouts_employer_idx").on(t.employerId, t.createdAt),
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
    /** The employer (one FEIN) of the shop's pay group when the entry was written; a trigger sets it and it never changes. */
    employerId: uuid("employer_id").references(() => payrollEmployers.id),
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
    index("tip_ledger_employer_idx").on(t.employerId, t.businessDate),
  ],
);

/** As src/domain/staff-payouts.ts names them. */
export type StaffAccountState = "not_started" | "in_progress" | "pending_verification" | "requirements_due" | "restricted" | "active" | "rejected";
export type StaffAccountDashboard = "none" | "express";
export type StaffServiceAgreement = "recipient" | "full";
export type StaffTaxForms = "will_not_file";

export type TipAbsorptionKind = "partial_refund" | "outside_window" | "rule" | "after_payout" | "dispute";

/**
 * A refunded or disputed tip the barber keeps because the shop absorbs it: a partial refund, a
 * refund after the reversal window, a brand that never reverses tips, or a card dispute. The tip
 * ledger is untouched; these flow into the tips-paid export. Append-only.
 */
export const tipAbsorptions = pgTable(
  "tip_absorptions",
  {
    id: id(),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    employerId: uuid("employer_id").references(() => payrollEmployers.id),
    saleId: uuid("sale_id").references(() => sales.id),
    paymentId: uuid("payment_id").references(() => payments.id),
    refundId: uuid("refund_id").references(() => refunds.id),
    stripeDisputeId: text("stripe_dispute_id"),
    kind: text("kind").$type<TipAbsorptionKind>().notNull(),
    /** The tip the shop absorbed, positive. */
    amountCents: integer("amount_cents").notNull(),
    businessDate: date("business_date").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("tip_absorptions_kind", sql`${t.kind} in ('partial_refund', 'outside_window', 'rule', 'after_payout', 'dispute')`),
    check("tip_absorptions_source", sql`(${t.kind} = 'dispute' and ${t.stripeDisputeId} is not null) or (${t.kind} <> 'dispute' and ${t.refundId} is not null)`),
    check("tip_absorptions_dispute_id", sql`${t.stripeDisputeId} is null or ${t.stripeDisputeId} ~ '^(dp|du|sim)_[A-Za-z0-9_]{1,80}$'`),
    uniqueIndex("tip_absorptions_refund_uq").on(t.refundId, t.staffId).where(sql`${t.refundId} is not null`),
    uniqueIndex("tip_absorptions_dispute_uq").on(t.stripeDisputeId, t.staffId).where(sql`${t.stripeDisputeId} is not null`),
    index("tip_absorptions_shop_date_idx").on(t.shopId, t.businessDate),
  ],
);

export type TipDeclarationSource = "staff_app" | "clock_out" | "web" | "manager";

/**
 * Cash tips an employee declares (handed to them, never rung up), with the attestation they checked.
 * Append-only: a correction is a new row replacing the old one, with a reason; what counts is every
 * row nothing replaces. Payroll exports them as their own earning, in the pay period of their date.
 */
export const tipDeclarations = pgTable(
  "tip_declarations",
  {
    id: id(),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    source: text("source").$type<TipDeclarationSource>().notNull(),
    attestation: text("attestation").notNull(),
    replacesId: uuid("replaces_id").references((): AnyPgColumn => tipDeclarations.id),
    reason: text("reason"),
    /** The shop's employer when declared; a trigger sets it and it never changes. */
    employerId: uuid("employer_id").references((): AnyPgColumn => payrollEmployers.id),
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("tip_declarations_amount", sql`${t.amountCents} >= 0 and ${t.amountCents} <= 1000000`),
    check("tip_declarations_source", sql`${t.source} in ('staff_app', 'clock_out', 'web', 'manager')`),
    check("tip_declarations_reason", sql`${t.replacesId} is null or ${t.reason} is not null`),
    uniqueIndex("tip_declarations_replaces_uq").on(t.replacesId),
    index("tip_declarations_shop_date_idx").on(t.shopId, t.businessDate),
    index("tip_declarations_staff_date_idx").on(t.staffId, t.businessDate),
  ],
);

/** The yearly check that Stripe won't file 1099s for the barbers' accounts: one row per tax year, with what it found. */
export const taxFormChecks = pgTable(
  "tax_form_checks",
  {
    id: id(),
    taxYear: integer("tax_year").notNull().unique(),
    accounts: integer("accounts").notNull(),
    untagged: integer("untagged").notNull(),
    feesOnAccount: integer("fees_on_account").notNull(),
    checkedBy: uuid("checked_by").references(() => staff.id),
    checkedAt: ts("checked_at").notNull().defaultNow(),
  },
  (t) => [check("tax_form_checks_year", sql`${t.taxYear} between 2020 and 2100`)],
);

/**
 * For payroll (W-2): the pay period each payout's tips belong to, by the business date of every
 * entry in it, on the shop's pay group calendar. One row per payout per period, almost always just
 * one; a weekly batch that crosses a period end gets two. Written when a payout is approved, sent or
 * paid, and dropped when it fails or is taken out, so the paid ones add up to what iSolved got as
 * tips already received for that employee, shop and period.
 */
export const tipPayoutPeriods = pgTable(
  "tip_payout_periods",
  {
    id: id(),
    payoutId: uuid("payout_id")
      .notNull()
      .references(() => tipPayouts.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").notNull().references(() => shops.id),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    method: text("method").$type<TipPayoutMethod>().notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** Tips less refunds from the period, before any card fee: what payroll counts as tips. */
    tipsCents: integer("tips_cents").notNull(),
    /** Manager adjustments dated in the period; payroll counts them as tips too. */
    adjustCents: integer("adjust_cents").notNull().default(0),
    /** The card fee share netted from the period's card tips, where the shop nets it. */
    feeCents: integer("fee_cents").notNull().default(0),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
  },
  (t) => [
    check("tip_payout_periods_method", sql`${t.method} in ('cash', 'stripe', 'payroll', 'prior')`),
    check("tip_payout_periods_dates", sql`${t.periodEnd} >= ${t.periodStart}`),
    uniqueIndex("tip_payout_periods_uq").on(t.payoutId, t.periodStart),
    index("tip_payout_periods_period_idx").on(t.shopId, t.periodStart, t.staffId),
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
    /** Every bank account and debit card on the Stripe account: Stripe's id for each, its type, name, last 4, whether it's the default and takes instant payouts. Never a number. */
    externalAccounts: jsonb("external_accounts")
      .$type<{ id: string; type: "bank_account" | "card"; name: string | null; last4: string; default: boolean; instant: boolean }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Who pays Stripe's fees on the account (controller.fees.payer), as Stripe last reported it. Ray'z
     * creates every one as "application": Stripe issues a 1099-K only where the account pays its own
     * fees, and these employees' tips are W-2 wages. Anything else holds their Stripe payouts.
     */
    feesPayer: text("fees_payer"),
    /** When Stripe confirmed the account is tagged as a W-2 employee's (metadata worker_type, tax_forms), so nobody treats it as a contractor's. */
    w2TaggedAt: ts("w2_tagged_at"),
    /** The Stripe Dashboard the account was made with: none (embedded components in the app) or express. Null: no account yet. */
    dashboard: text("dashboard").$type<StaffAccountDashboard>(),
    /** Stripe's service agreement on the account: recipient (transfers only) or full. */
    serviceAgreement: text("service_agreement").$type<StaffServiceAgreement>(),
    /** One of seven (accountState in src/domain/staff-payouts.ts), saved on every Stripe event and audited when it changes. */
    state: text("state").$type<StaffAccountState>().notNull().default("not_started"),
    stateChangedAt: ts("state_changed_at"),
    /** Stripe's transfers capability: active, inactive, pending, unrequested or disabled. */
    transfersCapability: text("transfers_capability"),
    requirementsPastDue: jsonb("requirements_past_due").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** The account was disconnected from the platform (account.application.deauthorized). */
    deauthorizedAt: ts("deauthorized_at"),
    /** What Stripe does with 1099s for the account: never file (tips are W-2 wages through payroll). */
    taxForms: text("tax_forms").$type<StaffTaxForms>().notNull().default("will_not_file"),
    /** The instant payout fee, in words, the employee accepted before instant payouts turned on; a new fee needs accepting again. */
    instantFeeTerms: text("instant_fee_terms"),
    instantFeeAcceptedAt: ts("instant_fee_accepted_at"),
    /** The Stripe tip deposit consent wording they last agreed to (ST-C17), and when; null once withdrawn. History is tip_deposit_consents. */
    depositConsentVersion: text("deposit_consent_version"),
    depositConsentAt: ts("deposit_consent_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("staff_payout_accounts_deposit_consent", sql`(${t.depositConsentVersion} is null) = (${t.depositConsentAt} is null)`),
    check("staff_payout_accounts_method", sql`${t.method} is null or ${t.method} in ('cash', 'stripe', 'payroll')`),
    check("staff_payout_accounts_destination_type", sql`${t.destinationType} is null or ${t.destinationType} in ('bank_account', 'card')`),
    check("staff_payout_accounts_last4", sql`${t.destinationLast4} is null or ${t.destinationLast4} ~ '^[0-9]{4}$'`),
    check("staff_payout_accounts_external_accounts", sql`jsonb_typeof(${t.externalAccounts}) = 'array'`),
    check("staff_payout_accounts_state", sql`${t.state} in ('not_started', 'in_progress', 'pending_verification', 'requirements_due', 'restricted', 'active', 'rejected')`),
    check("staff_payout_accounts_dashboard", sql`${t.dashboard} is null or ${t.dashboard} in ('none', 'express')`),
    check("staff_payout_accounts_service_agreement", sql`${t.serviceAgreement} is null or ${t.serviceAgreement} in ('recipient', 'full')`),
    check("staff_payout_accounts_tax_forms", sql`${t.taxForms} in ('will_not_file')`),
  ],
);

/** Every grant and withdrawal of an employee's Stripe tip deposit consent, with the wording they saw. Append-only. */
export const tipDepositConsents = pgTable(
  "tip_deposit_consents",
  {
    id: id(),
    staffId: uuid("staff_id").notNull().references(() => staff.id),
    action: text("action").$type<"granted" | "revoked">().notNull(),
    version: text("version").notNull(),
    text: text("text").notNull(),
    source: text("source").$type<"web" | "staff_app">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("tip_deposit_consents_action", sql`${t.action} in ('granted', 'revoked')`),
    check("tip_deposit_consents_source", sql`${t.source} in ('web', 'staff_app')`),
    check("tip_deposit_consents_text", sql`char_length(${t.text}) <= 2000`),
    index("tip_deposit_consents_staff_idx").on(t.staffId, t.createdAt),
  ],
);

/**
 * Invites to set up Stripe payouts, one row per employee: everyone onboards fresh under Ray'z, since
 * no Squire account carries over. Each send is also in the audit log. Reminders stop once their
 * setup is done (or a manager stops them).
 */
export const staffOnboardingInvites = pgTable(
  "staff_onboarding_invites",
  {
    staffId: uuid("staff_id")
      .primaryKey()
      .references(() => staff.id, { onDelete: "cascade" }),
    firstSentAt: ts("first_sent_at").notNull(),
    firstSentBy: uuid("first_sent_by").references(() => staff.id, { onDelete: "set null" }),
    lastSentAt: ts("last_sent_at").notNull(),
    lastSentBy: uuid("last_sent_by").references(() => staff.id, { onDelete: "set null" }),
    /** Where the last invite went, which reminders follow. */
    channels: jsonb("channels").$type<("sms" | "email")[]>().notNull().default(sql`'[]'::jsonb`),
    invites: integer("invites").notNull().default(1),
    reminders: integer("reminders").notNull().default(0),
    remindersStoppedAt: ts("reminders_stopped_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("staff_onboarding_invites_channels", sql`jsonb_typeof(${t.channels}) = 'array' and ${t.channels} <@ '["sms", "email"]'::jsonb`),
    check("staff_onboarding_invites_counts", sql`${t.invites} >= 1 and ${t.reminders} >= 0`),
    index("staff_onboarding_invites_reminders").on(t.lastSentAt).where(sql`${t.remindersStoppedAt} is null`),
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
    kind: text("kind").notNull(), // earn | reverse | reward_issued | reward_redeemed | import | expire | merge | convert
    progressDeltaCents: integer("progress_delta_cents").notNull().default(0),
    /** What progressDeltaCents counts: cents (value based) or paid visits (transaction based). */
    unit: text("unit").notNull().default("cents"),
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
    /** Emails only: the HTML version, sent alongside the plain text body. */
    htmlBody: text("html_body"),
    attachments: jsonb("attachments").$type<EmailAttachment[]>(),
    /** Push only: more strings for the app when it's tapped, beside kind and appointmentId (the review link). */
    pushData: jsonb("push_data").$type<Record<string, string>>(),
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
    /** Held for quiet hours (src/domain/staff-notifications.ts): this person clocking in or ending a break sends it then. */
    heldForStaffId: uuid("held_for_staff_id").references(() => staff.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notification_jobs_due_idx").on(t.status, t.runAt),
    index("notification_jobs_held_idx").on(t.heldForStaffId).where(sql`${t.heldForStaffId} is not null`),
    index("notification_jobs_appt_idx").on(t.appointmentId),
    index("notification_jobs_provider_msg_idx").on(t.providerMessageId),
    index("notification_jobs_outreach_idx").on(t.outreachId),
    index("notification_jobs_customer_idx").on(t.customerId, t.createdAt),
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
  /** Set for a cutover delta import, which only takes that shop's bookings and tickets. */
  shopId: uuid("shop_id").references(() => shops.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/** A section of a cutover reconciliation: Squire's final export against what's here, in cents. */
export interface CutoverSection {
  expected: { count: number; cents: number };
  actual: { count: number; cents: number };
  /** Differences nothing here explains; any one blocks the switch. */
  differences: { ref: string; label: string; squireCents: number | null; hereCents: number | null }[];
  /** Differences from activity here since the import (a gift card used at a shop already moved, say). */
  explained: { ref: string; label: string; squireCents: number | null; hereCents: number | null }[];
}

export interface CutoverReconciliation {
  environment: string;
  at: string;
  frozenAt: string;
  sections: Partial<Record<"bookings" | "tickets" | "loyalty" | "gift_cards", CutoverSection>>;
  files: Partial<Record<"bookings" | "tickets" | "loyalty" | "gift_cards", string>>;
}

/**
 * Moving one shop's online booking off Squire (C22): record when Squire booking was frozen, import what
 * changed after it, reconcile Squire's final exports to the cent, then an owner signs off and switches.
 */
export const shopCutovers = pgTable("shop_cutovers", {
  shopId: uuid("shop_id")
    .primaryKey()
    .references(() => shops.id, { onDelete: "cascade" }),
  squireFrozenAt: ts("squire_frozen_at"),
  freezeRecordedBy: uuid("freeze_recorded_by").references(() => staff.id, { onDelete: "set null" }),
  freezeRecordedAt: ts("freeze_recorded_at"),
  reconciliation: jsonb("reconciliation").$type<CutoverReconciliation>(),
  reconciledAt: ts("reconciled_at"),
  reconciledBy: uuid("reconciled_by").references(() => staff.id, { onDelete: "set null" }),
  matched: boolean("matched").notNull().default(false),
  signedOffBy: uuid("signed_off_by").references(() => staff.id, { onDelete: "set null" }),
  signedOffAt: ts("signed_off_at"),
  switchedAt: ts("switched_at"),
  handedBackAt: ts("handed_back_at"),
  handedBackBy: uuid("handed_back_by").references(() => staff.id, { onDelete: "set null" }),
  /** The last day Squire pays this shop's tips. Everyone should finish Ray'z Stripe payout setup before it. */
  squireTipsEndOn: date("squire_tips_end_on"),
  /** Squire's last payout statement covers tips through this day; what's after it, to squireTipsEndOn, Squire still owes. */
  squirePaidThrough: date("squire_paid_through"),
  /** The day Squire makes its last payout of this shop's tips. */
  squireLastPayoutOn: date("squire_last_payout_on"),
  /** The tip payout reconciliation as the manager signed it off (src/server/payout-cutover.ts). */
  payoutReport: jsonb("payout_report").$type<Record<string, unknown>>(),
  payoutReportSignedBy: uuid("payout_report_signed_by").references(() => staff.id, { onDelete: "set null" }),
  payoutReportSignedAt: ts("payout_report_signed_at"),
  /** The total of Squire's final payout statement for what it still owes this shop's barbers, tied out against Squire's tickets and the barbers' answers (ST-C9). */
  squireStatementCents: integer("squire_statement_cents"),
  /** The CPA's sign-off of the tie-out after the manager's, recorded by an owner: their name, the day they signed, and the report they signed. */
  cpaSignedName: text("cpa_signed_name"),
  cpaSignedOn: date("cpa_signed_on"),
  cpaReport: jsonb("cpa_report").$type<Record<string, unknown>>(),
  cpaRecordedBy: uuid("cpa_recorded_by").references(() => staff.id, { onDelete: "set null" }),
  cpaRecordedAt: ts("cpa_recorded_at"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [
  check("shop_cutovers_statement", sql`${t.squireStatementCents} is null or ${t.squireStatementCents} >= 0`),
  check("shop_cutovers_cpa", sql`(${t.cpaSignedName} is null) = (${t.cpaRecordedAt} is null) and (${t.cpaSignedOn} is null) = (${t.cpaRecordedAt} is null) and (${t.cpaReport} is null) = (${t.cpaRecordedAt} is null)`),
]);

export interface CleanPeriodCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * The rollout Charles approved: one pilot shop (wave 1) goes live while Squire stays as its backup;
 * the rest (wave 2) switch after the pilot's first clean pay period is signed off (src/server/rollout.ts).
 */
export const shopRollouts = pgTable(
  "shop_rollouts",
  {
    shopId: uuid("shop_id")
      .primaryKey()
      .references(() => shops.id, { onDelete: "cascade" }),
    wave: smallint("wave").notNull().default(2),
    plannedOn: date("planned_on", { mode: "string" }),
    /** The first pay period whose payroll comes from this platform. Before it (or while null), from the Squire data imported for the period. */
    payrollFrom: date("payroll_from", { mode: "string" }),
    /** Squire is kept running for this shop, as the backup, through this day. */
    squireBackupUntil: date("squire_backup_until", { mode: "string" }),
    cleanPeriodStart: date("clean_period_start", { mode: "string" }),
    cleanPeriodEnd: date("clean_period_end", { mode: "string" }),
    cleanCheck: jsonb("clean_check").$type<CleanPeriodCheck[]>(),
    cleanNote: text("clean_note"),
    cleanSignedBy: uuid("clean_signed_by").references(() => staff.id, { onDelete: "set null" }),
    cleanSignedAt: ts("clean_signed_at"),
    note: text("note"),
    updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("shop_rollouts_one_pilot").on(t.wave).where(sql`${t.wave} = 1`),
    check("shop_rollouts_wave", sql`${t.wave} in (1, 2)`),
    check(
      "shop_rollouts_clean",
      sql`(${t.cleanPeriodStart} is null) = (${t.cleanSignedAt} is null) and (${t.cleanPeriodEnd} is null) = (${t.cleanSignedAt} is null) and (${t.cleanPeriodEnd} is null or ${t.cleanPeriodEnd} >= ${t.cleanPeriodStart})`,
    ),
    check("shop_rollouts_clean_pilot", sql`${t.cleanSignedAt} is null or ${t.wave} = 1`),
    check("shop_rollouts_note_len", sql`(${t.note} is null or char_length(${t.note}) <= 300) and (${t.cleanNote} is null or char_length(${t.cleanNote}) <= 300)`),
  ],
);

export interface SquireImportTotals {
  workedCenti: number;
  serviceCents: number;
  productCents: number;
  tipsCents: number;
  salesTaxCents: number;
  /** Sales on the report with no barber ("Unassigned sales"): reference only, as on the Payroll Report. */
  unassignedServiceCents: number;
  unassignedProductCents: number;
}

/** A shop's Squire Commissions report for a pay period whose payroll still comes from Squire. */
export const payrollSquireImports = pgTable(
  "payroll_squire_imports",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    fileName: text("file_name"),
    rows: integer("rows").notNull(),
    totals: jsonb("totals").$type<SquireImportTotals>().notNull(),
    notes: jsonb("notes").$type<string[]>().notNull().default([]),
    importedBy: uuid("imported_by").references(() => staff.id, { onDelete: "set null" }),
    importedAt: ts("imported_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payroll_squire_imports_shop_period_uq").on(t.shopId, t.periodStart), check("payroll_squire_imports_dates", sql`${t.periodEnd} >= ${t.periodStart}`)],
);

/** One employee's figures at a shop for a Squire-sourced pay period, as Squire's report has them. */
export const payrollSquireInputs = pgTable(
  "payroll_squire_inputs",
  {
    importId: uuid("import_id")
      .notNull()
      .references(() => payrollSquireImports.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    squireName: text("squire_name").notNull(),
    workedCenti: integer("worked_centi").notNull().default(0),
    otCenti: integer("ot_centi").notNull().default(0),
    ptoCenti: integer("pto_centi").notNull().default(0),
    trainingCenti: integer("training_centi").notNull().default(0),
    serviceCents: integer("service_cents").notNull().default(0),
    productCents: integer("product_cents").notNull().default(0),
    tipsCents: integer("tips_cents").notNull().default(0),
    salesTaxCents: integer("sales_tax_cents").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "payroll_squire_inputs_pk", columns: [t.periodStart, t.shopId, t.staffId] }),
    index("payroll_squire_inputs_import_idx").on(t.importId),
    check("payroll_squire_inputs_hours", sql`${t.workedCenti} >= 0 and ${t.otCenti} >= 0 and ${t.otCenti} <= ${t.workedCenti} and ${t.ptoCenti} >= 0 and ${t.trainingCenti} >= 0`),
  ],
);

/** Each barber's answer, in the staff app, to what the cutover report says Squire still owes them. */
export const staffPayoutConfirmations = pgTable(
  "staff_payout_confirmations",
  {
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    status: text("status").$type<"confirmed" | "disputed">().notNull(),
    /** What the report said when they answered; a later change to it asks them again. */
    squireOwedCents: integer("squire_owed_cents").notNull(),
    note: text("note"),
    decidedAt: ts("decided_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: "staff_payout_confirmations_pk", columns: [t.shopId, t.staffId] })],
);

/** Year-to-date tips and sales from before Ray'z (Squire's reports), per barber per shop, so year totals and the W-2 reconcile. Read-only in the app. */
export const staffYtdImports = pgTable(
  "staff_ytd_imports",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    year: smallint("year").notNull(),
    throughDate: date("through_date").notNull(),
    cardTipsCents: integer("card_tips_cents").notNull().default(0),
    cashTipsCents: integer("cash_tips_cents").notNull().default(0),
    serviceSalesCents: integer("service_sales_cents").notNull().default(0),
    productSalesCents: integer("product_sales_cents").notNull().default(0),
    /** Tips Squire already paid them directly (outside payroll), for the CPA's withholding check. */
    paidOutCents: integer("paid_out_cents").notNull().default(0),
    source: text("source").$type<"squire">().notNull().default("squire"),
    importedBy: uuid("imported_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staff_ytd_imports_uq").on(t.staffId, t.shopId, t.year, t.source)],
);

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
 * An employer: one legal entity (one FEIN) its shops' pay groups belong to, and every tip is tagged
 * with. Only the last four digits of its federal tax id are kept; the full number stays in iSolved and Stripe.
 */
export const payrollEmployers = pgTable(
  "payroll_employers",
  {
    id: id(),
    legalName: text("legal_name").notNull().unique(),
    /** The company code in iSolved, for the tips-paid export. */
    isolvedCompanyCode: text("isolved_company_code"),
    taxIdLast4: text("tax_id_last4"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("payroll_employers_tax_id_last4", sql`${t.taxIdLast4} is null or ${t.taxIdLast4} ~ '^[0-9]{4}$'`)],
);

/** A legal entity's registration in one state (withholding and unemployment accounts). Only the last 4 of each account number is kept. */
export const payrollEmployerStates = pgTable(
  "payroll_employer_states",
  {
    id: id(),
    employerId: uuid("employer_id")
      .notNull()
      .references(() => payrollEmployers.id, { onDelete: "cascade" }),
    /** Two-letter postal code (IL, IA). */
    state: text("state").notNull(),
    withholdingIdLast4: text("withholding_id_last4"),
    unemploymentIdLast4: text("unemployment_id_last4"),
    registeredOn: date("registered_on", { mode: "string" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("payroll_employer_states_uq").on(t.employerId, t.state),
    check("payroll_employer_states_state", sql`${t.state} ~ '^[A-Z]{2}$'`),
    check(
      "payroll_employer_states_last4",
      sql`(${t.withholdingIdLast4} is null or ${t.withholdingIdLast4} ~ '^[0-9]{4}$') and (${t.unemploymentIdLast4} is null or ${t.unemploymentIdLast4} ~ '^[0-9]{4}$')`,
    ),
  ],
);

/**
 * Each shop is an iSolved pay group with its own pay calendar (Dubuque's differs from the rest).
 * The label is whatever Charles calls the pay group, and the code is iSolved's letter for it (B is
 * Rock Island). Shops of the same legal entity (one FEIN; Ray'z Inc. is the only one) share overtime.
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
    /** The employer for the legal entity; a trigger keeps it in step with legal_entity. */
    employerId: uuid("employer_id").references(() => payrollEmployers.id),
    /** The workbook tab this shop's export copies: its sheet name and formatting. */
    exportTab: text("export_tab").notNull(),
    /** iSolved's pay group code: 1 to 4 capital letters or digits, one per pay group. */
    isolvedCode: text("isolved_code"),
    /** First day of a known period, and that period's number in iSolved. */
    anchorStart: date("anchor_start", { mode: "string" }).notNull(),
    anchorNumber: integer("anchor_number").notNull(),
    periodDays: integer("period_days").notNull().default(14),
    checkOffsetDays: integer("check_offset_days").notNull().default(6),
    submitOffsetDays: integer("submit_offset_days").notNull().default(4),
    numberResetsYearly: boolean("number_resets_yearly").notNull().default(true),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("pay_groups_period_days", sql`${t.periodDays} in (7, 14)`),
    check("pay_groups_submit_offset", sql`${t.submitOffsetDays} between 0 and ${t.checkOffsetDays}`),
    check("pay_groups_isolved_code", sql`${t.isolvedCode} is null or ${t.isolvedCode} ~ '^[A-Z0-9]{1,4}$'`),
    uniqueIndex("pay_groups_isolved_code_uq").on(t.isolvedCode).where(sql`${t.isolvedCode} is not null`),
  ],
);

/**
 * Each pay period's check date and iSolved submit-by date, per pay group. Written from the calendar's
 * offsets for the periods around today, and kept when someone moves one (a holiday), with the reason.
 */
export const payPeriodDates = pgTable(
  "pay_period_dates",
  {
    id: id(),
    payGroupId: uuid("pay_group_id")
      .notNull()
      .references(() => payGroups.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    periodNumber: integer("period_number").notNull(),
    checkDate: date("check_date", { mode: "string" }).notNull(),
    submitBy: date("submit_by", { mode: "string" }).notNull(),
    /** Set when someone moved the dates off the calendar's offsets; the calendar's own rows have none. */
    reason: text("reason"),
    updatedBy: uuid("updated_by").references(() => staff.id),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("pay_period_dates_uq").on(t.payGroupId, t.periodStart),
    check("pay_period_dates_order", sql`${t.periodEnd} >= ${t.periodStart} and ${t.submitBy} >= ${t.periodEnd} and ${t.checkDate} >= ${t.submitBy}`),
    check("pay_period_dates_reason_len", sql`${t.reason} is null or char_length(${t.reason}) <= 200`),
  ],
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
  /** Treasury tipped occupation code for the 2026 W-2 (barber versus front desk). Null: not set, so their tips can't be reported as qualified. */
  tippedOccupationCode: text("tipped_occupation_code"),
  /** Hours go to iSolved but Hourly Total is $0 (the owner's row in the workbook). */
  zeroHourlyPay: boolean("zero_hourly_pay").notNull().default(false),
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

/**
 * One version of an employee's pay plan (src/domain/compensation.ts), in effect from its date until
 * the next one. Never edited (a trigger refuses): a change is a new version starting after the last
 * locked pay period, so past payroll stays as it was. Null amounts and rates fall back to Payroll setup.
 */
export const staffCompensation = pgTable(
  "staff_compensation",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    hourlyRateCents: integer("hourly_rate_cents"),
    /** A different hourly rate at some shops: [{ shopId, cents }]. */
    shopHourlyRates: jsonb("shop_hourly_rates").$type<{ shopId: string; cents: number }[]>().notNull().default(sql`'[]'::jsonb`),
    /** Fractions (0.45 = 45%), as Payroll setup keeps them. */
    servicePct: doublePrecision("service_pct"),
    serviceOverrides: jsonb("service_overrides").$type<{ kind: "service" | "category"; ref: string; pct: number }[]>().notNull().default(sql`'[]'::jsonb`),
    serviceTiers: jsonb("service_tiers").$type<{ fromCents: number; pct: number }[]>().notNull().default(sql`'[]'::jsonb`),
    tierMode: text("tier_mode").$type<"step" | "marginal">().notNull().default("step"),
    productPct: doublePrecision("product_pct"),
    boothRentCents: integer("booth_rent_cents"),
    boothRentFrequency: text("booth_rent_frequency").$type<"weekly" | "biweekly" | "monthly">(),
    guaranteeCents: integer("guarantee_cents"),
    guaranteePer: text("guarantee_per").$type<"pay_period" | "week" | "month" | "year">(),
    /** Null: the shop's (or their own) tip payout method. */
    tipMethod: text("tip_method").$type<"cash" | "stripe" | "payroll">(),
    /** Retired (ST-C18): always null, since card fees never come out of tips. */
    tipCardFeeNetting: boolean("tip_card_fee_netting"),
    note: text("note"),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index("staff_compensation_staff_idx").on(t.staffId, t.effectiveFrom, t.createdAt)],
);

/** Employee fields the brand adds itself. Labels that look like bank, card, social security or tax ID fields are refused (by the app and a check). */
export const staffCustomFields = pgTable("staff_custom_fields", {
  id: id(),
  label: text("label").notNull(),
  kind: text("kind").$type<"text" | "number" | "percent" | "date" | "dropdown">().notNull(),
  options: jsonb("options").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  position: integer("position").notNull().default(100),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const staffCustomValues = pgTable(
  "staff_custom_values",
  {
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => staffCustomFields.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "staff_custom_values_pk", columns: [t.staffId, t.fieldId] })],
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
    /** The shop's employer; a trigger sets it and moves it with the shop. */
    employerId: uuid("employer_id").references(() => payrollEmployers.id),
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_entries_starts_idx").on(t.startsAt),
    index("time_entries_employer_idx").on(t.employerId, t.startsAt),
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
 * Commission owed for an already-locked pay period, paid in the open one starting periodStart (I2).
 * The earned dates find the locked period, whose overtime then owes half-time on it too.
 */
export const payrollCommissionAdjustments = pgTable(
  "payroll_commission_adjustments",
  {
    id: id(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    earnedStart: date("earned_start", { mode: "string" }).notNull(),
    earnedEnd: date("earned_end", { mode: "string" }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("payroll_commission_adjustments_period_idx").on(t.periodStart, t.shopId),
    check("payroll_commission_adjustments_amount", sql`${t.amountCents} > 0`),
    check("payroll_commission_adjustments_earned", sql`${t.earnedEnd} >= ${t.earnedStart} and ${t.earnedEnd} < ${t.periodStart}`),
    check("payroll_commission_adjustments_reason", sql`char_length(btrim(${t.reason})) > 0 and char_length(${t.reason}) <= 300`),
  ],
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
    /** The pay group's employer at the lock; a trigger sets it. */
    employerId: uuid("employer_id").references(() => payrollEmployers.id),
    lockedAt: ts("locked_at").notNull().defaultNow(),
    lockedBy: uuid("locked_by").references(() => staff.id),
  },
  (t) => [unique("payroll_runs_uq").on(t.payGroupId, t.periodStart)],
);

export interface PayrollApprovalTotals {
  shops: { shopId: string; shop: string; rows: number; service: number; totalWages: number; laborCost: number }[];
  service: number;
  employeeCost: number;
  grossProfit: number;
}

/**
 * A pay period's figures as someone with payroll.approve approved them, before the lock. Never
 * edited or deleted (a trigger refuses): only revoked once, with a reason. One active per period.
 */
export const payrollApprovals = pgTable(
  "payroll_approvals",
  {
    id: id(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    /** Every shop's rows, totals and iSolved file as approved: a lock or download needs the live figures to hash the same. */
    figuresHash: text("figures_hash").notNull(),
    totals: jsonb("totals").$type<PayrollApprovalTotals>().notNull(),
    note: text("note"),
    approvedAt: ts("approved_at").notNull().defaultNow(),
    approvedBy: uuid("approved_by").references(() => staff.id),
    revokedAt: ts("revoked_at"),
    revokedBy: uuid("revoked_by").references(() => staff.id),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    uniqueIndex("payroll_approvals_active_uq").on(t.periodStart, t.periodEnd).where(sql`${t.revokedAt} is null`),
    index("payroll_approvals_period_idx").on(t.periodStart, t.periodEnd, t.approvedAt),
    check("payroll_approvals_dates", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

/**
 * N9: one employee's final pay, run off-cycle for the pay period of their last day. The snapshot
 * keeps each shop's row and iSolved line as approved (the payroll run's Line and ExportRow); the
 * regular run for that period leaves them out. Never edited or deleted (a trigger refuses).
 */
export const payrollFinalPays = pgTable(
  "payroll_final_pays",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    lastDay: date("last_day", { mode: "string" }).notNull(),
    snapshot: jsonb("snapshot").$type<{ shops: Record<string, unknown>[] }>().notNull(),
    figuresHash: text("figures_hash").notNull(),
    note: text("note"),
    approvedBy: uuid("approved_by").references(() => staff.id),
    approvedAt: ts("approved_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payroll_final_pays_staff_period_uq").on(t.staffId, t.periodStart),
    index("payroll_final_pays_period_idx").on(t.periodStart),
    check("payroll_final_pays_dates", sql`${t.periodEnd} >= ${t.periodStart} and ${t.lastDay} >= ${t.periodStart} and ${t.lastDay} <= ${t.periodEnd}`),
    check("payroll_final_pays_note_len", sql`${t.note} is null or char_length(${t.note}) <= 300`),
  ],
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

/** What went into a shop's tab when the pay period's iSolved file was marked sent. */
export interface PayrollSendShop {
  shopId: string;
  payGroup: string;
  tab: string;
  rows: number;
  /** The file's column totals, in its order (hours to the hundredth, dollars to the cent). */
  totals: number[];
  headers: string[];
  /** The shop's legal entity as sent (absent on sends before ST-I14). */
  employerId?: string | null;
  employer?: string | null;
  isolvedCompanyCode?: string | null;
  workState?: string | null;
}

/**
 * A pay period's iSolved file, marked sent to iSolved (uploaded by hand) once every shop in it is
 * approved and locked and its tips reconcile to the cent. One per period; undoing it deletes the row
 * (audited). iSolved stays the system of record; nothing here talks to it.
 */
export const payrollExportSends = pgTable(
  "payroll_export_sends",
  {
    id: id(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    shops: jsonb("shops").$type<PayrollSendShop[]>().notNull(),
    note: text("note"),
    sentAt: ts("sent_at").notNull().defaultNow(),
    sentBy: uuid("sent_by").references(() => staff.id),
  },
  (t) => [unique("payroll_export_sends_uq").on(t.periodStart, t.periodEnd), check("payroll_export_sends_dates", sql`${t.periodEnd} >= ${t.periodStart}`)],
);

// ───────────────────────────── Time clock ─────────────────────────────

export type PunchType = "in" | "out" | "break_start" | "break_end";
export type PunchSource = "self" | "kiosk" | "manager";
export type PunchMethod = "device" | "gps" | "network" | "qr" | "nfc" | "none" | "manager";

/** A shop's registered front-desk device. The browser keeps the token in a cookie; only its hash is stored. */
export const clockDevices = pgTable("clock_devices", {
  id: id(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  registeredBy: uuid("registered_by").references(() => staff.id),
  /** Paired by a manager's QR code (ST-C0c): it runs the clock on its own token, no shop login. */
  pairedAt: ts("paired_at"),
  /** A paired app install's own id, hashed: the token works only from that install. */
  installHash: text("install_hash"),
  lastSeenAt: ts("last_seen_at"),
  revokedAt: ts("revoked_at"),
  createdAt: createdAt(),
});

/** A manager's one-time pairing code for a front-desk clock, shown as a QR code; good for 10 minutes. */
export const clockPairings = pgTable("clock_pairings", {
  id: id(),
  shopId: uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  codeHash: text("code_hash").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => staff.id),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  deviceId: uuid("device_id").references(() => clockDevices.id),
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
    /** The shop's employer; a trigger sets it and moves it with the shop. */
    employerId: uuid("employer_id").references(() => payrollEmployers.id),
    /** The staff app's own id for a punch (ST-I18), so a punch queued offline and retried goes in once. */
    clientPunchId: uuid("client_punch_id"),
    createdBy: uuid("created_by").references(() => staff.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("time_punches_staff_at_idx").on(t.staffId, t.at),
    uniqueIndex("time_punches_client_punch_uq").on(t.staffId, t.clientPunchId).where(sql`${t.clientPunchId} is not null`),
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

export interface PayQuestionEvent {
  at: string;
  kind: "asked" | "answered" | "escalated" | "resolved" | "reminded";
  /** The staff member, or null for the system (an overdue escalation). */
  by: string | null;
  byLabel: string;
  text: string | null;
}

/**
 * An employee's question about their pay (ST-I10): answered by the managers who approve timecards
 * at the shop, and escalated to the owners when nobody answers in time or the employee asks. Kept
 * after it's closed, with its history, as a pay record.
 */
export const payQuestions = pgTable(
  "pay_questions",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    periodStart: date("period_start", { mode: "string" }),
    /** PAY_QUESTION_TOPICS in src/domain/staff-privacy.ts. */
    topic: text("topic").notNull(),
    detail: text("detail").notNull(),
    status: text("status").$type<"open" | "answered" | "resolved">().notNull().default("open"),
    level: text("level").$type<"manager" | "owner">().notNull().default("manager"),
    /** An answer is due by then; past it, a manager-level question goes to the owners. */
    dueAt: ts("due_at").notNull(),
    escalatedAt: ts("escalated_at"),
    /** The owners were reminded once about an overdue escalated question. */
    remindedAt: ts("reminded_at"),
    history: jsonb("history").$type<PayQuestionEvent[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("pay_questions_staff_idx").on(t.staffId, t.createdAt),
    index("pay_questions_open_idx").on(t.shopId, t.status, t.dueAt),
    check("pay_questions_status_ck", sql`${t.status} in ('open', 'answered', 'resolved')`),
    check("pay_questions_level_ck", sql`${t.level} in ('manager', 'owner')`),
  ],
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

/**
 * Addresses no email goes to: a hard bounce or spam complaint reported by the email provider, the
 * stop link in an email, or staff. `customerIds`: whose "OK to email" this turned off.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: id(),
    email: text("email").notNull(),
    reason: text("reason").$type<"bounce" | "complaint" | "unsubscribe" | "staff">().notNull(),
    provider: text("provider"),
    customerIds: jsonb("customer_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [unique("email_suppressions_email_uq").on(t.email), check("email_suppressions_reason_chk", sql`${t.reason} in ('bounce', 'complaint', 'unsubscribe', 'staff')`)],
);

/** A customer's private calendar feed of upcoming appointments (theirs and their children's). Only the token's hash is kept. */
export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    lastFetchedAt: ts("last_fetched_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [unique("calendar_feeds_token_uq").on(t.tokenHash), uniqueIndex("calendar_feeds_active_uq").on(t.customerId).where(sql`${t.revokedAt} is null`)],
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
    /** The phone operator answered: after hours, nobody picked up, or the shop has it answer first. */
    operator: boolean("operator").notNull().default(false),
    /** What the caller chose from the operator's menu (OperatorChoice in src/domain/phone-operator.ts). */
    operatorChoice: text("operator_choice"),
    createdAt: createdAt(),
    endedAt: ts("ended_at"),
    /** Someone at the shop followed up on the call (rang back, texted, booked them). */
    followedUpAt: ts("followed_up_at"),
    followedUpBy: uuid("followed_up_by").references(() => staff.id, { onDelete: "set null" }),
    followUpNote: text("follow_up_note"),
  },
  (t) => [index("call_logs_phone_idx").on(t.phone, t.createdAt), index("call_logs_shop_idx").on(t.shopId, t.createdAt)],
);

export type TranscriptSpeaker = "agent" | "caller" | "line";

/** A call's transcript, in order: what the phone agent said, what the caller pressed or said, and what the line did. */
export const callTranscriptLines = pgTable(
  "call_transcript_lines",
  {
    id: id(),
    callLogId: uuid("call_log_id")
      .notNull()
      .references(() => callLogs.id, { onDelete: "cascade" }),
    n: bigint("n", { mode: "number" }).generatedAlwaysAsIdentity(),
    speaker: text("speaker").$type<TranscriptSpeaker>().notNull(),
    text: text("text").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("call_transcript_lines_call_idx").on(t.callLogId, t.n)],
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

/** One row per person per day the earlier morning digest went to; kept for history, superseded by morning_dashboard_sends. */
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

/**
 * One row per person, day, version and channel of the Morning Dashboard: "all" for the
 * all-locations email, or a shop id for a single-shop one. A row stuck in "building" (a run that
 * died before queuing) can be claimed again after a few minutes, so the job is safe to rerun.
 */
export const morningDashboardSends = pgTable(
  "morning_dashboard_sends",
  {
    date: date("date").notNull(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    channel: text("channel").$type<"email" | "sms">().notNull(),
    status: text("status").$type<"building" | "queued" | "skipped">().notNull().default("building"),
    /** The day the numbers are for: the last day before `date` a shop was open. */
    reportDate: date("report_date"),
    jobId: uuid("job_id"),
    claimedAt: ts("claimed_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.date, t.staffId, t.scope, t.channel] }),
    check("morning_dashboard_sends_channel", sql`${t.channel} in ('email', 'sms')`),
    check("morning_dashboard_sends_status", sql`${t.status} in ('building', 'queued', 'skipped')`),
  ],
);

// ───────────────────────────── Custom reports ─────────────────────────────

/** A person's named filters for one report (dates, shops, barbers, options), as its query string; shared ones show for everyone who can open the report. */
/** A named week of shifts (TemplateRow in src/domain/bulk-edit.ts), applied to many barbers at one shop from Bulk edit. */
export const scheduleTemplates = pgTable(
  "schedule_templates",
  {
    id: id(),
    name: text("name").notNull(),
    rows: jsonb("rows").$type<{ weekday: number; startMin: number; endMin: number }[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("schedule_templates_name_uq").on(sql`lower(${t.name})`), check("schedule_templates_rows_array", sql`jsonb_typeof(${t.rows}) = 'array'`)  ],
);

/** A Stripe payout matched to the bank statement: who matched it, when, and the bank's reference. */
export const payoutReconciliations = pgTable(
  "payout_reconciliations",
  {
    id: id(),
    payoutId: uuid("payout_id")
      .notNull()
      .unique("payout_reconciliations_payout_uq")
      .references(() => shopPayouts.id, { onDelete: "cascade" }),
    bankReference: text("bank_reference"),
    note: text("note"),
    reconciledBy: uuid("reconciled_by").references(() => staff.id, { onDelete: "set null" }),
    reconciledAt: ts("reconciled_at").notNull().defaultNow(),
  },
  (t) => [check("payout_reconciliations_ref_len", sql`${t.bankReference} is null or length(${t.bankReference}) <= 60`)],
);

/** A membership plan, e.g. unlimited buzz cuts for a monthly price. The brand's; sold at the shops in shopIds (every shop when empty). */
export const membershipPlans = pgTable(
  "membership_plans",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    /** Services a visit covers in full. */
    serviceIds: uuid("service_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Covered visits per billing month; null is unlimited. */
    visitsPerPeriod: integer("visits_per_period"),
    /** Off retail on members' tickets. */
    productDiscountPct: integer("product_discount_pct").notNull().default(0),
    shopIds: uuid("shop_ids").array().notNull().default(sql`'{}'::uuid[]`),
    active: boolean("active").notNull().default(true),
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("membership_plans_name_uq").on(sql`lower(${t.name})`),
    check("membership_plans_name", sql`length(trim(${t.name})) between 1 and 60`),
    check("membership_plans_price", sql`${t.priceCents} between 100 and 100000`),
    check("membership_plans_visits", sql`${t.visitsPerPeriod} is null or ${t.visitsPerPeriod} between 1 and 31`),
    check("membership_plans_product_pct", sql`${t.productDiscountPct} between 0 and 50`),
  ],
);

export type MembershipStatus = "incomplete" | "active" | "past_due" | "canceled";

/** A client on a plan. Billing "stripe" is a Stripe Billing subscription; "simulated" renews itself with no card (no Stripe keys). */
export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => membershipPlans.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    homeShopId: uuid("home_shop_id")
      .notNull()
      .references(() => shops.id),
    status: text("status").$type<MembershipStatus>().notNull().default("active"),
    billing: text("billing").$type<"simulated" | "stripe">().notNull().default("simulated"),
    /** The plan's price when they joined; a later price change doesn't reach existing members. */
    priceCents: integer("price_cents").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    /** Stripe's hosted sign-up page, until the client has paid the first month. */
    stripeCheckoutUrl: text("stripe_checkout_url"),
    currentPeriodStart: date("current_period_start").notNull(),
    currentPeriodEnd: date("current_period_end").notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: ts("canceled_at"),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("memberships_live_uq").on(t.customerId, t.planId).where(sql`${t.status} <> 'canceled'`),
    index("memberships_customer_idx").on(t.customerId),
    index("memberships_shop_idx").on(t.homeShopId, t.status),
    check("memberships_status", sql`${t.status} in ('incomplete', 'active', 'past_due', 'canceled')`),
    check("memberships_billing", sql`${t.billing} in ('simulated', 'stripe')`),
    check("memberships_period", sql`${t.currentPeriodEnd} > ${t.currentPeriodStart}`),
  ],
);

export const membershipInvoices = pgTable(
  "membership_invoices",
  {
    id: id(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").$type<"paid" | "failed">().notNull(),
    stripeInvoiceId: text("stripe_invoice_id").unique(),
    failureMessage: text("failure_message"),
    createdAt: createdAt(),
  },
  (t) => [unique("membership_invoices_period_uq").on(t.membershipId, t.periodStart, t.status), check("membership_invoices_status", sql`${t.status} in ('paid', 'failed')`)],
);

/** Covered visits rung up at checkout. A voided or fully refunded ticket gives its visits back. */
export const membershipUses = pgTable(
  "membership_uses",
  {
    id: id(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id),
    periodStart: date("period_start").notNull(),
    visits: integer("visits").notNull(),
    valueCents: integer("value_cents").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("membership_uses_sale_uq").on(t.membershipId, t.saleId), index("membership_uses_period_idx").on(t.membershipId, t.periodStart), check("membership_uses_visits", sql`${t.visits} >= 0`)],
);

export const reportViews = pgTable(
  "report_views",
  {
    id: id(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    report: text("report").notNull(),
    name: text("name").notNull(),
    query: text("query").notNull(),
    shared: boolean("shared").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("report_views_report_idx").on(t.report, t.ownerId),
    check("report_views_name", sql`length(trim(${t.name})) between 1 and 60`),
    check("report_views_query", sql`length(${t.query}) <= 2000`),
  ],
);

/**
 * A report built in the report builder: its data source and definition (ReportDefinition in
 * src/domain/report-builder.ts). Private to its owner, shared with roles, or a brand template
 * everyone with "open saved reports" sees. Whoever opens it gets it under their own access: their
 * locations, their barbers, client details as they see them.
 */
export const savedReports = pgTable(
  "saved_reports",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description"),
    source: text("source").notNull().default("customers"),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    visibility: text("visibility").$type<"private" | "roles" | "template">().notNull().default("private"),
    /** Roles it's shared with, when visibility is "roles". */
    roleIds: jsonb("role_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** ReportSchedule in src/domain/report-builder.ts, or null for none. */
    schedule: jsonb("schedule").$type<Record<string, unknown>>(),
    /** Listed in the owner's (and the recipients') Morning Dashboard. */
    morning: boolean("morning").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("saved_reports_owner_idx").on(t.ownerId),
    check("saved_reports_visibility", sql`${t.visibility} in ('private', 'roles', 'template')`),
    check("saved_reports_source", sql`${t.source} in ('customers', 'sales', 'appointments', 'staff', 'inventory', 'tips', 'campaigns')`),
  ],
);

/** One row per scheduled report, recipient and period, so a send goes out once even when the cron reruns. */
export const savedReportSends = pgTable(
  "saved_report_sends",
  {
    reportId: uuid("report_id")
      .notNull()
      .references(() => savedReports.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    /** The day it's due, YYYY-MM-DD. */
    period: date("period").notNull(),
    status: text("status").$type<"building" | "queued" | "skipped">().notNull().default("building"),
    rows: integer("rows"),
    jobId: uuid("job_id"),
    claimedAt: ts("claimed_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.staffId, t.period] }),
    check("saved_report_sends_status", sql`${t.status} in ('building', 'queued', 'skipped')`),
  ],
);

// ───────────────────────────── Rayz Assistant ─────────────────────────────

/** One person's chat with the assistant. Only they can open it. */
export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("assistant_conversations_staff_idx").on(t.staffId, t.updatedAt)],
);

/**
 * A question or an answer. Answers keep what was shown (the text, the cards with their numbers and
 * links, the tools called) but not the tool results the model read. Questions are counted for the limits.
 */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    body: text("body").notNull(),
    /** AssistantCard[] in src/domain/assistant.ts. */
    cards: jsonb("cards").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** The tools called for this answer: name, arguments, whether they worked. */
    tools: jsonb("tools").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("assistant_messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("assistant_messages_staff_idx").on(t.staffId, t.createdAt),
    check("assistant_messages_role", sql`${t.role} in ('user', 'assistant')`),
  ],
);

export type AssistantActionKind = "draft_blast" | "draft_po";
export type AssistantActionStatus = "pending" | "confirmed" | "cancelled" | "failed";

/** A blast or purchase order the assistant drafted. Nothing is created until the person confirms it, with their permissions checked again then. */
export const assistantActions = pgTable(
  "assistant_actions",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AssistantActionKind>().notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    summary: text("summary").notNull(),
    status: text("status").$type<AssistantActionStatus>().notNull().default("pending"),
    /** What confirming made: the blast or the purchase orders, with links. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [
    index("assistant_actions_staff_idx").on(t.staffId, t.createdAt),
    check("assistant_actions_kind", sql`${t.kind} in ('draft_blast', 'draft_po')`),
    check("assistant_actions_status", sql`${t.status} in ('pending', 'confirmed', 'cancelled', 'failed')`),
  ],
);

// ───────────────────────────── Campaign Center ─────────────────────────────

export type CampaignKind = "trigger" | "blast" | "sequence" | "openings";
/**
 * Openings blasts can also wait for the brand ("pending_approval"), be turned down, or expire when
 * their times pass first. Recurring blasts can be paused; an A/B-tested blast is "testing" while
 * its test groups have it and the rest wait for the winner.
 */
export type BlastStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled" | "pending_approval" | "rejected" | "expired" | "paused" | "testing";
export type CampaignType = "update" | "promotion";

/** The brand's approved wording (Templates in src/domain/marketing.ts) for new blasts to start from. */
export const marketingTemplates = pgTable(
  "marketing_templates",
  {
    id: id(),
    name: text("name").notNull(),
    campaignType: text("campaign_type").$type<CampaignType>().notNull().default("update"),
    description: text("description"),
    channels: jsonb("channels").$type<string[]>().notNull().default(sql`'["sms","email","push"]'::jsonb`),
    templates: jsonb("templates").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").$type<"draft" | "approved" | "archived">().notNull().default("draft"),
    approvedBy: uuid("approved_by").references(() => staff.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    /** "milestone": the wording offered from a barber's milestone for their clients to celebrate with them. */
    purpose: text("purpose").$type<"milestone">(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("marketing_templates_status_idx").on(t.status, t.name)],
);

/**
 * A marketing campaign: one brand-level row per automated trigger (switched on per location in
 * marketing_location_settings), a one-off blast to a segment, a lapsed sequence (its steps in
 * marketing_steps, its barbers in segment, its locations in shop_ids), or one location's "We have
 * openings" for one barber (its barber, days and filter in segment, OpeningsSegment). Wording,
 * settings and segment are jsonb (Templates, trigger and sequence settings, Segment and
 * SequenceAudience in src/domain/marketing.ts).
 */
/**
 * Images uploaded for marketing emails (the header image), served at /mi/<id> to anyone with the
 * link, since email clients fetch them. Never changed under its ID: a refined or replaced image
 * is a new row, so a sent email keeps the picture it went out with.
 */
export const marketingImages = pgTable("marketing_images", {
  id: id(),
  dataUrl: text("data_url").notNull(),
  alt: text("alt"),
  width: integer("width"),
  height: integer("height"),
  /** The image this one was refined from (cropped or enhanced in the editor). */
  sourceId: uuid("source_id"),
  createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

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
    /** Openings blasts the brand approves first: who approved or turned it down, and why. */
    reviewedBy: uuid("reviewed_by").references(() => staff.id, { onDelete: "set null" }),
    reviewedAt: ts("reviewed_at"),
    reviewNote: text("review_note"),
    /** Blasts: a quick update (no offer) or a promotion (with a coupon). */
    campaignType: text("campaign_type").$type<CampaignType>(),
    /** Blasts: repeats (Recurrence in src/domain/campaign-schedule.ts); null is one time. */
    recurrence: jsonb("recurrence").$type<Record<string, unknown>>(),
    /** Blasts: an A/B test of the wording (AbTest in src/domain/campaign-schedule.ts). */
    ab: jsonb("ab").$type<Record<string, unknown>>(),
    /** This share of eligible clients gets nothing, to measure lift against. */
    holdoutPct: integer("holdout_pct").notNull().default(0),
    /** Each client's message waits for the time of day they usually book. */
    sendTimeOpt: boolean("send_time_opt").notNull().default(false),
    templateId: uuid("template_id").references(() => marketingTemplates.id, { onDelete: "set null" }),
    /** Drafted by the assistant: it can only be scheduled or sent from the review step, by a person. */
    aiDrafted: boolean("ai_drafted").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("marketing_campaigns_trigger_uq").on(t.trigger).where(sql`${t.kind} = 'trigger'`),
    index("marketing_campaigns_due_idx").on(t.status, t.scheduledAt),
    index("marketing_campaigns_kind_idx").on(t.kind, t.createdAt),
  ],
);

export type OpeningsWaitlistStatus = "waiting" | "texted" | "removed";

/**
 * "All booked, join the waitlist" on an openings blast's live page: a first name and a mobile
 * number, for the location to text when a time with that barber opens up. Staff see the first
 * name, never the number; texts go through the system.
 */
export const openingsWaitlist = pgTable(
  "openings_waitlist",
  {
    id: id(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    phone: text("phone").notNull(),
    wantsDate: date("wants_date"),
    status: text("status").$type<OpeningsWaitlistStatus>().notNull().default("waiting"),
    textedAt: ts("texted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("openings_waitlist_phone_uq").on(t.campaignId, t.phone),
    index("openings_waitlist_shop_idx").on(t.shopId, t.status, t.createdAt),
    check("openings_waitlist_status_chk", sql`${t.status} in ('waiting', 'texted', 'removed')`),
  ],
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

/** holdout: the client was eligible and held back on purpose, to compare against. */
export type SendStatus = "queued" | "skipped" | "test" | "holdout";

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
    /** Emails: tracking-pixel loads (not mail scanners), and the first. */
    opens: integer("opens").notNull().default(0),
    openedAt: ts("opened_at"),
    costCents: doublePrecision("cost_cents").notNull().default(0),
    /** Lapsed sequences: which step it was. */
    stepId: uuid("step_id").references(() => marketingSteps.id, { onDelete: "set null" }),
    /** A/B-tested blasts: the wording it got. */
    variant: text("variant").$type<"a" | "b">(),
    /** The client had an appointment coming up when it went, so what they spend isn't credited to it. */
    alreadyBooked: boolean("already_booked").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("marketing_sends_campaign_idx").on(t.campaignId, t.createdAt),
    index("marketing_sends_customer_idx").on(t.customerId, t.createdAt),
    index("marketing_sends_campaign_status_idx").on(t.campaignId, t.status),
  ],
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

/** Badges the brand builds from a client filter (CustomBadge in src/domain/badges.ts). */
export const customBadges = pgTable(
  "custom_badges",
  {
    id: id(),
    label: text("label").notNull(),
    tooltip: text("tooltip").notNull().default(""),
    icon: text("icon").notNull().default("tag"),
    tone: text("tone").notNull().default("blue"),
    /** A Segment (src/domain/marketing.ts). */
    filter: jsonb("filter").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [check("custom_badges_tone", sql`${t.tone} in ('gray', 'green', 'blue', 'amber', 'orange', 'red', 'violet')`)],
);

/**
 * Each client's badges as last computed (StoredBadge[] in src/domain/badges.ts), every one the
 * rules earn; who sees which is decided when they're read. Refreshed nightly and after checkout;
 * computed_on before today means stale.
 */
export const clientBadges = pgTable(
  "client_badges",
  {
    customerId: uuid("customer_id")
      .primaryKey()
      .references(() => customers.id, { onDelete: "cascade" }),
    keys: text("keys").array().notNull().default(sql`'{}'::text[]`),
    badges: jsonb("badges").$type<{ k: string; d?: Record<string, string | number> }[]>().notNull().default(sql`'[]'::jsonb`),
    /** Badge key to the day (shop time) it was earned. */
    since: jsonb("since").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** Visits, no-shows, streak and referrals, for progress meters. */
    progress: jsonb("progress").$type<{ visits: number; noShows: number; streak: number; referrals: number } | Record<string, never>>().notNull().default(sql`'{}'::jsonb`),
    hash: text("hash").notNull().default(""),
    computedOn: date("computed_on").notNull(),
    computedAt: ts("computed_at").notNull().defaultNow(),
    changedAt: ts("changed_at").notNull().defaultNow(),
  },
  (t) => [index("client_badges_keys_idx").using("gin", t.keys), index("client_badges_computed_idx").on(t.computedOn)],
);

/** A customer-visible badge a client earned or lost, waiting for (or done with) its Badge news message. */
export const clientBadgeNotices = pgTable(
  "client_badge_notices",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    badgeKey: text("badge_key").notNull(),
    change: text("change").$type<"earned" | "lost">().notNull(),
    occurredOn: date("occurred_on").notNull(),
    status: text("status").$type<"pending" | "queued" | "skipped">().notNull().default("pending"),
    reason: text("reason"),
    sendId: uuid("send_id").references(() => marketingSends.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    handledAt: ts("handled_at"),
  },
  (t) => [uniqueIndex("client_badge_notices_uq").on(t.customerId, t.badgeKey, t.change, t.occurredOn), index("client_badge_notices_pending_idx").on(t.status, t.createdAt)],
);

/**
 * The event log: one append-only row per meaningful action, written by triggers on the source
 * tables (drizzle/core_0059_analytics.sql) and by recordEvent for what only the app sees (the
 * booking funnel). Ids, numbers and short codes only; the README lists every event.
 */
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: ts("occurred_at").notNull(),
    recordedAt: ts("recorded_at").notNull().default(sql`clock_timestamp()`),
    businessDate: date("business_date").notNull(),
    event: text("event").notNull(),
    category: text("category").notNull(),
    shopId: uuid("shop_id"),
    actorKind: text("actor_kind").$type<"staff" | "client" | "system">().notNull(),
    actorStaffId: uuid("actor_staff_id"),
    staffId: uuid("staff_id"),
    customerId: uuid("customer_id"),
    channel: text("channel"),
    device: text("device"),
    source: text("source"),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    appointmentId: uuid("appointment_id"),
    saleId: uuid("sale_id"),
    amountCents: bigint("amount_cents", { mode: "number" }),
    quantity: integer("quantity"),
    minutes: doublePrecision("minutes"),
    value: doublePrecision("value"),
    subtype: text("subtype"),
    reason: text("reason"),
    props: jsonb("props").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    dedupeKey: text("dedupe_key").unique("analytics_events_dedupe_key"),
  },
  (t) => [
    index("analytics_events_day_idx").on(t.businessDate, t.event),
    index("analytics_events_shop_idx").on(t.shopId, t.businessDate),
    index("analytics_events_entity_idx").on(t.entity, t.entityId),
  ],
);

/** The optional 1-5 a client gives after a visit, asked of everyone alike (it never decides who is sent to Google). */
export const visitSatisfaction = pgTable(
  "visit_satisfaction",
  {
    id: id(),
    saleId: uuid("sale_id")
      .notNull()
      .unique("visit_satisfaction_sale_uq")
      .references(() => sales.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    stars: smallint("stars").notNull(),
    channel: text("channel").$type<"receipt" | "app">().notNull().default("receipt"),
    createdAt: createdAt(),
  },
  (t) => [check("visit_satisfaction_stars", sql`${t.stars} between 1 and 5`), index("visit_satisfaction_shop_idx").on(t.shopId, t.createdAt)],
);

/** Each copy of new events to the brand's warehouse. The warehouse address is an environment secret, never stored. */
export const analyticsExports = pgTable("analytics_exports", {
  id: id(),
  target: text("target").notNull(),
  fromId: bigint("from_id", { mode: "number" }).notNull(),
  toId: bigint("to_id", { mode: "number" }).notNull(),
  rows: integer("rows").notNull().default(0),
  status: text("status").$type<"running" | "done" | "failed">().notNull().default("running"),
  failure: text("failure"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

/** Client merges and erasures the warehouse copy still has to apply (it has the old client id). */
export const analyticsCustomerMoves = pgTable("analytics_customer_moves", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  fromCustomer: uuid("from_customer").notNull(),
  toCustomer: uuid("to_customer"),
  createdAt: createdAt(),
});

/** A checkout prompt switched on or off for one location, one role or one barber's tickets; the brand default is brand_settings.checkout_prompts. */
export const checkoutPromptRules = pgTable(
  "checkout_prompt_rules",
  {
    id: id(),
    prompt: text("prompt").$type<"rebook" | "product">().notNull(),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    check("checkout_prompt_rules_prompt", sql`${t.prompt} in ('rebook', 'product')`),
    check("checkout_prompt_rules_one_target", sql`num_nonnulls(${t.shopId}, ${t.roleId}, ${t.staffId}) = 1`),
    unique("checkout_prompt_rules_uq").on(t.prompt, t.shopId, t.roleId, t.staffId).nullsNotDistinct(),
  ],
);

/** The brand's products for a service, suggested at checkout whenever the service is on the ticket. */
export const serviceProductSuggestions = pgTable(
  "service_product_suggestions",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(100),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().default(sql`clock_timestamp()`),
  },
  (t) => [primaryKey({ name: "service_product_suggestions_pk", columns: [t.serviceId, t.productId] })],
);

/** Products the barber used in the service, tagged on the ticket (not sold, so no stock moves). */
export const saleUsedProducts = pgTable(
  "sale_used_products",
  {
    id: id(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    taggedBy: uuid("tagged_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().default(sql`clock_timestamp()`),
  },
  (t) => [unique("sale_used_products_uq").on(t.saleId, t.productId)],
);

/** A reminder to book, asked for at checkout when the client didn't book there; dropped once they have. */
export const rebookReminders = pgTable(
  "rebook_reminders",
  {
    id: id(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    saleId: uuid("sale_id").references(() => sales.id, { onDelete: "set null" }),
    runAt: ts("run_at").notNull(),
    status: text("status").$type<"scheduled" | "sent" | "cancelled" | "skipped">().notNull().default("scheduled"),
    outcome: text("outcome").$type<"booked" | "no_contact" | "cancelled" | "queued">(),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().default(sql`clock_timestamp()`),
    sentAt: ts("sent_at"),
  },
  (t) => [
    check("rebook_reminders_status", sql`${t.status} in ('scheduled', 'sent', 'cancelled', 'skipped')`),
    check("rebook_reminders_outcome", sql`${t.outcome} is null or ${t.outcome} in ('booked', 'no_contact', 'cancelled', 'queued')`),
    index("rebook_reminders_due_idx").on(t.status, t.runAt),
    index("rebook_reminders_customer_idx").on(t.customerId),
  ],
);

/** One prompt shown on one ticket: what it suggested (CheckoutPromptSuggested) and how staff answered it. */
export const checkoutPrompts = pgTable(
  "checkout_prompts",
  {
    id: id(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    prompt: text("prompt").$type<"rebook" | "product">().notNull(),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    required: boolean("required").notNull().default(false),
    suggested: jsonb("suggested").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    shownBy: uuid("shown_by").references(() => staff.id, { onDelete: "set null" }),
    shownAt: ts("shown_at").notNull().default(sql`clock_timestamp()`),
    outcome: text("outcome").$type<"accepted" | "declined">(),
    /** Paid without an answer, so declined by default. */
    skipped: boolean("skipped").notNull().default(false),
    answeredBy: uuid("answered_by").references(() => staff.id, { onDelete: "set null" }),
    answeredAt: ts("answered_at"),
    declineReason: text("decline_reason"),
    bookedAppointmentIds: uuid("booked_appointment_ids").array().notNull().default(sql`'{}'::uuid[]`),
    addedProductIds: uuid("added_product_ids").array().notNull().default(sql`'{}'::uuid[]`),
    paidProductIds: uuid("paid_product_ids").array().notNull().default(sql`'{}'::uuid[]`),
    paidProductCents: integer("paid_product_cents").notNull().default(0),
    reminderId: uuid("reminder_id").references(() => rebookReminders.id, { onDelete: "set null" }),
  },
  (t) => [
    check("checkout_prompts_prompt", sql`${t.prompt} in ('rebook', 'product')`),
    check("checkout_prompts_outcome", sql`${t.outcome} is null or ${t.outcome} in ('accepted', 'declined')`),
    check("checkout_prompts_answered", sql`(${t.outcome} is null) = (${t.answeredAt} is null)`),
    check("checkout_prompts_reason", sql`${t.declineReason} is null or char_length(${t.declineReason}) <= 120`),
    unique("checkout_prompts_uq").on(t.saleId, t.prompt),
    index("checkout_prompts_shop_idx").on(t.shopId, t.shownAt),
  ],
);

// ───────────────────────────── Scale: background tasks and rollups ─────────────────────────────

/**
 * Background work split into small tasks so it grows with the number of locations: one per
 * location (rollups, campaign triggers) or per client bucket (badges) and day. Any number of
 * workers claim tasks with FOR UPDATE SKIP LOCKED; a lease that runs out puts a crashed task back.
 */
export const jobTasks = pgTable(
  "job_tasks",
  {
    id: id(),
    kind: text("kind").notNull(),
    /** What the task covers: a shop id, a shop and slot ("<id>|14:30"), or a bucket ("3/16"). */
    shard: text("shard").notNull(),
    runOn: date("run_on").notNull(),
    status: text("status").$type<JobTaskStatus>().notNull().default("queued"),
    attempts: smallint("attempts").notNull().default(0),
    lockedUntil: ts("locked_until"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("job_tasks_uq").on(t.kind, t.shard, t.runOn),
    index("job_tasks_claim_idx").on(t.status, t.lockedUntil),
    check("job_tasks_status", sql`${t.status} in ('queued', 'running', 'done', 'failed')`),
  ],
);
export type JobTaskStatus = "queued" | "running" | "done" | "failed";

/**
 * One location's day, summed by the rollup job from sales, refunds and appointments, so brand
 * reports compare 50+ locations and regions without scanning every ticket. The region is the
 * location's at the time the day was rolled up.
 */
export const locationDailyStats = pgTable(
  "location_daily_stats",
  {
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    regionId: uuid("region_id").references(() => regions.id, { onDelete: "set null" }),
    tickets: integer("tickets").notNull().default(0),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull().default(0),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    serviceNetCents: bigint("service_net_cents", { mode: "number" }).notNull().default(0),
    productNetCents: bigint("product_net_cents", { mode: "number" }).notNull().default(0),
    refundCents: bigint("refund_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    tipCents: bigint("tip_cents", { mode: "number" }).notNull().default(0),
    clients: integer("clients").notNull().default(0),
    newClients: integer("new_clients").notNull().default(0),
    appointments: integer("appointments").notNull().default(0),
    noShows: integer("no_shows").notNull().default(0),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.day] }),
    index("location_daily_stats_day_idx").on(t.day),
    index("location_daily_stats_region_day_idx").on(t.regionId, t.day),
  ],
);

// ───────────────────────────── Staff milestones ─────────────────────────────

/**
 * What counts as a staff milestone: the built-in counts, anniversaries, birthdays, personal bests
 * and streaks (key set, kind and metric fixed), and the brand's own. Kinds and metrics are in
 * src/domain/milestones.ts.
 */
export const staffMilestoneRules = pgTable("staff_milestone_rules", {
  id: id(),
  /** Built-in rules only. */
  key: text("key").unique(),
  kind: text("kind").$type<"count" | "anniversary" | "birthday" | "best" | "streak">().notNull(),
  metric: text("metric").notNull(),
  name: text("name").notNull(),
  /** Counts and streaks: what the number is of, plural ("cuts", "fades"). */
  unit: text("unit"),
  /** Counts and streaks: the numbers to reach; anniversaries: the years. */
  thresholds: jsonb("thresholds").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  /** Cuts and services only: count just these services; empty is every service. */
  serviceIds: jsonb("service_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  active: boolean("active").notNull().default(true),
  builtIn: boolean("built_in").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(100),
  createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** A person's total from before the history in the system (Squire's own counts): the metric is this plus everything on or after as_of. */
export const staffMilestoneBaselines = pgTable(
  "staff_milestone_baselines",
  {
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    count: integer("count").notNull(),
    asOf: date("as_of").notNull(),
    setBy: uuid("set_by").references(() => staff.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.metric] })],
);

/**
 * One milestone a person reached, once (dedupe_key). Silent ones were found after the fact (history,
 * a baseline, a first record) and are kept for the trophy case without an alert.
 */
export const staffMilestones = pgTable(
  "staff_milestones",
  {
    id: id(),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => staffMilestoneRules.id, { onDelete: "set null" }),
    kind: text("kind").$type<"count" | "anniversary" | "birthday" | "best" | "streak">().notNull(),
    metric: text("metric").notNull(),
    /** Counts and streaks: the number reached; anniversaries: the years. */
    threshold: integer("threshold"),
    /** Personal bests: the record (cents, cuts, or rebook rate in tenths of a percent). */
    value: bigint("value", { mode: "number" }),
    /** Personal bests: the record it beat. */
    previous: bigint("previous", { mode: "number" }),
    /** Personal bests: the day, the week's Sunday, or the month (YYYY-MM). */
    period: text("period"),
    achievedOn: date("achieved_on").notNull(),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "set null" }),
    /** As it read when reached, for the history when the rule changes. */
    title: text("title").notNull(),
    silent: boolean("silent").notNull().default(false),
    dedupeKey: text("dedupe_key").notNull().unique(),
    notifiedAt: ts("notified_at"),
    /** When they dismissed the congratulations. */
    seenAt: ts("seen_at"),
    createdAt: createdAt(),
  },
  (t) => [index("staff_milestones_staff_idx").on(t.staffId, t.achievedOn), index("staff_milestones_date_idx").on(t.achievedOn)],
);

/** A teammate's cheer on a milestone in the team feed, with an optional short message (scrubbed by trigger). */
export const staffMilestoneCheers = pgTable(
  "staff_milestone_cheers",
  {
    milestoneId: uuid("milestone_id")
      .notNull()
      .references(() => staffMilestones.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    message: text("message"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.milestoneId, t.staffId] })],
);

// ───────────────────────────── Brand change scope ─────────────────────────────

/**
 * A shop's inheritance of one brand-controlled setting ("<type>:<item>", src/domain/brand-sync.ts):
 * following the brand ("inherit", which shows out of sync while its value differs) or its own value
 * ("override"). `local` holds the shop's value for settings only the brand stored before (checkout
 * prompts, milestones, loyalty rules, campaign templates, roles, app config); null follows the brand.
 * No row: worked out from the shop's value, so shops from before this keep what they had.
 */
export const shopSyncState = pgTable(
  "shop_sync_state",
  {
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    mode: text("mode").$type<"inherit" | "override">().notNull().default("inherit"),
    local: jsonb("local"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "shop_sync_state_pk", columns: [t.shopId, t.key] }),
    index("shop_sync_state_key_idx").on(t.key),
    check("shop_sync_state_mode", sql`${t.mode} in ('inherit', 'override')`),
  ],
);

/** Brand values for settings that were only ever set per shop: the hours template, tax rates and receipt branding. */
export const brandSyncValues = pgTable("brand_sync_values", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
});

export type BrandSyncBatchKind = "apply" | "push" | "reset" | "rollback";
export type BrandSyncBatchStatus = "applied" | "scheduled" | "cancelled" | "rolled_back" | "failed";

/**
 * One brand change and where it went: saved from a brand editor ("apply"), the Sync status bulk
 * actions ("push", "reset") or an undo ("rollback"). A scheduled one keeps what to do in `plan` and
 * is worked out again when it runs. `brand` holds the brand values before and after.
 */
export const brandSyncBatches = pgTable(
  "brand_sync_batches",
  {
    id: id(),
    kind: text("kind").$type<BrandSyncBatchKind>().notNull(),
    label: text("label").notNull(),
    status: text("status").$type<BrandSyncBatchStatus>().notNull(),
    runAt: ts("run_at"),
    appliedAt: ts("applied_at"),
    createdBy: uuid("created_by").references(() => staff.id, { onDelete: "set null" }),
    createdByLabel: text("created_by_label").notNull(),
    scope: text("scope").$type<"all" | "selected" | "brand_only">().notNull().default("all"),
    shopIds: uuid("shop_ids").array().notNull().default(sql`'{}'::uuid[]`),
    keys: text("keys").array().notNull().default(sql`'{}'::text[]`),
    brand: jsonb("brand").$type<{ key: string; from: unknown; to: unknown }[]>().notNull().default(sql`'[]'::jsonb`),
    plan: jsonb("plan"),
    error: text("error"),
    rolledBackAt: ts("rolled_back_at"),
    rolledBackBy: text("rolled_back_by"),
    rollbackOf: uuid("rollback_of").references((): AnyPgColumn => brandSyncBatches.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("brand_sync_batches_created_idx").on(t.createdAt),
    index("brand_sync_batches_due_idx").on(t.runAt).where(sql`${t.status} = 'scheduled'`),
    check("brand_sync_batches_kind", sql`${t.kind} in ('apply', 'push', 'reset', 'rollback')`),
    check("brand_sync_batches_status", sql`${t.status} in ('applied', 'scheduled', 'cancelled', 'rolled_back', 'failed')`),
    check("brand_sync_batches_scope", sql`${t.scope} in ('all', 'selected', 'brand_only')`),
    check("brand_sync_batches_run_at", sql`${t.status} <> 'scheduled' or ${t.runAt} is not null`),
  ],
);

/** What one sync did at one shop to one setting, with its state before and after, for the history and rollback. */
export const brandSyncChanges = pgTable(
  "brand_sync_changes",
  {
    id: id(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => brandSyncBatches.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    action: text("action").$type<"push" | "replace" | "keep" | "freeze" | "reset" | "restore">().notNull(),
    from: jsonb("from").notNull(),
    to: jsonb("to").notNull(),
  },
  (t) => [
    index("brand_sync_changes_batch_idx").on(t.batchId),
    index("brand_sync_changes_shop_idx").on(t.shopId, t.key),
    check("brand_sync_changes_action", sql`${t.action} in ('push', 'replace', 'keep', 'freeze', 'reset', 'restore')`),
  ],
);

/** Whether shop managers may change their shop's own value of a brand-controlled setting. No row: they can't. */
export const brandSyncControls = pgTable("brand_sync_controls", {
  type: text("type").primaryKey(),
  shopsCanEdit: boolean("shops_can_edit").notNull().default(false),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
});
