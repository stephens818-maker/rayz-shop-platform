import type { ReportKey } from "./permissions";

/**
 * Report categories for the hub and the tabs on every report. Every report is in exactly one, so
 * nothing hides behind a "More" menu: the tabs show the categories, then the active category's reports.
 */
export const REPORT_GROUPS = [
  { id: "sales", label: "Sales and close" },
  { id: "staff", label: "Staff and labor" },
  { id: "payroll", label: "Payroll" },
  { id: "bookings", label: "Appointments and operations" },
  { id: "clients", label: "Clients and retention" },
  { id: "marketing", label: "Marketing" },
  { id: "inventory", label: "Inventory" },
  { id: "admin", label: "Locations and admin" },
] as const;

export type ReportGroupId = (typeof REPORT_GROUPS)[number]["id"];

export const REPORT_GROUP: Record<ReportKey, ReportGroupId> = {
  my_sales: "sales",
  analytics: "sales",
  sales_summary: "sales",
  end_of_day: "sales",
  card_vs_cash: "sales",
  card_fees: "sales",
  discounts_refunds: "sales",
  sales_tax: "sales",
  cash_drawer: "sales",
  gift_cards: "sales",
  services_vs_products: "sales",
  sales_by_barber: "staff",
  leaderboard: "staff",
  labor: "staff",
  payroll_summary: "payroll",
  payroll_timesheets: "payroll",
  payroll_tips: "payroll",
  payroll_commission: "payroll",
  payroll_full_time: "payroll",
  payroll_labor: "payroll",
  payroll_overtime: "payroll",
  payroll_isolved: "payroll",
  tips_payroll: "payroll",
  tip_payouts: "payroll",
  commission_payout: "payroll",
  attendance: "staff",
  milestones: "staff",
  appointments: "bookings",
  operations: "bookings",
  heatmap: "bookings",
  service_times: "bookings",
  staffing: "bookings",
  call_ins: "bookings",
  phone_operator: "bookings",
  checkout_prompts: "bookings",
  kpis: "clients",
  rebook_rate: "clients",
  retention: "clients",
  acquisition: "clients",
  client_ratings: "clients",
  lapsed_clients: "clients",
  loyalty: "clients",
  campaign_center: "marketing",
  openings: "marketing",
  google_reviews: "marketing",
  inventory: "inventory",
  inventory_movement: "inventory",
  sell_through: "inventory",
  low_stock: "inventory",
  purchasing: "inventory",
  rollup: "admin",
  shop_accounts: "admin",
  morning_dashboard: "admin",
  audit_log: "admin",
};

/** The given reports in category order, each category with its reports in the order given; empty categories are left out. */
export function groupReports<T extends { key: ReportKey }>(list: readonly T[]): { id: ReportGroupId; label: string; reports: T[] }[] {
  return REPORT_GROUPS.map((g) => ({ id: g.id, label: g.label, reports: list.filter((r) => REPORT_GROUP[r.key] === g.id) })).filter((g) => g.reports.length > 0);
}
