import { DateTime } from "luxon";
import { phoneState, phoneTimeZone } from "./area-codes";

/**
 * When marketing may reach someone: 8 AM to 9 PM in the recipient's time (TCPA), 8 PM in states whose
 * own laws stop earlier, and never inside the brand's own quiet hours (set in each location's time). The
 * legal window is checked in the recipient's zone (by area code) and the shop's, so a wrong guess about
 * the number never sends at night where the shop is.
 */
export const LEGAL_START = 8 * 60;
export const LEGAL_END = 21 * 60;
/** Florida (FTSA), Oklahoma (OTSA) and Maryland (Stop the Spam Calls Act) end at 8 PM. */
const EARLIER_END: Record<string, number> = { FL: 20 * 60, OK: 20 * 60, MD: 20 * 60 };

export interface QuietWindow {
  /** "HH:MM"; equal start and end means none. */
  quietStart: string;
  quietEnd: string;
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const inBrandQuiet = (m: number, q: QuietWindow | null) => {
  if (!q) return false;
  const a = toMin(q.quietStart);
  const b = toMin(q.quietEnd);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
};

export function legalEnd(phone: string | null | undefined) {
  const state = phoneState(phone);
  return (state && EARLIER_END[state]) || LEGAL_END;
}

/** The zones a message to this number has to be inside the window in. */
export function recipientZones(phone: string | null | undefined, shopTimeZone: string) {
  const z = phoneTimeZone(phone);
  return z && z !== shopTimeZone ? [z, shopTimeZone] : [shopTimeZone];
}

/** The legal window in every zone; the brand's quiet hours, which are set per location, in the shop's. */
export function mayMarketAt(at: Date, phone: string | null | undefined, shopTimeZone: string, brand: QuietWindow | null = null) {
  const end = legalEnd(phone);
  const minutes = (zone: string) => {
    const l = DateTime.fromJSDate(at).setZone(zone);
    return l.hour * 60 + l.minute;
  };
  if (inBrandQuiet(minutes(shopTimeZone), brand)) return false;
  return recipientZones(phone, shopTimeZone).every((zone) => {
    const m = minutes(zone);
    return m >= LEGAL_START && m < end;
  });
}

/** Now when allowed, else the first quarter hour that is (within two days; none at all means the brand's settings leave no window). */
export function nextMarketingTime(now: Date, phone: string | null | undefined, shopTimeZone: string, brand: QuietWindow | null = null): Date | null {
  if (mayMarketAt(now, phone, shopTimeZone, brand)) return now;
  const step = 15 * 60_000;
  let t = Math.ceil(now.getTime() / step) * step;
  for (let i = 0; i < 4 * 48; i++, t += step) if (mayMarketAt(new Date(t), phone, shopTimeZone, brand)) return new Date(t);
  return null;
}
