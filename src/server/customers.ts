import { and, eq, inArray, or, sql, SQL } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  appointments,
  clientRatings,
  customerSquireIds,
  customers,
  giftCards,
  loyaltyAccounts,
  loyaltyLedger,
  loyaltyRewards,
  notificationJobs,
  refreshTokens,
  sales,
  waitlistEntries,
} from "@/db/schema";
import { MatchVia, pickMatch, samePerson } from "@/domain/customers";
import { rewardExpiry } from "@/domain/loyalty";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { Actor, audit } from "./audit";
import { AppError, notFound } from "./errors";
import { getLoyaltyConfig, lockAccount } from "./loyalty";

export type Customer = typeof customers.$inferSelect;

export interface Identity {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  squireIds?: string[];
}

/**
 * Serialize "find or create" per phone and email so two simultaneous bookings for one new client
 * can't both insert. Transaction-scoped; a no-op outside a transaction.
 */
export async function lockIdentity(tx: DBorTx, keys: (string | null | undefined)[]) {
  for (const k of [...new Set(keys.filter(Boolean) as string[])].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer:${k}`}, 0))`);
  }
}

export async function customerBySquireId(tx: DBorTx, squireId: string): Promise<Customer | null> {
  const [hit] = await tx
    .select({ c: customers })
    .from(customerSquireIds)
    .innerJoin(customers, eq(customers.id, customerSquireIds.customerId))
    .where(eq(customerSquireIds.squireId, squireId));
  return hit?.c ?? null;
}

/** The one match order used everywhere: Squire ID, then email + compatible name, then phone + compatible name. */
export async function matchCustomer(tx: DBorTx, input: Identity): Promise<{ customer: Customer; via: MatchVia } | null> {
  for (const id of input.squireIds ?? []) {
    const hit = await customerBySquireId(tx, id);
    if (hit) return { customer: hit, via: "squire_id" };
  }
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (!phone && !email) return null;
  const conds: SQL[] = [];
  if (phone) conds.push(eq(customers.phone, phone));
  if (email) conds.push(eq(customers.email, email));
  const candidates = await tx
    .select()
    .from(customers)
    .where(or(...conds))
    .limit(50);
  const m = pickMatch({ firstName: input.firstName, lastName: input.lastName, phone, email }, candidates);
  if (!m) return null;
  return { customer: candidates.find((c) => c.id === m.id)!, via: m.via };
}

export interface CustomerInput {
  firstName: string;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  /** undefined = no answer given (keeps what's on file); an explicit false always wins. */
  smsOptIn?: boolean;
  emailOptIn?: boolean;
}

/**
 * Match with the shared rules or create. Walk-ins may have no phone or email; they always get a
 * client record (no dedupe is possible), which the duplicates page can merge later.
 */
export async function findOrCreateCustomer(
  input: CustomerInput,
  homeShopId: string | null,
  tx: DBorTx = db,
  opts: { allowNoContact?: boolean; /** Consent for a brand-new record only (a walk-in who gave a number to be texted). */ smsOptInIfNew?: boolean } = {},
): Promise<Customer> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  const firstName = input.firstName.trim();
  const lastName = input.lastName?.trim() || null;
  if (!firstName) throw new AppError("bad_request", "First name is required");
  if (!phone && !email && !opts.allowNoContact) throw new AppError("bad_request", "A phone number or email is required");
  await lockIdentity(tx, [phone, email]);
  const m = phone || email ? await matchCustomer(tx, { firstName, lastName, phone, email }) : null;
  if (m) {
    const existing = m.customer;
    const patch: Partial<typeof customers.$inferInsert> = {};
    if (!existing.email && email) patch.email = email;
    if (!existing.phone && phone) patch.phone = phone;
    if (!existing.lastName && lastName) patch.lastName = lastName;
    if (input.smsOptIn !== undefined && input.smsOptIn !== existing.smsOptIn) patch.smsOptIn = input.smsOptIn;
    if (input.emailOptIn !== undefined && input.emailOptIn !== existing.emailOptIn) patch.emailOptIn = input.emailOptIn;
    if (!existing.homeShopId && homeShopId) patch.homeShopId = homeShopId;
    if (Object.keys(patch).length) await tx.update(customers).set(patch).where(eq(customers.id, existing.id));
    return { ...existing, ...patch };
  }
  const [row] = await tx
    .insert(customers)
    .values({ firstName, lastName, phone, email, homeShopId, smsOptIn: input.smsOptIn ?? (!!phone && !!opts.smsOptInIfNew), emailOptIn: input.emailOptIn ?? false })
    .returning();
  return row;
}

export function mergeNotes(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = a?.trim() || "";
  const y = b?.trim() || "";
  if (!y || x.includes(y)) return x || null;
  if (!x || y.includes(x)) return y;
  return `${x}\n${y}`;
}

/**
 * Fold `dropId` into `keepId`: history, tickets, gift cards, loyalty, sessions, and Squire IDs
 * move over; blank contact fields are filled from the dropped record; consent is kept only if
 * both records had it. The dropped record is deleted, with a full snapshot in the audit log.
 */
export async function mergeCustomers(keepId: string, dropId: string, actor: Actor, now = new Date()) {
  if (keepId === dropId) throw new AppError("bad_request", "Pick two different clients");
  return db.transaction(async (tx) => {
    const both = await tx
      .select()
      .from(customers)
      .where(inArray(customers.id, [keepId, dropId]))
      .orderBy(customers.id)
      .for("update");
    const keep = both.find((c) => c.id === keepId);
    const drop = both.find((c) => c.id === dropId);
    if (!keep || !drop) throw notFound("Client");

    const moved: Record<string, number> = {};
    const repoint = async (name: string, q: Promise<unknown[]>) => {
      moved[name] = (await q).length;
    };
    await repoint("appointments", tx.update(appointments).set({ customerId: keepId }).where(eq(appointments.customerId, dropId)).returning({ id: appointments.id }));
    await repoint("sales", tx.update(sales).set({ customerId: keepId }).where(eq(sales.customerId, dropId)).returning({ id: sales.id }));
    await repoint("giftCards", tx.update(giftCards).set({ customerId: keepId }).where(eq(giftCards.customerId, dropId)).returning({ id: giftCards.id }));
    await repoint("waitlist", tx.update(waitlistEntries).set({ customerId: keepId }).where(eq(waitlistEntries.customerId, dropId)).returning({ id: waitlistEntries.id }));
    await repoint("notifications", tx.update(notificationJobs).set({ customerId: keepId }).where(eq(notificationJobs.customerId, dropId)).returning({ id: notificationJobs.id }));
    await repoint("rewards", tx.update(loyaltyRewards).set({ customerId: keepId }).where(eq(loyaltyRewards.customerId, dropId)).returning({ id: loyaltyRewards.id }));
    await repoint("ledger", tx.update(loyaltyLedger).set({ customerId: keepId }).where(eq(loyaltyLedger.customerId, dropId)).returning({ id: loyaltyLedger.id }));
    await repoint("sessions", tx.update(refreshTokens).set({ customerId: keepId }).where(eq(refreshTokens.customerId, dropId)).returning({ id: refreshTokens.id }));
    await repoint("squireIds", tx.update(customerSquireIds).set({ customerId: keepId }).where(eq(customerSquireIds.customerId, dropId)).returning({ squireId: customerSquireIds.squireId }));
    await repoint("ratings", tx.update(clientRatings).set({ customerId: keepId }).where(eq(clientRatings.customerId, dropId)).returning({ id: clientRatings.id }));

    const [dropAcct] = await tx.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, dropId)).for("update");
    let rewardsIssued = 0;
    if (dropAcct) {
      const cfg = await getLoyaltyConfig(tx);
      const acct = await lockAccount(tx, keepId);
      const combined = acct.progressCents + dropAcct.progressCents;
      rewardsIssued = cfg.thresholdCents > 0 ? Math.floor(combined / cfg.thresholdCents) : 0;
      const progress = combined - rewardsIssued * cfg.thresholdCents;
      const lastEarnAt = [acct.lastEarnAt, dropAcct.lastEarnAt].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
      await tx
        .update(loyaltyAccounts)
        .set({ progressCents: progress, lifetimeEarnedCents: acct.lifetimeEarnedCents + dropAcct.lifetimeEarnedCents, lastEarnAt, updatedAt: now })
        .where(eq(loyaltyAccounts.customerId, keepId));
      await tx.delete(loyaltyAccounts).where(eq(loyaltyAccounts.customerId, dropId));
      await tx.insert(loyaltyLedger).values({ customerId: keepId, kind: "merge", progressDeltaCents: progress - acct.progressCents });
      for (let i = 0; i < rewardsIssued; i++) {
        await tx.insert(loyaltyRewards).values({ customerId: keepId, amountCents: cfg.rewardCents, issuedAt: now, expiresAt: rewardExpiry(now, cfg), source: "merge" });
        await tx.insert(loyaltyLedger).values({ customerId: keepId, kind: "reward_issued", rewardCents: cfg.rewardCents });
      }
    }

    const patch = {
      lastName: keep.lastName ?? drop.lastName,
      phone: keep.phone ?? drop.phone,
      email: keep.email ?? drop.email,
      notes: mergeNotes(keep.notes, drop.notes),
      smsOptIn: keep.smsOptIn && drop.smsOptIn,
      emailOptIn: keep.emailOptIn && drop.emailOptIn,
      homeShopId: keep.homeShopId ?? drop.homeShopId,
      preferredStaffId: keep.preferredStaffId ?? drop.preferredStaffId,
      createdAt: keep.createdAt < drop.createdAt ? keep.createdAt : drop.createdAt,
    };
    await tx.delete(customers).where(eq(customers.id, dropId));
    await tx.update(customers).set(patch).where(eq(customers.id, keepId));
    await audit(actor, "customer.merge", "customer", keepId, { merged: drop, moved, rewardsIssued }, null, tx);
    return { keepId, moved, rewardsIssued };
  });
}

// ───────────────────────────── Profile numbers ─────────────────────────────

export interface CustomerStats {
  visits: number;
  noShows: number;
  cancellations: number;
  upcoming: number;
  firstVisit: Date | null;
  lastVisit: Date | null;
  /** Net service + product spend on tickets, after refunds. */
  ticketSpendCents: number;
  tipsCents: number;
  tickets: number;
  /** Prices of imported Squire visits that have no ticket on file (no transactions export for that day). */
  squireVisitSpendCents: number;
  lifetimeSpendCents: number;
  usualBarberId: string | null;
}

const toDate = (v: unknown) => (v ? new Date(v as string) : null);

export async function customerStats(customerId: string, tx: DBorTx = db, now = new Date()): Promise<CustomerStats> {
  const nowIso = now.toISOString();
  const [row] = (await tx.execute(sql`
    select
      (select count(*) from appointments where customer_id = ${customerId} and status = 'completed')::int as visits,
      (select count(*) from appointments where customer_id = ${customerId} and status = 'no_show')::int as "noShows",
      (select count(*) from appointments where customer_id = ${customerId} and status = 'cancelled')::int as cancellations,
      (select count(*) from appointments where customer_id = ${customerId} and status in ('booked','confirmed','checked_in','in_service') and starts_at >= ${nowIso})::int as upcoming,
      (select min(starts_at) from appointments where customer_id = ${customerId} and status = 'completed') as "firstVisit",
      (select max(starts_at) from appointments where customer_id = ${customerId} and status = 'completed') as "lastVisit",
      (select coalesce(sum(service_net_cents + product_net_cents), 0) from sales
        where customer_id = ${customerId} and status in ('paid','partially_refunded','refunded'))::int as gross,
      (select coalesce(sum(tip_cents), 0) from sales
        where customer_id = ${customerId} and status in ('paid','partially_refunded','refunded'))::int as tips,
      (select count(*) from sales where customer_id = ${customerId} and status in ('paid','partially_refunded','refunded'))::int as tickets,
      (select coalesce(sum(r.service_net_cents + r.product_net_cents), 0) from refunds r join sales s on s.id = r.sale_id
        where s.customer_id = ${customerId} and r.kind = 'refund' and s.status <> 'voided')::int as refunded,
      (select coalesce(sum(r.tip_cents), 0) from refunds r join sales s on s.id = r.sale_id
        where s.customer_id = ${customerId} and r.kind = 'refund' and s.status <> 'voided')::int as "tipRefunds",
      (select coalesce(sum(a.estimate_cents), 0) from appointments a
        where a.customer_id = ${customerId} and a.status = 'completed' and a.source = 'import'
          and not exists (select 1 from sales s where s.appointment_id = a.id
            or (s.customer_id = a.customer_id and s.business_date = (a.starts_at at time zone 'America/Chicago')::date)))::int as "squireVisitSpend",
      (select staff_id from appointments where customer_id = ${customerId} and status = 'completed'
        group by staff_id order by count(*) desc, max(starts_at) desc limit 1) as "usualBarberId"
  `)) as unknown as Record<string, number | string | null>[];
  const ticketSpendCents = Number(row.gross) - Number(row.refunded);
  const squireVisitSpendCents = Number(row.squireVisitSpend);
  return {
    visits: Number(row.visits),
    noShows: Number(row.noShows),
    cancellations: Number(row.cancellations),
    upcoming: Number(row.upcoming),
    firstVisit: toDate(row.firstVisit),
    lastVisit: toDate(row.lastVisit),
    ticketSpendCents,
    tipsCents: Number(row.tips) - Number(row.tipRefunds),
    tickets: Number(row.tickets),
    squireVisitSpendCents,
    lifetimeSpendCents: ticketSpendCents + squireVisitSpendCents,
    usualBarberId: (row.usualBarberId as string | null) ?? null,
  };
}

// ───────────────────────────── Search & access ─────────────────────────────

const fullNameExpr = sql`lower(${customers.firstName} || ' ' || coalesce(${customers.lastName}, ''))`;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Name, phone (any 4+ digits), or email. Backed by the trigram indexes in 0006_client_search.sql. */
export function customerSearchWhere(term: string): SQL | undefined {
  const t = term.trim();
  if (!t) return undefined;
  const phone = normalizePhone(t);
  if (phone) return eq(customers.phone, phone);
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 4 && /^[\d\s().+-]+$/.test(t)) return sql`${customers.phone} like ${`%${digits}%`}`;
  const lower = likeEscape(t.toLowerCase().replace(/\s+/g, " "));
  if (t.includes("@")) return sql`lower(${customers.email}) like ${`%${lower}%`}`;
  return or(sql`${fullNameExpr} like ${`%${lower}%`}`, sql`lower(${customers.email}) like ${`${lower}%`}`);
}

/** Clients with any appointment at these shops (or with this barber). */
export function visitedScope(opts: { shopIds?: string[]; staffId?: string }): SQL {
  const conds: SQL[] = [sql`v.customer_id = ${customers.id}`];
  if (opts.shopIds) conds.push(opts.shopIds.length ? sql`v.shop_id in (${sql.join(opts.shopIds.map((s) => sql`${s}::uuid`), sql`, `)})` : sql`false`);
  if (opts.staffId) conds.push(sql`v.staff_id = ${opts.staffId}::uuid`);
  return sql`exists (select 1 from appointments v where ${sql.join(conds, sql` and `)})`;
}

export interface SearchScope {
  /** Barbers only see clients who have visited their shops; managers and admins see the shared book. */
  restrictToShops?: string[];
}

export async function searchCustomers(term: string, scope: SearchScope = {}, limit = 8) {
  const where = customerSearchWhere(term);
  if (!where) return [];
  const t = likeEscape(term.trim().toLowerCase());
  return db
    .select({
      id: customers.id,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      email: customers.email,
      notes: customers.notes,
      smsOptIn: customers.smsOptIn,
    })
    .from(customers)
    .where(and(where, scope.restrictToShops ? visitedScope({ shopIds: scope.restrictToShops }) : undefined))
    .orderBy(sql`(${fullNameExpr} like ${`${t}%`}) desc`, sql`${customers.createdAt} desc`)
    .limit(limit);
}

export type CustomerAccess = "full" | "barber" | null;

/** Managers and admins: full record. Barbers: name, notes, loyalty, and visits for clients they've served. */
export async function customerAccess(viewer: { staffId: string; canManage: boolean }, customerId: string): Promise<CustomerAccess> {
  if (viewer.canManage) return "full";
  const [hit] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.customerId, customerId), eq(appointments.staffId, viewer.staffId)))
    .limit(1);
  return hit ? "barber" : null;
}

/** The entry's client, or anyone on file with that phone when there is no client, said no to texts. */
export async function textingDeclined(customerId: string | null, phone: string) {
  const [hit] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(customerId ? eq(customers.id, customerId) : eq(customers.phone, phone), eq(customers.smsOptIn, false)))
    .limit(1);
  return !!hit;
}

export const maskPhone = (e164: string | null) => (e164 ? `•••-${e164.slice(-4)}` : null);

// ───────────────────────────── Duplicates ─────────────────────────────

export type DuplicateKind = "likely" | "shared_contact" | "same_name";

export interface DuplicatePair {
  a: Customer;
  b: Customer;
  kind: DuplicateKind;
  samePhone: boolean;
  sameEmail: boolean;
}

/**
 * Candidate pairs: same phone or email (labelled "likely" when the names are compatible, otherwise
 * "shared contact", e.g. a family), plus same full name where one side has no contact at all
 * (walk-ins). Nothing here merges automatically.
 */
export async function duplicatePairs(opts: { forId?: string; limit?: number } = {}): Promise<DuplicatePair[]> {
  const limit = opts.limit ?? 150;
  const only = opts.forId ? sql`and ${opts.forId}::uuid in (a.id, b.id)` : sql``;
  const pairs = (await db.execute(sql`
    select a_id, b_id from (
      select a.id a_id, b.id b_id from customers a join customers b on a.id < b.id and a.phone = b.phone where a.phone is not null ${only}
      union
      select a.id, b.id from customers a join customers b on a.id < b.id and a.email = b.email where a.email is not null ${only}
      union
      select a.id, b.id from customers a join customers b on a.id < b.id
        and lower(a.first_name) = lower(b.first_name) and lower(coalesce(a.last_name, '')) = lower(coalesce(b.last_name, ''))
        where coalesce(a.last_name, '') <> '' and ((a.phone is null and a.email is null) or (b.phone is null and b.email is null)) ${only}
    ) p limit ${limit * 3}
  `)) as unknown as { a_id: string; b_id: string }[];
  if (!pairs.length) return [];
  const ids = [...new Set(pairs.flatMap((p) => [p.a_id, p.b_id]))];
  const rows = await db.select().from(customers).where(inArray(customers.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: DuplicatePair[] = [];
  for (const p of pairs) {
    const a = byId.get(p.a_id);
    const b = byId.get(p.b_id);
    if (!a || !b) continue;
    const samePhone = !!a.phone && a.phone === b.phone;
    const sameEmail = !!a.email && a.email === b.email;
    const kind: DuplicateKind = samePhone || sameEmail ? (samePerson(a, b) ? "likely" : "shared_contact") : "same_name";
    out.push({ a, b, kind, samePhone, sameEmail });
  }
  const order: Record<DuplicateKind, number> = { likely: 0, same_name: 1, shared_contact: 2 };
  return out.sort((x, y) => order[x.kind] - order[y.kind]).slice(0, limit);
}
