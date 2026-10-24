/**
 * "How do I..." answers for Rayz Assistant. Each points at the page that does it, and a person is
 * only told about pages they can open (pageAllowed, the same table the sidebar uses).
 */
import { type AdminPage, pageAllowed } from "./navigation";
import type { Permission } from "./permissions";

export interface HelpTopic {
  title: string;
  page: AdminPage;
  words: string[];
  steps: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    title: "Book or move an appointment",
    page: "/admin/calendar",
    words: ["book", "appointment", "move", "reschedule", "calendar"],
    steps: ["Open Calendar and pick the day.", "Click an open time in the barber's column to book, or drag an appointment to move it.", "Without \"Book, move and change any barber's appointments\" you work only in your own column."],
  },
  {
    title: "Block out time for lunch, a break or an errand",
    page: "/admin/my-time",
    words: ["block", "lunch", "break", "time", "errand", "doctor"],
    steps: ["Open My time and choose Block time.", "Pick the reason, the day and the times. The shop's limits (like the longest lunch) apply.", "Every block is logged."],
  },
  {
    title: "Request time off",
    page: "/admin/my-time",
    words: ["time off", "vacation", "day off", "pto", "request"],
    steps: ["Open My time and choose Request time off.", "Pick the days. Requests wait for a manager unless the shop approves them automatically."],
  },
  {
    title: "Approve time off",
    page: "/admin/time-off",
    words: ["approve", "time off", "deny", "request"],
    steps: ["Open Time off to see waiting requests.", "Each shows the appointments it affects so you can move them or ask the clients to reschedule.", "You can never approve your own request."],
  },
  {
    title: "Mark a barber as called in",
    page: "/admin/call-ins",
    words: ["call in", "called in", "sick", "emergency"],
    steps: ["Open Call-ins and pick the barber and the reason.", "It writes the time off and lists every booked appointment so you can move the clients or send them a rebook link."],
  },
  {
    title: "Run walk-ins and the waitlist",
    page: "/admin/walk-ins",
    words: ["walk in", "walk-in", "waitlist", "queue"],
    steps: ["Open Walk-ins & waitlist, add the client and who they're waiting for.", "Start them when a chair opens; they're notified when it's their turn."],
  },
  {
    title: "Check out a client",
    page: "/admin/sales",
    words: ["checkout", "check out", "ticket", "pay", "sale", "receipt"],
    steps: ["Open Sales & checkout, or the appointment on the calendar, and start a ticket.", "Add services and products, any discount you're allowed, then take card, cash or a gift card.", "The receipt goes by text or email as the client chose."],
  },
  {
    title: "Refund or void a ticket",
    page: "/admin/sales",
    words: ["refund", "void", "return"],
    steps: ["Open the ticket from Sales & checkout.", "Choose Refund (all or some lines) or Void, with a reason. It needs \"Refund and void tickets\"."],
  },
  {
    title: "Open or close the cash drawer",
    page: "/admin/drawer",
    words: ["drawer", "cash", "close out", "count"],
    steps: ["Open Cash drawer, count the float and open it.", "At close, count again; the drawer shows what it expected and any difference."],
  },
  {
    title: "Find a client",
    page: "/admin/customers",
    words: ["client", "customer", "find", "search", "look up"],
    steps: ["Use the client search at the top of the sidebar, or open Clients.", "Search by name, or by phone or email where Client data lets you see them."],
  },
  {
    title: "Clock in or out",
    page: "/admin/clock",
    words: ["clock", "punch", "clock in", "clock out"],
    steps: ["Open Time clock and press Clock in, Start break or Clock out.", "The shop's device, GPS or network rule applies."],
  },
  {
    title: "Fix or approve timesheets",
    page: "/admin/timesheets",
    words: ["timesheet", "punch", "hours", "fix", "approve"],
    steps: ["Open Timesheets and pick the person and pay period.", "Edit, add or void a punch with a reason, then approve. You can never edit or approve your own."],
  },
  {
    title: "Pay out tips",
    page: "/admin/tips",
    words: ["tip", "tips", "payout"],
    steps: ["Open Tip payouts and build a batch for the period.", "Review, hold or adjust a payout with a reason, then approve. Cash tips can be paid from the drawer at close."],
  },
  {
    title: "Run payroll",
    page: "/admin/payroll/report",
    words: ["payroll", "isolved", "pay period", "export"],
    steps: ["Open Payroll report and pick the pay period.", "Check that every total reconciles, approve and lock the period, then download the iSolved files."],
  },
  {
    title: "See what's low and reorder",
    page: "/admin/inventory/low-stock",
    words: ["low stock", "reorder", "inventory", "stock", "par"],
    steps: ["Open Low stock to see what's at or below its reorder point.", "Create purchase orders from the suggestions, one per vendor, filled up to par in whole cases."],
  },
  {
    title: "Create a purchase order",
    page: "/admin/purchase-orders",
    words: ["purchase order", "po", "order", "vendor"],
    steps: ["Open Purchase orders and choose New, or start from Low stock's suggestions.", "Orders over the approval limit need someone with \"Approve purchase orders\" before they're sent."],
  },
  {
    title: "Receive a delivery",
    page: "/admin/purchase-orders",
    words: ["receive", "delivery", "shipment"],
    steps: ["Open the purchase order and choose Receive.", "Enter what arrived; stock updates and anything short stays on order."],
  },
  {
    title: "Send a blast to clients",
    page: "/admin/campaign-center/blasts",
    words: ["blast", "campaign", "text clients", "email clients", "marketing", "promo"],
    steps: ["Open Blasts and choose New blast.", "Build the segment, write the wording (texts must say Reply STOP to opt out), pick the locations and send a test.", "Only clients who agreed to marketing get it, outside quiet hours and within the frequency limits."],
  },
  {
    title: "Tell clients a barber has openings",
    page: "/admin/campaign-center/openings",
    words: ["openings", "open chair", "fill", "slow day"],
    steps: ["Open We have openings, pick the barber and today or tomorrow.", "It texts or emails that barber's regulars and recent clients who agreed to marketing."],
  },
  {
    title: "Build a custom report",
    page: "/admin/reports/custom/new",
    words: ["custom report", "report builder", "build", "save report", "schedule report"],
    steps: ["Open Reports, then Custom reports, and choose New report.", "Tick fields to add columns, add filters and grouping, then save it, share it with roles or email it on a schedule."],
  },
  {
    title: "Read the reports",
    page: "/admin/reports",
    words: ["report", "reports", "numbers", "sales report"],
    steps: ["Open Reports and pick one.", "Choose the dates, locations and barbers, and the view: combined, by location, by barber or both. Download CSV where you're allowed."],
  },
  {
    title: "Change someone's permissions",
    page: "/admin/permissions",
    words: ["permission", "role", "access", "grant"],
    steps: ["Open Permissions and pick the role or the person.", "You can only grant what you have yourself, and never change your own access."],
  },
  {
    title: "Set up a shop login",
    page: "/admin/shop-logins",
    words: ["shop login", "shared login", "front desk login"],
    steps: ["Open Shop logins and create one for the location, with its role.", "Reset its password or turn it off there."],
  },
  {
    title: "Edit shop hours and booking rules",
    page: "/admin/settings",
    words: ["hours", "closure", "holiday", "booking rules", "shop settings"],
    steps: ["Open Shop settings and pick the shop.", "Edit weekday hours, closures and how far ahead clients can book."],
  },
  {
    title: "Turn Rayz Assistant on or off for a role",
    page: "/admin/assistant/settings",
    words: ["assistant", "ai", "rayz assistant", "turn off"],
    steps: ["Open Rayz Assistant under Setup.", "Switch it on or off for each role, set the question limits, and choose whether it may draft blasts and purchase orders."],
  },
];

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");

/** The best topics for a question that this person can open, best first. */
export function helpFor(question: string, perms: ReadonlySet<Permission>, limit = 3): HelpTopic[] {
  const q = ` ${tokens(question)} `;
  return HELP_TOPICS.filter((t) => pageAllowed(perms, t.page))
    .map((t) => ({ t, score: t.words.reduce((n, w) => n + (q.includes(` ${w} `) || q.includes(` ${w}s `) ? w.split(" ").length + 1 : 0), 0) + (q.includes(t.title.toLowerCase()) ? 3 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t);
}
