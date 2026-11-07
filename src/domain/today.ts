/**
 * The rules behind Today's alerts, kept pure so they can be tested without a database. The
 * server (src/server/today.ts) gathers the facts and these decide what is worth a manager's time.
 */

export type AlertType =
  | "idle_chairs"
  | "no_show_risk"
  | "low_stock"
  | "draft_pos"
  | "time_off_pending"
  | "callin_fallout"
  | "off_but_booked"
  | "overdue_rebook"
  | "running_behind"
  | "drawer_variance"
  | "drawer_open"
  | "unusual_refunds"
  | "unusual_discounts"
  | "client_lookups"
  | "tax_unverified"
  | "setup_checklist"
  | "sales_pace"
  | "failed_notifications"
  | "open_tickets"
  | "not_taking_cards"
  | "failed_payouts"
  | "overdue_deliveries"
  | "waitlist_match"
  | "unread_texts"
  | "forgot_clock_out"
  | "ft_change"
  | "late_clock_in"
  | "clock_affected";

export type Severity = "high" | "medium" | "low";

export interface AlertAction {
  kind: "fill" | "rebook" | "no_show_reminder" | "running_late" | "draft_po" | "retry_notifications";
  label: string;
  /** What it will do, shown before the click. */
  confirm: string;
  payload: Record<string, string | number | string[]>;
}

export interface Alert {
  /** Stable for the day, so a dismissal sticks: "<type>:<shop>:<date>[:extra]". */
  key: string;
  type: AlertType;
  severity: Severity;
  shopId: string | null;
  shop: string | null;
  title: string;
  detail: string;
  items?: { label: string; sub?: string; href?: string }[];
  href?: string;
  linkLabel?: string;
  action?: AlertAction;
}

export const ALERT_LABEL: Record<AlertType, string> = {
  idle_chairs: "Open chair time today",
  no_show_risk: "No-show risk",
  low_stock: "Low stock",
  draft_pos: "Purchase orders ready to send",
  time_off_pending: "Time off waiting",
  callin_fallout: "Call-in clients to reach",
  off_but_booked: "Booked with someone who's off",
  overdue_rebook: "Regulars overdue to rebook",
  running_behind: "Running behind",
  drawer_variance: "Cash drawer variance",
  drawer_open: "Cash drawer left open",
  unusual_refunds: "Unusual refunds",
  unusual_discounts: "Unusual discounts",
  client_lookups: "Unusual client lookups",
  tax_unverified: "Tax rates to confirm",
  setup_checklist: "Location setup",
  sales_pace: "Sales vs last week",
  failed_notifications: "Messages that didn't send",
  open_tickets: "Tickets left open",
  not_taking_cards: "Can't take cards",
  failed_payouts: "Payouts that failed",
  overdue_deliveries: "Late deliveries",
  waitlist_match: "Waitlist and open time",
  unread_texts: "Unread client texts",
  forgot_clock_out: "Forgotten clock-outs",
  ft_change: "Full time / part time changes",
  late_clock_in: "Not clocked in for their first client",
  clock_affected: "Clients booked over a break or clock-out",
};

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const sortAlerts = (alerts: Alert[]) =>
  [...alerts].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.shop ?? "").localeCompare(b.shop ?? "") || a.title.localeCompare(b.title));

export interface Interval {
  start: number;
  end: number;
}

/** Shorter gaps can't take a cut, so they don't count as open time. */
export const MIN_GAP_MIN = 30;
/** A barber with this much open time left today is worth a fill campaign. */
export const IDLE_ALERT_MIN = 60;

/** Free stretches of `windows` after `from`, minus `busy`, each at least `minMinutes` long. Times in ms. */
export function freeIntervals(windows: readonly Interval[], busy: readonly Interval[], from: number, minMinutes = MIN_GAP_MIN): Interval[] {
  const out: Interval[] = [];
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  for (const w of windows) {
    let cursor = Math.max(w.start, from);
    for (const b of sorted) {
      if (b.end <= cursor || b.start >= w.end) continue;
      if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, w.end) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out.filter((i) => i.end - i.start >= minMinutes * 60_000);
}

export const minutesIn = (xs: readonly Interval[]) => Math.round(xs.reduce((a, i) => a + (i.end - i.start), 0) / 60_000);

export const durationLabel = (min: number) => (min < 60 ? `${min}m` : min % 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min / 60}h`);

/** From the last year of a client's appointments: high when no-shows are a habit, medium when they've happened. */
export function noShowRisk(h: { noShows: number; lateCancels: number; total: number }): Severity | null {
  if (h.noShows >= 2 || (h.noShows >= 1 && h.total > 0 && h.noShows / h.total >= 0.34)) return "high";
  if (h.noShows + h.lateCancels >= 2) return "medium";
  return null;
}

/** Visits, first and last visit, and the cadence (domain/visit-cadence.ts) when known; without it the usual gap is the plain average. */
export interface VisitHistory {
  visits: number;
  firstVisit: number;
  lastVisit: number;
  cadenceDays?: number | null;
}

/**
 * Whether a regular is overdue: at least three visits, and more than 1.5× their usual gap (and at
 * least four weeks) since the last one, but not so long ago that they've likely moved on.
 */
export function rebookDue(h: VisitHistory, now: number): { due: boolean; usualDays: number; sinceDays: number } {
  const day = 86_400_000;
  const sinceDays = Math.floor((now - h.lastVisit) / day);
  const usualDays =
    h.cadenceDays != null ? Math.round(h.cadenceDays) : h.visits >= 2 ? Math.round((h.lastVisit - h.firstVisit) / day / (h.visits - 1)) : 0;
  const due = h.visits >= 3 && usualDays > 0 && sinceDays > Math.max(28, usualDays * 1.5) && sinceDays <= 180;
  return { due, usualDays, sinceDays };
}

/** Due for a cut: at or past their usual gap (three weeks for clients without one yet). Used to pick who hears about an open chair. */
export function dueForCut(h: VisitHistory, now: number) {
  const { usualDays, sinceDays } = rebookDue(h, now);
  return sinceDays >= (usualDays >= 7 ? Math.round(usualDays * 0.9) : 21) && sinceDays <= 120;
}

/** Drawer differences worth a look. */
export const DRAWER_VARIANCE_CENTS = 500;

/** Refunds or discounts by one person that stand out from a normal day. */
export const UNUSUAL = { refundCount: 3, refundCents: 10_000, discountCount: 4, discountPct: 0.3 };

/** Sales this far below last week at the same time are flagged; tiny days are ignored. */
export const PACE = { dropPct: 0.25, minPriorCents: 20_000 };

export function paceChange(now: number, prior: number) {
  if (!prior) return null;
  return (now - prior) / prior;
}

export const pctLabel = (x: number) => `${x >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(x * 100))}%`;
