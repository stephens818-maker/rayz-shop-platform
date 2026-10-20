import { sql } from "drizzle-orm";
import {
  boolean,
  date,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const staffRole = pgEnum("staff_role", ["brand_admin", "shop_manager", "barber"]);
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

// ───────────────────────────── Brand & shops ─────────────────────────────

export const brandSettings = pgTable("brand_settings", {
  id: smallint("id").primaryKey().default(1),
  name: text("name").notNull().default("Ray'z Barber Shop"),
  loyalty: jsonb("loyalty").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const shops = pgTable("shops", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  zip: text("zip").notNull().default(""),
  phone: text("phone"),
  email: text("email"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  active: boolean("active").notNull().default(true),
  bookingEnabled: boolean("booking_enabled").notNull().default(true),
  /** Fractions (0.07 = 7%). Configured per shop; never hard-coded. */
  serviceTaxRate: numeric("service_tax_rate", { precision: 7, scale: 5 }).notNull().default("0"),
  productTaxRate: numeric("product_tax_rate", { precision: 7, scale: 5 }).notNull().default("0"),
  taxRatesVerified: boolean("tax_rates_verified").notNull().default(false),
  cardFeeEnabled: boolean("card_fee_enabled").notNull().default(true),
  cardFeeRate: numeric("card_fee_rate", { precision: 6, scale: 5 }).notNull().default("0.03"),
  cardFeeAppliesToTip: boolean("card_fee_applies_to_tip").notNull().default(false),
  cardFeeMode: text("card_fee_mode").notNull().default("surcharge"),
  tipPresets: jsonb("tip_presets").$type<number[]>().notNull().default(sql`'[20,25,30]'::jsonb`),
  cancelCutoffMinutes: integer("cancel_cutoff_minutes").notNull().default(30),
  slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
  minLeadMinutes: integer("min_lead_minutes").notNull().default(15),
  bookingWindowDays: integer("booking_window_days").notNull().default(60),
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  description: text("description"),
  createdAt: createdAt(),
});

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
  role: staffRole("role").notNull().default("barber"),
  /** Shop managers are scoped to exactly this shop. */
  managerShopId: uuid("manager_shop_id").references(() => shops.id),
  isBookable: boolean("is_bookable").notNull().default(true),
  active: boolean("active").notNull().default(true),
  passwordHash: text("password_hash"),
  squireName: text("squire_name"),
  createdAt: createdAt(),
});

export const staffShops = pgTable(
  "staff_shops",
  {
    staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    visibleOnline: boolean("visible_online").notNull().default(true),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.shopId] })],
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
    reason: text("reason").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("time_blocks_staff_time_idx").on(t.staffId, t.startsAt)],
);

// ───────────────────────────── Catalog ─────────────────────────────

export const services = pgTable("services", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: serviceKind("kind").notNull().default("service"),
  category: text("category").notNull().default("Haircuts"),
  description: text("description"),
  defaultPriceCents: integer("default_price_cents").notNull(),
  defaultDurationMin: integer("default_duration_min").notNull(),
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

export const products = pgTable("products", {
  id: id(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  category: text("category").notNull().default("Styling"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const shopProducts = pgTable(
  "shop_products",
  {
    shopId: uuid("shop_id").notNull().references(() => shops.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    costCents: integer("cost_cents").notNull(),
    priceCents: integer("price_cents").notNull(),
    stock: integer("stock").notNull().default(0),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(3),
    active: boolean("active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.productId] })],
);

export const inventoryAdjustments = pgTable("inventory_adjustments", {
  id: id(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  productId: uuid("product_id").notNull().references(() => products.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(), // sale | refund | receive | count | damage
  saleId: uuid("sale_id"),
  staffId: uuid("staff_id"),
  createdAt: createdAt(),
});

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
    notes: text("notes"),
    smsOptIn: boolean("sms_opt_in").notNull().default(true),
    emailOptIn: boolean("email_opt_in").notNull().default(true),
    squireId: text("squire_id"),
    homeShopId: uuid("home_shop_id").references(() => shops.id),
    createdAt: createdAt(),
  },
  (t) => [
    // Not unique: Squire data has families sharing one phone number.
    index("customers_phone_idx").on(t.phone),
    index("customers_email_idx").on(t.email),
    uniqueIndex("customers_squire_uq").on(t.squireId),
    index("customers_name_idx").on(t.firstName, t.lastName),
  ],
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
    status: appointmentStatus("status").notNull().default("booked"),
    source: appointmentSource("source").notNull().default("online"),
    anyBarber: boolean("any_barber").notNull().default(false),
    estimateCents: integer("estimate_cents").notNull().default(0),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key").unique(),
    rebookedFromId: uuid("rebooked_from_id"),
    squireId: text("squire_id").unique(),
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
    createdAt: createdAt(),
  },
  (t) => [index("payments_shop_date_idx").on(t.shopId, t.businessDate), index("payments_sale_idx").on(t.saleId)],
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
    stripeRefundId: text("stripe_refund_id"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("refunds_shop_date_idx").on(t.shopId, t.businessDate)],
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
    kind: text("kind").notNull(), // confirmation | reminder_24h | reminder_2h | cancellation | reschedule | otp | waitlist_ready
    channel: text("channel").notNull(), // sms | email
    to: text("to").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    runAt: ts("run_at").notNull(),
    status: notificationStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    provider: text("provider"),
    lastError: text("last_error"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notification_jobs_due_idx").on(t.status, t.runAt), index("notification_jobs_appt_idx").on(t.appointmentId)],
);

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

export const importRuns = pgTable("import_runs", {
  id: id(),
  kind: text("kind").notNull(),
  filename: text("filename"),
  dryRun: boolean("dry_run").notNull().default(false),
  totalRows: integer("total_rows").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errors: jsonb("errors").$type<{ row: number; message: string }[]>().notNull().default(sql`'[]'::jsonb`),
  staffId: uuid("staff_id"),
  createdAt: createdAt(),
});

export type Shop = typeof shops.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Sale = typeof sales.$inferSelect;
