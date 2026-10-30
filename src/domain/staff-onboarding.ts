/**
 * Staff payout onboarding. Every employee sets up a new Stripe recipient account under Ray'z (no
 * Squire account carries over), so the brand tracks who's been invited, who started, who's done and
 * who Stripe is holding up, and reminds the rest. Pure: tests/staff-onboarding.test.ts.
 */
import type { BankingStatus } from "./banking";

export const ONBOARDING_PROGRESS = ["not_invited", "invited", "started", "blocked", "verifying", "done"] as const;
export type OnboardingProgress = (typeof ONBOARDING_PROGRESS)[number];

export const ONBOARDING_LABEL: Record<OnboardingProgress, string> = {
  not_invited: "Not invited",
  invited: "Invited",
  started: "Started",
  blocked: "Blocked on Stripe",
  verifying: "Stripe is verifying",
  done: "Done",
};

export const ONBOARDING_HINT: Record<OnboardingProgress, string> = {
  not_invited: "No invite sent yet",
  invited: "Invited, hasn't opened Stripe's page yet",
  started: "Opened Stripe's page, hasn't finished",
  blocked: "Stripe needs more from them before it can pay them",
  verifying: "Finished; Stripe is checking what they sent",
  done: "Stripe can pay them",
};

export const ONBOARDING_TONE: Record<OnboardingProgress, "gray" | "blue" | "amber" | "red" | "violet" | "green"> = {
  not_invited: "gray",
  invited: "blue",
  started: "amber",
  blocked: "red",
  verifying: "violet",
  done: "green",
};

/**
 * Where someone is. `hasAccount` is a Ray'z Stripe account they've been sent to (a simulator account
 * doesn't count once real keys are in); `invited` is any invite sent.
 */
export function onboardingProgress(o: { status: BankingStatus; hasAccount: boolean; invited: boolean }): OnboardingProgress {
  if (o.status === "ready") return "done";
  if (o.status === "action_needed") return "blocked";
  if (o.status === "pending_verification") return "verifying";
  if (o.hasAccount) return "started";
  return o.invited ? "invited" : "not_invited";
}

/** Whether someone is still on the list to finish: everyone but done and (their part over) verifying. */
export const stillToDo = (p: OnboardingProgress) => p !== "done" && p !== "verifying";

export interface ReminderPolicy {
  /** Days between the last invite or reminder and the next reminder. */
  everyDays: number;
  /** Reminders after each invite; 0 turns them off. */
  max: number;
}
export const DEFAULT_REMINDERS: ReminderPolicy = { everyDays: 3, max: 4 };

const DAY = 86_400_000;

export function reminderDue(inv: { lastSentAt: Date; reminders: number; remindersStoppedAt: Date | null }, progress: OnboardingProgress, policy: ReminderPolicy, now: Date): boolean {
  if (inv.remindersStoppedAt || !stillToDo(progress) || policy.max <= 0 || inv.reminders >= policy.max) return false;
  return now.getTime() - inv.lastSentAt.getTime() >= policy.everyDays * DAY;
}

/** When the next reminder would go, or null when none will. */
export function nextReminderAt(inv: { lastSentAt: Date; reminders: number; remindersStoppedAt: Date | null }, progress: OnboardingProgress, policy: ReminderPolicy): Date | null {
  if (inv.remindersStoppedAt || !stillToDo(progress) || policy.max <= 0 || inv.reminders >= policy.max) return null;
  return new Date(inv.lastSentAt.getTime() + policy.everyDays * DAY);
}

/** Reminders go out between 9 AM and 7 PM where the employee's shop is. */
export const inSendingHours = (localHour: number) => localHour >= 9 && localHour < 19;

/** A second invite to the same person within this long is skipped, so a double click doesn't text twice. */
export const RESEND_GAP_MS = 10 * 60_000;

export type InviteChannel = "sms" | "email";
export type ChannelChoice = InviteChannel | "both";
export const CHANNEL_CHOICE_LABEL: Record<ChannelChoice, string> = { sms: "Text", email: "Email", both: "Text and email" };

/** The channels an invite goes on: what was asked for that they have, else whichever they have. */
export function inviteChannels(choice: ChannelChoice, has: { email: boolean; phone: boolean }): InviteChannel[] {
  const want: InviteChannel[] = choice === "both" ? ["sms", "email"] : [choice];
  const ok = want.filter((c) => (c === "sms" ? has.phone : has.email));
  if (ok.length) return ok;
  if (has.email) return ["email"];
  if (has.phone) return ["sms"];
  return [];
}

export interface OnboardingMessageInput {
  firstName: string;
  link: string;
  kind: "invite" | "reminder";
  progress: OnboardingProgress;
  /** The last day Squire pays their shop's tips, formatted, when it's set and still ahead. */
  deadline?: string | null;
  /** Tips approved for them and waiting on their setup, formatted, when there are any. */
  waiting?: string | null;
  /** What Stripe still needs, in plain words, when they're blocked. */
  needs?: readonly string[];
}

/** The invite or reminder, by email and by text. No account details, ever; Stripe collects them on its own page. */
export function onboardingMessage(o: OnboardingMessageInput): { subject: string; body: string; sms: string } {
  const by = o.deadline ? ` by ${o.deadline}, when Squire stops paying tips` : "";
  const waiting = o.waiting ? ` ${o.waiting} in tips is waiting for you and goes out as soon as you're done.` : "";
  const safe = "Stripe collects your details on its own secure page; Ray'z never sees your bank or card numbers.";
  if (o.kind === "invite") {
    return {
      subject: "Set up your Ray'z tip payouts with Stripe",
      body:
        `Hi ${o.firstName}, Ray'z now pays tips through Stripe. Everyone sets up a new Stripe payout account under Ray'z, even if you had one with Squire. ` +
        `It takes about 5 minutes: your ID, the bank account for standard payouts, and a debit card if you want instant payouts. Please finish${by}.${waiting} ${safe} Start here: ${o.link}`,
      sms: `Ray'z: set up your new tip payout account with Stripe (about 5 min, even if you had one with Squire)${by}.${waiting ? ` Tips are waiting.` : ""} ${o.link}`,
    };
  }
  const blocked = o.progress === "blocked";
  const started = o.progress === "started";
  const needs = blocked && o.needs?.length ? ` Stripe still needs: ${o.needs.join("; ")}.` : "";
  const lead = blocked
    ? "Stripe needs a little more before it can pay your tips."
    : started
      ? "You started setting up your Ray'z tip payouts but haven't finished."
      : "You haven't set up your Ray'z tip payouts yet.";
  return {
    subject: blocked ? "Stripe needs more to pay your tips" : "Reminder: finish your Ray'z tip payout setup",
    body: `Hi ${o.firstName}, ${lead}${needs} Please finish${by}.${waiting} ${safe} Continue here: ${o.link}`,
    sms: `Ray'z reminder: ${blocked ? "Stripe needs more info to pay your tips" : "finish your tip payout setup"}${by}.${waiting ? " Tips are waiting." : ""} ${o.link}`,
  };
}

export const SETUP_HOLD_REASON = "Waiting for them to finish Stripe payout setup; sent on its own once they do";
