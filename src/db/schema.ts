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
  tipPresets: jsonb("tip_presets").$type<number[]>().notNull().default(sql`'[20,25,30]'::jsonb`),
  cancelCutoffMinutes: integer("cancel_cutoff_minutes").notNull().default(30),
  slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
  minLeadMinutes: integer("min_lead_minutes").notNull().default(15),
  bookingWindowDays: integer("booking_window_days").notNull().default(60),
  bufferMinutes: integer("buffer_minutes").notNull().default(0),
  description: text("description"),
  /** block: a sale or adjustment that would take on-hand below zero is refused. warn: it goes through with a warning. */
  negativeStock: text("negative_stock").$type<NegativeStockPolicy>().notNull().default("block"),
  /** Where low-stock alerts go. Falls back to the shop email. */
  inventoryAlertEmail: text("inventory_alert_email"),
  createdAt: createdAt(),
});
export type NegativeStockPolicy = "block" | "warn";

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
    level: text("level").$type<"hidden" | "masked" | "full">().notNull(),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "cascade" }),
    updatedBy: uuid("updated_by").references(() => staff.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("client_field_rules_uq").on(t.field, t.roleId, t.staffId, t.shopId).nullsNotDistinct(), index("client_field_rules_staff_idx").on(t.staffId), index("client_field_rules_role_idx").on(t.roleId)],
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
    /** The shop's buffer when booked. The chair is held until ends_at + buffer. */
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    /** Set by a trigger (ends_at + buffer_minutes); the no-double-booking constraint covers [starts_at, busy_until). */
    busyUntil: ts("busy_until"),
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
    createdAt: createdAt(),
  },
  (t) => [
    index("payments_shop_date_idx").on(t.shopId, t.businessDate),
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
    /** The shop the message is from. Only sign-in codes, which are brand-level, have none. */
    shopId: uuid("shop_id").references(() => shops.id),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    kind: text("kind").notNull(), // confirmation | reminder_24h | reminder_2h | cancellation | reschedule | otp | waitlist_ready | purchase_order | low_stock | staff_text | staff_call | privacy_alert
    channel: text("channel").notNull(), // sms | email | voice
    to: text("to").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    attachments: jsonb("attachments").$type<EmailAttachment[]>(),
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
