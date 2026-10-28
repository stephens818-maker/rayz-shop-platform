import { DateTime } from "luxon";
import { phoneTimeZone } from "./area-codes";

/**
 * When automated texts and push may reach someone: 9 AM to 8 PM in the recipient's time (Charles chose
 * the stricter window on Oct 28; it sits inside every state's own law, including Florida, Oklahoma and
 * Maryland's 8 PM), and never inside the brand's own quiet hours (set in each location's time). The
 * window is checked in the recipient's zone (by area code) and the shop's, so a wrong guess about the
 * number never sends at night where the shop is.
 */
export const SEND_START = 9 * 60;
export const SEND_END = 20 * 60;

/** Outside 9 AM to 8 PM at this local time (minutes after midnight). */
export const outsideSendWindow = (minutes: number) => minutes < SEND_START || minutes >= SEND_END;

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

/** The zones a message to this number has to be inside the window in. */
export function recipientZones(phone: string | null | undefined, shopTimeZone: string) {
  const z = phoneTimeZone(phone);
  return z && z !== shopTimeZone ? [z, shopTimeZone] : [shopTimeZone];
}

/** The send window in every zone; the brand's quiet hours, which are set per location, in the shop's. */
export function mayMarketAt(at: Date, phone: string | null | undefined, shopTimeZone: string, brand: QuietWindow | null = null) {
  const minutes = (zone: string) => {
    const l = DateTime.fromJSDate(at).setZone(zone);
    return l.hour * 60 + l.minute;
  };
  if (inBrandQuiet(minutes(shopTimeZone), brand)) return false;
  return recipientZones(phone, shopTimeZone).every((zone) => !outsideSendWindow(minutes(zone)));
}

/** Now when allowed, else the first quarter hour that is (within two days; none at all means the brand's settings leave no window). */
export function nextMarketingTime(now: Date, phone: string | null | undefined, shopTimeZone: string, brand: QuietWindow | null = null): Date | null {
  if (mayMarketAt(now, phone, shopTimeZone, brand)) return now;
  const step = 15 * 60_000;
  let t = Math.ceil(now.getTime() / step) * step;
  for (let i = 0; i < 4 * 48; i++, t += step) if (mayMarketAt(new Date(t), phone, shopTimeZone, brand)) return new Date(t);
  return null;
}
