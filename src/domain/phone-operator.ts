/**
 * The phone operator answers a shop's Twilio number when nobody at the shop can: after hours, when
 * the shop phone rings out, or first on every call if the shop wants it to. It is a keypad menu, not
 * a conversation: 1 texts the caller a booking link, 2 reads the shop's hours, 3 rings the shop
 * while it's open. Its report counts the calls it took, the bookings that followed and the staff
 * time it saved.
 */

export type OperatorAnswer = "fallback" | "first";
export interface PhoneOperator {
  enabled: boolean;
  /** fallback: only after hours or when the shop phone isn't answered. first: before ringing the shop. */
  answer: OperatorAnswer;
  /** Staff minutes one handled call would have taken, for "minutes saved". */
  minutesPerCall: number;
  /** Said before the menu instead of "Thanks for calling Rays <shop>." */
  greeting: string | null;
}

export const DEFAULT_OPERATOR: PhoneOperator = { enabled: false, answer: "fallback", minutesPerCall: 3, greeting: null };
export const OPERATOR_ANSWER_LABEL: Record<OperatorAnswer, string> = {
  fallback: "When the shop is closed or nobody picks up",
  first: "First, on every call (3 rings the shop while it's open)",
};

/** What the caller picked. "none": they hung up or pressed nothing. */
export type OperatorChoice = "book" | "hours" | "shop" | "none";
export const OPERATOR_CHOICE_LABEL: Record<OperatorChoice, string> = { book: "Texted a booking link", hours: "Heard the hours", shop: "Put through to the shop", none: "Hung up" };
/** A later key only replaces an earlier one when it says more about what the caller wanted. */
const CHOICE_WEIGHT: Record<OperatorChoice, number> = { none: 0, hours: 1, shop: 2, book: 3 };
export const strongerChoice = (a: OperatorChoice | null | undefined, b: OperatorChoice): OperatorChoice => (a && CHOICE_WEIGHT[a] >= CHOICE_WEIGHT[b] ? a : b);

/** A booking by the same number at the same shop within this many days counts toward the call. */
export const ATTRIBUTION_DAYS = 7;

export function cleanOperator(raw: unknown): PhoneOperator {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const minutes = Number(r.minutesPerCall);
  const greeting = typeof r.greeting === "string" ? r.greeting.trim().slice(0, 300) : "";
  return {
    enabled: r.enabled === true,
    answer: r.answer === "first" ? "first" : "fallback",
    minutesPerCall: Number.isFinite(minutes) && minutes >= 1 && minutes <= 30 ? Math.round(minutes) : DEFAULT_OPERATOR.minutesPerCall,
    greeting: greeting || null,
  };
}

export function operatorProblem(o: { minutesPerCall: number; greeting: string | null }): string | null {
  if (!Number.isInteger(o.minutesPerCall) || o.minutesPerCall < 1 || o.minutesPerCall > 30) return "Minutes per call is 1 to 30";
  if ((o.greeting ?? "").length > 300) return "Keep the greeting under 300 characters";
  return null;
}

/** Whether the operator takes this call, given whether the shop is open and has a phone to ring. */
export const operatorTakes = (o: PhoneOperator, open: boolean) => o.enabled && (o.answer === "first" || !open);

/** The words before and the menu itself. Option 3 only while the shop is open and has a phone. */
export function operatorScript(o: { shop: string; greeting: string | null; open: boolean; missed: boolean; canRing: boolean }) {
  const intro = o.missed ? "Sorry, nobody could get to the phone." : (o.greeting ?? `Thanks for calling ${o.shop}.`) + (o.open ? "" : " We're closed right now.");
  const menu = ["Press 1 and we'll text you a link to book online.", "Press 2 to hear our hours.", ...(o.open && o.canRing ? ["Press 3 to talk to someone at the shop."] : [])].join(" ");
  return { intro, menu };
}

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function clock(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** "We're open Monday through Friday, 9 AM to 7 PM. Saturday, 8 AM to 3 PM. Closed Sunday." */
export function spokenHours(hours: readonly { weekday: number; openMin: number; closeMin: number }[]): string {
  const byDay = Array.from({ length: 7 }, (_, d) =>
    hours
      .filter((h) => h.weekday === d)
      .sort((a, b) => a.openMin - b.openMin)
      .map((h) => `${clock(h.openMin)} to ${clock(h.closeMin)}`)
      .join(" and "),
  );
  const order = [1, 2, 3, 4, 5, 6, 0];
  const runs: { from: number; to: number; text: string }[] = [];
  for (const d of order) {
    const last = runs[runs.length - 1];
    if (last && last.text === byDay[d] && order.indexOf(d) === order.indexOf(last.to) + 1) last.to = d;
    else runs.push({ from: d, to: d, text: byDay[d] });
  }
  const span = (r: { from: number; to: number }) => (r.from === r.to ? DAY[r.from] : order.indexOf(r.to) === order.indexOf(r.from) + 1 ? `${DAY[r.from]} and ${DAY[r.to]}` : `${DAY[r.from]} through ${DAY[r.to]}`);
  const open = runs.filter((r) => r.text);
  if (!open.length) return "We don't have opening hours set right now.";
  const closed = runs.filter((r) => !r.text);
  return [`We're open ${open.map((r) => `${span(r)}, ${r.text}`).join(". ")}.`, ...(closed.length ? [`Closed ${closed.map(span).join(" and ")}.`] : [])].join(" ");
}

export interface OperatorCall {
  operator: boolean;
  status: string;
  autoTextSent: boolean;
  choice: string | null;
  /** The first booking the same number made at the shop within ATTRIBUTION_DAYS, if any. */
  bookedCents: number | null;
}

/** The headline numbers: calls in, who answered, what the operator handled and what it booked. */
export function operatorMetrics(calls: readonly OperatorCall[], minutesPerCall: number) {
  const handled = calls.filter((c) => c.operator);
  const booked = handled.filter((c) => c.bookedCents !== null);
  return {
    calls: calls.length,
    staffAnswered: calls.filter((c) => !c.operator && c.status === "answered").length,
    handled: handled.length,
    missed: calls.filter((c) => !c.operator && (c.status === "missed" || c.status === "after_hours")).length,
    linksTexted: handled.filter((c) => c.autoTextSent).length,
    bookings: booked.length,
    bookedCents: booked.reduce((a, c) => a + (c.bookedCents ?? 0), 0),
    bookRate: handled.length ? booked.length / handled.length : null,
    answerRate: calls.length ? (calls.filter((c) => !c.operator && c.status === "answered").length + handled.length) / calls.length : null,
    /** Calls the operator put through to the shop took staff time anyway. */
    minutesSaved: handled.filter((c) => c.choice !== "shop").length * minutesPerCall,
  };
}
