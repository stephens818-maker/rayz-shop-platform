import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { ConsentChannel, ConsentSource, consentEvents, contactOptOuts, customers, marketingUnsubscribes, notificationJobs } from "@/db/schema";
import { CONSENT_CHANNELS, CONSENT_COLUMN, CONSENT_MARKERS, CONSENT_TEXTS, ConsentFlags, consentDiff, consentSource } from "@/domain/consent-texts";
import { clientIp } from "@/lib/client-ip";
import { AppError, notFound } from "./errors";

/**
 * The consent record (C20): every grant and revoke of appointment texts, emails and app push and of each
 * marketing channel, with the wording's version, where it happened and the app version. Writers call
 * these next to the flag they change; nothing here decides who gets a message (marketing/consent.ts does).
 */

export interface ConsentContext {
  source: ConsentSource;
  appVersion?: string | null;
  ip?: string | null;
  staffId?: string | null;
  /** A marker (STOP, an import) for every channel; unset uses each channel's current wording. */
  textVersion?: string;
}

/** The app or website a request came from, for the record. */
export const requestConsentContext = (req: Request): ConsentContext => ({
  source: consentSource(req.headers.get("x-client")),
  appVersion: req.headers.get("x-app-version")?.slice(0, 40) || null,
  ip: clientIp(req.headers),
});

export const staffConsentContext = (staffId: string | null | undefined): ConsentContext => ({ source: "pos", staffId: staffId ?? null, textVersion: CONSENT_MARKERS.staff });

type Who = { id: string; phone: string | null; email: string | null };

export async function recordConsent(tx: DBorTx, who: Who, changes: readonly { channel: ConsentChannel; granted: boolean; textVersion?: string }[], ctx: ConsentContext) {
  if (!changes.length) return;
  await tx.insert(consentEvents).values(
    changes.map((c) => ({
      customerId: who.id,
      phone: c.channel.startsWith("sms") ? who.phone : null,
      email: c.channel.startsWith("email") ? who.email : null,
      channel: c.channel,
      action: c.granted ? ("granted" as const) : ("revoked" as const),
      textVersion: c.textVersion ?? ctx.textVersion ?? CONSENT_TEXTS[c.channel].version,
      source: ctx.source,
      appVersion: ctx.appVersion ?? null,
      ip: ctx.ip ?? null,
      staffId: ctx.staffId ?? null,
    })),
  );
}

/** Record whatever changed between a client's flags before and the values just written. */
export async function recordConsentChange(tx: DBorTx, who: Who, before: Partial<ConsentFlags>, after: Partial<ConsentFlags>, ctx: ConsentContext) {
  await recordConsent(tx, who, consentDiff(before, after), ctx);
}

const MARKETING_KIND_BY_CHANNEL: Record<"sms" | "email" | "push", string[]> = { sms: ["marketing", "fill_offer", "rebook_nudge"], email: ["marketing"], push: ["marketing"] };
const queueChannel = (c: ConsentChannel) => (c.startsWith("sms") ? "sms" : c.startsWith("email") ? "email" : "push") as "sms" | "email" | "push";

export interface ConsentState {
  channels: {
    channel: ConsentChannel;
    label: string;
    marketing: boolean;
    granted: boolean;
    /** The wording to show beside the box, and the version to send back with a yes. */
    text: string;
    textVersion: string;
    /** When and where it last changed, from the record. */
    changedAt: string | null;
    changedVia: ConsentSource | null;
    /** Why a yes can't take effect yet: the number replied STOP, or no phone or verified email on the account. */
    blockedBy: "stop" | "no_phone" | "no_verified_email" | null;
  }[];
}

export async function consentState(customerId: string, tx: DBorTx = db): Promise<ConsentState> {
  const c = await tx.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!c || c.deletedAt) throw notFound("Account");
  const [events, stop] = await Promise.all([
    tx
      .selectDistinctOn([consentEvents.channel], { channel: consentEvents.channel, at: consentEvents.createdAt, source: consentEvents.source })
      .from(consentEvents)
      .where(eq(consentEvents.customerId, customerId))
      .orderBy(consentEvents.channel, desc(consentEvents.createdAt)),
    c.phone ? tx.query.contactOptOuts.findFirst({ where: and(eq(contactOptOuts.phone, c.phone), eq(contactOptOuts.channel, "sms")) }) : null,
  ]);
  return {
    channels: CONSENT_CHANNELS.map((channel) => {
      const t = CONSENT_TEXTS[channel];
      const last = events.find((e) => e.channel === channel);
      const ch = queueChannel(channel);
      const blockedBy = ch === "sms" ? (!c.phone ? "no_phone" : stop ? "stop" : null) : channel === "email_marketing" && !c.emailVerifiedAt ? "no_verified_email" : null;
      return {
        channel,
        label: t.label,
        marketing: t.marketing,
        granted: c[CONSENT_COLUMN[channel]],
        text: t.text,
        textVersion: t.version,
        changedAt: last?.at.toISOString() ?? null,
        changedVia: last?.source ?? null,
        blockedBy,
      };
    }),
  };
}

/**
 * The client turns channels on or off in the app or account page. A yes must carry the version of the
 * wording they were shown, and it must be the current one; a no never needs it. A yes to marketing also
 * lifts an earlier unsubscribe on that channel (it's a newer, explicit choice), but never a STOP: only
 * START does that.
 */
export async function setConsent(customerId: string, changes: readonly { channel: ConsentChannel; granted: boolean; textVersion?: string | null }[], ctx: ConsentContext) {
  await db.transaction(async (tx) => {
    const c = await tx.query.customers.findFirst({ where: eq(customers.id, customerId) });
    if (!c || c.deletedAt) throw notFound("Account");
    if (c.guardianId) throw new AppError("forbidden", "A child's messages go to their parent, under the parent's choices");
    const patch: Partial<ConsentFlags> = {};
    const versions = new Map<ConsentChannel, string>();
    for (const ch of changes) {
      if (ch.granted) {
        const current = CONSENT_TEXTS[ch.channel].version;
        if (ch.textVersion !== current) throw new AppError("bad_request", "The wording for this choice has changed. Show the current text and ask again.", { field: ch.channel, textVersion: current });
        if (ch.channel === "email_marketing" && !c.emailVerifiedAt) throw new AppError("bad_request", "Confirm your email first", { field: ch.channel });
        if (ch.channel.startsWith("sms") && !c.phone) throw new AppError("bad_request", "Add a phone number first", { field: ch.channel });
        versions.set(ch.channel, current);
      }
      patch[CONSENT_COLUMN[ch.channel]] = ch.granted;
    }
    const diff = consentDiff(c, patch);
    if (!diff.length) return;
    await tx.update(customers).set(patch).where(eq(customers.id, customerId));
    await recordConsent(
      tx,
      c,
      diff.map((d) => ({ ...d, textVersion: versions.get(d.channel) })),
      ctx,
    );
    for (const d of diff) {
      if (!CONSENT_TEXTS[d.channel].marketing) continue;
      const ch = queueChannel(d.channel);
      if (d.granted) {
        await tx
          .delete(marketingUnsubscribes)
          .where(
            and(
              eq(marketingUnsubscribes.channel, ch),
              sql`${marketingUnsubscribes.source} <> 'stop'`,
              or(eq(marketingUnsubscribes.customerId, c.id), ch === "email" && c.email ? eq(sql`lower(${marketingUnsubscribes.email})`, c.email.toLowerCase()) : undefined),
            ),
          );
      } else {
        await tx
          .update(notificationJobs)
          .set({ status: "cancelled" })
          .where(
            and(
              eq(notificationJobs.customerId, c.id),
              eq(notificationJobs.status, "pending"),
              eq(notificationJobs.channel, ch),
              inArray(notificationJobs.kind, MARKETING_KIND_BY_CHANNEL[ch] as never[]),
            ),
          );
      }
    }
  });
  return consentState(customerId);
}

/** The record for one client, newest first (staff see it on the client page). */
export async function consentHistory(customerId: string, limit = 50) {
  return db
    .select({
      channel: consentEvents.channel,
      action: consentEvents.action,
      textVersion: consentEvents.textVersion,
      source: consentEvents.source,
      appVersion: consentEvents.appVersion,
      createdAt: consentEvents.createdAt,
    })
    .from(consentEvents)
    .where(eq(consentEvents.customerId, customerId))
    .orderBy(desc(consentEvents.createdAt))
    .limit(limit);
}

/** STOP or START from a number: the record for every client on file with it whose consent it changed. */
export async function recordKeyword(tx: DBorTx, phone: string, keyword: "stop" | "start", transactionalIds: readonly string[]) {
  const onNumber = await tx.select({ id: customers.id, phone: customers.phone, email: customers.email, sms: customers.smsMarketingOptIn }).from(customers).where(eq(customers.phone, phone));
  const ctx: ConsentContext = { source: "sms", textVersion: keyword === "stop" ? CONSENT_MARKERS.stop : CONSENT_MARKERS.start };
  for (const c of onNumber) {
    const changes: { channel: ConsentChannel; granted: boolean }[] = [];
    if (transactionalIds.includes(c.id)) changes.push({ channel: "sms_transactional", granted: keyword === "start" });
    if (c.sms) changes.push({ channel: "sms_marketing", granted: keyword === "start" });
    await recordConsent(tx, c, changes, ctx);
  }
}
