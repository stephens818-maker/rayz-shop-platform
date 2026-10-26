/**
 * A client deleting their own account (C10), from the app, the account page, or the public
 * /account/delete page (which works without the app). They see what happens first, confirm with a
 * fresh code to the phone or verified email on the profile, and only the profile they chose goes:
 * other adults sharing the phone are untouched, and their children's profiles go with them.
 *
 * Deleting anonymizes rather than removes the row: tickets, tips, payouts and the shop's accounting
 * still add up, under "Deleted client". Contact details, notes, photos, tags, preferences, sessions
 * and upcoming bookings are cleared; loyalty is forfeited; gift cards keep working by their code.
 * The Squire ID link stays so a later import can't bring the details back.
 */
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  appointments,
  calendarFeeds,
  clientNotes,
  clientPhotos,
  clientRatings,
  consentEvents,
  customerCards,
  customerDevices,
  customerTags,
  customers,
  giftCards,
  loyaltyAccounts,
  loyaltyRewards,
  memberships,
  messageThreads,
  notificationJobs,
  refreshTokens,
  sales,
} from "@/db/schema";
import { CONSENT_MARKERS } from "@/domain/consent-texts";
import { Actor, audit } from "./audit";
import { recordConsentChange } from "./consent-events";
import { AppError, notFound } from "./errors";
import { loyaltyBalance } from "./loyalty";
import { forgetStripeCustomer } from "./payments/saved-cards";

export const DELETED_NAME = "Deleted client";

type Customer = typeof customers.$inferSelect;

/** The profile being deleted: the signed-in client, or one of their children. */
export async function deletionTarget(customerId: string, profileId?: string | null): Promise<Customer> {
  const me = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!me || me.deletedAt) throw notFound("Customer");
  if (!profileId || profileId === customerId) return me;
  const child = await db.query.customers.findFirst({ where: and(eq(customers.id, profileId), eq(customers.guardianId, customerId)) });
  if (!child || child.deletedAt) throw notFound("Profile");
  return child;
}

async function childrenOf(id: string) {
  return db
    .select()
    .from(customers)
    .where(and(eq(customers.guardianId, id), isNull(customers.deletedAt)));
}

/** What deleting this profile does, for the confirmation screen. */
export async function deletionPreview(customerId: string, profileId?: string | null) {
  const target = await deletionTarget(customerId, profileId);
  const kids = target.guardianId ? [] : await childrenOf(target.id);
  const ids = [target.id, ...kids.map((k) => k.id)];
  const now = new Date();
  const [loyalty, upcoming, cards, active, [paid], saved] = await Promise.all([
    target.guardianId ? null : loyaltyBalance(target.id),
    db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(inArray(appointments.customerId, ids), gt(appointments.startsAt, now), inArray(appointments.status, ["booked", "confirmed"]))),
    db
      .select({ balance: giftCards.balanceCents })
      .from(giftCards)
      .where(and(inArray(giftCards.customerId, ids), eq(giftCards.status, "active"), gt(giftCards.balanceCents, 0))),
    db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(inArray(memberships.customerId, ids), inArray(memberships.status, ["active", "past_due", "incomplete"]))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sales)
      .where(inArray(sales.customerId, ids)),
    db
      .select({ id: customerCards.id })
      .from(customerCards)
      .where(and(inArray(customerCards.customerId, ids), isNull(customerCards.detachedAt))),
  ]);
  const blockers = active.length ? ["Cancel your membership first (ask the shop, or use the link in your membership emails). Then you can delete your account."] : [];
  return {
    profile: { id: target.id, firstName: target.firstName },
    dependents: kids.map((k) => ({ id: k.id, firstName: k.firstName })),
    canDelete: blockers.length === 0,
    blockers,
    forfeited: {
      loyaltyProgressCents: loyalty && !loyalty.household ? loyalty.progressCents : 0,
      loyaltyRewardsCents: loyalty && !loyalty.household ? loyalty.availableCents : 0,
      upcomingAppointments: upcoming.length,
    },
    giftCardBalanceCents: cards.reduce((a, c) => a + c.balance, 0),
    kept: {
      pastTickets: paid?.n ?? 0,
      explanation:
        'Your past tickets, payments and tips stay in the shop\'s records for accounting and tax, under "Deleted client" with no name, phone or email. A number that texted STOP stays on the do-not-text list.',
    },
    timing: "Immediately. Copies in our encrypted backups are gone within 35 days.",
    consequences: [
      ...(kids.length ? [`Your children's profiles (${kids.map((k) => k.firstName).join(", ")}) are deleted too.`] : []),
      ...(upcoming.length ? [`${upcoming.length} upcoming appointment${upcoming.length === 1 ? " is" : "s are"} cancelled.`] : []),
      ...(loyalty && !loyalty.household && (loyalty.progressCents > 0 || loyalty.availableCents > 0) ? ["Your rewards progress and any unused rewards are lost."] : []),
      ...(cards.length ? ["Gift cards keep their balance and still work with their code, but they're no longer linked to you."] : []),
      ...(saved.length ? [`Your saved card${saved.length === 1 ? " is" : "s are"} removed from Stripe.`] : []),
      "You're signed out everywhere, your devices stop getting notifications, and your phone and email are removed. Booking again later starts a new profile.",
    ],
  };
}

const NO_CONSENT = { smsOptIn: false, emailOptIn: false, smsMarketingOptIn: false, emailMarketingOptIn: false, pushMarketing: false, pushTransactional: false };

async function anonymize(tx: DBorTx, id: string, now: Date) {
  await tx
    .update(appointments)
    .set({ status: "cancelled", cancelledAt: now, cancelledBy: "client deleted account" })
    .where(and(eq(appointments.customerId, id), gt(appointments.startsAt, now), inArray(appointments.status, ["booked", "confirmed"])));
  await tx.update(appointments).set({ notes: null }).where(eq(appointments.customerId, id));
  await tx
    .update(notificationJobs)
    .set({ status: "cancelled" })
    .where(and(eq(notificationJobs.customerId, id), eq(notificationJobs.status, "pending")));
  await tx.delete(messageThreads).where(eq(messageThreads.customerId, id));
  await tx.delete(refreshTokens).where(eq(refreshTokens.customerId, id));
  await tx.update(customerDevices).set({ revokedAt: now, pushEnabled: false }).where(and(eq(customerDevices.customerId, id), isNull(customerDevices.revokedAt)));
  // The consent record stays as proof of what they agreed to and when, without their phone or email.
  const [c] = await tx.select().from(customers).where(eq(customers.id, id));
  if (c) await recordConsentChange(tx, { id, phone: null, email: null }, c, NO_CONSENT, { source: "web", textVersion: CONSENT_MARKERS.deleted });
  await tx.update(consentEvents).set({ phone: null, email: null }).where(eq(consentEvents.customerId, id));
  await tx.delete(clientPhotos).where(eq(clientPhotos.customerId, id));
  await tx.delete(customerTags).where(eq(customerTags.customerId, id));
  await tx.delete(clientNotes).where(eq(clientNotes.customerId, id));
  await tx.delete(clientRatings).where(eq(clientRatings.customerId, id));
  await tx.delete(calendarFeeds).where(eq(calendarFeeds.customerId, id));
  await tx
    .update(loyaltyRewards)
    .set({ expiresAt: now })
    .where(and(eq(loyaltyRewards.customerId, id), isNull(loyaltyRewards.redeemedAt)));
  await tx.update(loyaltyAccounts).set({ progressCents: 0, updatedAt: now }).where(eq(loyaltyAccounts.customerId, id));
  await tx.update(giftCards).set({ customerId: null }).where(eq(giftCards.customerId, id));
  await tx
    .update(customers)
    .set({
      firstName: DELETED_NAME,
      lastName: null,
      nickname: null,
      phone: null,
      email: null,
      emailVerifiedAt: null,
      receiptDelivery: null,
      address: null,
      birthday: null,
      birthYear: null,
      notes: null,
      preferencesNote: null,
      preferencesUpdatedAt: null,
      customFields: {},
      smsOptIn: false,
      emailOptIn: false,
      smsMarketingOptIn: false,
      emailMarketingOptIn: false,
      pushMarketing: false,
      pushTransactional: false,
      preferredStaffId: null,
      referredById: null,
      deletedAt: now,
    })
    .where(eq(customers.id, id));
}

/** Delete after the fresh code was checked. source is where they asked (app, web) for the audit log. */
export async function deleteAccount(actor: Actor, customerId: string, o: { profileId?: string | null; source: string }) {
  const preview = await deletionPreview(customerId, o.profileId);
  if (!preview.canDelete) throw new AppError("conflict", preview.blockers[0], { blockers: preview.blockers });
  const now = new Date();
  const ids = [preview.profile.id, ...preview.dependents.map((d) => d.id)];
  await db.transaction(async (tx) => {
    for (const id of ids) await forgetStripeCustomer(id, tx);
    for (const id of ids) await anonymize(tx, id, now);
    await audit(
      actor,
      "customer.deleted_by_client",
      "customer",
      preview.profile.id,
      { source: o.source, dependents: preview.dependents.map((d) => d.id), keptTickets: preview.kept.pastTickets },
      null,
      tx,
    );
  });
  return { deleted: true as const, profiles: ids.length };
}
