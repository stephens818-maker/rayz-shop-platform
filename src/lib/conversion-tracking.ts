/**
 * Booking-site conversion events for the brand's (or a location's) GA4 property and Meta Pixel.
 * The tags are loaded by BookingTracking only when an ID is set; without them these are no-ops.
 * Events carry the shop and step only: never client names, phone numbers or emails.
 */

type Gtag = (cmd: "event", name: string, params?: Record<string, unknown>) => void;
type Fbq = (cmd: "track" | "trackCustom", name: string, params?: Record<string, unknown>) => void;

/** Funnel step → GA4 event and Meta standard event. Steps not listed send nothing. */
export const CONVERSION_EVENTS: Record<string, { ga4: string; meta: string | null }> = {
  viewed: { ga4: "booking_view", meta: null },
  service_picked: { ga4: "booking_service", meta: "ViewContent" },
  time_picked: { ga4: "booking_time", meta: null },
  details: { ga4: "booking_details", meta: "InitiateCheckout" },
  booked: { ga4: "book_appointment", meta: "Schedule" },
};

export function trackBookingStep(step: string, data: { shop: string; channel: string; appointment?: unknown }) {
  const e = CONVERSION_EVENTS[step];
  if (!e || typeof window === "undefined") return;
  const w = window as unknown as { gtag?: Gtag; fbq?: Fbq };
  const params = { shop: data.shop, channel: data.channel, ...(step === "booked" && typeof data.appointment === "string" ? { transaction_id: data.appointment } : {}) };
  try {
    w.gtag?.("event", e.ga4, params);
    if (e.meta) w.fbq?.("track", e.meta, { content_category: "appointment", shop: data.shop });
  } catch {
    // A broken tag must never stop a booking.
  }
}
