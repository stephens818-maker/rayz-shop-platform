import { and, eq, inArray, or, sql, SQL } from "drizzle-orm";
import { db, DBorTx } from "@/db";
import {
  appointments,
  clientAccessLog,
  clientRatings,
  customerDuplicateDismissals,
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
import { MatchVia, pickMatch } from "@/domain/customers";
import { DuplicateKind, DuplicateScore, planMerges, scoreDuplicate } from "@/domain/duplicates";
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
    if (keep.guardianId === dropId || drop.guardianId === keepId) {
      throw new AppError("bad_request", "That's a parent and their own child. Take the child off the family account first if they're really one person.");
    }
    if (keep.guardianId) {
      const [kid] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.guardianId, dropId)).limit(1);
      if (kid) throw new AppError("bad_request", "Keep the parent's record: a child profile can't have children of its own");
    }

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

    await repoint("accessLog", tx.update(clientAccessLog).set({ customerId: keepId }).where(eq(clientAccessLog.customerId, dropId)).returning({ id: clientAccessLog.id }));

    // Tags both had stay once; a photo moves only when the kept record has none.
    await tx.execute(sql`delete from customer_tags d where d.customer_id = ${dropId} and exists (select 1 from customer_tags k where k.customer_id = ${keepId} and k.tag = d.tag)`);
    await tx.execute(sql`delete from client_photos where customer_id = ${dropId} and exists (select 1 from client_photos where customer_id = ${keepId})`);
    await tx.execute(sql`update customers set referred_by_id = ${keepId} where referred_by_id = ${dropId} and id <> ${keepId}`);
    // Its notes field is folded into the kept record's below, which brings the kept record note along; its other notes move.
    await tx.execute(sql`delete from client_notes where customer_id = ${dropId} and source = 'record'`);
    // Badges are a cache of one row per client: keep one, and mark it stale so the next read recomputes
    // it from the combined history. Badge news both records already had on the same day stays once.
    await tx.execute(sql`delete from client_badges where customer_id = ${dropId} and exists (select 1 from client_badges where customer_id = ${keepId})`);
    await tx.execute(sql`update client_badges set customer_id = ${keepId} where customer_id = ${dropId}`);
    await tx.execute(sql`update client_badges set computed_on = computed_on - 1 where customer_id = ${keepId}`);
    await tx.execute(sql`delete from client_badge_notices d where d.customer_id = ${dropId} and exists (select 1 from client_badge_notices k
      where k.customer_id = ${keepId} and k.badge_key = d.badge_key and k.change = d.change and k.occurred_on = d.occurred_on)`);
    // Everything else that points at a client, found in the catalog so a table added later (the
    // customer app's too) moves with the merge instead of being deleted with the dropped record.
    // A new table with a unique key on the client fails the merge rather than losing rows.
    const fks = (await tx.execute(sql`
      select c.conrelid::regclass::text tbl, a.attname col from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'customers'::regclass`)) as unknown as { tbl: string; col: string }[];
    const done = new Set([
      "appointments.customer_id",
      "sales.customer_id",
      "gift_cards.customer_id",
      "waitlist_entries.customer_id",
      "notification_jobs.customer_id",
      "loyalty_rewards.customer_id",
      "loyalty_ledger.customer_id",
      "refresh_tokens.customer_id",
      "customer_squire_ids.customer_id",
      "client_ratings.customer_id",
      "loyalty_accounts.customer_id",
      "client_badges.customer_id",
      "customers.referred_by_id",
      "customer_duplicate_dismissals.a_id",
      "customer_duplicate_dismissals.b_id",
    ]);
    for (const { tbl, col } of fks) {
      if (done.has(`${tbl}.${col}`) || !/^[a-z_][a-z0-9_]*$/.test(tbl)) continue;
      const rows = (await tx.execute(sql`update ${sql.identifier(tbl)} set ${sql.identifier(col)} = ${keepId} where ${sql.identifier(col)} = ${dropId} returning 1`)) as unknown as unknown[];
      if (rows.length) moved[tbl.replace(/_(\w)/g, (_, ch: string) => ch.toUpperCase())] = rows.length;
    }
    const patch = {
      lastName: keep.lastName ?? drop.lastName,
      phone: keep.phone ?? drop.phone,
      email: keep.email ?? drop.email,
      address: keep.address ?? drop.address,
      birthday: keep.birthday ?? drop.birthday,
      customFields: { ...drop.customFields, ...keep.customFields },
      notes: mergeNotes(keep.notes, drop.notes),
      smsOptIn: keep.smsOptIn && drop.smsOptIn,
      emailOptIn: keep.emailOptIn && drop.emailOptIn,
      homeShopId: keep.homeShopId ?? drop.homeShopId,
      preferredStaffId: keep.preferredStaffId ?? drop.preferredStaffId,
      nickname: keep.nickname ?? drop.nickname,
      source: keep.source ?? drop.source,
      referredById: [keep.referredById, drop.referredById].find((r) => r && r !== keepId && r !== dropId) ?? null,
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

/** Brand-wide, or only what happened at `shopIds` for a shop workspace. */
export async function customerStats(customerId: string, tx: DBorTx = db, now = new Date(), shopIds?: readonly string[]): Promise<CustomerStats> {
  const nowIso = now.toISOString();
  const at = (alias: string) => (shopIds ? sql`and ${sql.raw(alias)}shop_id in (${shopIds.length ? sql.join(shopIds.map((x) => sql`${x}::uuid`), sql`, `) : sql`null::uuid`})` : sql``);
  const [row] = (await tx.execute(sql`
    select
      (select count(*) from appointments where customer_id = ${customerId} ${at("")} and status = 'completed')::int as visits,
      (select count(*) from appointments where customer_id = ${customerId} ${at("")} and status = 'no_show')::int as "noShows",
      (select count(*) from appointments where customer_id = ${customerId} ${at("")} and status = 'cancelled')::int as cancellations,
      (select count(*) from appointments where customer_id = ${customerId} ${at("")} and status in ('booked','confirmed','checked_in','in_service') and starts_at >= ${nowIso})::int as upcoming,
      (select min(starts_at) from appointments where customer_id = ${customerId} ${at("")} and status = 'completed') as "firstVisit",
      (select max(starts_at) from appointments where customer_id = ${customerId} ${at("")} and status = 'completed') as "lastVisit",
      (select coalesce(sum(service_net_cents + product_net_cents), 0) from sales
        where customer_id = ${customerId} ${at("")} and status in ('paid','partially_refunded','refunded'))::int as gross,
      (select coalesce(sum(tip_cents), 0) from sales
        where customer_id = ${customerId} ${at("")} and status in ('paid','partially_refunded','refunded'))::int as tips,
      (select count(*) from sales where customer_id = ${customerId} ${at("")} and status in ('paid','partially_refunded','refunded'))::int as tickets,
      (select coalesce(sum(r.service_net_cents + r.product_net_cents), 0) from refunds r join sales s on s.id = r.sale_id
        where s.customer_id = ${customerId} ${at("s.")} and r.kind = 'refund' and s.status <> 'voided')::int as refunded,
      (select coalesce(sum(r.tip_cents), 0) from refunds r join sales s on s.id = r.sale_id
        where s.customer_id = ${customerId} ${at("s.")} and r.kind = 'refund' and s.status <> 'voided')::int as "tipRefunds",
      (select coalesce(sum(a.estimate_cents), 0) from appointments a
        where a.customer_id = ${customerId} ${at("a.")} and a.status = 'completed' and a.source = 'import'
          and not exists (select 1 from sales s where s.appointment_id = a.id
            or (s.customer_id = a.customer_id and s.business_date = (a.starts_at at time zone 'America/Chicago')::date)))::int as "squireVisitSpend",
      (select staff_id from appointments where customer_id = ${customerId} ${at("")} and status = 'completed'
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

/**
 * What a searcher sees in full decides what they may search by part of: someone who sees phones
 * masked still finds a client by their whole number, but a few digits match nothing, so the search
 * box can't be used to read numbers one digit at a time. The same goes for email.
 */
export interface SearchReach {
  phone: boolean;
  email: boolean;
}
const FULL_REACH: SearchReach = { phone: true, email: true };

/** Name, phone (any 4+ digits), or email. Backed by the trigram indexes in 0006_client_search.sql. */
export function customerSearchWhere(term: string, reach: SearchReach = FULL_REACH): SQL | undefined {
  const t = term.trim();
  if (!t) return undefined;
  const phone = normalizePhone(t);
  if (phone) return eq(customers.phone, phone);
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 4 && /^[\d\s().+-]+$/.test(t)) return reach.phone ? sql`${customers.phone} like ${`%${digits}%`}` : sql`false`;
  const lower = likeEscape(t.toLowerCase().replace(/\s+/g, " "));
  if (t.includes("@")) {
    if (reach.email) return sql`lower(${customers.email}) like ${`%${lower}%`}`;
    const email = normalizeEmail(t);
    return email ? eq(customers.email, email) : sql`false`;
  }
  return reach.email ? or(sql`${fullNameExpr} like ${`%${lower}%`}`, sql`lower(${customers.email}) like ${`${lower}%`}`) : sql`${fullNameExpr} like ${`%${lower}%`}`;
}

/** Clients with any appointment at these shops (or with this barber). */
export function visitedScope(opts: { shopIds?: string[]; staffId?: string }): SQL {
  const conds: SQL[] = [sql`v.customer_id = ${customers.id}`];
  if (opts.shopIds) conds.push(opts.shopIds.length ? sql`v.shop_id in (${sql.join(opts.shopIds.map((s) => sql`${s}::uuid`), sql`, `)})` : sql`false`);
  if (opts.staffId) conds.push(sql`v.staff_id = ${opts.staffId}::uuid`);
  return sql`exists (select 1 from appointments v where ${sql.join(conds, sql` and `)})`;
}

/**
 * Clients of these shops: their home shop is one of them or they've had an appointment at one. For
 * reports, exports and photo reach only: every client is the brand's, and lookups reach them all.
 */
export function shopClientsScope(shopIds: readonly string[]): SQL {
  if (!shopIds.length) return sql`false`;
  return or(inArray(customers.homeShopId, [...shopIds]), visitedScope({ shopIds: [...shopIds] }))!;
}

/** Raw rows for the server only, from the whole brand: pass them through showClient before they go anywhere. */
export async function searchCustomers(term: string, limit = 8, reach: SearchReach = FULL_REACH) {
  const where = customerSearchWhere(term, reach);
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
    .where(where)
    .orderBy(sql`(${fullNameExpr} like ${`${t}%`}) desc`, sql`${customers.createdAt} desc`)
    .limit(limit);
}

export type CustomerAccess = "full" | "barber" | null;

/** With "every client": the full record. Otherwise name, notes, loyalty, and visits for clients they've served. */
export async function customerAccess(viewer: { staffId: string; viewAll: boolean }, customerId: string): Promise<CustomerAccess> {
  if (viewer.viewAll) return "full";
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

// ───────────────────────────── Duplicates ─────────────────────────────

export type { DuplicateKind };

export type DuplicateClient = Customer & { squire: boolean; visits: number };

export interface DuplicatePair extends DuplicateScore {
  a: DuplicateClient;
  b: DuplicateClient;
  samePhone: boolean;
  sameEmail: boolean;
}

/**
 * Candidate pairs, scored by scoreDuplicate: same phone or email; the same or a typo-close name
 * (trigram) backed by a birthday, zip, phone last 4, or one record with no contact at all (Squire
 * imports and walk-ins). Pairs someone marked "not the same person" are left out. Nothing here
 * merges automatically.
 */
export async function duplicatePairs(opts: { forId?: string; limit?: number; squireOnly?: boolean } = {}): Promise<DuplicatePair[]> {
  const limit = opts.limit ?? 150;
  const squire = (col: string) => sql.raw(`exists (select 1 from customer_squire_ids s where s.customer_id = ${col})`);
  const backed = sql`(a.birthday = b.birthday or a.address_zip = b.address_zip or right(a.phone, 4) = right(b.phone, 4)
    or (a.phone is null and a.email is null) or (b.phone is null and b.email is null))`;
  const name = (t: string) => sql.raw(`lower(${t}.first_name || ' ' || coalesce(${t}.last_name, ''))`);
  const fuzzy = sql`${name("a")} % ${name("b")} and coalesce(a.last_name, '') <> '' and coalesce(b.last_name, '') <> '' and ${backed}`;
  // One client's pairs start from that client, so the profile page doesn't pair up the whole book.
  const candidates = opts.forId
    ? sql`select least(a.id, b.id) a_id, greatest(a.id, b.id) b_id from customers a join customers b on b.id <> a.id
        and (a.phone = b.phone or a.email = b.email or (${fuzzy})) where a.id = ${opts.forId}::uuid`
    : sql`select a.id a_id, b.id b_id from customers a join customers b on a.id < b.id and a.phone = b.phone where a.phone is not null
        union
        select a.id, b.id from customers a join customers b on a.id < b.id and a.email = b.email where a.email is not null
        union
        select a.id, b.id from customers a join customers b on a.id < b.id and ${fuzzy}`;
  const pairs = await db.transaction(async (tx) => {
    // Loose on purpose: this only proposes typo-close names; scoreDuplicate decides what they are.
    await tx.execute(sql`select set_config('pg_trgm.similarity_threshold', '0.5', true)`);
    return (await tx.execute(sql`
      select a_id, b_id from (${candidates}) p
      where not exists (select 1 from customer_duplicate_dismissals d where d.a_id = p.a_id and d.b_id = p.b_id)
        ${opts.squireOnly ? sql`and (${squire("p.a_id")} or ${squire("p.b_id")})` : sql``}
      limit ${limit * 3}
    `)) as unknown as { a_id: string; b_id: string }[];
  });
  if (!pairs.length) return [];
  const ids = [...new Set(pairs.flatMap((p) => [p.a_id, p.b_id]))];
  const [rows, extra] = await Promise.all([
    db.select().from(customers).where(inArray(customers.id, ids)),
    db.execute(sql`
      select c.id, ${squire("c.id")} squire, c.address_zip zip,
        (select count(*) from appointments a where a.customer_id = c.id and a.status = 'completed')::int visits
      from customers c where c.id in ${sql`(${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`}
    `) as unknown as Promise<{ id: string; squire: boolean; zip: string | null; visits: number }[]>,
  ]);
  const more = new Map(extra.map((e) => [e.id, e]));
  const byId = new Map(rows.map((r) => [r.id, { ...r, squire: !!more.get(r.id)?.squire, visits: more.get(r.id)?.visits ?? 0 }]));
  const side = (c: DuplicateClient) => ({ ...c, zip: more.get(c.id)?.zip ?? null });
  const out: DuplicatePair[] = [];
  for (const p of pairs) {
    const a = byId.get(p.a_id);
    const b = byId.get(p.b_id);
    if (!a || !b) continue;
    const samePhone = !!a.phone && a.phone === b.phone;
    const sameEmail = !!a.email && a.email === b.email;
    const s = scoreDuplicate(side(a), side(b));
    if (!samePhone && !sameEmail && s.conflicts.includes("first_name")) continue;
    out.push({ a, b, ...s, samePhone, sameEmail });
  }
  const order: Record<DuplicateKind, number> = { likely: 0, same_name: 1, similar_name: 2, shared_contact: 3 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || y.score - x.score).slice(0, limit);
}

/** "Not the same person": the pair stops being offered. Either order; stored low id first. */
export async function dismissDuplicate(aId: string, bId: string, actor: Actor) {
  if (aId === bId) throw new AppError("bad_request", "Pick two different clients");
  const found = await db.select({ id: customers.id }).from(customers).where(inArray(customers.id, [aId, bId]));
  if (found.length !== 2) throw notFound("Client");
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  await db.insert(customerDuplicateDismissals).values({ aId: lo, bId: hi, dismissedBy: actor.staffId ?? null }).onConflictDoNothing();
  await audit(actor, "client.duplicate_dismiss", "customer", lo, { other: hi });
}

/**
 * Merge several checked pairs, keeping the record with more visits (then the older one) each
 * time. Pairs that share a record chain together. Each merge is its own transaction and audit
 * entry; one that fails (a record merged away by someone else meanwhile) is reported and skipped.
 */
export async function mergeDuplicatePairs(pairs: { a: string; b: string }[], actor: Actor) {
  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  if (!ids.length) return { merged: 0, failed: [] as string[] };
  const facts = (await db.execute(sql`
    select c.id, c.created_at "createdAt", (select count(*) from appointments a where a.customer_id = c.id and a.status = 'completed')::int visits
    from customers c where c.id in ${sql`(${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`}
  `)) as unknown as { id: string; createdAt: Date | string; visits: number }[];
  type Fact = { id: string; visits: number; createdAt: Date };
  const byId = new Map<string, Fact>(facts.map((f) => [f.id, { ...f, createdAt: new Date(f.createdAt) }]));
  const usable = pairs.filter((p) => p.a !== p.b && byId.has(p.a) && byId.has(p.b)).map((p): [Fact, Fact] => [byId.get(p.a)!, byId.get(p.b)!]);
  let merged = 0;
  const failed: string[] = [];
  for (const step of planMerges(usable)) {
    try {
      await mergeCustomers(step.keep, step.drop, actor);
      merged++;
    } catch {
      failed.push(step.drop);
    }
  }
  return { merged, failed };
}
