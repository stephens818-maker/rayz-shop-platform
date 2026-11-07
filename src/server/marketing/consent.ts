/**
 * Who can get marketing, on which channel. Marketing needs its own consent, separate from the
 * appointment texts and emails clients agree to when booking: sms_marketing_opt_in,
 * email_marketing_opt_in, push_marketing and customer_devices (core_0085), which only the client
 * sets, in the app or account page (PUT /me/consent, recorded in consent_events). Columns are still
 * looked up at runtime so an older database sends nothing. A STOP, an unsubscribe, or a deleted
 * client always wins.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import { contactOptOuts, customers, marketingUnsubscribes, notificationJobs } from "@/db/schema";
import { CONSENT_COLUMN, CONSENT_MARKERS } from "@/domain/consent-texts";
import type { Channel, Reach } from "@/domain/marketing";
import { appSwitches } from "@/server/app-switches";
import { ConsentContext, recordConsent } from "@/server/consent-events";

interface Columns {
  sms: boolean;
  email: boolean;
  push: boolean;
  devices: boolean;
  deleted: boolean;
}

let cache: { at: number; cols: Columns } | null = null;

/** Which consent columns exist. Read once a minute. */
export async function consentColumns(tx: DBorTx = db): Promise<Columns> {
  if (cache && Date.now() - cache.at < 60_000) return cache.cols;
  const rows = (await tx.execute(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = current_schema() and (
      (table_name = 'customers' and column_name in ('sms_marketing_opt_in', 'email_marketing_opt_in', 'push_marketing', 'deleted_at'))
      or (table_name = 'customer_devices' and column_name in ('push_enabled', 'revoked_at')))`)) as unknown as { table_name: string; column_name: string }[];
  const has = (t: string, c: string) => rows.some((r) => r.table_name === t && r.column_name === c);
  const cols = {
    sms: has("customers", "sms_marketing_opt_in"),
    email: has("customers", "email_marketing_opt_in"),
    push: has("customers", "push_marketing") && has("customer_devices", "push_enabled") && has("customer_devices", "revoked_at"),
    devices: has("customer_devices", "push_enabled"),
    deleted: has("customers", "deleted_at"),
  };
  cache = { at: Date.now(), cols };
  return cols;
}

/** Tests add and drop the customer app's columns. */
export const resetConsentCache = () => {
  cache = null;
};

export interface Contact {
  customerId: string;
  firstName: string;
  /** The parent's id for a child (whose phone, email, device and consent these are), else the client's own. */
  householdId: string;
  phone: string | null;
  email: string | null;
  /** The newest device that takes push, by its customer_devices id. */
  deviceId: string | null;
  reach: Reach;
}

/**
 * Each client's marketing reach: agreed on the channel, has the number, address or device, and hasn't
 * opted out. A child's is their parent's: the parent's number, email, app and consent.
 */
export async function contactsFor(customerIds: readonly string[], tx: DBorTx = db): Promise<Map<string, Contact>> {
  const out = new Map<string, Contact>();
  const ids = [...new Set(customerIds)];
  if (!ids.length) return out;
  const cols = await consentColumns(tx);
  const flag = (on: boolean, col: string) => (on ? sql.raw(`case when g.id is null then c.${col} else g.${col} end`) : sql`false`);
  const device = cols.push
    ? sql`(select d.id from customer_devices d where d.customer_id = coalesce(g.id, c.id) and d.push_enabled and d.revoked_at is null order by d.last_seen_at desc nulls last limit 1)`
    : sql`null::uuid`;
  const rows = (await tx.execute(sql`
    select c.id, coalesce(g.id, c.id) household_id, c.first_name, coalesce(g.phone, c.phone) phone, coalesce(g.email, c.email) email,
      ${flag(cols.sms, "sms_marketing_opt_in")} as sms, ${flag(cols.email, "email_marketing_opt_in")} as em,
      ${flag(cols.push, "push_marketing")} as push, ${device} as device_id,
      ${cols.deleted ? sql`(c.deleted_at is not null or g.deleted_at is not null)` : sql`false`} as deleted
    from customers c left join customers g on g.id = c.guardian_id where c.id in ${sql`(${sql.join(
      ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    )})`}`)) as unknown as {
    id: string;
    household_id: string;
    first_name: string;
    phone: string | null;
    email: string | null;
    sms: boolean;
    em: boolean;
    push: boolean;
    device_id: string | null;
    deleted: boolean;
  }[];
  const heads = [...new Set(rows.map((r) => r.household_id))];
  const phones = rows.map((r) => r.phone).filter((p): p is string => !!p);
  const emails = rows.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e);
  const [stops, unsubs] = await Promise.all([
    phones.length ? tx.select({ phone: contactOptOuts.phone }).from(contactOptOuts).where(and(eq(contactOptOuts.channel, "sms"), inArray(contactOptOuts.phone, phones))) : [],
    tx
      .select({ channel: marketingUnsubscribes.channel, customerId: marketingUnsubscribes.customerId, email: marketingUnsubscribes.email, phone: marketingUnsubscribes.phone })
      .from(marketingUnsubscribes)
      .where(
        or(
          inArray(marketingUnsubscribes.customerId, [...new Set([...ids, ...heads])]),
          emails.length ? inArray(sql`lower(${marketingUnsubscribes.email})`, emails) : undefined,
          phones.length ? inArray(marketingUnsubscribes.phone, phones) : undefined,
        ),
      ),
  ]);
  const stopped = new Set(stops.map((s) => s.phone));
  const pushOn = (await appSwitches()).pushMarketing;
  const off = (ch: Channel, r: (typeof rows)[number]) =>
    unsubs.some((u) => u.channel === ch && (u.customerId === r.id || u.customerId === r.household_id || (!!u.email && u.email.toLowerCase() === r.email?.toLowerCase()) || (!!u.phone && u.phone === r.phone)));
  for (const r of rows) {
    const live = !r.deleted;
    out.set(r.id, {
      customerId: r.id,
      householdId: r.household_id,
      firstName: r.first_name,
      phone: r.phone,
      email: r.email,
      deviceId: r.device_id,
      reach: {
        sms: live && !!r.sms && !!r.phone && !stopped.has(r.phone) && !off("sms", r),
        email: live && !!r.em && !!r.email && !off("email", r),
        push: pushOn && live && !!r.push && !!r.device_id && !off("push", r),
      },
    });
  }
  return out;
}

/** Turn a client's marketing off on a channel: an unsubscribe link, STOP, or staff at the client's request. */
export async function unsubscribe(
  o: { channel: Channel; customerId?: string | null; email?: string | null; phone?: string | null; source: "link" | "stop" | "staff"; campaignId?: string | null; sendId?: string | null },
  tx: DBorTx = db,
) {
  if (!o.customerId && !o.email && !o.phone) return false;
  const [dupe] = await tx
    .select({ id: marketingUnsubscribes.id })
    .from(marketingUnsubscribes)
    .where(
      and(
        eq(marketingUnsubscribes.channel, o.channel),
        or(
          o.customerId ? eq(marketingUnsubscribes.customerId, o.customerId) : undefined,
          o.email ? eq(sql`lower(${marketingUnsubscribes.email})`, o.email.toLowerCase()) : undefined,
          o.phone ? eq(marketingUnsubscribes.phone, o.phone) : undefined,
        ),
      ),
    )
    .limit(1);
  // Anything still waiting (quiet hours) doesn't go out.
  await tx
    .update(notificationJobs)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(notificationJobs.kind, "marketing"),
        eq(notificationJobs.status, "pending"),
        eq(notificationJobs.channel, o.channel),
        or(
          o.customerId ? eq(notificationJobs.customerId, o.customerId) : undefined,
          o.email ? eq(sql`lower(${notificationJobs.to})`, o.email.toLowerCase()) : undefined,
          o.phone ? eq(notificationJobs.to, o.phone) : undefined,
        ),
      ),
    );
  if (o.customerId && o.source !== "stop") await revokeMarketing(tx, o.customerId, o.channel, o.source === "staff" ? { source: "pos", textVersion: CONSENT_MARKERS.staff } : { source: o.channel === "email" ? "email" : "web", textVersion: CONSENT_MARKERS.unsubscribe });
  if (dupe) return false;
  await tx.insert(marketingUnsubscribes).values({
    channel: o.channel,
    customerId: o.customerId ?? null,
    email: o.email?.toLowerCase() ?? null,
    phone: o.phone ?? null,
    source: o.source,
    campaignId: o.campaignId ?? null,
    sendId: o.sendId ?? null,
  });
  return true;
}

const MARKETING_CHANNEL = { sms: "sms_marketing", email: "email_marketing", push: "push_marketing" } as const;

/** An unsubscribe link or staff turns the client's own marketing yes off too, so the record and the flag agree. */
async function revokeMarketing(tx: DBorTx, customerId: string, channel: Channel, ctx: ConsentContext) {
  const ch = MARKETING_CHANNEL[channel];
  const col = customers[CONSENT_COLUMN[ch]];
  const [c] = await tx.update(customers).set({ [CONSENT_COLUMN[ch]]: false }).where(and(eq(customers.id, customerId), eq(col, true))).returning({ id: customers.id, phone: customers.phone, email: customers.email });
  if (c) await recordConsent(tx, c, [{ channel: ch, granted: false }], ctx);
}

/** START: the number opted back in to texts, so its STOP no longer blocks marketing texts it agreed to. */
export async function resubscribePhone(phone: string, tx: DBorTx = db) {
  await tx.delete(marketingUnsubscribes).where(and(eq(marketingUnsubscribes.channel, "sms"), eq(marketingUnsubscribes.phone, phone), eq(marketingUnsubscribes.source, "stop")));
}