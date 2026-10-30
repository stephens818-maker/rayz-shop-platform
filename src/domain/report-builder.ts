/**
 * The custom report builder. Pure: the data sources, the fields each one offers, a report's
 * definition (columns, filters, sort, grouping, totals, dates, locations and barbers), which
 * fields a person may use and how, cell formatting, email schedules, and turning a customer
 * report into a Campaign Center segment. The server builds SQL only from these whitelisted
 * fields (src/server/report-builder/engine.ts); nothing in a definition is ever run as SQL.
 */
import { z } from "zod";
import { addDays, formatDate, LocalDate, localStampLabel, minutesToLabel, weekdayOf } from "@/lib/time";
import { CATEGORIES, EVENTS } from "./analytics";
import { filterSees, type PanelSees } from "./client-filters";
import { BUILTIN_FIELDS, type FieldKey, type Level } from "./client-privacy";
import {
  EMPTY_SEGMENT,
  SegmentSchema,
  filterCount,
  segmentProblem,
  type Segment,
} from "./marketing";
import { REPORTS, type ReportKey } from "./permissions";
import { PRESETS, presetRange } from "./report-range";
import type { BrandCalendar } from "./payroll";

// ───────────────────────────── Sources ─────────────────────────────

export const REPORT_SOURCES = [
  {
    key: "customers",
    label: "Customers",
    ready: true,
    hint: "One row per client: profile, contact details as you may see them, visits, spend, loyalty and marketing.",
  },
  {
    key: "events",
    label: "Event log",
    ready: true,
    hint: "One row per logged action: bookings and the booking funnel, check-in to checkout times, ticket edits, refunds, tips, stock, clock punches, block-outs, messages and calls. Ids and numbers only.",
  },
  {
    key: "sales",
    label: "Sales",
    ready: true,
    hint: "One row per paid ticket (refunded ones too; open and voided tickets aren't counted): services, products, discounts, tax, tips, the card fee, refunds and tenders, by business day, location and barber.",
  },
  {
    key: "appointments",
    label: "Appointments",
    ready: true,
    hint: "One row per appointment: status, how it was booked, services, booked minutes and lead time, by day, location and barber.",
  },
  {
    key: "staff",
    label: "Staff",
    ready: true,
    report: "sales_by_barber",
    hint: "One row per barber and location: appointments, no-shows, booked and clocked hours, utilization, sales, tips, rebook rate and clients, over the report's dates.",
  },
  {
    key: "inventory",
    label: "Inventory",
    ready: true,
    report: "inventory",
    hint: "One row per product and location: stock on hand now, reorder point and par, value, and what was received, sold, returned, transferred and lost in the report's dates, with sell-through.",
  },
  {
    key: "tips",
    label: "Tips",
    ready: true,
    report: "tip_payouts",
    hint: "One row per tip entry: each barber's share of a ticket's tip, a tip given back on a refund, or a manager's adjustment, with how and when it was paid out.",
  },
  {
    key: "campaigns",
    label: "Campaigns",
    ready: true,
    report: "campaign_center",
    hint: "One row per Campaign Center message sent: campaign, channel, delivery, opens, clicks, and the bookings, revenue and coupons credited to it (last touch, within the attribution window).",
  },
] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number]["key"];
export const SOURCE_KEYS = REPORT_SOURCES.map((s) => s.key) as [
  ReportSource,
  ...ReportSource[],
];
export const sourceLabel = (s: string) =>
  REPORT_SOURCES.find((x) => x.key === s)?.label ?? s;

// ───────────────────────────── Fields ─────────────────────────────

/** `number` is a decimal (days between visits); `stars` an average rating; `pct` a rate from 0 to 1; `list` several names. */
export const FIELD_TYPES = [
  "text",
  "int",
  "number",
  "money",
  "pct",
  "date",
  "stars",
  "bool",
  "list",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const AGGS = ["none", "sum", "avg", "count", "min", "max"] as const;
export type Agg = (typeof AGGS)[number];
export const AGG_LABEL: Record<Agg, string> = {
  none: "No total",
  sum: "Sum",
  avg: "Average",
  count: "Count",
  min: "Lowest",
  max: "Highest",
};

const NUMERIC = new Set<FieldType>(["int", "number", "money"]);
/** Which totals make sense for a field: sums of money and counts, averages of ratings, the earliest and latest date. Counting filled-in values works for anything. */
export function aggsFor(t: FieldType): Agg[] {
  if (NUMERIC.has(t)) return ["none", "sum", "avg", "count", "min", "max"];
  if (t === "stars" || t === "pct") return ["none", "avg", "count", "min", "max"];
  if (t === "date") return ["none", "count", "min", "max"];
  return ["none", "count"];
}

export const FIELD_GROUPS = [
  "Client",
  "Contact",
  "Profile",
  "Family",
  "Visits",
  "Rebooking",
  "Spend",
  "Products",
  "Loyalty and gift cards",
  "Marketing",
  "Custom fields",
  "Event",
  "Ticket",
  "Appointment",
  "Barber",
  "Product",
  "Tip",
  "Message",
  "When",
  "Who and where",
  "Measures",
] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

export interface FieldDef {
  key: string;
  label: string;
  group: FieldGroup;
  type: FieldType;
  hint?: string;
  /** The protected client detail it shows; its level under Client data decides who may use it. */
  reads?: FieldKey;
  /** What a masked detail still shows is the real value here (an address's town and zip, the average rating), so it can be sorted, grouped and totalled. */
  maskedShows?: boolean;
  /** Spend, tips and gift cards: only for people who see every client (as with the money filters). */
  money?: boolean;
  /** Sales and appointment dollar amounts: "See dollar amounts in reports", as on the standard reports. */
  dollars?: boolean;
  /** Each person's tips: pay data, the brand's unless a role has "Tips and payroll export". */
  pay?: boolean;
  /** Counts what happened, so it covers the report's dates, locations and barbers. Everything else is the client as they are now. */
  activity?: boolean;
  /** The standard report whose view permission it needs, beyond the source's own. */
  report?: ReportKey;
}

export const CUSTOMER_FIELDS: FieldDef[] = [
  { key: "name", label: "Name", group: "Client", type: "text" },
  { key: "first_name", label: "First name", group: "Client", type: "text" },
  { key: "last_name", label: "Last name", group: "Client", type: "text", reads: "last_name" },
  { key: "nickname", label: "Nickname", group: "Client", type: "text" },
  { key: "number", label: "Client #", group: "Client", type: "int" },
  {
    key: "phone",
    label: "Phone",
    group: "Contact",
    type: "text",
    reads: "phone",
  },
  {
    key: "email",
    label: "Email",
    group: "Contact",
    type: "text",
    reads: "email",
  },
  {
    key: "address",
    label: "Address",
    group: "Contact",
    type: "text",
    reads: "address",
  },
  {
    key: "city",
    label: "City",
    group: "Contact",
    type: "text",
    reads: "address",
    maskedShows: true,
  },
  {
    key: "zip",
    label: "Zip",
    group: "Contact",
    type: "text",
    reads: "address",
    maskedShows: true,
  },
  {
    key: "birthday",
    label: "Birthday",
    group: "Contact",
    type: "date",
    reads: "birthday",
  },
  { key: "tags", label: "Tags", group: "Profile", type: "list" },
  {
    key: "badges",
    label: "Badges",
    group: "Profile",
    type: "list",
    hint: "The client's badges as of the last nightly run (or their last checkout): only the ones you see.",
  },
  {
    key: "rating",
    label: "Staff rating",
    group: "Profile",
    type: "stars",
    reads: "ratings",
    maskedShows: true,
    hint: "The average of every staff rating.",
  },
  {
    key: "home_location",
    label: "Home location",
    group: "Profile",
    type: "text",
    hint: "For reporting: the client is the brand's and books at any shop.",
  },
  {
    key: "locations_visited",
    label: "Locations visited",
    group: "Profile",
    type: "list",
    hint: "Every Ray'z shop they've had a completed visit at.",
  },
  {
    key: "primary_barber",
    label: "Primary barber",
    group: "Profile",
    type: "text",
    reads: "preferred_barber",
    hint: "The preferred barber on their profile, or who cut them last.",
  },
  { key: "source", label: "Source", group: "Profile", type: "text" },
  { key: "created", label: "Client since", group: "Profile", type: "date" },
  {
    key: "is_child",
    label: "Child profile",
    group: "Family",
    type: "bool",
    hint: "A child on a parent's family account.",
  },
  {
    key: "parent",
    label: "Parent",
    group: "Family",
    type: "text",
    hint: "The parent whose account a child is on.",
  },
  {
    key: "kids",
    label: "Kids on account",
    group: "Family",
    type: "int",
    hint: "Children on this client's family account.",
  },
  {
    key: "first_visit",
    label: "First visit",
    group: "Visits",
    type: "date",
    activity: true,
  },
  {
    key: "last_visit",
    label: "Last visit",
    group: "Visits",
    type: "date",
    activity: true,
  },
  {
    key: "visits",
    label: "Visits",
    group: "Visits",
    type: "int",
    activity: true,
    hint: "Completed appointments.",
  },
  {
    key: "avg_gap_days",
    label: "Average days between visits",
    group: "Visits",
    type: "number",
    activity: true,
    hint: "The median of the last 10 gaps between visit days, so one long break doesn't skew it. Needs two visits.",
  },
  {
    key: "cadence_label",
    label: "Comes in",
    group: "Visits",
    type: "text",
    activity: true,
    hint: 'Their average time between visits in words, e.g. "Every 3.5 weeks".',
  },
  {
    key: "days_since_visit",
    label: "Days since last visit",
    group: "Visits",
    type: "int",
    activity: true,
  },
  {
    key: "next_visit_due",
    label: "Next expected visit",
    group: "Visits",
    type: "date",
    activity: true,
    hint: "Last visit plus their average time between visits.",
  },
  {
    key: "visit_status",
    label: "Visit status",
    group: "Visits",
    type: "text",
    activity: true,
    hint: "On track, due (from 3 days before their next expected visit) or overdue (a week, or a quarter of their gap, after it). Anyone booked is on track.",
  },
  {
    key: "no_shows",
    label: "No-shows",
    group: "Visits",
    type: "int",
    activity: true,
  },
  {
    key: "cancellations",
    label: "Cancellations",
    group: "Visits",
    type: "int",
    activity: true,
  },
  {
    key: "visits_rebooked",
    label: "Visits rebooked at checkout",
    group: "Rebooking",
    type: "int",
    activity: true,
    hint: "Completed visits they left with their next visit booked: at checkout, later that day, or already on the books. Squire visits with no booking time don't count.",
  },
  {
    key: "rebook_rate",
    label: "Rebook rate",
    group: "Rebooking",
    type: "pct",
    activity: true,
    hint: "Visits rebooked at checkout out of their completed visits with a booking time. Average it for a rebook rate per client.",
  },
  {
    key: "first_visit_rebooked",
    label: "Rebooked at first visit",
    group: "Rebooking",
    type: "bool",
    hint: "Their first visit to any Ray'z shop ended with the next one booked.",
  },
  {
    key: "second_visit",
    label: "Came back for a 2nd visit",
    group: "Rebooking",
    type: "bool",
    hint: "Two or more completed visits at any Ray'z shop.",
  },
  {
    key: "days_to_second_visit",
    label: "Days to 2nd visit",
    group: "Rebooking",
    type: "int",
    hint: "Days from their first completed visit to their second, at any Ray'z shop.",
  },
  {
    key: "next_booked",
    label: "Next booked visit",
    group: "Rebooking",
    type: "date",
    activity: true,
    hint: "Their next booked or confirmed appointment, at the report's locations and with its barbers.",
  },
  {
    key: "future_appointments",
    label: "Future appointments",
    group: "Rebooking",
    type: "int",
    activity: true,
    hint: "Booked or confirmed appointments still to come, at the report's locations and with its barbers.",
  },
  {
    key: "total_spend",
    label: "Total spend",
    group: "Spend",
    type: "money",
    money: true,
    activity: true,
    hint: "Services and products on paid tickets, less refunds.",
  },
  {
    key: "avg_spend",
    label: "Average spend per ticket",
    group: "Spend",
    type: "money",
    money: true,
    activity: true,
  },
  {
    key: "tickets",
    label: "Paid tickets",
    group: "Spend",
    type: "int",
    money: true,
    activity: true,
  },
  {
    key: "tips",
    label: "Tips",
    group: "Spend",
    type: "money",
    money: true,
    activity: true,
    hint: "Less refunded tips.",
  },
  {
    key: "services_bought",
    label: "Services bought",
    group: "Spend",
    type: "list",
    activity: true,
  },
  {
    key: "products_bought",
    label: "Products bought",
    group: "Spend",
    type: "list",
    activity: true,
  },
  {
    key: "last_product",
    label: "Last product bought",
    group: "Products",
    type: "text",
    activity: true,
    hint: "The most recent product line on a paid ticket, net of returns.",
  },
  {
    key: "last_product_date",
    label: "Last product bought on",
    group: "Products",
    type: "date",
    activity: true,
  },
  {
    key: "last_product_location",
    label: "Last product bought at",
    group: "Products",
    type: "text",
    activity: true,
  },
  {
    key: "last_product_qty",
    label: "Last product quantity",
    group: "Products",
    type: "int",
    activity: true,
  },
  {
    key: "refill_status",
    label: "Product refill status",
    group: "Products",
    type: "text",
    activity: true,
    hint: "Likely running out (from a week before what they last bought should be used up), likely ran out (two weeks, or half the supply, after) or has some left, by how long one lasts them, or lasts clients in general when they bought it once. Their most pressing product.",
  },
  {
    key: "products_running_out",
    label: "Products likely running out",
    group: "Products",
    type: "list",
    activity: true,
  },
  {
    key: "next_refill_due",
    label: "Next product refill due",
    group: "Products",
    type: "date",
    activity: true,
    hint: "The soonest date a product they buy should be used up, of those they haven't already run out of.",
  },
  {
    key: "loyalty_balance",
    label: "Loyalty rewards available",
    group: "Loyalty and gift cards",
    type: "money",
  },
  {
    key: "gift_cards",
    label: "Gift cards",
    group: "Loyalty and gift cards",
    type: "int",
    money: true,
    hint: "Gift cards on their profile that aren't void.",
  },
  {
    key: "gift_card_balance",
    label: "Gift card balance",
    group: "Loyalty and gift cards",
    type: "money",
    money: true,
  },
  {
    key: "coupons_redeemed",
    label: "Coupons redeemed",
    group: "Loyalty and gift cards",
    type: "int",
    activity: true,
  },
  {
    key: "sms_opt_in",
    label: "Appointment texts",
    group: "Marketing",
    type: "bool",
    hint: "Agreed to appointment texts when booking.",
  },
  {
    key: "email_opt_in",
    label: "Appointment emails",
    group: "Marketing",
    type: "bool",
  },
  {
    key: "sms_marketing",
    label: "Marketing texts",
    group: "Marketing",
    type: "bool",
    hint: "Agreed to marketing texts in the customer app.",
  },
  {
    key: "email_marketing",
    label: "Marketing emails",
    group: "Marketing",
    type: "bool",
  },
  {
    key: "push_marketing",
    label: "Marketing push",
    group: "Marketing",
    type: "bool",
  },
  {
    key: "campaigns_received",
    label: "Campaign messages received",
    group: "Marketing",
    type: "int",
    activity: true,
  },
  {
    key: "campaigns_clicked",
    label: "Campaign messages clicked",
    group: "Marketing",
    type: "int",
    activity: true,
  },
  {
    key: "review_clicks",
    label: "Google review clicks",
    group: "Marketing",
    type: "int",
    activity: true,
  },
];
const BY_KEY = new Map(CUSTOMER_FIELDS.map((f) => [f.key, f]));

/** The event log's fields: what happened, when, where and to whom (by client number), and its measures. Never a contact detail or a name of a client. */
export const EVENT_FIELDS: FieldDef[] = [
  { key: "event", label: "Event", group: "Event", type: "text" },
  {
    key: "event_code",
    label: "Event code",
    group: "Event",
    type: "text",
    hint: "category.action, as in the README and the raw export.",
  },
  { key: "category", label: "Category", group: "Event", type: "text" },
  {
    key: "subtype",
    label: "Subtype",
    group: "Event",
    type: "text",
    hint: "A short code that splits the event: late or in_time for a cancellation, card or cash for a payment, and so on.",
  },
  {
    key: "reason",
    label: "Reason",
    group: "Event",
    type: "text",
    hint: "The reason given for a cancellation, void, refund, price change, stock movement or block-out.",
  },
  {
    key: "booking_source",
    label: "Source",
    group: "Event",
    type: "text",
    hint: "The booking source on appointment events; how they found us on client events.",
  },
  {
    key: "channel",
    label: "Channel",
    group: "Event",
    type: "text",
    hint: "Online, app, walk-in, phone, staff screens, kiosk, text, email and so on.",
  },
  { key: "device", label: "Device", group: "Event", type: "text" },
  {
    key: "actor_kind",
    label: "Done by (staff, client or system)",
    group: "Event",
    type: "text",
  },
  {
    key: "occurred",
    label: "When",
    group: "When",
    type: "text",
    hint: "Local date and time.",
  },
  { key: "business_date", label: "Business day", group: "When", type: "date" },
  { key: "hour", label: "Hour of day", group: "When", type: "int" },
  { key: "weekday", label: "Day of the week", group: "When", type: "text" },
  { key: "month", label: "Month", group: "When", type: "text" },
  { key: "location", label: "Location", group: "Who and where", type: "text" },
  {
    key: "barber",
    label: "Barber",
    group: "Who and where",
    type: "text",
    hint: "The barber or employee it's about.",
  },
  {
    key: "done_by",
    label: "Done by",
    group: "Who and where",
    type: "text",
    hint: "The staff member who did it, or Client or System.",
  },
  {
    key: "client_number",
    label: "Client #",
    group: "Who and where",
    type: "int",
    hint: 'Blank after a client is erased, and for clients you haven\'t served without "Look up any client".',
  },
  { key: "record", label: "Record type", group: "Who and where", type: "text" },
  {
    key: "record_id",
    label: "Record id",
    group: "Who and where",
    type: "text",
  },
  {
    key: "events",
    label: "Events",
    group: "Measures",
    type: "int",
    hint: "1 on every row: total it to count events.",
  },
  {
    key: "amount",
    label: "Amount",
    group: "Measures",
    type: "money",
    money: true,
    hint: "The event's money measure: net sales on a paid ticket, the tip, the refund, the estimate on a booking.",
  },
  { key: "quantity", label: "Quantity", group: "Measures", type: "int" },
  {
    key: "minutes",
    label: "Minutes",
    group: "Measures",
    type: "number",
    hint: "The event's duration: lead time on a booking, wait on a start, time in the chair on a finish.",
  },
  {
    key: "value",
    label: "Value",
    group: "Measures",
    type: "number",
    hint: "Another measure: tip percent on a paid ticket, booked minutes, a rating.",
  },
];

const WHEN_FIELDS: FieldDef[] = [
  { key: "business_date", label: "Business day", group: "When", type: "date" },
  { key: "weekday", label: "Day of the week", group: "When", type: "text" },
  { key: "hour", label: "Hour of day", group: "When", type: "int" },
  { key: "month", label: "Month", group: "When", type: "text" },
];
const WHERE_FIELDS: FieldDef[] = [
  { key: "location", label: "Location", group: "Who and where", type: "text" },
  { key: "barber", label: "Barber", group: "Who and where", type: "text" },
  {
    key: "client_number",
    label: "Client #",
    group: "Who and where",
    type: "int",
    hint: 'Blank after a client is erased, and for clients you haven\'t served without "Look up any client". A customer report has names.',
  },
];

/** Sales: one row per paid ticket. Client numbers only; amounts need dollar amounts in reports, and tips are pay data. */
export const SALE_FIELDS: FieldDef[] = [
  { key: "ticket", label: "Ticket #", group: "Ticket", type: "int" },
  {
    key: "status",
    label: "Status",
    group: "Ticket",
    type: "text",
    hint: "Paid, Partially refunded or Refunded.",
  },
  {
    key: "tender",
    label: "Paid with",
    group: "Ticket",
    type: "text",
    hint: "Card, Cash, Gift card, or a mix (Card + Cash) on a split ticket.",
  },
  {
    key: "client_type",
    label: "New or returning",
    group: "Ticket",
    type: "text",
    hint: "New on the client's first paid ticket anywhere in the brand; No client for a walk-in rung up without one.",
  },
  {
    key: "imported",
    label: "Imported from Squire",
    group: "Ticket",
    type: "bool",
  },
  {
    key: "paid",
    label: "Paid at",
    group: "When",
    type: "text",
    hint: "Local date and time.",
  },
  ...WHEN_FIELDS,
  ...WHERE_FIELDS,
  {
    key: "tickets",
    label: "Tickets",
    group: "Measures",
    type: "int",
    hint: "1 on every row: total it to count tickets.",
  },
  {
    key: "services",
    label: "Service sales",
    group: "Measures",
    type: "money",
    dollars: true,
    hint: "Services and add-ons after discounts, before tax.",
  },
  {
    key: "products",
    label: "Product sales",
    group: "Measures",
    type: "money",
    dollars: true,
    hint: "After discounts, before tax.",
  },
  {
    key: "net_sales",
    label: "Net sales",
    group: "Measures",
    type: "money",
    dollars: true,
    hint: "Service and product sales, less what was refunded of them.",
  },
  { key: "discounts", label: "Discounts", group: "Measures", type: "money", dollars: true },
  { key: "tax", label: "Tax", group: "Measures", type: "money", dollars: true },
  {
    key: "gift_card_sales",
    label: "Gift cards sold",
    group: "Measures",
    type: "money",
    dollars: true,
  },
  {
    key: "tips",
    label: "Tips",
    group: "Measures",
    type: "money",
    dollars: true,
    pay: true,
    hint: "Card and cash tips on the ticket.",
  },
  {
    key: "card_fee",
    label: "Credit card fee",
    group: "Measures",
    type: "money",
    dollars: true,
    hint: "The surcharge collected, after any waiver.",
  },
  {
    key: "total",
    label: "Ticket total",
    group: "Measures",
    type: "money",
    dollars: true,
    hint: "What the client paid: sales, tax, tips and the card fee.",
  },
  {
    key: "refunded",
    label: "Refunded",
    group: "Measures",
    type: "money",
    dollars: true,
    hint: "Every refund on the ticket so far, tips and tax included, whatever day it was made.",
  },
  {
    key: "items",
    label: "Items",
    group: "Measures",
    type: "int",
    hint: "Services, add-ons and products on the ticket, by quantity.",
  },
];

/** Appointments: one row per appointment, whatever its status. Client numbers only. */
export const APPOINTMENT_FIELDS: FieldDef[] = [
  {
    key: "status",
    label: "Status",
    group: "Appointment",
    type: "text",
    hint: "Booked, Confirmed, Checked in, In service, Completed, Cancelled or No-show.",
  },
  {
    key: "booking_source",
    label: "Booked through",
    group: "Appointment",
    type: "text",
    hint: "Online, App, Staff, Walk-in, Rebook at checkout or Imported.",
  },
  { key: "services", label: "Services", group: "Appointment", type: "text" },
  {
    key: "client_type",
    label: "New or returning",
    group: "Appointment",
    type: "text",
    hint: "New when the client had no completed visit anywhere in the brand before it.",
  },
  { key: "any_barber", label: "Booked for any barber", group: "Appointment", type: "bool" },
  { key: "family", label: "Family booking", group: "Appointment", type: "bool" },
  {
    key: "cancel_reason",
    label: "Cancellation reason",
    group: "Appointment",
    type: "text",
  },
  {
    key: "starts",
    label: "Starts",
    group: "When",
    type: "text",
    hint: "Local date and time.",
  },
  ...WHEN_FIELDS,
  {
    key: "booked_on",
    label: "Booked on",
    group: "When",
    type: "date",
    hint: "Blank for imported bookings whose booking date Squire didn't keep.",
  },
  ...WHERE_FIELDS,
  {
    key: "appointments",
    label: "Appointments",
    group: "Measures",
    type: "int",
    hint: "1 on every row: total it to count appointments.",
  },
  { key: "completed", label: "Completed", group: "Measures", type: "int", hint: "1 when completed." },
  { key: "no_shows", label: "No-shows", group: "Measures", type: "int", hint: "1 for a no-show." },
  { key: "cancellations", label: "Cancellations", group: "Measures", type: "int", hint: "1 when cancelled." },
  { key: "booked_minutes", label: "Booked minutes", group: "Measures", type: "int" },
  {
    key: "lead_days",
    label: "Lead time (days)",
    group: "Measures",
    type: "number",
    hint: "From booking to the start. Blank when the booking date isn't known.",
  },
  {
    key: "estimate",
    label: "Estimate",
    group: "Measures",
    type: "money",
    dollars: true,
    hint: "The services' price when it was booked.",
  },
];

const DAY_FIELDS = WHEN_FIELDS.filter((f) => f.key !== "hour");
const measure = (
  key: string,
  label: string,
  type: FieldType,
  hint: string,
  x: Partial<FieldDef> = {},
): FieldDef => ({ key, label, group: "Measures", type, hint, ...x });

/** Staff: one row per barber and location. Measures cover the report's dates; clocked hours follow the Labor report. */
export const STAFF_FIELDS: FieldDef[] = [
  { key: "barber", label: "Barber", group: "Barber", type: "text" },
  { key: "location", label: "Location", group: "Barber", type: "text" },
  {
    key: "role",
    label: "Role",
    group: "Barber",
    type: "text",
    hint: "Their role at this location, or their main role.",
  },
  { key: "active", label: "Active", group: "Barber", type: "bool" },
  { key: "main_location", label: "Main location", group: "Barber", type: "bool" },
  { key: "hire_date", label: "Hire date", group: "Barber", type: "date" },
  measure("appointments", "Appointments", "int", "Booked in the dates, whatever their status."),
  measure("completed", "Completed", "int", "Completed appointments."),
  measure("no_shows", "No-shows", "int", "No-shows."),
  measure("cancellations", "Cancellations", "int", "Cancelled appointments."),
  measure("clients", "Clients served", "int", "Different clients with a completed appointment."),
  measure(
    "new_clients",
    "New clients",
    "int",
    "Clients whose first completed visit anywhere in the brand was with them, in the dates.",
  ),
  measure("booked_hours", "Booked hours", "number", "Booked time of completed appointments."),
  measure(
    "clocked_hours",
    "Clocked hours",
    "number",
    "Worked hours from the time clock, as on the Labor report: breaks out, edits in.",
    { report: "labor" },
  ),
  measure("ot_hours", "Overtime hours", "number", "Overtime hours, as on the Labor report.", {
    report: "labor",
  }),
  measure(
    "utilization",
    "Utilization",
    "pct",
    "Booked hours of completed appointments over clocked hours.",
    { report: "labor" },
  ),
  measure(
    "service_sales",
    "Service sales",
    "money",
    "Their services after discounts and refunds, split by line on shared tickets, as payroll counts them.",
    { dollars: true },
  ),
  measure(
    "product_sales",
    "Product sales",
    "money",
    "Products they sold, after discounts and refunds, as payroll counts them.",
    { dollars: true },
  ),
  measure(
    "sales_per_hour",
    "Sales per clocked hour",
    "money",
    "Service and product sales over clocked hours.",
    { dollars: true, report: "labor" },
  ),
  measure("tickets", "Tickets", "int", "Paid tickets where they're the ticket's barber."),
  measure("tips", "Tips", "money", "Their tips less tips given back on refunds, by the tip's business day.", {
    dollars: true,
    pay: true,
  }),
  measure(
    "rebook_rate",
    "Rebooked at checkout",
    "pct",
    "Completed visits where the client had their next visit booked by the end of that day, as on the Rebook rate report.",
  ),
];

/** Inventory: one row per product and location. Stock is now; movement covers the report's dates, as on the stock movement report. */
export const INVENTORY_FIELDS: FieldDef[] = [
  { key: "product", label: "Product", group: "Product", type: "text" },
  { key: "sku", label: "SKU", group: "Product", type: "text" },
  { key: "brand", label: "Brand", group: "Product", type: "text" },
  { key: "category", label: "Category", group: "Product", type: "text" },
  {
    key: "active",
    label: "Sold here",
    group: "Product",
    type: "bool",
    hint: "Active at this location.",
  },
  { key: "location", label: "Location", group: "Who and where", type: "text" },
  measure("on_hand", "On hand", "int", "Stock now, whatever the dates."),
  measure("reorder_point", "Reorder point", "int", "Low stock at or below this."),
  measure("par", "Par level", "int", "Suggested orders fill up to this."),
  measure("low", "Low stock", "bool", "On hand at or below the reorder point."),
  measure("price", "Price", "money", "This location's price.", { dollars: true }),
  measure("cost_value", "Value at cost", "money", "On hand × average cost.", { dollars: true }),
  measure("retail_value", "Value at retail", "money", "On hand × price.", { dollars: true }),
  measure("received", "Received", "int", "From vendors."),
  measure("sold", "Sold", "int", "Units rung up."),
  measure("returned", "Returned", "int", "Back on the shelf from refunds and voids."),
  measure("transfers_in", "Transferred in", "int", "From other locations."),
  measure("transfers_out", "Transferred out", "int", "To other locations."),
  measure("back_bar", "Back bar", "int", "Taken for use in the shop."),
  measure(
    "shrink",
    "Shrink",
    "int",
    "Damaged, stolen and net count losses (a count that finds extra lowers it).",
  ),
  measure(
    "shrink_value",
    "Shrink at cost",
    "money",
    "Shrink at the cost on each entry, plus transfers that didn't fully arrive.",
    { dollars: true },
  ),
  measure(
    "sell_through",
    "Sell-through",
    "pct",
    "Sold less returned, over stock at the start plus what came in.",
  ),
  measure("product_sales", "Product sales", "money", "After discounts and refunds.", {
    dollars: true,
  }),
];

/** Tips: one row per tip ledger entry. Amounts need dollar amounts in reports. */
export const TIP_FIELDS: FieldDef[] = [
  {
    key: "entry",
    label: "Entry",
    group: "Tip",
    type: "text",
    hint: "Tip, Given back (a refund or void) or Adjustment.",
  },
  {
    key: "method",
    label: "Left by",
    group: "Tip",
    type: "text",
    hint: "Card, Cash, Gift card, or Adjustment.",
  },
  { key: "ticket", label: "Ticket #", group: "Tip", type: "int" },
  {
    key: "payout_status",
    label: "Payout",
    group: "Tip",
    type: "text",
    hint: "Not in a payout yet, or the payout's status: Pending, Held, Approved, Processing, Paid, Failed or Cancelled.",
  },
  {
    key: "payout_method",
    label: "Paid out by",
    group: "Tip",
    type: "text",
    hint: "Cash, Stripe, Payroll, or Before tip payouts (paid outside the platform).",
  },
  { key: "paid_out", label: "Paid out on", group: "Tip", type: "date" },
  { key: "reason", label: "Adjustment reason", group: "Tip", type: "text" },
  ...DAY_FIELDS,
  { key: "location", label: "Location", group: "Who and where", type: "text" },
  { key: "barber", label: "Barber", group: "Who and where", type: "text", hint: "Who earned it." },
  measure("entries", "Entries", "int", "1 on every row: total it to count them."),
  measure("amount", "Amount", "money", "Signed: a tip given back is negative.", { dollars: true }),
  measure(
    "fee",
    "Card fee share",
    "money",
    "This tip's share of the card processing fee. Taken out of the payout only where the location nets it.",
    { dollars: true },
  ),
];

/** Campaigns: one row per Campaign Center message sent (not tests, skips or the holdout group). */
export const CAMPAIGN_FIELDS: FieldDef[] = [
  { key: "campaign", label: "Campaign", group: "Message", type: "text" },
  {
    key: "kind",
    label: "Kind",
    group: "Message",
    type: "text",
    hint: "Automated, Blast, Lapsed sequence or We have openings.",
  },
  { key: "channel", label: "Channel", group: "Message", type: "text" },
  { key: "variant", label: "A/B wording", group: "Message", type: "text" },
  { key: "sent", label: "Sent at", group: "When", type: "text", hint: "Local date and time." },
  ...WHEN_FIELDS,
  ...WHERE_FIELDS.map((f) =>
    f.key === "barber" ? { ...f, hint: "The barber it's about, or the client's usual barber." } : f,
  ),
  measure("messages", "Messages", "int", "1 on every row: total it to count them."),
  measure("delivered", "Delivered", "int", "1 when the carrier or the email provider took it, or it was opened or clicked."),
  measure("opened", "Opened", "int", "Emails opened (not by a mail scanner), or clicked."),
  measure("clicked", "Clicked", "int", "1 when the link was clicked at least once."),
  measure("bookings", "Bookings", "int", "Appointments credited to it."),
  measure(
    "revenue",
    "Revenue",
    "money",
    "Service and product sales credited to it; nothing when the client was already booked.",
    { dollars: true },
  ),
  measure("redemptions", "Coupons used", "int", "Its coupon redeemed."),
  measure("cost", "Cost", "money", "The message at the brand's rates plus coupon discounts given.", {
    dollars: true,
  }),
  measure("unsubscribes", "Unsubscribes", "int", "Unsubscribes and STOP replies from it."),
  {
    key: "already_booked",
    label: "Already booked",
    group: "Message",
    type: "bool",
    hint: "The client had an appointment coming up when it went.",
  },
];

const FIELDS_BY_SOURCE: Partial<Record<ReportSource, Map<string, FieldDef>>> = {
  events: new Map(EVENT_FIELDS.map((f) => [f.key, f])),
  sales: new Map(SALE_FIELDS.map((f) => [f.key, f])),
  appointments: new Map(APPOINTMENT_FIELDS.map((f) => [f.key, f])),
  staff: new Map(STAFF_FIELDS.map((f) => [f.key, f])),
  inventory: new Map(INVENTORY_FIELDS.map((f) => [f.key, f])),
  tips: new Map(TIP_FIELDS.map((f) => [f.key, f])),
  campaigns: new Map(CAMPAIGN_FIELDS.map((f) => [f.key, f])),
};

/** Event types a report can pick: a whole category or one event. */
export const EVENT_TYPES: { key: string; label: string; category: string }[] = [
  ...Object.entries(CATEGORIES).map(([k, label]) => ({
    key: k,
    label: `All ${label.toLowerCase()}`,
    category: k,
  })),
  ...Object.entries(EVENTS).map(([k, e]) => ({
    key: k,
    label: e.label,
    category: k.split(".")[0],
  })),
];
export const isEventType = (k: string) => k in CATEGORIES || k in EVENTS;

export const isCustomField = (key: string) =>
  /^custom:[0-9a-f-]{36}$/.test(key);
export const customDef = (c: { id: string; label: string }): FieldDef => ({
  key: `custom:${c.id}`,
  label: c.label,
  group: "Custom fields",
  type: "text",
  reads: `custom:${c.id}`,
});

/** The field, or null when it isn't one the source offers (or a custom field that's gone). */
export function fieldDef(
  key: string,
  custom: readonly { id: string; label: string }[],
  source: string = "customers",
): FieldDef | null {
  const flat = FIELDS_BY_SOURCE[source as ReportSource];
  if (flat) return flat.get(key) ?? null;
  if (isCustomField(key)) {
    const c = custom.find((x) => `custom:${x.id}` === key);
    return c ? customDef(c) : null;
  }
  return BY_KEY.get(key) ?? null;
}

export const allFields = (
  custom: readonly { id: string; label: string }[],
  source: string = "customers",
): FieldDef[] => {
  const flat = FIELDS_BY_SOURCE[source as ReportSource];
  return flat ? [...flat.values()] : [...CUSTOMER_FIELDS, ...custom.map(customDef)];
};

export const reportLabel = (k: ReportKey) =>
  REPORTS.find((r) => r.key === k)?.label ?? k;

/** The standard report a source needs: its rows are that report's data. */
export const sourceReport = (s: string): ReportKey | null => {
  const src = REPORT_SOURCES.find((x) => x.key === s);
  return src && "report" in src ? src.report : null;
};

/** How one person may use a field: in full, masked (shown as Client data masks it), or not at all and why. */
export type FieldUse =
  { use: "full" } | { use: "masked" } | { use: "none"; why: string };

export function fieldUse(f: FieldDef, sees: PanelSees): FieldUse {
  if (f.money && !sees.money)
    return {
      use: "none",
      why: sees.moneyWhy ?? "Spend, tips and gift cards need access to every client",
    };
  if (f.dollars && !sees.dollars)
    return {
      use: "none",
      why: 'Dollar amounts need "See dollar amounts in reports"',
    };
  if (f.pay && !sees.pay)
    return {
      use: "none",
      why: 'Each person\'s tips are pay data: they need "Tips and payroll export"',
    };
  if (f.report && !sees.reports?.includes(f.report))
    return { use: "none", why: `It needs "${reportLabel(f.report)}"` };
  if (f.key === "badges" && !sees.badges?.length)
    return { use: "none", why: "No client badges are shown to you" };
  if (!f.reads) return { use: "full" };
  const level: Level = sees.levels[f.reads] ?? "hidden";
  const name = f.reads.startsWith("custom:")
    ? f.label
    : (BUILTIN_FIELDS.find((b) => b.key === f.reads)?.label ?? f.label);
  if (level === "hidden")
    return { use: "none", why: `${name} is hidden from you under Client data` };
  if (level === "masked")
    return f.maskedShows ? { use: "full" } : { use: "masked" };
  return { use: "full" };
}

// ───────────────────────────── Definition ─────────────────────────────

export const RANGE_PRESETS: { id: string; label: string }[] = [
  { id: "all", label: "All time" },
  ...PRESETS,
  { id: "custom", label: "Custom dates" },
];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .default(null);
const fieldKey = z.string().trim().min(1).max(80);

export const ReportColumn = z.object({
  field: fieldKey,
  /** The header; empty uses the field's name. */
  label: z
    .string()
    .trim()
    .max(60, "Keep column names under 60 characters")
    .default(""),
  agg: z.enum(AGGS).default("none"),
});
export type ReportColumn = z.output<typeof ReportColumn>;

export const ReportDefinition = z.object({
  source: z.enum(SOURCE_KEYS).default("customers"),
  columns: z
    .array(ReportColumn)
    .min(1, "Add at least one column")
    .max(40, "Up to 40 columns"),
  /** The segment builder's filters, over the client's whole history. */
  filter: SegmentSchema.default(EMPTY_SEGMENT),
  sort: z
    .array(
      z.object({
        field: fieldKey,
        dir: z.enum(["asc", "desc"]).default("asc"),
      }),
    )
    .max(3, "Sort by up to three fields")
    .default([]),
  groupBy: z.array(fieldKey).max(2, "Group by up to two fields").default([]),
  /** One row per group with its totals, instead of every client under each group. */
  summary: z.boolean().default(false),
  totals: z.boolean().default(true),
  range: z
    .object({
      preset: z.string().max(20).default("all"),
      from: isoDate,
      to: isoDate,
    })
    .default({ preset: "all", from: null, to: null }),
  /** "visited": only clients with a completed visit in the dates, at the locations, with the barbers. "all": every client they reach there. */
  rows: z.enum(["all", "visited"]).default("all"),
  /** The report's `shop` value: "all", "group:<id>", shop ids; null for the location the viewer is working in. */
  shops: z.string().max(4000).nullable().default(null),
  /** The report's `staff` value: "group:<id>" or staff ids; null for every barber. */
  staff: z.string().max(4000).nullable().default(null),
  /** Event log reports: the categories and events to include (EVENT_TYPES keys); empty for every event. */
  eventTypes: z
    .array(z.string().trim().min(1).max(60))
    .max(80, "Pick up to 80 event types")
    .default([]),
});
export type ReportDefinition = z.output<typeof ReportDefinition>;

export const DEFAULT_CUSTOMER_REPORT: ReportDefinition = ReportDefinition.parse(
  {
    columns: [
      { field: "name" },
      { field: "home_location" },
      { field: "last_visit" },
      { field: "visits", agg: "sum" },
    ],
    sort: [{ field: "last_visit", dir: "desc" }],
  },
);

export const DEFAULT_EVENT_REPORT: ReportDefinition = ReportDefinition.parse({
  source: "events",
  columns: [
    { field: "event" },
    { field: "events", agg: "sum" },
    { field: "minutes", agg: "avg" },
  ],
  groupBy: ["event"],
  summary: true,
  range: { preset: "7d" },
});

export const DEFAULT_SALES_REPORT: ReportDefinition = ReportDefinition.parse({
  source: "sales",
  columns: [
    { field: "location" },
    { field: "services", agg: "sum" },
    { field: "products", agg: "sum" },
    { field: "net_sales", agg: "sum" },
  ],
  groupBy: ["location"],
  summary: true,
  range: { preset: "7d" },
});

export const DEFAULT_APPOINTMENT_REPORT: ReportDefinition = ReportDefinition.parse({
  source: "appointments",
  columns: [
    { field: "barber" },
    { field: "completed", agg: "sum" },
    { field: "no_shows", agg: "sum" },
    { field: "cancellations", agg: "sum" },
  ],
  groupBy: ["barber"],
  summary: true,
  range: { preset: "7d" },
});

export const DEFAULT_STAFF_REPORT: ReportDefinition = ReportDefinition.parse({
  source: "staff",
  columns: [
    { field: "barber" },
    { field: "location" },
    { field: "completed", agg: "sum" },
    { field: "no_shows", agg: "sum" },
    { field: "booked_hours", agg: "sum" },
    { field: "rebook_rate", agg: "avg" },
  ],
  sort: [{ field: "completed", dir: "desc" }],
  range: { preset: "30d" },
});

export const DEFAULT_INVENTORY_REPORT: ReportDefinition = ReportDefinition.parse({
  source: "inventory",
  columns: [
    { field: "product" },
    { field: "location" },
    { field: "on_hand", agg: "sum" },
    { field: "sold", agg: "sum" },
    { field: "received", agg: "sum" },
    { field: "shrink", agg: "sum" },
  ],
  sort: [{ field: "sold", dir: "desc" }],
  range: { preset: "30d" },
});

export const DEFAULT_TIP_REPORT: ReportDefinition = ReportDefinition.parse({
  source: "tips",
  columns: [
    { field: "barber" },
    { field: "amount", agg: "sum" },
    { field: "fee", agg: "sum" },
  ],
  groupBy: ["barber"],
  summary: true,
  range: { preset: "7d" },
});

export const DEFAULT_CAMPAIGN_REPORT: ReportDefinition = ReportDefinition.parse({
  source: "campaigns",
  columns: [
    { field: "campaign" },
    { field: "delivered", agg: "sum" },
    { field: "clicked", agg: "sum" },
    { field: "bookings", agg: "sum" },
    { field: "unsubscribes", agg: "sum" },
  ],
  groupBy: ["campaign"],
  summary: true,
  range: { preset: "30d" },
});

const DEFAULTS: Partial<Record<ReportSource, ReportDefinition>> = {
  events: DEFAULT_EVENT_REPORT,
  sales: DEFAULT_SALES_REPORT,
  appointments: DEFAULT_APPOINTMENT_REPORT,
  staff: DEFAULT_STAFF_REPORT,
  inventory: DEFAULT_INVENTORY_REPORT,
  tips: DEFAULT_TIP_REPORT,
  campaigns: DEFAULT_CAMPAIGN_REPORT,
};

/** A starting report for a source, when the builder switches to it. */
export const defaultReport = (source: string): ReportDefinition =>
  DEFAULTS[source as ReportSource] ?? {
    ...DEFAULT_CUSTOMER_REPORT,
    source: source as ReportSource,
  };

export const columnLabel = (c: ReportColumn, f: FieldDef | null) =>
  c.label || f?.label || "Removed field";

/** The date range a report covers on a given day, or null for all time. */
export function reportRange(
  r: ReportDefinition["range"],
  today: LocalDate,
  cal?: BrandCalendar,
): { from: LocalDate; to: LocalDate } | null {
  if (r.preset === "all") return null;
  if (r.preset === "custom") {
    if (!r.from || !r.to) return null;
    return r.from <= r.to
      ? { from: r.from, to: r.to }
      : { from: r.to, to: r.from };
  }
  return presetRange(r.preset, today, cal);
}

export function rangeLabel(
  r: ReportDefinition["range"],
  today: LocalDate,
  cal?: BrandCalendar,
): string {
  const d = reportRange(r, today, cal);
  if (!d) return "All time";
  const preset = PRESETS.find((p) => p.id === r.preset)?.label;
  const dates =
    d.from === d.to
      ? formatDate(d.from, "MMM d, yyyy")
      : `${formatDate(d.from, "MMM d")} – ${formatDate(d.to, "MMM d, yyyy")}`;
  return preset ? `${preset} (${dates})` : dates;
}

/** Whether a field can order or group rows for this person: only values they see as they really are. */
const ordersBy = (f: FieldDef, sees: PanelSees) =>
  fieldUse(f, sees).use === "full" && f.type !== "list";

/**
 * Why a report can't run for this person, or null. A column on a hidden detail, money without
 * every client, or sorting, grouping or totalling a masked value (which would give away what the
 * mask hides) is refused, and so is any filter the segment builder would refuse them.
 */
export function definitionProblem(
  def: ReportDefinition,
  sees: PanelSees,
  custom: readonly { id: string; label: string }[],
  o: { filters: boolean } = { filters: true },
): string | null {
  const src = REPORT_SOURCES.find((s) => s.key === def.source);
  if (!src?.ready)
    return `${sourceLabel(def.source)} reports are coming next. ${REPORT_SOURCES.filter((x) => x.ready)
      .map((x) => x.label.toLowerCase())
      .join(", ")
      .replace(/^./, (c) => c.toUpperCase())} reports are ready now.`;
  const needs = sourceReport(def.source);
  if (needs && !sees.reports?.includes(needs))
    return `The ${sourceLabel(def.source)} source needs "${reportLabel(needs)}"`;
  const events = def.source === "events";
  const flat = def.source !== "customers";
  const known = (key: string) => fieldDef(key, custom, def.source);
  for (const c of def.columns) {
    const f = known(c.field);
    if (!f)
      return `"${c.label || c.field}" isn't a field this report can show anymore. Remove the column.`;
    const u = fieldUse(f, sees);
    if (u.use === "none")
      return `You can't add "${f.label}": ${u.why.charAt(0).toLowerCase()}${u.why.slice(1)}`;
    if (!aggsFor(f.type).includes(c.agg))
      return `"${columnLabel(c, f)}" can't be totalled as ${AGG_LABEL[c.agg].toLowerCase()}`;
    if (u.use === "masked" && c.agg !== "none" && c.agg !== "count")
      return `"${columnLabel(c, f)}" is masked for you, so it can only be counted`;
  }
  for (const s of def.sort) {
    const f = known(s.field);
    if (!f) return "One of the sort fields isn't available anymore";
    if (!ordersBy(f, sees))
      return f.type === "list"
        ? `Lists like "${f.label}" can't be sorted`
        : `You can't sort by "${f.label}" because you don't see it in full`;
  }
  for (const g of def.groupBy) {
    const f = known(g);
    if (!f) return "One of the grouping fields isn't available anymore";
    if (!ordersBy(f, sees))
      return f.type === "list"
        ? `Lists like "${f.label}" can't be grouped`
        : `You can't group by "${f.label}" because you don't see it in full`;
  }
  if (new Set(def.groupBy).size < def.groupBy.length)
    return "Group by two different fields";
  if (def.summary && !def.groupBy.length)
    return "Pick a field to group by for a summary";
  if (def.range.preset === "custom" && (!def.range.from || !def.range.to))
    return "Pick both dates for a custom range";
  if (
    def.range.preset !== "all" &&
    def.range.preset !== "custom" &&
    !PRESETS.some((p) => p.id === def.range.preset)
  )
    return "Pick a date range";
  if (def.eventTypes.length && !events)
    return "Event types are for event log reports";
  if (flat) {
    if (filterCount(def.filter) > 0)
      return events
        ? "Client filters are for customer reports. Remove them, or pick event types instead."
        : "Client filters are for customer reports. Remove them, or use a customer report.";
    if (def.eventTypes.some((t) => !isEventType(t)))
      return "One of the event types isn't logged anymore. Remove it.";
    return null;
  }
  if (!o.filters && filterCount(def.filter) > 0)
    return 'Filters need "Use advanced client filters"';
  return segmentProblem(def.filter, filterSees(sees));
}

export const parseDefinition = (raw: unknown) =>
  ReportDefinition.safeParse(raw);

/** A definition in a link (base64url JSON), for "Open in the report builder". */
export const encodeDefinition = (def: ReportDefinition) =>
  Buffer.from(JSON.stringify(def), "utf8").toString("base64url");
export function decodeDefinition(s: string): ReportDefinition | null {
  try {
    const r = ReportDefinition.safeParse(
      JSON.parse(Buffer.from(s, "base64url").toString("utf8")),
    );
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── Results ─────────────────────────────

export type Cell = string | number | boolean | string[] | null;

export interface ResultColumn {
  key: string;
  label: string;
  type: FieldType;
  agg: Agg;
  /** Shown as Client data masks it: the cells are already the masked text. */
  masked: boolean;
}

/** A client's row, or a group's header with its client count and totals (in the columns that have one). */
export type ResultLine =
  | { kind: "row"; id: string; cells: Cell[] }
  | {
      kind: "group";
      level: number;
      values: string[];
      count: number;
      cells: Cell[];
      continued?: boolean;
    };

export interface ReportResult {
  columns: ResultColumn[];
  groupBy: { key: string; label: string; type: FieldType }[];
  lines: ResultLine[];
  /** Clients, or groups in a summary. */
  total: number;
  page: number;
  pageSize: number;
  /** The whole report's totals, when any column has one. */
  totals: { count: number; cells: Cell[] } | null;
  rangeLabel: string;
  scopeLabel: string;
  /** More rows than an export takes. */
  truncated: boolean;
  /** What a row is: a client (linked to their profile), a logged event, a ticket or an appointment. */
  noun?: RowNoun;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/** A cell as it reads on the page, in an email and in a PDF. */
export function cellText(type: FieldType, v: Cell, masked = false): string {
  if (v === null || v === undefined || v === "") return "";
  if (masked) return String(v);
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  switch (type) {
    case "money":
      return usd.format(Number(v) / 100);
    case "int":
      return Math.round(Number(v)).toLocaleString("en-US");
    case "number":
      return (Math.round(Number(v) * 10) / 10).toLocaleString("en-US");
    case "stars":
      return Number(v).toFixed(1);
    case "pct":
      return `${Math.round(Number(v) * 100)}%`;
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? formatDate(v, "MMM d, yyyy")
        : String(v);
    default:
      return typeof v === "string" ? localStampLabel(v) : String(v);
  }
}

/** A cell for CSV and Excel: plain numbers (dollars with cents), ISO dates, lists separated by semicolons. */
export function cellValue(
  type: FieldType,
  v: Cell,
  masked = false,
): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (masked) return String(v);
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (type === "money") return Math.round(Number(v)) / 100;
  if (type === "pct") return `${(Number(v) * 100).toFixed(1)}%`;
  if (type === "number" || type === "stars")
    return Math.round(Number(v) * 100) / 100;
  if (type === "int") return Number(v);
  return typeof v === "string" ? localStampLabel(v, "yyyy-MM-dd") : String(v);
}

/** The header of a total: "Sum of Total spend". */
export const totalHeader = (c: ResultColumn) =>
  c.agg === "none" ? c.label : `${AGG_LABEL[c.agg]} of ${c.label}`;

/** The type a column's total is in: a count is a whole number, the rest keep the column's type. */
export const totalType = (c: ResultColumn): FieldType =>
  c.agg === "count"
    ? "int"
    : c.type === "int" && c.agg === "avg"
      ? "number"
      : c.type;

export interface FlatTable {
  headers: string[];
  /** Each column's type on a client's row, and on a subtotal or total line (a count is a whole number). */
  types: FieldType[];
  totalTypes: FieldType[];
  /** Masked on a client's row: the cell is already the masked text. */
  masked: boolean[];
  rows: { kind: "row" | "group" | "total"; level: number; cells: Cell[] }[];
}

export type RowNoun =
  | "client"
  | "event"
  | "ticket"
  | "appointment"
  | "barber"
  | "product"
  | "tip"
  | "message";

const NOUNS: Record<ReportSource, RowNoun> = {
  customers: "client",
  events: "event",
  sales: "ticket",
  appointments: "appointment",
  staff: "barber",
  inventory: "product",
  tips: "tip",
  campaigns: "message",
};
export const nounOf = (s: ReportSource): RowNoun => NOUNS[s] ?? "client";

/** "Clients", "Tickets": the count column of a summary. */
export const nounHeader = (n: RowNoun) =>
  `${n[0].toUpperCase()}${n.slice(1)}s`;

const plural = (n: number, w: string) =>
  `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/**
 * The report as one flat table for CSV, Excel and PDF. Grouped, each row carries its group values
 * and each group gets a subtotal line before its clients; a summary is one line per group with
 * its client count and the totalled columns. The grand total comes last.
 */
export function flatTable(
  r: Pick<ReportResult, "columns" | "groupBy" | "lines" | "totals" | "noun">,
  summary: boolean,
): FlatTable {
  const g = r.groupBy;
  const noun = r.noun ?? "client";
  if (summary && g.length) {
    const cols = r.columns
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.agg !== "none");
    const rows: FlatTable["rows"] = r.lines.flatMap((l) =>
      l.kind === "group"
        ? [
            {
              kind: "row" as const,
              level: 0,
              cells: [...l.values, l.count, ...cols.map((x) => l.cells[x.i])],
            },
          ]
        : [],
    );
    if (r.totals)
      rows.push({
        kind: "total",
        level: 0,
        cells: [
          `Total (${plural(r.totals.count, noun)})`,
          ...g.slice(1).map(() => null),
          r.totals.count,
          ...cols.map((x) => r.totals!.cells[x.i]),
        ],
      });
    return {
      headers: [
        ...g.map((x) => x.label),
        nounHeader(noun),
        ...cols.map((x) => totalHeader(x.c)),
      ],
      types: [
        ...g.map(() => "text" as FieldType),
        "int",
        ...cols.map((x) => totalType(x.c)),
      ],
      totalTypes: [
        ...g.map(() => "text" as FieldType),
        "int",
        ...cols.map((x) => totalType(x.c)),
      ],
      masked: [...g.map(() => false), false, ...cols.map(() => false)],
      rows,
    };
  }
  const lead = !g.length && !!r.totals;
  const headers = [
    ...(lead ? [""] : []),
    ...g.map((x) => x.label),
    ...r.columns.map((c) => c.label),
  ];
  const types: FieldType[] = [
    ...(lead ? ["text" as FieldType] : []),
    ...g.map(() => "text" as FieldType),
    ...r.columns.map((c) => c.type),
  ];
  const masked = [
    ...(lead ? [false] : []),
    ...g.map(() => false),
    ...r.columns.map((c) => c.masked),
  ];
  const rows: FlatTable["rows"] = [];
  let current: string[] = [];
  for (const l of r.lines) {
    if (l.kind === "group") {
      current = [...current.slice(0, l.level), l.values[l.level]];
      const vals = g.map((_, i) =>
        i < l.level
          ? l.values[i]
          : i === l.level
            ? `${l.values[i]} (subtotal, ${plural(l.count, noun)})`
            : null,
      );
      rows.push({
        kind: "group",
        level: l.level,
        cells: [
          ...vals,
          ...l.cells.map((c, i) => (r.columns[i].agg === "none" ? null : c)),
        ],
      });
    } else
      rows.push({
        kind: "row",
        level: 0,
        cells: [
          ...(lead ? [null] : []),
          ...g.map((_, i) => current[i] ?? null),
          ...l.cells,
        ],
      });
  }
  if (r.totals) {
    const label = `Total (${plural(r.totals.count, noun)})`;
    rows.push({
      kind: "total",
      level: 0,
      cells: [
        ...(lead ? [label] : g.map((_, i) => (i === 0 ? label : null))),
        ...r.totals.cells,
      ],
    });
  }
  const totalTypes: FieldType[] = [
    ...(lead ? ["text" as FieldType] : []),
    ...g.map(() => "text" as FieldType),
    ...r.columns.map(totalType),
  ];
  return { headers, types, totalTypes, masked, rows };
}

// ───────────────────────────── Saving and sharing ─────────────────────────────

export const VISIBILITIES = ["private", "roles", "template"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: "Only me",
  roles: "Shared with roles",
  template: "Brand template (everyone with custom reports)",
};

export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const FORMATS = ["none", "csv", "xlsx", "pdf"] as const;
export type ExportFormat = Exclude<(typeof FORMATS)[number], "none">;
export const FORMAT_LABEL: Record<(typeof FORMATS)[number], string> = {
  none: "No attachment",
  csv: "CSV",
  xlsx: "Excel",
  pdf: "PDF",
};
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const ReportSchedule = z.object({
  frequency: z.enum(FREQUENCIES),
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekday: z.number().int().min(0).max(6).default(1),
  /** Monthly: the day of the month, up to the 28th so every month has it. */
  monthDay: z.number().int().min(1).max(28).default(1),
  /** Local minutes after midnight. */
  timeMin: z
    .number()
    .int()
    .min(0)
    .max(1439)
    .default(7 * 60),
  /** The file attached for recipients who may export it. */
  format: z.enum(FORMATS).default("csv"),
  /** Staff who get it; each must be able to open the report. */
  recipients: z.array(z.uuid()).max(50, "Up to 50 recipients").default([]),
});
export type ReportSchedule = z.output<typeof ReportSchedule>;

export const SavedReportInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name the report")
    .max(80, "Keep the name under 80 characters"),
  description: z
    .string()
    .trim()
    .max(300, "Keep the description under 300 characters")
    .default(""),
  visibility: z.enum(VISIBILITIES).default("private"),
  roleIds: z.array(z.uuid()).max(30).default([]),
  schedule: ReportSchedule.nullable().default(null),
  morning: z.boolean().default(false),
  definition: ReportDefinition,
});
export type SavedReportInput = z.output<typeof SavedReportInput>;

/** Whether a schedule sends on this day. */
export function sendsOn(s: ReportSchedule, day: LocalDate): boolean {
  if (s.frequency === "daily") return true;
  if (s.frequency === "weekly") return weekdayOf(day) === s.weekday;
  return Number(day.slice(8, 10)) === s.monthDay;
}

/** The day this run sends for, or null: it's a sending day and past the time. A late run still sends that day; the next day is a new period. */
export const duePeriod = (
  s: ReportSchedule,
  today: LocalDate,
  nowMin: number,
): LocalDate | null =>
  sendsOn(s, today) && nowMin >= s.timeMin ? today : null;

/** The next day it sends, from today on. */
export function nextSend(
  s: ReportSchedule,
  today: LocalDate,
  nowMin: number,
): LocalDate {
  for (let i = 0; i < 62; i++) {
    const d = addDays(today, i);
    if (sendsOn(s, d) && (i > 0 || nowMin < s.timeMin)) return d;
  }
  return today;
}

const clock = (min: number) => minutesToLabel(min);
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export function scheduleLabel(s: ReportSchedule): string {
  const when =
    s.frequency === "daily"
      ? "Every day"
      : s.frequency === "weekly"
        ? `Every ${WEEKDAYS[s.weekday]}`
        : `The ${ordinal(s.monthDay)} of every month`;
  return `${when} at ${clock(s.timeMin)}${s.format === "none" ? "" : `, with ${FORMAT_LABEL[s.format]}`}`;
}

// ───────────────────────────── Campaign Center ─────────────────────────────

/**
 * A customer report's clients as a Campaign Center blast: its filters, its barbers (any visit with
 * them) and, for clients with a visit in a range that runs to today, a last visit since its start.
 * Its locations become the blast's locations, which go by a client's last visit or home location.
 * A range that ended before today can't be written as a segment, so it's left out and the notes say so.
 */
export function segmentFromReport(
  def: ReportDefinition,
  scope: { shopIds: string[] | null; staffIds: string[] | null },
  today: LocalDate,
  cal?: BrandCalendar,
): { segment: Segment; shopIds: string[]; notes: string[] } {
  const seg: Segment = { ...def.filter };
  const notes: string[] = [];
  if (scope.staffIds?.length) {
    seg.staffIds = [...scope.staffIds];
    seg.barberMatch = "any";
  }
  const range = reportRange(def.range, today, cal);
  const visited = def.rows === "visited" || !!scope.staffIds?.length;
  if (visited && range) {
    if (range.to >= today) {
      if (!seg.lastVisitFrom || seg.lastVisitFrom < range.from)
        seg.lastVisitFrom = range.from;
    } else
      notes.push(
        "The report's dates end before today, so the blast isn't limited to them. Add a last-visit filter in the blast if you need one.",
      );
  }
  if (scope.shopIds)
    notes.push(
      "The blast goes to the report's locations, by each client's last visit (or home location when they haven't visited).",
    );
  if (scope.staffIds?.length)
    notes.push('Barbers become "any visit with" those barbers.');
  notes.push(
    "Only clients who agreed to marketing on the blast's channel get it.",
  );
  return {
    segment: seg,
    shopIds: scope.shopIds ? [...scope.shopIds] : [],
    notes,
  };
}
