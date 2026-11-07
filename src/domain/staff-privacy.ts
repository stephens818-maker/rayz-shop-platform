/**
 * The employee privacy notice's facts in one place (/staff-app/privacy and GET /config read them):
 * the data map, how long each kind of record is kept, the pay question path, and the review that
 * has to sign off the wording before the Ray'z Staff app ships.
 */
import { STAFF_LEGAL_VERSIONS } from "./legal";

export interface DataMapRow {
  key: string;
  category: string;
  what: string;
  why: string;
  /** Where it comes from. */
  source: string;
  /** Who at Ray'z can see it. */
  access: string;
  /** Service providers that hold it for us. */
  processors: string;
  retention: string;
}

/** Punch photos are deleted this long after the punch, unless a pay question for the person is still open. */
export const PUNCH_PHOTO_DAYS = 90;
/** A signed-out or replaced phone's push token and details are deleted this long after it was signed out. */
export const SIGNED_OUT_DEVICE_DAYS = 30;
/** Time, pay and tip records: kept at least this many years after the year they belong to. */
export const PAY_RECORD_YEARS = 4;

export const STAFF_DATA_MAP: readonly DataMapRow[] = [
  {
    key: "profile",
    category: "Staff profile",
    what: "Name, the name you go by, work email, mobile number, role, shops, schedule, time off and blocked time.",
    why: "To run the schedule and your day at the shop.",
    source: "You and your managers.",
    access: "You; managers at your shops; others on the team see your name and schedule only.",
    processors: "Hosting and database (United States).",
    retention: `While you work here, then ${PAY_RECORD_YEARS} years after you leave with your personnel record.`,
  },
  {
    key: "security",
    category: "Sign-in and security",
    what: "Sign-ins and how (password, code or invite link), each phone's name and install id, IP addresses of sign-in requests, the authenticator or passkey you set up (never the code itself).",
    why: "To keep your account and client information secure and to sign a lost phone out.",
    source: "Your phone and browser.",
    access: "You see your own sign-ins; owners and managers who manage staff see the security log.",
    processors: "Hosting and database; Twilio and our email provider for sign-in codes.",
    retention: `A phone's details are deleted ${SIGNED_OUT_DEVICE_DAYS} days after it signs out; the security log is kept with the audit log, at least ${PAY_RECORD_YEARS} years.`,
  },
  {
    key: "time",
    category: "Time clock",
    what: "Each punch (in, out, breaks), the shop, how it was proven (QR code, NFC tag, shop Wi-Fi or front-desk PIN), meal-break answers, and every manager edit with who made it and why.",
    why: "To record your hours and breaks and pay you correctly, as wage and hour laws require.",
    source: "You, the front-desk clock and your managers.",
    access: "You; managers who approve or fix timecards at your shops; payroll.",
    processors: "Hosting and database; iSolved (payroll).",
    retention: `At least ${PAY_RECORD_YEARS} years after the year they belong to.`,
  },
  {
    key: "location",
    category: "Location (only where a shop's clock rule asks for it)",
    what: "Your phone's location once, at the moment you punch, with its accuracy and distance from the shop. Never tracked in the background.",
    why: "To check a punch was made at the shop.",
    source: "Your phone, with your permission.",
    access: "Managers who fix timecards at that shop.",
    processors: "Hosting and database.",
    retention: `With the punch: at least ${PAY_RECORD_YEARS} years after the year it belongs to.`,
  },
  {
    key: "photos",
    category: "Punch photos (only where a shop asks for them)",
    what: "A photo taken when you punch. Never scanned for faces or used to build a biometric identifier.",
    why: "So a manager can check who punched.",
    source: "Your phone's camera or the front-desk clock, with your permission.",
    access: "Managers who fix timecards at that shop. Never in the staff app's timecard.",
    processors: "Hosting and database.",
    retention: `Deleted ${PUNCH_PHOTO_DAYS} days after the punch, unless you have a pay question open then.`,
  },
  {
    key: "pay",
    category: "Pay and tips",
    what: "Hours, services and products sold, card, cash and gift-card tips, cash tips you declare with your attestation, commission, what payroll paid you, your W-2 tip figures, and your tip deposit choice and consent.",
    why: "To pay you correctly, report tips and wages as tax law requires, and answer pay questions.",
    source: "Shop records, your declarations and payroll.",
    access: "You; managers and owners whose role covers pay at your shops; payroll and our accountants.",
    processors: "iSolved (payroll); Stripe only if tips are ever paid by Stripe (it keeps your ID and bank details; Ray'z keeps the account id, status and last 4 digits).",
    retention: `At least ${PAY_RECORD_YEARS} years after the year they belong to.`,
  },
  {
    key: "notifications",
    category: "Notifications",
    what: "Your phone's push token, platform and app version, and which alerts you chose.",
    why: "To send the alerts you chose, and to hold non-urgent ones while you're off the clock.",
    source: "Your phone, with your permission.",
    access: "Nobody reads them; the system uses them to send.",
    processors: "Apple and Google (push); Twilio (texts); our email provider.",
    retention: `Deleted ${SIGNED_OUT_DEVICE_DAYS} days after the phone signs out; the record of sent messages is kept at least ${PAY_RECORD_YEARS} years.`,
  },
  {
    key: "client_access",
    category: "What you do with client records",
    what: "Opening a client card, searches, revealing a masked detail (with the reason you gave), calls and texts through the shop line, and booking changes.",
    why: "The brand's client privacy rules require a record of who looked at what.",
    source: "The app and website, as you use them.",
    access: "Owners and managers who review the privacy log.",
    processors: "Hosting and database; Twilio (the shop line).",
    retention: `At least ${PAY_RECORD_YEARS} years, with the audit log.`,
  },
  {
    key: "pay_questions",
    category: "Pay questions",
    what: "Questions you raise about your pay, the answers, and who escalated or closed them.",
    why: "So every pay question is answered and can be checked later.",
    source: "You and the managers and owners who answer.",
    access: "You; the managers who answer pay questions at that shop; the owners once escalated.",
    processors: "Hosting and database; our email provider for the alerts.",
    retention: `At least ${PAY_RECORD_YEARS} years after it's closed.`,
  },
];

// ───────────────────────────── Pay questions ─────────────────────────────

export const PAY_QUESTION_TOPICS = ["hours", "overtime", "breaks", "tips", "commission", "deductions", "pay_date", "other"] as const;
export type PayQuestionTopic = (typeof PAY_QUESTION_TOPICS)[number];
export const PAY_QUESTION_TOPIC_LABEL: Record<PayQuestionTopic, string> = {
  hours: "Hours or punches",
  overtime: "Overtime",
  breaks: "Breaks and meal periods",
  tips: "Tips",
  commission: "Commission",
  deductions: "Deductions",
  pay_date: "When I was paid",
  other: "Something else",
};
export type PayQuestionLevel = "manager" | "owner";
export type PayQuestionStatus = "open" | "answered" | "resolved";
/** A manager has this many days to answer before it goes to the owners on its own. */
export const PAY_QUESTION_MANAGER_DAYS = 5;
/** Owners answer an escalated question within this many days. */
export const PAY_QUESTION_OWNER_DAYS = 7;
export const PAY_QUESTION_MAX_OPEN = 10;
export const PAY_QUESTION_MAX_CHARS = 2000;

export const NO_RETALIATION =
  "Nobody at Ray'z may punish, threaten or treat you differently for asking about your pay, raising a pay question, escalating it, or going to an outside agency. Tell an owner, or the agency, if that happens.";

export const PAY_QUESTION_STEPS = [
  {
    title: "Ask in the app",
    body: `In the app's pay screen tap "Question my pay" (or use Pay questions on the staff website), pick the pay period and what it's about, and say what looks wrong. It goes to the managers who approve timecards at that shop, who answer within ${PAY_QUESTION_MANAGER_DAYS} days. You can also ask your manager in person; they log it for you.`,
  },
  {
    title: "Escalate to the owners",
    body: `If nobody answers within ${PAY_QUESTION_MANAGER_DAYS} days it goes to the owners on its own, and you can send it to them yourself any time you're not satisfied with the answer. Owners answer within ${PAY_QUESTION_OWNER_DAYS} days.`,
  },
  {
    title: "Getting it fixed",
    body: "If you were paid short, the difference is paid no later than your next regular payday, and the timecard or tip record is corrected with a note saying why.",
  },
  {
    title: "Outside help, any time",
    body: "You don't have to use these steps first. You can contact the labor department for the state you work in, or the U.S. Department of Labor, at any time.",
  },
] as const;

export const PAY_AGENCIES = [
  { state: "IL", name: "Illinois Department of Labor (wage claims)", url: "https://labor.illinois.gov" },
  { state: "IA", name: "Iowa Division of Labor, Department of Inspections, Appeals, and Licensing (wage claims)", url: "https://dial.iowa.gov" },
  { state: "US", name: "U.S. Department of Labor, Wage and Hour Division", url: "https://www.dol.gov/agencies/whd", phone: "1-866-487-9243" },
] as const;

// ───────────────────────────── Review before release ─────────────────────────────

export const PRIVACY_REVIEW_CHECKS = ["notice", "retention", "payQuestions", "agencies"] as const;
export type PrivacyReviewCheck = (typeof PRIVACY_REVIEW_CHECKS)[number];
export const PRIVACY_REVIEW_CHECK_LABEL: Record<PrivacyReviewCheck, string> = {
  notice: "The notice's wording (collection, use, sharing, choices)",
  retention: "The retention periods in the data map",
  payQuestions: "The pay question steps, deadlines and the next-payday correction",
  agencies: "The outside agency names and contacts for Illinois, Iowa and the United States",
};

export interface PrivacyReview {
  /** The STAFF_LEGAL_VERSIONS.privacy this review covers: a new version needs a new review. */
  version: string;
  reviewer: string | null;
  reviewedOn: string | null;
  approved: Partial<Record<PrivacyReviewCheck, boolean>>;
}

/** Filled in by whoever signs off the notice (counsel or the owner they name); `pnpm staff:release-check` reads it. */
export const STAFF_PRIVACY_REVIEW: PrivacyReview = {
  version: STAFF_LEGAL_VERSIONS.privacy,
  reviewer: null,
  reviewedOn: null,
  approved: {},
};

/** What still stops the staff app's release on the privacy notice; empty once it's signed off. */
export function privacyReleaseProblems(r: PrivacyReview = STAFF_PRIVACY_REVIEW, current: string = STAFF_LEGAL_VERSIONS.privacy): string[] {
  const out: string[] = [];
  if (r.version !== current) out.push(`The review covers the ${r.version} notice, but the notice is now ${current}. Review the new wording.`);
  if (!r.reviewer?.trim()) out.push("Nobody is named as the reviewer.");
  if (!r.reviewedOn || !/^\d{4}-\d{2}-\d{2}$/.test(r.reviewedOn)) out.push("The review date is missing.");
  for (const c of PRIVACY_REVIEW_CHECKS) if (!r.approved[c]) out.push(`Not signed off: ${PRIVACY_REVIEW_CHECK_LABEL[c]}.`);
  return out;
}

export const privacyReviewed = (r: PrivacyReview = STAFF_PRIVACY_REVIEW) => privacyReleaseProblems(r).length === 0;
