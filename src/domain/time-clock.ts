/**
 * The time clock's rules, kept pure: pairing punches into shifts and breaks, paid and unpaid break
 * time, early and late against the schedule, how a punch is verified (registered device, GPS geofence,
 * the shop's network), PINs, the rolling full-time/part-time average and the payroll export lines.
 * The server (src/server/time-clock.ts) loads the rows and calls these.
 */
import { z } from "zod";
import type { LocalDate } from "@/lib/time";
import { existingWallTime, localDateOf, toZoned, zonedWallTime } from "@/lib/time";
import { minutesToCenti } from "./payroll/overtime";

/**
 * A shop wall-clock time ("2026-11-01T01:30") as an instant. Null for the hour skipped when clocks
 * spring forward. In the hour repeated when they fall back, `later` picks the second one.
 */
export function wallInstant(local: string, later = false): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) return null;
  const dt = existingWallTime(m[1], Number(m[2]) * 60 + Number(m[3]));
  if (!dt || !dt.isValid) return null;
  const alt = dt.plus({ hours: 1 });
  return later && alt.hour === dt.hour && alt.minute === dt.minute ? alt.toJSDate() : dt.toJSDate();
}

/** Whether a wall-clock time falls in the hour that happens twice when clocks fall back. */
export function isRepeatedWallTime(local: string): boolean {
  const a = wallInstant(local, false);
  const b = wallInstant(local, true);
  return !!a && !!b && a.getTime() !== b.getTime();
}

/** The wall-clock form of an instant, for an edit field: the inverse of wallInstant. */
export function wallStamp(at: Date | string): { local: string; later: boolean } {
  const z = toZoned(at);
  const local = z.toFormat("yyyy-MM-dd'T'HH:mm");
  return { local, later: wallInstant(local, false)?.getTime() !== z.startOf("minute").toMillis() };
}

export type PunchType = "in" | "out" | "break_start" | "break_end";
export const PUNCH_LABEL: Record<PunchType, string> = { in: "Clock in", out: "Clock out", break_start: "Start break", break_end: "End break" };

export interface PunchLike {
  id: string;
  staffId: string;
  shopId: string;
  type: PunchType;
  at: Date;
}

// ───────────────────────────── Pairing ─────────────────────────────

export type PairProblemKind = "open_shift" | "double_in" | "out_without_in" | "break_outside_shift" | "break_end_without_start" | "break_not_ended" | "double_break";

export const PROBLEM_LABEL: Record<PairProblemKind, string> = {
  open_shift: "No clock-out",
  double_in: "Clocked in again without clocking out",
  out_without_in: "Clock-out with no clock-in",
  break_outside_shift: "Break started while not clocked in",
  break_end_without_start: "Break ended that never started",
  break_not_ended: "Break never ended (closed at clock-out)",
  double_break: "Break started twice",
};

export interface Break {
  startId: string;
  endId: string | null;
  start: Date;
  /** Null while the break is still going. */
  end: Date | null;
}

export interface Shift {
  staffId: string;
  shopId: string;
  inId: string;
  outId: string | null;
  start: Date;
  /** Null while clocked in (or a forgotten clock-out). */
  end: Date | null;
  breaks: Break[];
}

export interface PairProblem {
  kind: PairProblemKind;
  punchId: string;
  staffId: string;
  shopId: string;
  at: Date;
}

const TYPE_ORDER: Record<PunchType, number> = { in: 0, break_start: 1, break_end: 2, out: 3 };

/**
 * Punches in time order become shifts: an in opens one, breaks nest inside it, an out closes it.
 * Anything that doesn't fit is a problem for a manager, never silently dropped or guessed at.
 */
export function pairPunches(punches: readonly PunchLike[]): { shifts: Shift[]; problems: PairProblem[] } {
  const shifts: Shift[] = [];
  const problems: PairProblem[] = [];
  const byStaff = new Map<string, PunchLike[]>();
  for (const p of punches) byStaff.set(p.staffId, [...(byStaff.get(p.staffId) ?? []), p]);
  for (const list of byStaff.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime() || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    let cur: Shift | null = null;
    const problem = (kind: PairProblemKind, p: PunchLike) => problems.push({ kind, punchId: p.id, staffId: p.staffId, shopId: p.shopId, at: p.at });
    for (const p of list) {
      const openBreak: Break | undefined = cur?.breaks.find((b) => b.end === null);
      if (p.type === "in") {
        if (cur) {
          problem("double_in", p);
          shifts.push(cur);
        }
        cur = { staffId: p.staffId, shopId: p.shopId, inId: p.id, outId: null, start: p.at, end: null, breaks: [] };
      } else if (p.type === "break_start") {
        if (!cur) problem("break_outside_shift", p);
        else if (openBreak) problem("double_break", p);
        else cur.breaks.push({ startId: p.id, endId: null, start: p.at, end: null });
      } else if (p.type === "break_end") {
        if (!cur || !openBreak) problem("break_end_without_start", p);
        else {
          openBreak.endId = p.id;
          openBreak.end = p.at;
        }
      } else {
        if (!cur) {
          problem("out_without_in", p);
          continue;
        }
        if (openBreak) {
          openBreak.end = p.at;
          problem("break_not_ended", p);
        }
        cur.outId = p.id;
        cur.end = p.at;
        shifts.push(cur);
        cur = null;
      }
    }
    if (cur) shifts.push(cur);
  }
  for (const s of shifts) if (s.end === null) problems.push({ kind: "open_shift", punchId: s.inId, staffId: s.staffId, shopId: s.shopId, at: s.start });
  shifts.sort((a, b) => a.start.getTime() - b.start.getTime());
  problems.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { shifts, problems };
}

/** Where someone stands right now from their punches: off, working at a shop, or on a break there. */
export function clockStatus(punches: readonly PunchLike[]): { state: "off" | "working" | "on_break"; shift: Shift | null } {
  const { shifts } = pairPunches(punches);
  const open = [...shifts].reverse().find((s) => s.end === null) ?? null;
  if (!open) return { state: "off", shift: null };
  return { state: open.breaks.some((b) => b.end === null) ? "on_break" : "working", shift: open };
}

/** Which punches make sense next. */
export function allowedNext(state: "off" | "working" | "on_break"): PunchType[] {
  return state === "off" ? ["in"] : state === "working" ? ["break_start", "out"] : ["break_end", "out"];
}

// ───────────────────────────── Breaks and paid time ─────────────────────────────

export interface ClockRules {
  /**
   * Breaks this long or longer are unpaid meal breaks; shorter ones are paid rest breaks (the federal
   * FLSA treats 5–20 minute rests as work time). 0 = every break is unpaid.
   */
  unpaidBreakFromMinutes: number;
  /** Unpaid meal minutes taken off a shift longer than autoMealAfterHours when no unpaid break was punched. 0 = off. */
  autoMealMinutes: number;
  autoMealAfterHours: number;
  /** A shift still open this long after its scheduled end is a forgotten clock-out. */
  forgotOutAfterMinutes: number;
  /** With no schedule that day: a shift open this long is a forgotten clock-out. */
  maxShiftHours: number;
  /** Minutes either side of the scheduled start or end that still count as on time. Shops can override. */
  graceMinutes: number;
  /** Columns of the iSolved layout export, in order. */
  isolvedColumns: ExportColumn[];
}

// ───────────────────────────── Export layout ─────────────────────────────

export const EXPORT_FIELDS = {
  employeeNumber: { label: "Employee Number", kind: "text" },
  isolvedName: { label: "Employee name (as iSolved spells it)", kind: "text" },
  name: { label: "Display name", kind: "text" },
  shop: { label: "Shop", kind: "text" },
  payGroup: { label: "Pay group / export tab", kind: "text" },
  periodStart: { label: "Period start", kind: "text" },
  periodEnd: { label: "Period end", kind: "text" },
  regularHours: { label: "Regular hours", kind: "hours" },
  otHours: { label: "Overtime hours", kind: "hours" },
  workedHours: { label: "Total worked hours", kind: "hours" },
  breakHours: { label: "Break time (all breaks)", kind: "hours" },
  unpaidBreakHours: { label: "Unpaid break time", kind: "hours" },
  ptoHours: { label: "PTO hours", kind: "hours" },
  trainingHours: { label: "Training hours", kind: "hours" },
  cardTips: { label: "Card tips", kind: "money" },
  cashTips: { label: "Cash tips", kind: "money" },
  serviceSales: { label: "Service sales", kind: "money" },
  productSales: { label: "Product sales", kind: "money" },
} as const satisfies Record<string, { label: string; kind: "text" | "hours" | "money" }>;
export type ExportField = keyof typeof EXPORT_FIELDS;
export const isExportField = (s: string): s is ExportField => s in EXPORT_FIELDS;

export interface ExportColumn {
  header: string;
  field: ExportField;
}

export const GENERIC_FIELDS: ExportField[] = [
  "employeeNumber",
  "name",
  "shop",
  "periodStart",
  "periodEnd",
  "regularHours",
  "otHours",
  "breakHours",
  "unpaidBreakHours",
  "ptoHours",
  "trainingHours",
  "cardTips",
  "cashTips",
  "serviceSales",
  "productSales",
];

/**
 * A starting point for iSolved's import. The earning codes copy the ones in the owner's workbook
 * export; the card tips, service and product codes are placeholders until the exact template is
 * confirmed, which is why every column is editable.
 */
export const DEFAULT_ISOLVED_COLUMNS: ExportColumn[] = [
  { header: "Key", field: "employeeNumber" },
  { header: "Name", field: "isolvedName" },
  { header: "Location", field: "payGroup" },
  { header: "E_Regular_Hours", field: "regularHours" },
  { header: "E_Overtime 1.5_Hours", field: "otHours" },
  { header: "E_Cash Tips Recd_Dollars", field: "cashTips" },
  { header: "E_Charge Tips_Dollars", field: "cardTips" },
  { header: "E_Service Sales_Dollars", field: "serviceSales" },
  { header: "E_Product Sales_Dollars", field: "productSales" },
];

export const DEFAULT_CLOCK_RULES: ClockRules = {
  unpaidBreakFromMinutes: 30,
  autoMealMinutes: 0,
  autoMealAfterHours: 6,
  forgotOutAfterMinutes: 60,
  maxShiftHours: 12,
  graceMinutes: 5,
  isolvedColumns: DEFAULT_ISOLVED_COLUMNS,
};

export function clockRules(raw: unknown): ClockRules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ClockRules, unknown>>;
  const d = DEFAULT_CLOCK_RULES;
  const num = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : dflt);
  const cols = Array.isArray(r.isolvedColumns)
    ? r.isolvedColumns.filter((c): c is ExportColumn => !!c && typeof c === "object" && typeof c.header === "string" && c.header.trim() !== "" && isExportField(String(c.field)))
    : [];
  return {
    unpaidBreakFromMinutes: num(r.unpaidBreakFromMinutes, 0, 240, d.unpaidBreakFromMinutes),
    autoMealMinutes: num(r.autoMealMinutes, 0, 120, d.autoMealMinutes),
    autoMealAfterHours: num(r.autoMealAfterHours, 1, 16, d.autoMealAfterHours),
    forgotOutAfterMinutes: num(r.forgotOutAfterMinutes, 10, 720, d.forgotOutAfterMinutes),
    maxShiftHours: num(r.maxShiftHours, 4, 24, d.maxShiftHours),
    graceMinutes: num(r.graceMinutes, 0, 60, d.graceMinutes),
    isolvedColumns: cols.length ? cols.map((c) => ({ header: c.header.trim(), field: c.field })) : d.isolvedColumns,
  };
}

/** "Header = field" per line, the way the settings page edits the iSolved layout. */
export function parseColumnMapping(text: string): { columns: ExportColumn[]; problems: string[] } {
  const columns: ExportColumn[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/^(.+?)\s*=\s*([A-Za-z]+)$/);
    if (!m) return problems.push(`Line ${i + 1}: write it as "Header = field".`);
    if (!isExportField(m[2])) return problems.push(`Line ${i + 1}: "${m[2]}" isn't a field. Use one of ${Object.keys(EXPORT_FIELDS).join(", ")}.`);
    columns.push({ header: m[1].trim(), field: m[2] });
  });
  if (!columns.length && !problems.length) problems.push("Add at least one column.");
  return { columns, problems };
}

export const mappingText = (cols: readonly ExportColumn[]) => cols.map((c) => `${c.header} = ${c.field}`).join("\n");

const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

export interface Interval {
  start: Date;
  end: Date;
}

export interface ShiftWork {
  /** Paid work: the shift minus unpaid breaks (and any automatic meal deduction). */
  segments: Interval[];
  workedMin: number;
  breakMin: number;
  paidBreakMin: number;
  unpaidBreakMin: number;
  autoMealMin: number;
}

export const breakIsUnpaid = (minutes: number, r: Pick<ClockRules, "unpaidBreakFromMinutes">) => r.unpaidBreakFromMinutes === 0 || minutes >= r.unpaidBreakFromMinutes;

/**
 * A closed shift's paid time, from real elapsed time (so a shift over a DST change is 1 hour longer
 * or shorter on the wall clock than it looks). Breaks are clipped to the shift.
 */
export function shiftWork(shift: Shift, r: Pick<ClockRules, "unpaidBreakFromMinutes" | "autoMealMinutes" | "autoMealAfterHours">, end: Date | null = shift.end): ShiftWork {
  const stop = end ?? shift.start;
  const breaks = shift.breaks
    .map((b) => ({ start: new Date(Math.max(b.start.getTime(), shift.start.getTime())), end: new Date(Math.min((b.end ?? stop).getTime(), stop.getTime())) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  let paidBreakMin = 0;
  let unpaidBreakMin = 0;
  const unpaid: Interval[] = [];
  for (const b of breaks) {
    const m = minutesBetween(b.start, b.end);
    if (breakIsUnpaid(m, r)) {
      unpaidBreakMin += m;
      unpaid.push(b);
    } else paidBreakMin += m;
  }
  let segments: Interval[] = [];
  let cursor = shift.start;
  for (const u of unpaid) {
    if (u.start > cursor) segments.push({ start: cursor, end: u.start });
    if (u.end > cursor) cursor = u.end;
  }
  if (stop > cursor) segments.push({ start: cursor, end: stop });
  let workedMin = segments.reduce((a, s) => a + minutesBetween(s.start, s.end), 0);
  let autoMealMin = 0;
  if (r.autoMealMinutes > 0 && unpaid.length === 0 && workedMin > r.autoMealAfterHours * 60) {
    autoMealMin = Math.min(r.autoMealMinutes, workedMin);
    let take = autoMealMin;
    const trimmed: Interval[] = [];
    for (const s of [...segments].reverse()) {
      const len = minutesBetween(s.start, s.end);
      if (take >= len) {
        take -= len;
        continue;
      }
      trimmed.unshift(take > 0 ? { start: s.start, end: new Date(s.end.getTime() - take * 60_000) } : s);
      take = 0;
    }
    segments = trimmed;
    workedMin -= autoMealMin;
  }
  return { segments, workedMin, breakMin: paidBreakMin + unpaidBreakMin, paidBreakMin, unpaidBreakMin, autoMealMin };
}

// ───────────────────────────── Schedule ─────────────────────────────

export type PunchFlag = "late" | "early_in" | "early_out" | "late_out" | "during_time_off" | "forgot_out" | "off_site" | "manual";

export const FLAG_LABEL: Record<PunchFlag, string> = {
  late: "Late",
  early_in: "Early in",
  early_out: "Left early",
  late_out: "Stayed late",
  during_time_off: "During time off",
  forgot_out: "Forgot to clock out",
  off_site: "Away from the shop",
  manual: "Added by a manager",
};

export interface ScheduleRow {
  weekday: number;
  startMin: number;
  endMin: number;
}

/** The scheduled stretches on one local date, as instants. An end past midnight runs into the next day. */
export function scheduledOn(date: LocalDate, weekday: number, rows: readonly ScheduleRow[]): Interval[] {
  return rows
    .filter((r) => r.weekday === weekday && r.endMin > r.startMin)
    .map((r) => ({ start: zonedWallTime(date, r.startMin).toJSDate(), end: zonedWallTime(date, r.endMin).toJSDate() }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** How far a clock-in or clock-out is from the nearest scheduled start or end, and whether that's outside the grace. */
export function offSchedule(type: "in" | "out", at: Date, scheduled: readonly Interval[], graceMinutes: number): { flag: PunchFlag | null; minutes: number | null } {
  if (!scheduled.length) return { flag: null, minutes: null };
  const edge = (i: Interval) => (type === "in" ? i.start : i.end);
  const nearest = [...scheduled].sort((a, b) => Math.abs(at.getTime() - edge(a).getTime()) - Math.abs(at.getTime() - edge(b).getTime()))[0];
  const minutes = Math.round(minutesBetween(edge(nearest), at));
  if (Math.abs(minutes) <= graceMinutes) return { flag: null, minutes };
  if (type === "in") return { flag: minutes > 0 ? "late" : "early_in", minutes };
  return { flag: minutes < 0 ? "early_out" : "late_out", minutes };
}

/** When an open shift counts as a forgotten clock-out: after its scheduled end plus the allowance, or the longest shift with no schedule. */
export function forgottenAfter(shiftStart: Date, scheduled: readonly Interval[], r: Pick<ClockRules, "forgotOutAfterMinutes" | "maxShiftHours">): Date {
  const cap = new Date(shiftStart.getTime() + r.maxShiftHours * 3600_000);
  const end = scheduled.filter((s) => s.end > shiftStart).sort((a, b) => a.end.getTime() - b.end.getTime())[0]?.end;
  if (!end) return cap;
  const t = new Date(end.getTime() + r.forgotOutAfterMinutes * 60_000);
  return t < cap ? t : cap;
}

// ───────────────────────────── Verifying a punch ─────────────────────────────

export type ClockMethod = "device" | "gps" | "network";
export const METHOD_LABEL: Record<ClockMethod | "none" | "manager", string> = {
  device: "Shop device",
  gps: "Phone GPS",
  network: "Shop network",
  none: "Unverified",
  manager: "Manager",
};

export interface ShopClockSettings {
  /** Any one of these passes a phone punch. Empty: anywhere (still recorded). The front-desk clock always needs a registered device. */
  methods: ClockMethod[];
  /** Geofence radius around the shop, in meters. */
  radiusM: number;
  /** The shop's public IP addresses or CIDR ranges (its Wi-Fi as the internet sees it). */
  networks: string[];
  photo: "off" | "optional" | "required";
  /** Null follows the brand's grace minutes. */
  graceMinutes: number | null;
  /** A break closes online booking over it: from the break's start for breakHoldMinutes, or longer while it lasts. */
  blockOnBreak: boolean;
  breakHoldMinutes: number;
  /** Clocking out before the scheduled end closes online booking for the rest of the day here, until they clock back in. */
  blockAfterClockOut: boolean;
  /** Clocking in before the scheduled start opens the time in between for booking, for barbers who allow it. */
  openEarly: boolean;
  /** Managers are told when a barber isn't clocked in this many minutes before their first appointment. Null: off. */
  lateAlertMinutes: number | null;
}

export const DEFAULT_SHOP_CLOCK: ShopClockSettings = {
  methods: [],
  radiusM: 150,
  networks: [],
  photo: "off",
  graceMinutes: null,
  blockOnBreak: true,
  breakHoldMinutes: 30,
  blockAfterClockOut: true,
  openEarly: false,
  lateAlertMinutes: 10,
};

export const ShopClockSettingsSchema = z.object({
  methods: z.array(z.enum(["device", "gps", "network"])).max(3),
  radiusM: z.number().int().min(25).max(5000),
  networks: z.array(z.string().trim().min(1).max(64)).max(20),
  photo: z.enum(["off", "optional", "required"]),
  graceMinutes: z.number().int().min(0).max(60).nullable(),
  blockOnBreak: z.boolean(),
  breakHoldMinutes: z.number().int().min(5).max(120),
  blockAfterClockOut: z.boolean(),
  openEarly: z.boolean(),
  lateAlertMinutes: z.number().int().min(0).max(120).nullable(),
});

export function shopClockSettings(raw: unknown): ShopClockSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = ShopClockSettingsSchema.partial().safeParse(r);
  const v = p.success ? p.data : {};
  const d = DEFAULT_SHOP_CLOCK;
  return {
    methods: [...new Set(v.methods ?? d.methods)],
    radiusM: v.radiusM ?? d.radiusM,
    networks: (v.networks ?? d.networks).filter((n) => parseCidr(n) !== null),
    photo: v.photo ?? d.photo,
    graceMinutes: v.graceMinutes === undefined ? d.graceMinutes : v.graceMinutes,
    blockOnBreak: v.blockOnBreak ?? d.blockOnBreak,
    breakHoldMinutes: v.breakHoldMinutes ?? d.breakHoldMinutes,
    blockAfterClockOut: v.blockAfterClockOut ?? d.blockAfterClockOut,
    openEarly: v.openEarly ?? d.openEarly,
    lateAlertMinutes: v.lateAlertMinutes === undefined ? d.lateAlertMinutes : v.lateAlertMinutes,
  };
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** An IPv4 or IPv6 address as a number, with its family. IPv4-mapped IPv6 (::ffff:1.2.3.4) reads as IPv4. */
export function parseIp(raw: string): { v: 4 | 6; n: bigint } | null {
  const s = raw.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = (x: string) => {
    const parts = x.split(".");
    if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
    return parts.reduce((a, p) => (a << BigInt(8)) + BigInt(Number(p)), BigInt(0));
  };
  if (!s.includes(":")) {
    const n = v4(s);
    return n === null ? null : { v: 4, n };
  }
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) {
    const n = v4(mapped[1]);
    return n === null ? null : { v: 4, n };
  }
  let text = s;
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4(tail[1]);
    if (n === null) return null;
    text = text.slice(0, -tail[1].length) + `${(n >> BigInt(16)).toString(16)}:${(n & BigInt(0xffff)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const group = (h: string) => (h ? h.split(":") : []);
  const head = group(halves[0]);
  const rest = halves.length === 2 ? group(halves[1]) : [];
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const all = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest] : head;
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return { v: 6, n: all.reduce((a, g) => (a << BigInt(16)) + BigInt(parseInt(g, 16)), BigInt(0)) };
}

export function parseCidr(raw: string): { v: 4 | 6; n: bigint; bits: number } | null {
  const [addr, len] = raw.trim().split("/");
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { ...ip, bits };
}

export function ipInList(ip: string | null, list: readonly string[]): boolean {
  const a = ip ? parseIp(ip) : null;
  if (!a) return false;
  return list.some((c) => {
    const r = parseCidr(c);
    if (!r || r.v !== a.v) return false;
    const shift = BigInt((a.v === 4 ? 32 : 128) - r.bits);
    return a.n >> shift === r.n >> shift;
  });
}

export interface PunchEvidence {
  /** The registered device this browser holds, and its shop. */
  deviceShopId: string | null;
  ip: string | null;
  gps: (LatLng & { accuracyM: number | null }) | null;
}

export type Verified = { ok: true; method: "device" | "gps" | "network" | "none"; distanceM: number | null } | { ok: false; problem: string; distanceM: number | null };

/** GPS fixes rougher than this can't prove anything. */
export const MAX_GPS_ACCURACY_M = 250;

/**
 * Whether a phone (or browser) punch at this shop passes the shop's rule: any one allowed method is
 * enough. The distance is always worked out when there's a fix, so it's on record either way.
 */
export function verifyPunch(shopId: string, shop: { name: string; latitude: number | null; longitude: number | null }, s: ShopClockSettings, e: PunchEvidence): Verified {
  const distanceM = e.gps && shop.latitude !== null && shop.longitude !== null ? Math.round(haversineMeters(e.gps, { lat: shop.latitude, lng: shop.longitude })) : null;
  if (!s.methods.length) return { ok: true, method: e.deviceShopId === shopId ? "device" : "none", distanceM };
  if (s.methods.includes("device") && e.deviceShopId === shopId) return { ok: true, method: "device", distanceM };
  if (s.methods.includes("network") && ipInList(e.ip, s.networks)) return { ok: true, method: "network", distanceM };
  if (s.methods.includes("gps") && distanceM !== null && e.gps) {
    const acc = e.gps.accuracyM ?? 0;
    if (acc <= MAX_GPS_ACCURACY_M && distanceM <= s.radiusM + Math.min(acc, 50)) return { ok: true, method: "gps", distanceM };
  }
  const ways = s.methods.map((m) => (m === "device" ? `from ${shop.name}'s front-desk device` : m === "network" ? "on the shop's Wi-Fi" : `within ${s.radiusM} m of the shop with location on`));
  const why =
    s.methods.includes("gps") && !e.gps
      ? " Your phone didn't share its location."
      : s.methods.includes("gps") && shop.latitude === null
        ? " The shop's location isn't set yet, so ask a manager."
        : s.methods.includes("gps") && e.gps && (e.gps.accuracyM ?? 0) > MAX_GPS_ACCURACY_M
          ? " Your location fix was too rough; step outside or turn on precise location."
          : distanceM !== null && s.methods.includes("gps")
            ? ` You look to be ${distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${distanceM} m`} away.`
            : "";
  return { ok: false, problem: `Punch ${ways.join(", or ")}.${why}`, distanceM };
}

/** What a phone punch at this shop needs, in a sentence for the clock page. */
export function clockRuleText(s: ShopClockSettings): string {
  if (!s.methods.length) return "Punches from anywhere are accepted here; where you are is still recorded.";
  const ways = s.methods.map((m) => (m === "device" ? "on the shop's front-desk device" : m === "network" ? "on the shop's Wi-Fi" : `within ${s.radiusM} m of the shop (location on)`));
  return `Punch ${ways.join(", or ")}.`;
}

// ───────────────────────────── PINs ─────────────────────────────

export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 5;

export function pinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return "A PIN is 4 to 6 digits.";
  if (/^(\d)\1+$/.test(pin)) return "Pick a PIN that isn't one digit repeated.";
  const digits = pin.split("").map(Number);
  const step = digits[1] - digits[0];
  if ((step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) return "Pick a PIN that isn't a run like 1234.";
  return null;
}

// ───────────────────────────── Full time / part time ─────────────────────────────

export type FtLabel = "full_time" | "part_time";
export const FT_LABEL: Record<FtLabel, string> = { full_time: "Full time", part_time: "Part time" };

export interface WeekHours {
  weekStart: LocalDate;
  hours: number;
}

/**
 * The rolling average for each week, over the `window` weeks ending with it (missing weeks count as 0
 * hours), and the status: full time is strictly more than the threshold, so exactly 32 is part time.
 * Only weeks with a full window behind them get a status.
 */
export function rollingFt(weeks: readonly WeekHours[], window: number, thresholdHours: number): (WeekHours & { average: number; status: FtLabel })[] {
  const w = Math.max(1, Math.round(window));
  const out: (WeekHours & { average: number; status: FtLabel })[] = [];
  for (let i = w - 1; i < weeks.length; i++) {
    const slice = weeks.slice(i - w + 1, i + 1);
    const average = Math.round((slice.reduce((a, x) => a + x.hours, 0) / w) * 100) / 100;
    out.push({ ...weeks[i], average, status: average > thresholdHours ? "full_time" : "part_time" });
  }
  return out;
}

/** The weeks where the rolling status flipped, oldest first. */
export function ftCrossings(weeks: readonly WeekHours[], window: number, thresholdHours: number): { weekStart: LocalDate; from: FtLabel; to: FtLabel; average: number }[] {
  const r = rollingFt(weeks, window, thresholdHours);
  const out: { weekStart: LocalDate; from: FtLabel; to: FtLabel; average: number }[] = [];
  for (let i = 1; i < r.length; i++) if (r[i].status !== r[i - 1].status) out.push({ weekStart: r[i].weekStart, from: r[i - 1].status, to: r[i].status, average: r[i].average });
  return out;
}

// ───────────────────────────── Payroll export ─────────────────────────────

export interface ExportLine {
  staffId: string;
  name: string;
  isolvedName: string;
  /** Lives in the database only; goes out in the file and nowhere else. */
  employeeNumber: string | null;
  shopId: string;
  shop: string;
  payGroup: string;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  /** Centi-hours, so the columns add up exactly. */
  regularCenti: number;
  otCenti: number;
  breakCenti: number;
  unpaidBreakCenti: number;
  ptoCenti: number;
  trainingCenti: number;
  cardTipsCents: number;
  cashTipsCents: number;
  serviceSalesCents: number;
  productSalesCents: number;
}

export const NUMERIC_EXPORT_KEYS = [
  "regularCenti",
  "otCenti",
  "breakCenti",
  "unpaidBreakCenti",
  "ptoCenti",
  "trainingCenti",
  "cardTipsCents",
  "cashTipsCents",
  "serviceSalesCents",
  "productSalesCents",
] as const;
export type ExportTotals = Record<(typeof NUMERIC_EXPORT_KEYS)[number], number>;

export const exportTotals = (lines: readonly ExportLine[]): ExportTotals =>
  Object.fromEntries(NUMERIC_EXPORT_KEYS.map((k) => [k, lines.reduce((a, l) => a + l[k], 0)])) as ExportTotals;

export interface ExportInput {
  staffId: string;
  shopId: string;
  /** Centi-hours from the overtime slices: all worked hours and the OT among them. */
  workedCenti: number;
  otCenti: number;
  ptoCenti: number;
  trainingCenti: number;
  /** Break minutes from the punches. */
  breakMin: number;
  unpaidBreakMin: number;
}

/** One line per employee and shop with hours, breaks or sales, ordered by shop then name. */
export function exportLines(
  hours: readonly ExportInput[],
  sales: readonly { staffId: string; shopId: string; cardTipsCents: number; cashTipsCents: number; serviceSalesCents: number; productSalesCents: number }[],
  who: (staffId: string) => { name: string; isolvedName: string; employeeNumber: string | null },
  shop: (shopId: string) => { name: string; payGroup: string },
  period: { start: LocalDate; end: LocalDate },
): ExportLine[] {
  const lines = new Map<string, ExportLine>();
  const line = (staffId: string, shopId: string) => {
    const k = `${staffId}|${shopId}`;
    let l = lines.get(k);
    if (!l) {
      const p = who(staffId);
      const s = shop(shopId);
      l = {
        staffId,
        shopId,
        name: p.name,
        isolvedName: p.isolvedName,
        employeeNumber: p.employeeNumber,
        shop: s.name,
        payGroup: s.payGroup,
        periodStart: period.start,
        periodEnd: period.end,
        regularCenti: 0,
        otCenti: 0,
        breakCenti: 0,
        unpaidBreakCenti: 0,
        ptoCenti: 0,
        trainingCenti: 0,
        cardTipsCents: 0,
        cashTipsCents: 0,
        serviceSalesCents: 0,
        productSalesCents: 0,
      };
      lines.set(k, l);
    }
    return l;
  };
  for (const h of hours) {
    const l = line(h.staffId, h.shopId);
    l.regularCenti += h.workedCenti - h.otCenti;
    l.otCenti += h.otCenti;
    l.ptoCenti += h.ptoCenti;
    l.trainingCenti += h.trainingCenti;
    l.breakCenti += minutesToCenti(h.breakMin);
    l.unpaidBreakCenti += minutesToCenti(h.unpaidBreakMin);
  }
  for (const s of sales) {
    if (!s.cardTipsCents && !s.cashTipsCents && !s.serviceSalesCents && !s.productSalesCents) continue;
    const l = line(s.staffId, s.shopId);
    l.cardTipsCents += s.cardTipsCents;
    l.cashTipsCents += s.cashTipsCents;
    l.serviceSalesCents += s.serviceSalesCents;
    l.productSalesCents += s.productSalesCents;
  }
  return [...lines.values()].sort((a, b) => a.shop.localeCompare(b.shop) || a.name.localeCompare(b.name));
}

const fix2 = (n: number) => (n / 100).toFixed(2);

function fieldValue(l: ExportLine, f: ExportField): string {
  switch (f) {
    case "employeeNumber":
      return l.employeeNumber ?? "";
    case "isolvedName":
      return l.isolvedName;
    case "name":
      return l.name;
    case "shop":
      return l.shop;
    case "payGroup":
      return l.payGroup;
    case "periodStart":
      return l.periodStart;
    case "periodEnd":
      return l.periodEnd;
    case "regularHours":
      return fix2(l.regularCenti);
    case "otHours":
      return fix2(l.otCenti);
    case "workedHours":
      return fix2(l.regularCenti + l.otCenti);
    case "breakHours":
      return fix2(l.breakCenti);
    case "unpaidBreakHours":
      return fix2(l.unpaidBreakCenti);
    case "ptoHours":
      return fix2(l.ptoCenti);
    case "trainingHours":
      return fix2(l.trainingCenti);
    case "cardTips":
      return fix2(l.cardTipsCents);
    case "cashTips":
      return fix2(l.cashTipsCents);
    case "serviceSales":
      return fix2(l.serviceSalesCents);
    case "productSales":
      return fix2(l.productSalesCents);
  }
}

function totalValue(t: ExportTotals, f: ExportField): string {
  const map: Partial<Record<ExportField, number>> = {
    regularHours: t.regularCenti,
    otHours: t.otCenti,
    workedHours: t.regularCenti + t.otCenti,
    breakHours: t.breakCenti,
    unpaidBreakHours: t.unpaidBreakCenti,
    ptoHours: t.ptoCenti,
    trainingHours: t.trainingCenti,
    cardTips: t.cardTipsCents,
    cashTips: t.cashTipsCents,
    serviceSales: t.serviceSalesCents,
    productSales: t.productSalesCents,
  };
  const v = map[f];
  return v === undefined ? "" : fix2(v);
}

/** RFC 4180, with text that would open as a spreadsheet formula defused. */
export function csv(rows: readonly (readonly string[])[]): string {
  const esc = (s: string) => {
    let v = s;
    if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = `'${v}`;
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

/** Every field, one row per employee and shop, then a totals row. */
export function genericCsv(lines: readonly ExportLine[]): string {
  const head = GENERIC_FIELDS.map((f) => EXPORT_FIELDS[f].label);
  const t = exportTotals(lines);
  const totals = GENERIC_FIELDS.map((f, i) => (i === 0 ? "TOTAL" : totalValue(t, f)));
  return csv([head, ...lines.map((l) => GENERIC_FIELDS.map((f) => fieldValue(l, f))), totals]);
}

/** The iSolved layout: the configured columns only, no totals row (an import would read it as an employee). */
export function mappedCsv(lines: readonly ExportLine[], columns: readonly ExportColumn[]): string {
  return csv([columns.map((c) => c.header), ...lines.map((l) => columns.map((c) => fieldValue(l, c.field)))]);
}

/** The local date a punch belongs to for the timesheet: the day its shift started. */
export const shiftDate = (s: Pick<Shift, "start">) => localDateOf(s.start);
