import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { shopCutovers, shops, staff, staffOnboardingInvites, staffPayoutAccounts, staffShops } from "@/db/schema";
import { BankingStatus, requirementLabels } from "@/domain/banking";
import {
  ChannelChoice,
  DEFAULT_REMINDERS,
  InviteChannel,
  ONBOARDING_PROGRESS,
  OnboardingProgress,
  RESEND_GAP_MS,
  ReminderPolicy,
  inSendingHours,
  inviteChannels,
  nextReminderAt,
  onboardingMessage,
  onboardingProgress,
  reminderDue,
} from "@/domain/staff-onboarding";
import { reminderPolicy } from "@/domain/tips";
import { appBaseUrl } from "@/lib/deployment";
import { formatCents } from "@/lib/money";
import { formatDate, todayLocal, toZoned, weekdayOf, type LocalDate } from "@/lib/time";
import { Actor, SYSTEM, audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { enqueueRaw } from "@/server/notifications/queue";
import { connectMode } from "@/server/payments/connect";
import { StaffPayoutAccount, staffAccountState } from "./accounts";
import { tipPolicy } from "./ledger";
import { assertStripePayouts, stripePayoutsOn } from "./payout-model";
import { PAYOUT_SETUP_PATH, waitingForSetup } from "./payouts";

/**
 * Staff payout onboarding: everyone sets up a new Stripe Express account under Ray'z (no Squire
 * account carries over). Managers see where each person is, send invites by text or email in bulk,
 * and reminders follow until the person is done. Contact details never leave the server; the roster
 * says only whether there's an email or a phone to send to.
 */

export const MAX_INVITES_AT_ONCE = 500;

type Invite = typeof staffOnboardingInvites.$inferSelect;

/** A Ray'z Stripe account they've been sent to. A simulator account doesn't count once real keys are in. */
const hasRayzAccount = (a: StaffPayoutAccount | null) => !!a?.stripeAccountId && !(a.simulated && connectMode() === "stripe");

export function progressOf(a: StaffPayoutAccount | null, inv: Invite | null): { status: BankingStatus; progress: OnboardingProgress } {
  const status = staffAccountState(a);
  return { status, progress: onboardingProgress({ status, hasAccount: hasRayzAccount(a), invited: !!inv }) };
}

/** The earliest Squire tips end date still ahead among these shops. */
export function squireDeadline(ends: readonly (LocalDate | null | undefined)[], today: LocalDate): LocalDate | null {
  return ends.filter((d): d is LocalDate => !!d && d >= today).sort()[0] ?? null;
}

export interface OnboardingRow {
  staffId: string;
  name: string;
  shops: { id: string; name: string }[];
  hasEmail: boolean;
  hasPhone: boolean;
  status: BankingStatus;
  progress: OnboardingProgress;
  invite: { firstSentAt: Date; lastSentAt: Date; invites: number; reminders: number; channels: InviteChannel[]; remindersStoppedAt: Date | null } | null;
  nextReminderAt: Date | null;
  /** What Stripe still needs from them, in plain words. */
  needs: string[];
  stripeDeadline: Date | null;
  waitingCents: number;
  waitingPayouts: number;
  /** The earliest Squire tips end date still ahead at their shops. */
  squireTipsEndOn: LocalDate | null;
}

async function policiesFor(shopIds: readonly string[]) {
  const out = new Map<string, ReminderPolicy>();
  for (const id of new Set(shopIds)) out.set(id, reminderPolicy(await tipPolicy(id)));
  return out;
}

/** Everyone active at these shops and where they are with payout setup, for the managers' tracker. */
export async function onboardingRoster(shopIds: readonly string[], now = new Date()) {
  const ids = [...shopIds];
  const links = ids.length
    ? await db
        .select({
          staffId: staff.id,
          name: staff.displayLabel,
          hasEmail: sql<boolean>`${staff.email} is not null`,
          hasPhone: sql<boolean>`${staff.phone} is not null`,
          shopId: shops.id,
          shopName: shops.name,
        })
        .from(staffShops)
        .innerJoin(staff, eq(staff.id, staffShops.staffId))
        .innerJoin(shops, eq(shops.id, staffShops.shopId))
        .where(and(inArray(staffShops.shopId, ids), eq(staff.active, true), eq(staff.kind, "person")))
        .orderBy(asc(staff.displayLabel), desc(staffShops.isPrimary), asc(shops.name))
    : [];
  const people = new Map<string, { name: string; hasEmail: boolean; hasPhone: boolean; shops: { id: string; name: string }[] }>();
  for (const l of links) {
    const p = people.get(l.staffId) ?? { name: l.name, hasEmail: l.hasEmail, hasPhone: l.hasPhone, shops: [] };
    p.shops.push({ id: l.shopId, name: l.shopName });
    people.set(l.staffId, p);
  }
  const staffIds = [...people.keys()];
  const [accounts, invites, waiting, cutovers, policies] = await Promise.all([
    staffIds.length ? db.select().from(staffPayoutAccounts).where(inArray(staffPayoutAccounts.staffId, staffIds)) : [],
    staffIds.length ? db.select().from(staffOnboardingInvites).where(inArray(staffOnboardingInvites.staffId, staffIds)) : [],
    waitingForSetup(staffIds),
    ids.length ? db.select({ shopId: shopCutovers.shopId, end: shopCutovers.squireTipsEndOn }).from(shopCutovers).where(inArray(shopCutovers.shopId, ids)) : [],
    policiesFor(links.map((l) => l.shopId)),
  ]);
  const acct = new Map(accounts.map((a) => [a.staffId, a]));
  const inv = new Map(invites.map((i) => [i.staffId, i]));
  const ends = new Map(cutovers.map((c) => [c.shopId, c.end as LocalDate | null]));
  const today = todayLocal(now);
  const rows: OnboardingRow[] = [...people].map(([staffId, p]) => {
    const a = acct.get(staffId) ?? null;
    const i = inv.get(staffId) ?? null;
    const { status, progress } = progressOf(a, i);
    const w = waiting.get(staffId);
    const policy = policies.get(p.shops[0].id) ?? DEFAULT_REMINDERS;
    return {
      staffId,
      name: p.name,
      shops: p.shops,
      hasEmail: p.hasEmail,
      hasPhone: p.hasPhone,
      status,
      progress,
      invite: i && { firstSentAt: i.firstSentAt, lastSentAt: i.lastSentAt, invites: i.invites, reminders: i.reminders, channels: i.channels, remindersStoppedAt: i.remindersStoppedAt },
      nextReminderAt: i ? nextReminderAt(i, progress, policy) : null,
      needs: progress === "blocked" ? requirementLabels(a?.requirementsDue ?? []) : [],
      stripeDeadline: progress === "blocked" ? (a?.requirementsDeadline ?? null) : null,
      waitingCents: w?.cents ?? 0,
      waitingPayouts: w?.payouts ?? 0,
      squireTipsEndOn: squireDeadline(
        p.shops.map((s) => ends.get(s.id)),
        today,
      ),
    };
  });
  const counts = Object.fromEntries(ONBOARDING_PROGRESS.map((k) => [k, rows.filter((r) => r.progress === k).length])) as Record<OnboardingProgress, number>;
  return { rows, counts, total: rows.length, waitingCents: rows.reduce((s, r) => s + r.waitingCents, 0) };
}

/** Per shop: how many active people there and how many can be paid through Stripe, for the cutover checklist. */
export async function shopOnboardingCounts(shopIds: readonly string[], now = new Date()) {
  const out = new Map<string, { total: number; done: number; notDone: { staffId: string; name: string; progress: OnboardingProgress }[] }>();
  for (const id of shopIds) {
    const { rows } = await onboardingRoster([id], now);
    const notDone = rows.filter((r) => r.progress !== "done").map((r) => ({ staffId: r.staffId, name: r.name, progress: r.progress }));
    out.set(id, { total: rows.length, done: rows.length - notDone.length, notDone });
  }
  return out;
}

async function contactsOf(staffIds: readonly string[]) {
  if (!staffIds.length) return new Map<string, { firstName: string; email: string | null; phone: string | null; homeShopId: string | null; shopIds: string[] }>();
  const rows = await db
    .select({ id: staff.id, firstName: staff.firstName, email: staff.email, phone: staff.phone, shopId: staffShops.shopId, isPrimary: staffShops.isPrimary })
    .from(staff)
    .leftJoin(staffShops, eq(staffShops.staffId, staff.id))
    .where(inArray(staff.id, [...staffIds]))
    .orderBy(desc(staffShops.isPrimary));
  const out = new Map<string, { firstName: string; email: string | null; phone: string | null; homeShopId: string | null; shopIds: string[] }>();
  for (const r of rows) {
    const c = out.get(r.id) ?? { firstName: r.firstName, email: r.email, phone: r.phone, homeShopId: r.shopId, shopIds: [] };
    if (r.shopId) c.shopIds.push(r.shopId);
    out.set(r.id, c);
  }
  return out;
}

async function deadlinesOf(shopIds: readonly string[]) {
  if (!shopIds.length) return new Map<string, LocalDate | null>();
  const rows = await db.select({ shopId: shopCutovers.shopId, end: shopCutovers.squireTipsEndOn }).from(shopCutovers).where(inArray(shopCutovers.shopId, [...new Set(shopIds)]));
  return new Map(rows.map((r) => [r.shopId, r.end as LocalDate | null]));
}

async function send(channels: readonly InviteChannel[], to: { email: string | null; phone: string | null }, msg: { subject: string; body: string; sms: string }, shopId: string) {
  for (const c of channels) {
    if (c === "email" && to.email) await enqueueRaw({ kind: "tip_onboarding", channel: "email", to: to.email, subject: msg.subject, body: msg.body, shopId });
    if (c === "sms" && to.phone) await enqueueRaw({ kind: "tip_onboarding", channel: "sms", to: to.phone, body: msg.sms, shopId });
  }
}

export interface InviteSkip {
  staffId: string;
  name: string | null;
  why: string;
}

/**
 * Invites (or re-invites) people to set up payouts, by text, email or both; whoever lacks the one
 * asked for gets the other. Done and verifying are skipped, and so is anyone invited in the last few
 * minutes, so a double click doesn't text twice. Each invite restarts their reminders.
 */
export async function sendOnboardingInvites(o: { actor: Actor; staffIds: readonly string[]; choice: ChannelChoice; allowedShopIds: readonly string[]; now?: Date }) {
  assertStripePayouts();
  const now = o.now ?? new Date();
  const wanted = [...new Set(o.staffIds)];
  if (!wanted.length) throw new AppError("bad_request", "Pick who to invite");
  if (wanted.length > MAX_INVITES_AT_ONCE) throw new AppError("bad_request", `Invite at most ${MAX_INVITES_AT_ONCE} people at once`);
  const { rows } = await onboardingRoster(o.allowedShopIds, now);
  const byId = new Map(rows.map((r) => [r.staffId, r]));
  const skipped: InviteSkip[] = [];
  const go: { row: OnboardingRow; channels: InviteChannel[] }[] = [];
  for (const id of wanted) {
    const r = byId.get(id);
    if (!r) skipped.push({ staffId: id, name: null, why: "Not on the team at your locations" });
    else if (r.progress === "done") skipped.push({ staffId: id, name: r.name, why: "Already done" });
    else if (r.progress === "verifying") skipped.push({ staffId: id, name: r.name, why: "Finished; Stripe is verifying" });
    else if (r.invite && now.getTime() - r.invite.lastSentAt.getTime() < RESEND_GAP_MS) skipped.push({ staffId: id, name: r.name, why: "Invited a few minutes ago" });
    else {
      const channels = inviteChannels(o.choice, { email: r.hasEmail, phone: r.hasPhone });
      if (!channels.length) skipped.push({ staffId: id, name: r.name, why: "No email or mobile number on their profile" });
      else go.push({ row: r, channels });
    }
  }
  const contacts = await contactsOf(go.map((g) => g.row.staffId));
  const ends = await deadlinesOf([...contacts.values()].flatMap((c) => c.shopIds));
  const link = `${appBaseUrl()}${PAYOUT_SETUP_PATH}`;
  const today = todayLocal(now);
  let sent = 0;
  for (const { row, channels } of go) {
    const c = contacts.get(row.staffId);
    if (!c?.homeShopId) {
      skipped.push({ staffId: row.staffId, name: row.name, why: "Not at any location" });
      continue;
    }
    const deadline = squireDeadline(
      c.shopIds.map((s) => ends.get(s)),
      today,
    );
    const kind = row.progress === "not_invited" || row.progress === "invited" ? "invite" : "reminder";
    const msg = onboardingMessage({
      firstName: c.firstName,
      link,
      kind,
      progress: row.progress,
      deadline: deadline ? formatDate(deadline, "EEE, MMM d") : null,
      waiting: row.waitingCents > 0 ? formatCents(row.waitingCents) : null,
      needs: row.needs,
    });
    await send(channels, c, msg, c.homeShopId);
    await db
      .insert(staffOnboardingInvites)
      .values({ staffId: row.staffId, firstSentAt: now, firstSentBy: o.actor.staffId ?? null, lastSentAt: now, lastSentBy: o.actor.staffId ?? null, channels, invites: 1, reminders: 0, updatedAt: now })
      .onConflictDoUpdate({
        target: staffOnboardingInvites.staffId,
        set: { lastSentAt: now, lastSentBy: o.actor.staffId ?? null, channels, invites: sql`${staffOnboardingInvites.invites} + 1`, reminders: 0, remindersStoppedAt: null, updatedAt: now },
      });
    await audit(o.actor, "tips.onboarding_invite", "staff", row.staffId, { channels, progress: row.progress, wording: kind }, c.homeShopId);
    sent++;
  }
  return { sent, skipped };
}

/** A manager stops someone's reminders (they're on leave, say). The next invite starts them again. */
export async function stopOnboardingReminders(actor: Actor, staffId: string, allowedShopIds: readonly string[], now = new Date()) {
  const { rows } = await onboardingRoster(allowedShopIds, now);
  const r = rows.find((x) => x.staffId === staffId);
  if (!r) throw new AppError("not_found", "Not on the team at your locations");
  const [row] = await db
    .update(staffOnboardingInvites)
    .set({ remindersStoppedAt: now, updatedAt: now })
    .where(and(eq(staffOnboardingInvites.staffId, staffId), isNull(staffOnboardingInvites.remindersStoppedAt)))
    .returning();
  if (!row) throw new AppError("conflict", "Their reminders are already off");
  await audit(actor, "tips.onboarding_reminders_stopped", "staff", staffId, { reminders: row.reminders }, r.shops[0]?.id);
}

/**
 * Reminders, from the notifications cron: to everyone invited who isn't done, every few days (the
 * brand's setting) up to the brand's limit, 9 AM to 7 PM. Someone done, gone or no longer on the
 * payroll side stops getting them; someone Stripe is verifying waits.
 */
export async function onboardingReminderCron(now = new Date(), limit = 300) {
  const out = { sent: 0, stopped: 0, waiting: 0 };
  if (!stripePayoutsOn() || !inSendingHours(toZoned(now).hour)) return out;
  const due = await db
    .select()
    .from(staffOnboardingInvites)
    .where(and(isNull(staffOnboardingInvites.remindersStoppedAt), lte(staffOnboardingInvites.lastSentAt, new Date(now.getTime() - 86_400_000))))
    .orderBy(asc(staffOnboardingInvites.lastSentAt))
    .limit(limit);
  if (!due.length) return out;
  const ids = due.map((d) => d.staffId);
  const [people, accounts, contacts, waiting] = await Promise.all([
    db.select({ id: staff.id, active: staff.active, kind: staff.kind }).from(staff).where(inArray(staff.id, ids)),
    db.select().from(staffPayoutAccounts).where(inArray(staffPayoutAccounts.staffId, ids)),
    contactsOf(ids),
    waitingForSetup(ids),
  ]);
  const who = new Map(people.map((p) => [p.id, p]));
  const acct = new Map(accounts.map((a) => [a.staffId, a]));
  const ends = await deadlinesOf([...contacts.values()].flatMap((c) => c.shopIds));
  const policies = await policiesFor([...contacts.values()].map((c) => c.homeShopId).filter((x): x is string => !!x));
  const link = `${appBaseUrl()}${PAYOUT_SETUP_PATH}`;
  const today = todayLocal(now);
  const stop = async (staffId: string) => {
    await db.update(staffOnboardingInvites).set({ remindersStoppedAt: now, updatedAt: now }).where(and(eq(staffOnboardingInvites.staffId, staffId), isNull(staffOnboardingInvites.remindersStoppedAt)));
    out.stopped++;
  };
  for (const inv of due) {
    const p = who.get(inv.staffId);
    const c = contacts.get(inv.staffId);
    const a = acct.get(inv.staffId) ?? null;
    const { progress } = progressOf(a, inv);
    if (!p?.active || p.kind !== "person" || !c?.homeShopId || progress === "done") {
      await stop(inv.staffId);
      continue;
    }
    if (progress === "verifying") {
      out.waiting++;
      continue;
    }
    const policy = policies.get(c.homeShopId)!;
    if (!reminderDue(inv, progress, policy, now)) continue;
    let channels = inv.channels.filter((ch) => (ch === "sms" ? !!c.phone : !!c.email));
    if (!channels.length) channels = inviteChannels("email", { email: !!c.email, phone: !!c.phone });
    if (!channels.length) continue;
    const [claimed] = await db
      .update(staffOnboardingInvites)
      .set({ reminders: sql`${staffOnboardingInvites.reminders} + 1`, lastSentAt: now, updatedAt: now })
      .where(and(eq(staffOnboardingInvites.staffId, inv.staffId), eq(staffOnboardingInvites.lastSentAt, inv.lastSentAt), isNull(staffOnboardingInvites.remindersStoppedAt)))
      .returning();
    if (!claimed) continue;
    const deadline = squireDeadline(
      c.shopIds.map((s) => ends.get(s)),
      today,
    );
    const w = waiting.get(inv.staffId);
    const msg = onboardingMessage({
      firstName: c.firstName,
      link,
      kind: "reminder",
      progress,
      deadline: deadline ? formatDate(deadline, "EEE, MMM d") : null,
      waiting: w?.cents ? formatCents(w.cents) : null,
      needs: progress === "blocked" ? requirementLabels(a?.requirementsDue ?? []) : [],
    });
    await send(channels, c, msg, c.homeShopId);
    await audit(SYSTEM, "tips.onboarding_reminder", "staff", inv.staffId, { reminder: claimed.reminders, of: policy.max, channels, progress }, c.homeShopId);
    out.sent++;
  }
  return out;
}

/** The last day Squire pays a shop's tips; everyone there should be done with payout setup before it. Null clears it. */
export async function setSquireTipsEnd(actor: Actor, shopId: string, end: LocalDate | null, now = new Date()) {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true } });
  if (!shop) throw new AppError("not_found", "No such shop");
  if (end && weekdayOf(end) !== 6) throw new AppError("bad_request", "Squire stops at a Saturday close, so the first Ray'z week starts on a Sunday: pick a Saturday.", { field: "end" });
  await db.insert(shopCutovers).values({ shopId, squireTipsEndOn: end, updatedAt: now }).onConflictDoUpdate({ target: shopCutovers.shopId, set: { squireTipsEndOn: end, updatedAt: now } });
  await audit(actor, "cutover.squire_tips_end", "shop", shopId, { squireTipsEndOn: end }, shopId);
}
