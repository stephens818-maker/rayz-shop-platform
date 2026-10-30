/**
 * Per-barber booking options. One person record works at several shops: a setting saved for "all
 * shops" applies wherever they work, a "this shop only" setting overrides it at one shop, and
 * anything left unset follows the shop. Staff booking from the calendar is never held to these
 * limits (as with the shop's own); they're for clients booking themselves.
 */

export const BOOKING_OPTION_KEYS = [
  "bookWithoutPayment",
  "bookingTip",
  "confirmationTip",
  "multipleServices",
  "trackTime",
  "maxDaysAhead",
  "minNoticeMinutes",
  "cancelCutoffMinutes",
  "barberIntervalMinutes",
] as const;
export type BookingOptionKey = (typeof BOOKING_OPTION_KEYS)[number];
export type BoolOptionKey = "bookWithoutPayment" | "bookingTip" | "confirmationTip" | "multipleServices" | "trackTime";
export type NumberOptionKey = Exclude<BookingOptionKey, BoolOptionKey>;
export type StaffBookingOptions = Partial<Record<BoolOptionKey, boolean> & Record<NumberOptionKey, number>>;

export interface OptionMeta {
  label: string;
  hint: string;
  kind: "bool" | "days" | "minutes";
  max?: number;
}

export const BOOKING_OPTION_META: Record<BookingOptionKey, OptionMeta> = {
  bookWithoutPayment: {
    label: "Book without payment",
    hint: "Clients can book online without a card on file. Off: the booking site sends them to the Rayz app (which saves a card) or the shop's phone.",
    kind: "bool",
  },
  bookingTip: { label: "Booking tip", hint: "Offer a tip while booking. It's filled in on the ticket at checkout, where it can be changed.", kind: "bool" },
  confirmationTip: { label: "Confirmation tip", hint: "Offer a tip on the confirmation and manage-booking page.", kind: "bool" },
  multipleServices: { label: "Multiple services", hint: "Clients can add add-ons to a service in one booking online. Off: one service per online booking.", kind: "bool" },
  trackTime: { label: "Track time", hint: "Ask for arrived, start and finish on their appointments, and count them in Service times.", kind: "bool" },
  maxDaysAhead: { label: "Max days ahead", hint: "How far out clients can book them.", kind: "days", max: 365 },
  minNoticeMinutes: { label: "Minimum notice", hint: "How soon before a start clients can still book it.", kind: "minutes", max: 7 * 24 * 60 },
  cancelCutoffMinutes: { label: "Cancellation cutoff", hint: "Online cancel and reschedule close this long before the appointment.", kind: "minutes", max: 7 * 24 * 60 },
  barberIntervalMinutes: { label: "Barber interval", hint: "Time held after each appointment before their next one (the shop's gap unless set).", kind: "minutes", max: 120 },
};

/** Defaults when neither the shop nor the barber says otherwise. */
export const BOOL_DEFAULTS: Record<BoolOptionKey, boolean> = { bookWithoutPayment: true, bookingTip: false, confirmationTip: false, multipleServices: true, trackTime: true };

export const isBoolKey = (k: BookingOptionKey): k is BoolOptionKey => BOOKING_OPTION_META[k].kind === "bool";

/** Keeps known keys with sane values; anything else is dropped. */
export function cleanBookingOptions(raw: unknown): StaffBookingOptions {
  if (!raw || typeof raw !== "object") return {};
  const out: StaffBookingOptions = {};
  for (const k of BOOKING_OPTION_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === "") continue;
    if (isBoolKey(k)) {
      if (typeof v === "boolean") out[k] = v;
    } else {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isInteger(n) && n >= 0 && n <= (BOOKING_OPTION_META[k].max ?? Infinity)) out[k] = n;
    }
  }
  return out;
}

export interface ShopBookingDefaults {
  bookingWindowDays: number;
  minLeadMinutes: number;
  cancelCutoffMinutes: number;
  bufferMinutes: number;
}

export type OptionSource = "shop" | "all_shops" | "this_shop";
export const OPTION_SOURCE_LABEL: Record<OptionSource, string> = { shop: "Shop default", all_shops: "All shops", this_shop: "This shop only" };

export type EffectiveOptions = { [K in BookingOptionKey]: { value: K extends BoolOptionKey ? boolean : number; source: OptionSource } };

const shopValue = (k: NumberOptionKey, s: ShopBookingDefaults) =>
  k === "maxDaysAhead" ? s.bookingWindowDays : k === "minNoticeMinutes" ? s.minLeadMinutes : k === "cancelCutoffMinutes" ? s.cancelCutoffMinutes : s.bufferMinutes;

/**
 * What applies to this barber at this shop and where each value comes from. A barber's limits can
 * be tighter or looser than the shop's, except max days ahead, which never runs past the shop's
 * booking window (the shop's booking site stops there).
 */
export function effectiveBookingOptions(shop: ShopBookingDefaults, all: StaffBookingOptions, here: StaffBookingOptions): EffectiveOptions {
  const out = {} as Record<BookingOptionKey, { value: boolean | number; source: OptionSource }>;
  for (const k of BOOKING_OPTION_KEYS) {
    const base = isBoolKey(k) ? BOOL_DEFAULTS[k] : shopValue(k, shop);
    out[k] = here[k] !== undefined ? { value: here[k]!, source: "this_shop" } : all[k] !== undefined ? { value: all[k]!, source: "all_shops" } : { value: base, source: "shop" };
  }
  out.maxDaysAhead.value = Math.min(Number(out.maxDaysAhead.value), shop.bookingWindowDays);
  return out as EffectiveOptions;
}

/** "2 hours", "1 day", "45 min", for limits shown on the staff page. */
export function minutesLabel(n: number): string {
  if (n === 0) return "none";
  if (n % 1440 === 0) return `${n / 1440} day${n === 1440 ? "" : "s"}`;
  if (n % 60 === 0) return `${n / 60} hour${n === 60 ? "" : "s"}`;
  return `${n} min`;
}
