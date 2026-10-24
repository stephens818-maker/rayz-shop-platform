import { z } from "zod";

/**
 * The event log (analytics_events): what each event means and what its measure columns hold. The
 * rows themselves are written by database triggers (drizzle/core_0059_analytics.sql) and, for the
 * booking funnel, by recordEvent. The README's event schema is checked against this list.
 */

export const ACTOR_KINDS = ["staff", "client", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Where an action happened. A booking's channel is how it was made. */
export const CHANNELS = {
  online: "Online booking (website or rebook link)",
  widget: "Booking widget on another website",
  app: "Ray'z app",
  walk_in: "Walk-in",
  phone: "Phone (booked by staff within 2 hours after the client called)",
  staff: "Staff screens",
  staff_app: "Staff's own phone or computer (time clock)",
  kiosk: "Shop kiosk",
  import: "Squire import",
  sms: "Text message",
  email: "Email",
  voice: "Voice call",
  push: "App notification",
  receipt: "Receipt",
  follow_up: "Review follow-up",
  assistant: "Rayz Assistant",
} as const;

export const DEVICES = {
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Computer",
  kiosk: "Shop kiosk",
  reader: "Card reader",
} as const;

export const CATEGORIES = {
  booking: "Bookings",
  funnel: "Online booking funnel",
  appointment: "Appointment flow",
  ticket: "Tickets",
  payment: "Payments",
  tip: "Tips",
  discount: "Coupons",
  inventory: "Retail stock",
  clock: "Time clock",
  block: "Block-outs",
  time_off: "Time off",
  staff: "Call-ins",
  message: "Messages",
  campaign: "Campaigns",
  review: "Reviews",
  badge: "Client badges",
  client: "Clients",
  visit: "Satisfaction",
  assistant: "Rayz Assistant",
  call: "Phone calls",
  walkin: "Walk-in list",
} as const;
export type EventCategory = keyof typeof CATEGORIES;

export interface EventDef {
  label: string;
  /** What fills minutes, value, amount_cents, quantity and subtype for this event, when they're used. */
  minutes?: string;
  value?: string;
  amount?: string;
  quantity?: string;
  subtype?: string;
  reason?: string;
}

export const EVENTS = {
  "booking.created": {
    label: "Booking made",
    minutes:
      "lead time: minutes from booking to the appointment (blank for imports without a booked-at time)",
    value: "booked minutes",
    amount: "estimate",
    subtype: "barber, any_barber, rebook or group",
  },
  "booking.rescheduled": {
    label: "Booking moved",
    minutes: "lead time to the new time",
    value: "minutes moved (negative is earlier)",
    amount: "estimate",
    subtype: "time, barber or time_and_barber",
  },
  "booking.confirmed": {
    label: "Booking confirmed",
    minutes: "minutes before the appointment",
  },
  "booking.cancelled": {
    label: "Booking cancelled",
    minutes: "lead time: minutes before the appointment",
    amount: "estimate",
    subtype: "in_time, late (inside the shop's cutoff) or after_start",
    reason: "the reason given",
  },
  "booking.restored": {
    label: "Cancellation or no-show undone",
    subtype: "what it was",
  },
  "funnel.viewed": { label: "Booking page opened" },
  "funnel.service_picked": {
    label: "Service picked",
    quantity: "services picked",
  },
  "funnel.barber_picked": {
    label: "Barber picked",
    subtype: "barber or any_barber",
  },
  "funnel.time_picked": {
    label: "Time picked",
    minutes: "lead time to the picked slot",
  },
  "funnel.details": { label: "Details step reached" },
  "funnel.booked": { label: "Booked from the funnel" },
  "funnel.abandoned": {
    label: "Left without booking",
    subtype: "the last step reached",
  },
  "appointment.arrived": {
    label: "Client arrived",
    minutes: "minutes after the booked start (negative is early)",
    subtype: "early, on_time, late or walk_in",
  },
  "appointment.started": {
    label: "Service started",
    minutes: "wait: minutes from arrival to start",
    value: "minutes after the booked start",
    subtype: "on_time, late or walk_in",
  },
  "appointment.finished": {
    label: "Service finished",
    minutes: "actual minutes in the chair",
    value: "booked minutes",
    subtype: "on_pace, over or under (5-minute tolerance)",
  },
  "appointment.times_corrected": {
    label: "Service times corrected",
    minutes: "actual minutes after the correction",
    value: "booked minutes",
    subtype: "include or exclude",
  },
  "appointment.completed": {
    label: "Appointment completed",
    value: "booked minutes",
    amount: "estimate",
  },
  "appointment.no_show": {
    label: "No-show",
    value: "booked minutes",
    amount: "estimate",
  },
  "ticket.opened": { label: "Ticket opened" },
  "ticket.discount_changed": {
    label: "Discount changed on an open ticket",
    amount: "discount now",
    value: "change in cents",
  },
  "ticket.reassigned": { label: "Ticket moved to another barber" },
  "ticket.paid": {
    label: "Ticket paid",
    amount:
      "net sales (services and products after discounts, before tax and tip)",
    value: "tip as a percent of net sales",
    quantity: "lines",
    subtype: "service_only, service_and_retail, retail_only or other",
  },
  "ticket.line": {
    label: "Line sold",
    amount: "line net",
    value: "unit price",
    quantity: "quantity",
    subtype: "service, addon, product or gift_card",
  },
  "ticket.price_override": {
    label: "Price changed at checkout",
    amount: "price charged",
    value: "catalog price",
    quantity: "quantity",
    reason: "the reason given",
  },
  "ticket.voided": {
    label: "Ticket voided",
    amount: "net sales",
    subtype: "its status before",
    reason: "the reason given",
  },
  "ticket.merged": {
    label: "Ticket combined into another",
    amount: "net sales",
  },
  "ticket.refunded": {
    label: "Refund",
    amount: "refunded",
    subtype: "card, cash or gift_card",
    reason: "the reason given",
  },
  "payment.taken": {
    label: "Payment taken",
    amount: "amount",
    subtype: "card, cash or gift_card",
  },
  "payment.failed": {
    label: "Payment failed",
    amount: "amount",
    subtype: "card, cash or gift_card",
  },
  "payment.voided": {
    label: "Payment reversed by a void",
    amount: "amount",
    subtype: "card, cash or gift_card",
    reason: "the reason given",
  },
  "tip.recorded": {
    label: "Tip",
    amount: "tip",
    value: "tip as a percent of the ticket's net sales",
    subtype: "card, cash or gift_card",
  },
  "discount.coupon_redeemed": {
    label: "Coupon used",
    amount: "discount",
    subtype: "how it was applied",
  },
  "discount.coupon_reversed": {
    label: "Coupon use reversed",
    amount: "discount",
  },
  "inventory.moved": {
    label: "Stock moved",
    quantity: "units (negative out)",
    value: "on hand after",
    amount: "cost of the units moved",
    subtype: "sale, receive, transfer, count and so on",
    reason: "the reason given",
  },
  "clock.in": {
    label: "Clocked in",
    value: "minutes off schedule",
    minutes: "planned minutes",
    subtype: "how it was checked (gps, network or device)",
  },
  "clock.out": {
    label: "Clocked out",
    value: "minutes off schedule",
    minutes: "planned minutes",
    subtype: "how it was checked",
  },
  "clock.break_start": {
    label: "Break started",
    value: "minutes off schedule",
    minutes: "planned minutes",
    subtype: "how it was checked",
  },
  "clock.break_end": {
    label: "Break ended",
    value: "minutes off schedule",
    subtype: "how it was checked",
  },
  "clock.edited": {
    label: "Punch edited",
    value: "minutes moved from the original time",
  },
  "clock.voided": { label: "Punch voided" },
  "block.added": {
    label: "Time blocked out",
    minutes: "length",
    value: "notice: minutes from adding it to its start",
    subtype: "lunch, time_off, other or day_off",
    reason: "the block-out reason (blank when the reason is private)",
  },
  "block.removed": {
    label: "Block-out removed",
    minutes: "length",
    value: "minutes before it would have started",
    subtype: "lunch, time_off, other or day_off",
  },
  "time_off.requested": {
    label: "Time off requested",
    minutes: "length",
    value: "notice in days",
    reason: "the reason (blank when private)",
  },
  "time_off.approved": {
    label: "Time off approved",
    minutes: "length",
    value: "hours to decide",
    subtype: "manager or auto",
  },
  "time_off.denied": {
    label: "Time off denied",
    minutes: "length",
    value: "hours to decide",
    subtype: "manager or auto",
  },
  "time_off.cancelled": { label: "Time off withdrawn", minutes: "length" },
  "staff.called_in": {
    label: "Call-in",
    minutes: "length",
    value: "notice: minutes from the call-in to its start",
    subtype: "kind",
    reason: "the reason (blank when private)",
  },
  "staff.call_in_cancelled": { label: "Call-in withdrawn", minutes: "length" },
  "message.queued": {
    label: "Message queued",
    value: "minutes until it's due",
    subtype: "kind (reminder_24h and so on)",
  },
  "message.sent": {
    label: "Message sent",
    quantity: "attempts",
    subtype: "kind",
  },
  "message.delivered": {
    label: "Message delivered",
    minutes: "minutes from sent to delivered",
    subtype: "kind",
  },
  "message.failed": {
    label: "Message failed",
    quantity: "attempts",
    subtype: "kind",
  },
  "message.suppressed": {
    label: "Message not sent (opted out or quiet hours)",
    subtype: "kind",
  },
  "message.cancelled": { label: "Message cancelled", subtype: "kind" },
  "campaign.sent": { label: "Campaign message sent", amount: "cost" },
  "campaign.skipped": { label: "Campaign message skipped", subtype: "why" },
  "campaign.clicked": {
    label: "Campaign link clicked",
    minutes: "minutes from send to first click",
    quantity: "clicks so far",
  },
  "campaign.booked": {
    label: "Booking after a campaign message",
    amount: "estimate",
    subtype: "clicked or sent (inside the attribution window)",
  },
  "review.clicked": {
    label: "Google review link clicked",
    subtype: "receipt or follow_up",
  },
  "badge.earned": { label: "Badge earned", subtype: "badge" },
  "badge.lost": { label: "Badge lost", subtype: "badge" },
  "client.created": { label: "New client", subtype: "referred or dependent" },
  "client.source_set": {
    label: "How they found us changed",
    subtype: "referred",
  },
  "client.removed": {
    label: "Client record erased",
    quantity: "events made anonymous",
  },
  "visit.satisfaction": {
    label: "Post-visit rating",
    value: "1 to 5",
    subtype: "receipt or app",
  },
  "assistant.asked": { label: "Assistant question", value: "characters" },
  "assistant.answered": {
    label: "Assistant answer",
    quantity: "tools used",
    value: "characters",
  },
  "call.received": { label: "Call to the shop", subtype: "kind" },
  "call.placed": { label: "Call from the shop", subtype: "kind" },
  "call.answered": {
    label: "Call answered",
    minutes: "minutes to answer",
    subtype: "kind",
  },
  "call.completed": {
    label: "Call ended",
    minutes: "call length",
    subtype: "kind",
  },
  "call.missed": {
    label: "Call not answered",
    minutes: "call length",
    subtype: "missed, after_hours, voicemail, no_answer, busy or failed",
  },
  "call.booked": { label: "Booking after a call", amount: "estimate" },
  "walkin.joined": { label: "Joined the walk-in list", value: "quoted wait" },
  "walkin.notified": {
    label: "Walk-in told they're next",
    minutes: "minutes waited",
    value: "quoted wait",
  },
  "walkin.serving": {
    label: "Walk-in in the chair",
    minutes: "minutes waited",
    value: "quoted wait",
  },
  "walkin.done": {
    label: "Walk-in done",
    minutes: "minutes from joining",
    value: "quoted wait",
  },
  "walkin.left": {
    label: "Walk-in left",
    minutes: "minutes waited",
    value: "quoted wait",
  },
} as const satisfies Record<string, EventDef>;
export type EventName = keyof typeof EVENTS;

export const eventCategory = (e: string) => e.split(".")[0] as EventCategory;
export const eventLabel = (e: string) =>
  (EVENTS as Record<string, EventDef>)[e]?.label ?? e;

/** The columns of a row, in export order. Contact details, names, message text and card data never appear. */
export const EVENT_COLUMNS = [
  {
    key: "id",
    label: "Event id",
    doc: "Increasing number; the warehouse copy resumes from the last one sent.",
  },
  { key: "occurred_at", label: "When", doc: "When it happened (UTC)." },
  {
    key: "recorded_at",
    label: "Recorded",
    doc: "When it was logged (later than When for backfilled history).",
  },
  {
    key: "business_date",
    label: "Business day",
    doc: "The location's local date.",
  },
  {
    key: "event",
    label: "Event",
    doc: "category.action, from the list below.",
  },
  { key: "category", label: "Category", doc: "The part before the dot." },
  { key: "shop_id", label: "Location", doc: "Where it happened." },
  { key: "actor_kind", label: "Actor", doc: "staff, client or system." },
  {
    key: "actor_staff_id",
    label: "Done by",
    doc: "The staff member who did it, when it was staff.",
  },
  {
    key: "staff_id",
    label: "Barber",
    doc: "The barber or employee it's about.",
  },
  {
    key: "customer_id",
    label: "Client",
    doc: "The client it's about (cleared if the client is erased).",
  },
  {
    key: "channel",
    label: "Channel",
    doc: "Where it happened: online, app, walk_in, phone, staff, kiosk, import, sms, email and so on.",
  },
  {
    key: "device",
    label: "Device",
    doc: "phone, tablet, desktop, kiosk or reader, when known.",
  },
  {
    key: "source",
    label: "Source",
    doc: "Booking source on appointment events; how they found us on client events.",
  },
  {
    key: "entity",
    label: "Record type",
    doc: "appointment, ticket, payment, client, campaign and so on.",
  },
  { key: "entity_id", label: "Record id", doc: "That record's id." },
  {
    key: "appointment_id",
    label: "Appointment",
    doc: "The appointment, when there is one.",
  },
  { key: "sale_id", label: "Ticket", doc: "The ticket, when there is one." },
  {
    key: "amount_cents",
    label: "Amount (cents)",
    doc: "The money measure (see each event).",
  },
  { key: "quantity", label: "Quantity", doc: "A count (see each event)." },
  { key: "minutes", label: "Minutes", doc: "A duration (see each event)." },
  {
    key: "value",
    label: "Value",
    doc: "Another measure: a percent, a rating, a count of minutes (see each event).",
  },
  {
    key: "subtype",
    label: "Subtype",
    doc: "A short code that splits the event (see each event).",
  },
  {
    key: "reason",
    label: "Reason",
    doc: "The reason given, for cancellations, voids, refunds, price changes, stock and block-outs.",
  },
  {
    key: "props",
    label: "Details",
    doc: "More ids, numbers and codes, as JSON.",
  },
] as const;
export type EventColumn = (typeof EVENT_COLUMNS)[number]["key"];

// ───────────────────────────── Booking funnel ─────────────────────────────

export const FUNNEL_STEPS = [
  "viewed",
  "service_picked",
  "barber_picked",
  "time_picked",
  "details",
  "booked",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
/** A funnel with no booking this long after its last step counts as abandoned. */
export const FUNNEL_ABANDON_MINUTES = 60;

/** An id, or the slug or code the booking pages use. */
const ref = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,80}$/, "Bad reference");

export const funnelBeacon = z.object({
  funnel: z.string().regex(/^[A-Za-z0-9_-]{12,40}$/, "Bad funnel id"),
  step: z.enum(FUNNEL_STEPS),
  /** The shop's id or slug. */
  shop: ref,
  services: z.array(z.string().uuid()).max(10).optional(),
  /** The barber's id or booking slug; null or left out for any barber. */
  staff: ref.nullish(),
  anyBarber: z.boolean().optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  /** The booked step: the new appointment's id or code. */
  appointment: ref.optional(),
  channel: z.enum(["online", "widget", "app"]).optional(),
});
export type FunnelBeacon = z.infer<typeof funnelBeacon>;

/** phone, tablet or desktop from a User-Agent; null when there's none. */
export function deviceClass(
  ua: string | null | undefined,
): "phone" | "tablet" | "desktop" | null {
  if (!ua) return null;
  if (/iPad|Tablet|PlayBook|Silk|Kindle|(Android(?!.*Mobile))/i.test(ua))
    return "tablet";
  if (/Mobi|iPhone|iPod|Android|BlackBerry|IEMobile|Opera Mini/i.test(ua))
    return "phone";
  return "desktop";
}

// ───────────────────────────── Settings ─────────────────────────────

/** Source tables the backfill walks, in order. */
export const BACKFILL_TABLES = [
  "customers",
  "appointments",
  "appointment_times",
  "sales",
  "sale_items",
  "refunds",
  "payments",
  "coupon_redemptions",
  "inventory_ledger",
  "time_punches",
  "time_blocks",
  "time_off_requests",
  "call_ins",
  "notification_jobs",
  "marketing_sends",
  "review_clicks",
  "client_badges",
  "assistant_messages",
  "call_logs",
  "waitlist_entries",
  "visit_satisfaction",
] as const;

export interface AnalyticsSettings {
  /** Ask every client "How was your visit?" 1-5 on their receipt. */
  satisfaction: boolean;
  /** Copy new events nightly to the warehouse at ANALYTICS_WAREHOUSE_URL. */
  warehouse: boolean;
  /** Source tables whose history has been logged. */
  backfilled: string[];
}

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  satisfaction: false,
  warehouse: false,
  backfilled: [],
};

export function analyticsSettings(raw: unknown): AnalyticsSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof AnalyticsSettings, unknown>
  >;
  const tables = new Set<string>(BACKFILL_TABLES);
  return {
    satisfaction: r.satisfaction === true,
    warehouse: r.warehouse === true,
    backfilled: Array.isArray(r.backfilled)
      ? r.backfilled.filter(
          (t): t is string => typeof t === "string" && tables.has(t),
        )
      : [],
  };
}

export const analyticsSettingsInput = z.object({
  satisfaction: z.boolean(),
  warehouse: z.boolean(),
});
