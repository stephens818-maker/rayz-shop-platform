/**
 * Calendar invites (RFC 5545) for appointments and family bookings: served at /a/<code>/calendar.ics
 * and /g/<code>/calendar.ics and attached to confirmation and reschedule emails. LOCATION is the
 * shop's full address and GEO its map pin, so calendar apps offer directions; the description has
 * the shop's phone and parking notes.
 */

export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  geo?: { lat: number; lng: number } | null;
  url?: string | null;
  /** CANCELLED for a cancelled appointment, so calendars remove it. */
  status?: "CONFIRMED" | "CANCELLED";
  /** Bumped whenever the appointment changes, so calendars take the new time. */
  sequence?: number;
  now?: Date;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** TEXT values: backslash, semicolon, comma and newlines escaped. */
export const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets are folded with CRLF and a space, without splitting a character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      len = 0;
    }
    cur += ch;
    len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function icsCalendar(events: readonly IcsEvent[], o: { method?: "PUBLISH" | "REQUEST"; name?: string } = {}): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Rayz Barber Shop//Booking//EN", "CALSCALE:GREGORIAN", `METHOD:${o.method ?? "PUBLISH"}`];
  if (o.name) lines.push(`X-WR-CALNAME:${icsText(o.name)}`);
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp(e.now ?? new Date())}`,
      `DTSTART:${stamp(e.start)}`,
      `DTEND:${stamp(e.end)}`,
      `SEQUENCE:${e.sequence ?? 0}`,
      `STATUS:${e.status ?? "CONFIRMED"}`,
      `SUMMARY:${icsText(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.geo) lines.push(`GEO:${e.geo.lat.toFixed(6)};${e.geo.lng.toFixed(6)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if ((e.status ?? "CONFIRMED") === "CONFIRMED" && e.start.getTime() > (e.now ?? new Date()).getTime())
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(e.summary)}`, "TRIGGER:-PT1H", "END:VALARM");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** What an appointment's invite says about where it is. */
export function locationDescription(o: { phone: string | null; directions: string | null; manageUrl: string; mapUrl: string | null; extra?: string[] }): string {
  return [
    ...(o.extra ?? []),
    o.phone ? `Shop phone: ${o.phone}` : null,
    o.directions ? `Parking and directions: ${o.directions}` : null,
    o.mapUrl ? `Map: ${o.mapUrl}` : null,
    `View, change or cancel: ${o.manageUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}
