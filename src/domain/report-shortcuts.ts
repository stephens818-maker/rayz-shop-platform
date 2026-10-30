import type { ReportKey } from "./permissions";
import { FilingFrequency, taxShortcuts } from "./sales-tax";

/**
 * Saved reports on the reports hub: a built-in report with its range and options already set, one
 * click from the hub. Each is shown only to people who may open that report, and opens with the
 * shops and barbers they can see.
 */
export interface ReportShortcut {
  label: string;
  report: ReportKey;
  /** Query string for the report page, without the leading "?". */
  query: string;
  hint: string;
}

export const REPORT_SHORTCUTS: readonly ReportShortcut[] = [
  { label: "End of day", report: "end_of_day", query: "preset=lastday", hint: "The last day the shops were open (Saturday on a Monday): sales, tax, tips, tenders, refunds, each barber and the counted drawer." },
  { label: "Today so far", report: "end_of_day", query: "preset=today", hint: "Today's sales, tax, tips, tenders, refunds, each barber and the drawer, as they come in." },
  { label: "Tips", report: "tips_payroll", query: "", hint: "Each barber's card, cash and gift card tips for the pay period." },
  { label: "Gross and net sales", report: "sales_summary", query: "preset=month", hint: "This month's gross, discounts, refunds and net, by day and month." },
  { label: "Employee summary", report: "sales_by_barber", query: "preset=lastpayperiod&view=barbers", hint: "Last pay period, per barber: sales, tips, clients and hours." },
  { label: "Total collected", report: "card_vs_cash", query: "preset=month", hint: "This month's card, cash and gift card takings." },
  { label: "Leaderboard", report: "leaderboard", query: "preset=month", hint: "This month's barbers ranked on service sales." },
  { label: "Quarterly retention", report: "retention", query: "preset=lastquarter&visits=2", hint: "Last quarter against the one before, for clients with 2+ visits." },
  { label: "New-client rebooks", report: "rebook_rate", query: "preset=30d&clients=new&rank=new_rebook", hint: "The last 30 days' first visits: who rebooked them at checkout, against the brand average." },
];

/** The fixed shortcuts and a sales tax shortcut per state, on that state's filing schedule. */
export function shortcutsFor(states: readonly string[], filing: Record<string, FilingFrequency>): ReportShortcut[] {
  return [
    ...REPORT_SHORTCUTS,
    ...taxShortcuts(states, filing).map((t) => ({ label: t.label.charAt(0).toUpperCase() + t.label.slice(1), report: "sales_tax" as const, query: t.query, hint: `The last full ${t.frequency === "monthly" ? "month" : "quarter"}, ready for the return.` })),
  ];
}
