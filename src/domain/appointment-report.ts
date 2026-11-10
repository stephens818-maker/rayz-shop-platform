/**
 * The Appointments report's filters: shop and barber (the usual report scope), plus payment,
 * booking method, status and platform. Platform is where the booking was made, from its source.
 */

export const BOOKING_METHODS = ["online", "api", "staff", "walk_in", "rebook", "import"] as const;
export type BookingMethod = (typeof BOOKING_METHODS)[number];
export const BOOKING_METHOD_LABEL: Record<BookingMethod, string> = {
  online: "Booking site",
  api: "Rayz app",
  staff: "Front desk",
  walk_in: "Walk-in",
  rebook: "Rebooked at checkout",
  import: "Imported from Squire",
};

export const PLATFORMS = ["web", "app", "in_shop", "import"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABEL: Record<Platform, string> = { web: "Web", app: "App", in_shop: "In shop", import: "Import" };

export function platformOf(source: string): Platform {
  if (source === "online") return "web";
  if (source === "api") return "app";
  if (source === "import") return "import";
  return "in_shop";
}

export const APPOINTMENT_STATUSES = ["booked", "confirmed", "checked_in", "in_service", "completed", "cancelled", "no_show"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_service: "In the chair",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export const PAYMENT_FILTERS = ["card", "cash", "gift_card", "split", "unpaid"] as const;
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number];
export const PAYMENT_LABEL: Record<PaymentFilter, string> = { card: "Card", cash: "Cash", gift_card: "Gift card", split: "Split", unpaid: "Unpaid" };

/** How an appointment was paid, from the methods of its ticket's successful payments. */
export function paymentOf(methods: readonly string[] | null | undefined): PaymentFilter {
  const m = [...new Set(methods ?? [])];
  if (m.length === 0) return "unpaid";
  if (m.length > 1) return "split";
  return m[0] === "card" || m[0] === "cash" || m[0] === "gift_card" ? m[0] : "unpaid";
}

export interface AppointmentFilters {
  payment: PaymentFilter | null;
  method: BookingMethod | null;
  status: AppointmentStatus | null;
  platform: Platform | null;
}

const pick = <T extends string>(xs: readonly T[], v: string | undefined): T | null => (v && (xs as readonly string[]).includes(v) ? (v as T) : null);

export function parseAppointmentFilters(p: Record<string, string | undefined>): AppointmentFilters {
  return { payment: pick(PAYMENT_FILTERS, p.payment), method: pick(BOOKING_METHODS, p.method), status: pick(APPOINTMENT_STATUSES, p.status), platform: pick(PLATFORMS, p.platform) };
}

export interface AppointmentRowLike {
  status: string;
  source: string;
  methods: readonly string[] | null;
}

/** A gift card payment that also has a card or cash part counts as split, but matches the gift card filter too. */
export function matchesFilters(r: AppointmentRowLike, f: AppointmentFilters): boolean {
  if (f.status && r.status !== f.status) return false;
  if (f.method && r.source !== f.method) return false;
  if (f.platform && platformOf(r.source) !== f.platform) return false;
  if (f.payment) {
    const pay = paymentOf(r.methods);
    if (f.payment === "split" || f.payment === "unpaid") return pay === f.payment;
    if (!(r.methods ?? []).includes(f.payment)) return false;
  }
  return true;
}
