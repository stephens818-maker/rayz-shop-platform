import { and, desc, eq, isNull } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { consentEvents, customers } from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { audit, SYSTEM } from "@/server/audit";
import { CONSENT_TEXT_VERSION, ConsentChannel, importedConsentChannel } from "./rules";

export interface ConsentInput {
  customerId?: string | null;
  phone?: string | null;
  email?: string | null;
  channel: ConsentChannel;
  action: "granted" | "revoked";
  source: "ios" | "android" | "web" | "pos" | "import" | "sms";
  appVersion?: string | null;
  textVersion?: string;
}

/**
 * An opt-out sticks. A later booking or import that says "yes" does not turn the channel back on.
 * Turning it on again goes through `recordConsent`, which stores the consent event.
 * `incoming` undefined means the caller didn't answer, so the stored choice stays.
 */
export function retainOptOut(current: boolean, incoming: boolean | undefined): boolean {
  if (incoming === false) return false;
  return current;
}

export async function recordConsent(input: ConsentInput, tx: DBorTx = db) {
  await tx.insert(consentEvents).values({
    customerId: input.customerId ?? null,
    phone: normalizePhone(input.phone),
    email: normalizeEmail(input.email),
    channel: input.channel,
    action: input.action,
    textVersion: input.textVersion ?? (input.source === "import" ? "squire-import" : CONSENT_TEXT_VERSION),
    source: input.source,
    appVersion: input.appVersion ?? null,
  });
  if (!input.customerId) return;
  const on = input.action === "granted";
  const patch: Partial<typeof customers.$inferInsert> = {};
  if (input.channel === "sms_transactional") patch.smsOptIn = on;
  if (input.channel === "sms_marketing") patch.smsMarketingOptIn = on;
  if (input.channel === "email") patch.emailOptIn = on;
  if (input.channel === "email_marketing") patch.emailMarketingOptIn = on;
  if (input.channel === "push_transactional") patch.pushTransactional = on;
  if (input.channel === "push_marketing") patch.pushMarketing = on;
  if (Object.keys(patch).length) await tx.update(customers).set(patch).where(eq(customers.id, input.customerId));
}

/** Squire's exported opt-in is transactional only. Marketing flags are left off. */
export async function recordImportedConsent(tx: DBorTx, customerId: string, phone: string | null, email: string | null, kind: "sms" | "email") {
  await recordConsent(
    {
      customerId,
      phone,
      email,
      channel: importedConsentChannel(kind),
      action: "granted",
      source: "import",
      textVersion: "squire-import",
    },
    tx,
  );
}

const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START = new Set(["START", "UNSTOP", "YES"]);
const HELP = new Set(["HELP", "INFO"]);

export type KeywordResult = { keyword: "stop" | "start" | "help" | "other"; reply: string };

/**
 * Carrier STOP/START/HELP. STOP revokes transactional and marketing SMS.
 * START restores transactional only; marketing stays off until an in-app opt-in.
 */
export async function applySmsKeyword(from: string, body: string): Promise<KeywordResult> {
  const phone = normalizePhone(from);
  const word = body.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (!phone) return { keyword: "other", reply: "Ray'z Barber Shop: call your shop for help." };
  if (HELP.has(word)) {
    return { keyword: "help", reply: "Ray'z appointment texts. Msg & data rates may apply. Reply STOP to opt out. For help, ask in the shop." };
  }
  const rows = await db.select().from(customers).where(and(eq(customers.phone, phone), isNull(customers.deletedAt)));
  if (STOP.has(word)) {
    for (const c of rows) {
      await recordConsent({ customerId: c.id, phone, channel: "sms_transactional", action: "revoked", source: "sms", textVersion: "stop" });
      await recordConsent({ customerId: c.id, phone, channel: "sms_marketing", action: "revoked", source: "sms", textVersion: "stop" });
    }
    if (!rows.length) await recordConsent({ phone, channel: "sms_transactional", action: "revoked", source: "sms", textVersion: "stop" });
    await audit(SYSTEM, "sms.stop", "customer", rows[0]?.id ?? null, { phone, profiles: rows.length }, null);
    return { keyword: "stop", reply: "Ray'z: you are unsubscribed from texts. Reply START to get appointment messages again. No promotions will be sent." };
  }
  if (START.has(word)) {
    for (const c of rows) {
      await recordConsent({ customerId: c.id, phone, channel: "sms_transactional", action: "granted", source: "sms", textVersion: "start" });
    }
    await audit(SYSTEM, "sms.start", "customer", rows[0]?.id ?? null, { phone, profiles: rows.length }, null);
    return { keyword: "start", reply: "Ray'z: appointment texts are on again. Promotions stay off until you opt in in the app. Reply STOP to opt out." };
  }
  return { keyword: "other", reply: "Ray'z Barber Shop: reply HELP for help or STOP to opt out." };
}

export async function latestConsent(customerId: string, channel: ConsentChannel) {
  const [row] = await db
    .select()
    .from(consentEvents)
    .where(and(eq(consentEvents.customerId, customerId), eq(consentEvents.channel, channel)))
    .orderBy(desc(consentEvents.createdAt))
    .limit(1);
  return row ?? null;
}
