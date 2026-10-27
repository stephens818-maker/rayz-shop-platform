import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMINDERS,
  ONBOARDING_LABEL,
  ONBOARDING_PROGRESS,
  inSendingHours,
  inviteChannels,
  nextReminderAt,
  onboardingMessage,
  onboardingProgress,
  reminderDue,
  stillToDo,
} from "@/domain/staff-onboarding";

const DAY = 86_400_000;
const t0 = new Date("2026-11-02T15:00:00Z");
const inv = (o: Partial<{ lastSentAt: Date; reminders: number; remindersStoppedAt: Date | null }> = {}) => ({ lastSentAt: t0, reminders: 0, remindersStoppedAt: null, ...o });

describe("where someone is with Ray'z Stripe payout setup", () => {
  it("not invited, invited, started, blocked on Stripe, verifying, done", () => {
    expect(onboardingProgress({ status: "not_set_up", hasAccount: false, invited: false })).toBe("not_invited");
    expect(onboardingProgress({ status: "not_set_up", hasAccount: false, invited: true })).toBe("invited");
    expect(onboardingProgress({ status: "not_set_up", hasAccount: true, invited: false })).toBe("started");
    expect(onboardingProgress({ status: "action_needed", hasAccount: true, invited: true })).toBe("blocked");
    expect(onboardingProgress({ status: "pending_verification", hasAccount: true, invited: true })).toBe("verifying");
    expect(onboardingProgress({ status: "ready", hasAccount: true, invited: false })).toBe("done");
    expect(ONBOARDING_PROGRESS.filter(stillToDo)).toEqual(["not_invited", "invited", "started", "blocked"]);
    expect(ONBOARDING_LABEL.blocked).toBe("Blocked on Stripe");
  });
});

describe("reminders", () => {
  it("every few days after the last invite or reminder, up to the limit, only while there's something for them to do", () => {
    const p = DEFAULT_REMINDERS;
    expect(reminderDue(inv(), "invited", p, new Date(t0.getTime() + 3 * DAY - 1))).toBe(false);
    expect(reminderDue(inv(), "invited", p, new Date(t0.getTime() + 3 * DAY))).toBe(true);
    expect(reminderDue(inv(), "blocked", p, new Date(t0.getTime() + 5 * DAY))).toBe(true);
    expect(reminderDue(inv({ reminders: 4 }), "started", p, new Date(t0.getTime() + 30 * DAY))).toBe(false);
    expect(reminderDue(inv({ remindersStoppedAt: t0 }), "invited", p, new Date(t0.getTime() + 30 * DAY))).toBe(false);
    expect(reminderDue(inv(), "verifying", p, new Date(t0.getTime() + 30 * DAY))).toBe(false);
    expect(reminderDue(inv(), "done", p, new Date(t0.getTime() + 30 * DAY))).toBe(false);
    expect(reminderDue(inv(), "invited", { everyDays: 3, max: 0 }, new Date(t0.getTime() + 30 * DAY))).toBe(false);
    expect(nextReminderAt(inv({ reminders: 1 }), "started", p)).toEqual(new Date(t0.getTime() + 3 * DAY));
    expect(nextReminderAt(inv({ reminders: 4 }), "started", p)).toBeNull();
    expect(nextReminderAt(inv(), "done", p)).toBeNull();
  });

  it("go out 9 AM to 7 PM", () => {
    expect([8, 9, 18, 19].map(inSendingHours)).toEqual([false, true, true, false]);
  });
});

describe("invite channels", () => {
  it("what was asked for that they have, else whichever they have", () => {
    expect(inviteChannels("both", { email: true, phone: true })).toEqual(["sms", "email"]);
    expect(inviteChannels("both", { email: false, phone: true })).toEqual(["sms"]);
    expect(inviteChannels("sms", { email: true, phone: false })).toEqual(["email"]);
    expect(inviteChannels("email", { email: false, phone: true })).toEqual(["sms"]);
    expect(inviteChannels("sms", { email: false, phone: false })).toEqual([]);
  });
});

describe("the invite and reminder wording", () => {
  it("says everyone re-registers under Ray'z, by when, and never asks for account details", () => {
    const m = onboardingMessage({ firstName: "Beth", link: "https://rayz.example/staff-app/payouts", kind: "invite", progress: "not_invited", deadline: "Sun, Nov 15", waiting: "$84.00" });
    expect(m.body).toMatch(/new Stripe payout account under Ray'z, even if you had one with Squire/);
    expect(m.body).toMatch(/by Sun, Nov 15, when Squire stops paying tips/);
    expect(m.body).toMatch(/\$84\.00 in tips is waiting for you/);
    expect(m.body).toMatch(/Ray'z never sees your bank or card numbers/);
    expect(m.sms).toMatch(/even if you had one with Squire/);
    expect(m.sms).toContain("https://rayz.example/staff-app/payouts");
    expect(m.sms.length).toBeLessThan(320);
    for (const s of [m.body, m.sms]) expect(s).not.toMatch(/routing|account number|SSN|social security/i);
  });

  it("a reminder to someone blocked lists what Stripe needs", () => {
    const m = onboardingMessage({ firstName: "Beth", link: "https://x", kind: "reminder", progress: "blocked", needs: ["Photo ID", "Bank account"] });
    expect(m.subject).toBe("Stripe needs more to pay your tips");
    expect(m.body).toMatch(/Stripe still needs: Photo ID; Bank account\./);
    const started = onboardingMessage({ firstName: "Beth", link: "https://x", kind: "reminder", progress: "started" });
    expect(started.body).toMatch(/started setting up/);
    expect(started.body).not.toMatch(/by .*Squire/);
  });
});
