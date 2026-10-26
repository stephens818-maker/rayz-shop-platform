import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appointmentItems,
  appointments,
  customers,
  customerSquireIds,
  CutoverReconciliation,
  CutoverSection,
  giftCardLedger,
  giftCards,
  importRuns,
  loyaltyAccounts,
  loyaltyLedger,
  loyaltyRewards,
  sales,
  shopCutovers,
  shops,
  staff,
} from "@/db/schema";
import { formatPhone, normalizeEmail, normalizePhone } from "@/lib/phone";
import { formatDateTime } from "@/lib/time";
import { Actor, audit } from "./audit";
import { matchCustomer } from "./customers";
import { AppError } from "./errors";
import { mapStatus, parseSquireDateTime, readSquireCsv, RowError, shopFinder, squireMoney, ticketAmounts, ticketRef } from "./importer";
import { getLoyaltyConfig } from "./loyalty";
import { toCsv } from "./reports";

export type CutoverFile = "bookings" | "tickets" | "loyalty" | "gift_cards";
export const CUTOVER_FILES: CutoverFile[] = ["bookings", "tickets", "loyalty", "gift_cards"];
/** Bookings, loyalty and gift cards must reconcile before a shop moves; tickets when the export is at hand. */
export const REQUIRED_FILES: CutoverFile[] = ["bookings", "loyalty", "gift_cards"];

export type CutoverStage = "on_squire" | "frozen" | "reconciled" | "signed_off" | "live" | "handed_back";

type Cutover = typeof shopCutovers.$inferSelect;

export function cutoverStage(shop: { bookingMode: string }, c: Cutover | null): CutoverStage {
  if (shop.bookingMode !== "external") return "live";
  if (!c?.squireFrozenAt) return c?.handedBackAt ? "handed_back" : "on_squire";
  if (c.signedOffAt) return "signed_off";
  if (c.matched && c.reconciledAt && c.reconciledAt > c.squireFrozenAt) return "reconciled";
  return "frozen";
}

/** A shop that has booked on Squire (imported bookings or tickets, or a cutover started) only changes over on the cutover page. */
export async function squireHistory(shopId: string) {
  const [r] = (await db.execute(sql`
    select exists (select 1 from ${shopCutovers} where shop_id = ${shopId})
        or exists (select 1 from ${appointments} where shop_id = ${shopId} and source = 'import')
        or exists (select 1 from ${sales} where shop_id = ${shopId} and is_imported) as hit
  `)) as unknown as { hit: boolean }[];
  return !!r?.hit;
}

export const cutoverEnvironment = () => process.env.VERCEL_ENV ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";

async function shopOrThrow(shopId: string) {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw new AppError("not_found", "No such shop");
  return shop;
}

/** Committed imports since a point in time that could change what was reconciled for this shop. */
async function importsSince(shopId: string, since: Date) {
  return db
    .select({ id: importRuns.id, kind: importRuns.kind, createdAt: importRuns.createdAt })
    .from(importRuns)
    .where(
      and(
        gt(importRuns.createdAt, since),
        eq(importRuns.dryRun, false),
        or(
          and(inArray(importRuns.kind, ["appointments", "transactions"]), or(eq(importRuns.shopId, shopId), isNull(importRuns.shopId))),
          inArray(importRuns.kind, ["clients", "loyalty", "gift_cards"]),
        ),
      ),
    );
}

export async function listCutovers() {
  const rows = await db.select({ shop: shops, c: shopCutovers }).from(shops).leftJoin(shopCutovers, eq(shopCutovers.shopId, shops.id)).where(eq(shops.active, true)).orderBy(shops.name);
  const names = new Map(
    (
      await db
        .select({ id: staff.id, label: staff.displayLabel })
        .from(staff)
        .where(inArray(staff.id, rows.flatMap((r) => [r.c?.freezeRecordedBy, r.c?.reconciledBy, r.c?.signedOffBy].filter((x): x is string => !!x)).concat("00000000-0000-0000-0000-000000000000")))
    ).map((s) => [s.id, s.label]),
  );
  return Promise.all(
    rows.map(async ({ shop, c }) => {
      const stage = cutoverStage(shop, c);
      const stale = c?.reconciledAt && ["reconciled", "signed_off"].includes(stage) ? await importsSince(shop.id, c.reconciledAt) : [];
      const deltaRuns = c?.squireFrozenAt
        ? await db
            .select({ id: importRuns.id, kind: importRuns.kind, createdAt: importRuns.createdAt, inserted: importRuns.inserted, updated: importRuns.updated, skipped: importRuns.skipped })
            .from(importRuns)
            .where(and(eq(importRuns.dryRun, false), gt(importRuns.createdAt, c.squireFrozenAt), or(eq(importRuns.shopId, shop.id), inArray(importRuns.kind, ["clients", "loyalty", "gift_cards"]))))
            .orderBy(importRuns.createdAt)
        : [];
      return {
        shop: { id: shop.id, name: shop.name, bookingMode: shop.bookingMode, externalBookingUrl: shop.externalBookingUrl },
        cutover: c,
        stage: stale.length && stage === "reconciled" ? ("frozen" as CutoverStage) : stage,
        staleBy: stale,
        deltaRuns,
        by: {
          freeze: c?.freezeRecordedBy ? names.get(c.freezeRecordedBy) : null,
          reconcile: c?.reconciledBy ? names.get(c.reconciledBy) : null,
          signOff: c?.signedOffBy ? names.get(c.signedOffBy) : null,
        },
      };
    }),
  );
}

/** Staff turned off this shop's online booking in Squire at `frozenAt`; what changed after it comes over in a delta import. */
export async function recordFreeze(actor: Actor, shopId: string, frozenAt: Date, now = new Date()) {
  const shop = await shopOrThrow(shopId);
  if (shop.bookingMode !== "external") throw new AppError("conflict", `${shop.name} already books here. To move it back to Squire, hand it back first.`);
  if (frozenAt > now) throw new AppError("bad_request", "Record the freeze once Squire booking is actually off, not ahead of time");
  const values = {
    squireFrozenAt: frozenAt,
    freezeRecordedBy: actor.staffId ?? null,
    freezeRecordedAt: now,
    matched: false,
    reconciledAt: null,
    reconciledBy: null,
    signedOffAt: null,
    signedOffBy: null,
    updatedAt: now,
  };
  await db
    .insert(shopCutovers)
    .values({ shopId, ...values })
    .onConflictDoUpdate({ target: shopCutovers.shopId, set: { ...values, handedBackAt: null, handedBackBy: null } });
  await audit(actor, "cutover.freeze", "shop", shopId, { frozenAt: frozenAt.toISOString() }, shopId);
}

// ───────────────────────────── Reconciliation ─────────────────────────────

type Diff = CutoverSection["differences"][number];

const section = (): CutoverSection => ({ expected: { count: 0, cents: 0 }, actual: { count: 0, cents: 0 }, differences: [], explained: [] });

const LIVE_BOOKING = ["booked", "confirmed", "checked_in", "in_service"] as const;

async function reconcileBookings(shopId: string, csv: string, now: Date): Promise<CutoverSection> {
  const out = section();
  const { rows, get } = readSquireCsv("appointments", csv);
  const findShop = shopFinder(await db.select().from(shops));
  const expected: { ref: string; squireId: string | null; startsAt: Date; cents: number | null; label: string }[] = [];
  for (const r of rows) {
    if (findShop(get(r, "shop"))?.id !== shopId) continue;
    const startsAt = parseSquireDateTime(get(r, "date"), get(r, "time"), get(r, "start"));
    if (!startsAt || startsAt <= now || mapStatus(get(r, "status"), true) !== "booked") continue;
    const squireId = get(r, "appointmentId") ?? null;
    const label = `${formatDateTime(startsAt)} with ${get(r, "barber") ?? "no barber"}`;
    expected.push({ ref: squireId ?? `${startsAt.toISOString()}|${get(r, "barber") ?? ""}`, squireId, startsAt, cents: squireMoney(get(r, "price")), label });
  }
  const ids = expected.map((e) => e.squireId).filter((x): x is string => !!x);
  const here = await db
    .select({
      id: appointments.id,
      squireId: appointments.squireId,
      startsAt: appointments.startsAt,
      status: appointments.status,
      estimateCents: appointments.estimateCents,
      cancelledBy: appointments.cancelledBy,
      source: appointments.source,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.shopId, shopId),
        or(and(eq(appointments.source, "import"), inArray(appointments.status, [...LIVE_BOOKING]), gt(appointments.startsAt, now)), ids.length ? inArray(appointments.squireId, ids) : sql`false`),
      ),
    );
  const bySquire = new Map(here.filter((h) => h.squireId).map((h) => [h.squireId!, h]));
  const used = new Set<string>();
  for (const e of expected) {
    out.expected.count++;
    out.expected.cents += e.cents ?? 0;
    const h = e.squireId ? bySquire.get(e.squireId) : here.find((x) => !used.has(x.id) && !x.squireId && x.source === "import" && x.startsAt.getTime() === e.startsAt.getTime());
    if (h) used.add(h.id);
    const d: Diff = { ref: e.ref, label: e.label, squireCents: e.cents, hereCents: h ? h.estimateCents : null };
    if (!h) out.differences.push({ ...d, label: `${e.label}: booked in Squire, not here` });
    else if (!(LIVE_BOOKING as readonly string[]).includes(h.status)) {
      if (h.status === "cancelled" && h.cancelledBy !== "squire") out.explained.push({ ...d, label: `${e.label}: cancelled here since the import` });
      else out.differences.push({ ...d, label: `${e.label}: ${h.status.replace("_", " ")} here, still booked in Squire` });
    } else {
      out.actual.count++;
      out.actual.cents += h.estimateCents ?? 0;
      if (h.startsAt.getTime() !== e.startsAt.getTime()) out.differences.push({ ...d, label: `${e.label}: here it's at ${formatDateTime(h.startsAt)}` });
      else if (e.cents !== null && e.cents !== h.estimateCents) out.differences.push({ ...d, label: `${e.label}: price differs` });
    }
  }
  for (const h of here) {
    if (used.has(h.id) || h.source !== "import" || !(LIVE_BOOKING as readonly string[]).includes(h.status) || h.startsAt <= now) continue;
    out.actual.count++;
    out.actual.cents += h.estimateCents ?? 0;
    out.differences.push({
      ref: h.squireId ?? h.id,
      label: `${formatDateTime(h.startsAt)}: booked here from Squire, but not booked in Squire's final export`,
      squireCents: null,
      hereCents: h.estimateCents,
    });
  }
  return out;
}

async function reconcileTickets(shopId: string, csv: string): Promise<CutoverSection> {
  const out = section();
  const { rows, get } = readSquireCsv("transactions", csv);
  const findShop = shopFinder(await db.select().from(shops));
  const expected: { ref: string; total: number; voided: boolean; label: string }[] = [];
  rows.forEach((r, i) => {
    if (findShop(get(r, "shop"))?.id !== shopId) return;
    const at = parseSquireDateTime(get(r, "date"), get(r, "time"), get(r, "start"));
    const label = at ? `Ticket ${get(r, "transactionId") ?? ""} on ${formatDateTime(at)}`.replace("  ", " ") : `Row ${i + 2}`;
    try {
      if (!at) throw new RowError("Bad date", "Couldn't read the date/time");
      const a = ticketAmounts(get, r);
      expected.push({ ref: ticketRef(get, r, shopId, at, a.total, a.tip), total: a.total, voided: a.voided, label });
    } catch (e) {
      out.differences.push({ ref: `row:${i + 2}`, label: `${label}: ${(e as Error).message}`, squireCents: null, hereCents: null });
    }
  });
  const here = expected.length
    ? await db
        .select({ ref: sales.squireRef, status: sales.status, totalCents: sales.totalCents })
        .from(sales)
        .where(
          inArray(
            sales.squireRef,
            expected.map((e) => e.ref),
          ),
        )
    : [];
  const byRef = new Map(here.map((h) => [h.ref!, h]));
  for (const e of expected) {
    const h = byRef.get(e.ref);
    if (!e.voided) {
      out.expected.count++;
      out.expected.cents += e.total;
    }
    if (h && h.status !== "voided") {
      out.actual.count++;
      out.actual.cents += h.totalCents;
    }
    const d: Diff = { ref: e.ref, label: e.label, squireCents: e.voided ? 0 : e.total, hereCents: h ? (h.status === "voided" ? 0 : h.totalCents) : null };
    if (!h) out.differences.push({ ...d, label: `${e.label}: in Squire, not here` });
    else if (e.voided !== (h.status === "voided")) out.differences.push({ ...d, label: `${e.label}: ${e.voided ? "voided in Squire" : "voided here"}` });
    else if (!e.voided && h.totalCents !== e.total) {
      if (h.status === "refunded" || h.status === "partially_refunded") out.explained.push({ ...d, label: `${e.label}: refunded here since the import` });
      else out.differences.push({ ...d, label: `${e.label}: total differs` });
    }
  }
  return out;
}

async function customerForRow(get: ReturnType<typeof readSquireCsv>["get"], r: Record<string, string>) {
  const squireId = get(r, "squireId");
  if (squireId) {
    const [hit] = await db.select({ id: customerSquireIds.customerId }).from(customerSquireIds).where(eq(customerSquireIds.squireId, squireId));
    if (hit) return hit.id;
  }
  const [first, ...rest] = (get(r, "fullName") ?? "").split(/\s+/).filter(Boolean);
  const m = await matchCustomer(db, {
    squireIds: [],
    firstName: get(r, "firstName") ?? first,
    lastName: get(r, "lastName") ?? (rest.join(" ") || undefined),
    phone: normalizePhone(get(r, "phone")),
    email: normalizeEmail(get(r, "email")),
  });
  return m?.customer.id ?? null;
}

/** Changes made here after the client's (or card's) last import, which Squire can't know about. */
async function loyaltyActivity(customerIds: string[]) {
  if (!customerIds.length) return new Set<string>();
  const rows = (await db.execute(sql`
    select l.customer_id as id from ${loyaltyLedger} l
    where l.customer_id in (${sql.join(
      customerIds.map((x) => sql`${x}::uuid`),
      sql`, `,
    )}) and l.kind <> 'import'
      and l.created_at > coalesce((select max(i.created_at) from ${loyaltyLedger} i where i.customer_id = l.customer_id and i.kind = 'import'), '-infinity')
    group by l.customer_id
  `)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

async function reconcileLoyalty(csv: string, now: Date): Promise<CutoverSection> {
  const out = section();
  const cfg = await getLoyaltyConfig();
  const { rows, get } = readSquireCsv("loyalty", csv);
  const per = new Map<string, { progress: number; rewards: number; label: string }>();
  for (const [i, r] of rows.entries()) {
    const label = `Squire client ${get(r, "squireId") ?? `on row ${i + 2}`}`;
    const progress = squireMoney(get(r, "progress")) ?? 0;
    const rewards = Number(get(r, "rewards") ?? 0) || 0;
    const id = await customerForRow(get, r);
    if (!id) {
      out.differences.push({ ref: `row:${i + 2}`, label: `${label}: no matching client here`, squireCents: progress + rewards * cfg.rewardCents, hereCents: null });
      continue;
    }
    const p = per.get(id) ?? { progress: 0, rewards: 0, label };
    per.set(id, { progress: p.progress + progress, rewards: p.rewards + rewards, label: p.label });
  }
  const ids = [...per.keys()];
  const [accounts, rewards, active] = ids.length
    ? await Promise.all([
        db.select({ id: loyaltyAccounts.customerId, progress: loyaltyAccounts.progressCents }).from(loyaltyAccounts).where(inArray(loyaltyAccounts.customerId, ids)),
        db
          .select({ id: loyaltyRewards.customerId, n: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${loyaltyRewards.amountCents}), 0)::int` })
          .from(loyaltyRewards)
          .where(and(inArray(loyaltyRewards.customerId, ids), isNull(loyaltyRewards.redeemedAt), or(isNull(loyaltyRewards.expiresAt), gt(loyaltyRewards.expiresAt, now))))
          .groupBy(loyaltyRewards.customerId),
        loyaltyActivity(ids),
      ])
    : [[], [], new Set<string>()];
  const acct = new Map(accounts.map((a) => [a.id, a.progress]));
  const rew = new Map(rewards.map((r) => [r.id, r]));
  for (const [id, e] of per) {
    let progress = e.progress;
    let count = e.rewards;
    if (cfg.thresholdCents > 0)
      while (progress >= cfg.thresholdCents) {
        progress -= cfg.thresholdCents;
        count++;
      }
    const squireCents = progress + count * cfg.rewardCents;
    const hereProgress = acct.get(id);
    const hereRewards = rew.get(id) ?? { n: 0, cents: 0 };
    const hereCents = hereProgress === undefined ? null : hereProgress + hereRewards.cents;
    out.expected.count++;
    out.expected.cents += squireCents;
    if (hereCents !== null) {
      out.actual.count++;
      out.actual.cents += hereCents;
    }
    const d: Diff = { ref: id, label: e.label, squireCents, hereCents };
    if (hereProgress === undefined) out.differences.push({ ...d, label: `${e.label}: no loyalty account here` });
    else if (hereProgress !== progress || hereRewards.n !== count || hereCents !== squireCents) {
      if (active.has(id)) out.explained.push({ ...d, label: `${e.label}: earned or redeemed here since the import` });
      else out.differences.push({ ...d, label: `${e.label}: ${hereRewards.n} reward${hereRewards.n === 1 ? "" : "s"} and ${hereProgress} progress here, ${count} and ${progress} in Squire` });
    }
  }
  return out;
}

async function reconcileGiftCards(csv: string): Promise<CutoverSection> {
  const out = section();
  const { rows, get } = readSquireCsv("gift_cards", csv);
  const expected = new Map<string, number>();
  for (const [i, r] of rows.entries()) {
    const code = get(r, "code")?.toUpperCase();
    const balance = squireMoney(get(r, "balance"));
    if (!code || balance === null || balance < 0) {
      out.differences.push({ ref: `row:${i + 2}`, label: `Row ${i + 2}: missing code or balance`, squireCents: balance, hereCents: null });
      continue;
    }
    expected.set(code, balance);
  }
  const codes = [...expected.keys()];
  const here = codes.length
    ? await db.select({ id: giftCards.id, code: giftCards.code, balance: giftCards.balanceCents, status: giftCards.status }).from(giftCards).where(inArray(giftCards.code, codes))
    : [];
  const usedHere = here.length
    ? new Set(
        (
          (await db.execute(sql`
            select l.gift_card_id as id from ${giftCardLedger} l
            where l.gift_card_id in (${sql.join(
              here.map((h) => sql`${h.id}::uuid`),
              sql`, `,
            )}) and l.kind <> 'import'
              and l.created_at > coalesce((select max(i.created_at) from ${giftCardLedger} i where i.gift_card_id = l.gift_card_id and i.kind = 'import'), '-infinity')
            group by l.gift_card_id
          `)) as unknown as { id: string }[]
        ).map((r) => r.id),
      )
    : new Set<string>();
  const byCode = new Map(here.map((h) => [h.code, h]));
  for (const [code, balance] of expected) {
    const h = byCode.get(code);
    const hereCents = h ? (h.status === "void" ? 0 : h.balance) : null;
    const label = `Gift card ending ${code.slice(-4)}`;
    out.expected.count++;
    out.expected.cents += balance;
    if (hereCents !== null) {
      out.actual.count++;
      out.actual.cents += hereCents;
    }
    const d: Diff = { ref: code.slice(-4), label, squireCents: balance, hereCents };
    if (!h) out.differences.push({ ...d, label: `${label}: in Squire, not here` });
    else if (hereCents !== balance) {
      if (usedHere.has(h.id)) out.explained.push({ ...d, label: `${label}: used here since the import` });
      else out.differences.push({ ...d, label: `${label}: balance differs` });
    }
  }
  return out;
}

export const sectionMatched = (s: CutoverSection) => s.differences.length === 0;

/**
 * Squire's final exports, taken after the freeze, against what's here. Matched only when every
 * required file is in and nothing differs that activity here doesn't explain.
 */
export async function reconcileShop(actor: Actor, shopId: string, files: Partial<Record<CutoverFile, { name: string; csv: string }>>, now = new Date()) {
  const shop = await shopOrThrow(shopId);
  const c = await db.query.shopCutovers.findFirst({ where: eq(shopCutovers.shopId, shopId) });
  if (!c?.squireFrozenAt) throw new AppError("conflict", "Record when Squire booking was turned off for this shop first");
  if (shop.bookingMode !== "external") throw new AppError("conflict", `${shop.name} already books here`);
  const sections: CutoverReconciliation["sections"] = {};
  if (files.bookings) sections.bookings = await reconcileBookings(shopId, files.bookings.csv, now);
  if (files.tickets) sections.tickets = await reconcileTickets(shopId, files.tickets.csv);
  if (files.loyalty) sections.loyalty = await reconcileLoyalty(files.loyalty.csv, now);
  if (files.gift_cards) sections.gift_cards = await reconcileGiftCards(files.gift_cards.csv);
  const missing = REQUIRED_FILES.filter((f) => !files[f]);
  const matched = missing.length === 0 && Object.values(sections).every((s) => sectionMatched(s!));
  const reconciliation: CutoverReconciliation = {
    environment: cutoverEnvironment(),
    at: now.toISOString(),
    frozenAt: c.squireFrozenAt.toISOString(),
    sections,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v!.name])),
  };
  await db
    .update(shopCutovers)
    .set({ reconciliation, reconciledAt: now, reconciledBy: actor.staffId ?? null, matched, signedOffAt: null, signedOffBy: null, updatedAt: now })
    .where(eq(shopCutovers.shopId, shopId));
  await audit(
    actor,
    "cutover.reconcile",
    "shop",
    shopId,
    {
      matched,
      missing,
      environment: reconciliation.environment,
      ...Object.fromEntries(Object.entries(sections).map(([k, s]) => [k, { expected: s!.expected, actual: s!.actual, differences: s!.differences.length, explained: s!.explained.length }])),
    },
    shopId,
  );
  return { matched, missing, reconciliation };
}

/** An owner signs off on the reconciliation and the shop's online booking moves here in the same step. */
export async function signOffAndSwitch(actor: Actor, shopId: string, now = new Date()) {
  const shop = await shopOrThrow(shopId);
  const c = await db.query.shopCutovers.findFirst({ where: eq(shopCutovers.shopId, shopId) });
  const stage = cutoverStage(shop, c ?? null);
  if (stage === "live") throw new AppError("conflict", `${shop.name} already books here`);
  if (!c?.squireFrozenAt) throw new AppError("conflict", "Record when Squire booking was turned off first");
  if (!c.matched || !c.reconciledAt || c.reconciledAt <= c.squireFrozenAt)
    throw new AppError("conflict", "The last reconciliation didn't match to the cent. Fix the differences, import again, and reconcile");
  const later = await importsSince(shopId, c.reconciledAt);
  if (later.length) throw new AppError("conflict", "Something was imported after the last reconciliation. Reconcile again before switching");
  await db.transaction(async (tx) => {
    await tx.update(shops).set({ bookingMode: "platform" }).where(eq(shops.id, shopId));
    await tx
      .update(shopCutovers)
      .set({ signedOffAt: now, signedOffBy: actor.staffId ?? null, switchedAt: now, updatedAt: now })
      .where(eq(shopCutovers.shopId, shopId));
    await audit(actor, "cutover.switch", "shop", shopId, { environment: cutoverEnvironment(), reconciledAt: c.reconciledAt!.toISOString(), frozenAt: c.squireFrozenAt!.toISOString() }, shopId, tx);
  });
}

/** Since the shop moved here: what Squire needs re-entered if it goes back (C11, the other direction). */
export async function handBackReport(shopId: string, now = new Date()) {
  const c = await db.query.shopCutovers.findFirst({ where: eq(shopCutovers.shopId, shopId) });
  const since = (c?.switchedAt ?? new Date(0)).toISOString();
  const bookings = await db
    .select({
      code: appointments.code,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      barber: staff.displayLabel,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phone: customers.phone,
      email: customers.email,
      estimateCents: appointments.estimateCents,
      services: sql<string>`coalesce((select string_agg(${appointmentItems.name}, ', ' order by ${appointmentItems.kind}, ${appointmentItems.name}) from ${appointmentItems} where ${appointmentItems.appointmentId} = ${appointments.id}), '')`,
    })
    .from(appointments)
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(and(eq(appointments.shopId, shopId), ne(appointments.source, "import"), inArray(appointments.status, [...LIVE_BOOKING]), gt(appointments.startsAt, now)))
    .orderBy(appointments.startsAt);
  const [cards] = (await db.execute(sql`
    select
      (select count(*) from ${giftCards} where issued_shop_id = ${shopId} and created_at > ${since} and source <> 'import')::int as sold,
      (select coalesce(sum(initial_cents), 0) from ${giftCards} where issued_shop_id = ${shopId} and created_at > ${since} and source <> 'import')::int as sold_cents,
      (select count(*) from ${giftCardLedger} l join ${sales} s on s.id = l.sale_id where s.shop_id = ${shopId} and l.kind = 'redeem' and l.created_at > ${since})::int as redeemed,
      (select coalesce(-sum(l.delta_cents), 0) from ${giftCardLedger} l join ${sales} s on s.id = l.sale_id where s.shop_id = ${shopId} and l.kind = 'redeem' and l.created_at > ${since})::int as redeemed_cents,
      (select count(*) from ${loyaltyRewards} r join ${sales} s on s.id = r.redeemed_sale_id where s.shop_id = ${shopId} and r.redeemed_at > ${since})::int as rewards_redeemed,
      (select count(*) from ${loyaltyRewards} r join ${sales} s on s.id = r.source_sale_id where s.shop_id = ${shopId} and r.issued_at > ${since})::int as rewards_earned
  `)) as unknown as { sold: number; sold_cents: number; redeemed: number; redeemed_cents: number; rewards_redeemed: number; rewards_earned: number }[];
  return { since: c?.switchedAt ?? null, bookings, cards };
}

export function handBackCsv(rows: Awaited<ReturnType<typeof handBackReport>>["bookings"]) {
  return toCsv(
    ["Code", "Starts", "Ends", "Barber", "First name", "Last name", "Phone", "Email", "Services", "Estimate"],
    rows.map((b) => [
      b.code,
      formatDateTime(b.startsAt),
      formatDateTime(b.endsAt),
      b.barber,
      b.firstName,
      b.lastName,
      b.phone ? formatPhone(b.phone) : "",
      b.email,
      b.services,
      b.estimateCents === null ? "" : (b.estimateCents / 100).toFixed(2),
    ]),
  );
}

/**
 * Online booking for this shop goes back to Squire. Bookings already made here stay (the desk serves
 * them); the hand-back report lists them for Squire. A later move starts over from the freeze.
 */
export async function handBack(actor: Actor, shopId: string, externalBookingUrl: string, now = new Date()) {
  const shop = await shopOrThrow(shopId);
  if (shop.bookingMode === "external") throw new AppError("conflict", `${shop.name} already sends clients to ${shop.externalBookingUrl}`);
  if (!/^https:\/\/\S+\.\S+$/.test(externalBookingUrl)) throw new AppError("bad_request", "Enter the shop's https booking link on Squire");
  const report = await handBackReport(shopId, now);
  await db.transaction(async (tx) => {
    await tx.update(shops).set({ bookingMode: "external", externalBookingUrl }).where(eq(shops.id, shopId));
    await tx
      .insert(shopCutovers)
      .values({ shopId, handedBackAt: now, handedBackBy: actor.staffId ?? null, updatedAt: now })
      .onConflictDoUpdate({
        target: shopCutovers.shopId,
        set: {
          handedBackAt: now,
          handedBackBy: actor.staffId ?? null,
          squireFrozenAt: null,
          freezeRecordedAt: null,
          freezeRecordedBy: null,
          matched: false,
          reconciledAt: null,
          reconciledBy: null,
          signedOffAt: null,
          signedOffBy: null,
          updatedAt: now,
        },
      });
    await audit(actor, "cutover.hand_back", "shop", shopId, { externalBookingUrl, upcomingBookingsHere: report.bookings.length, ...report.cards }, shopId, tx);
  });
  return report;
}
