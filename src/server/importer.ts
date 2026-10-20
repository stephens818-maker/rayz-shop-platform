import { and, eq, ilike, or } from "drizzle-orm";
import { DateTime } from "luxon";
import Papa from "papaparse";
import { db, Tx } from "@/db";
import {
  appointmentItems,
  appointments,
  customers,
  giftCardLedger,
  giftCards,
  importRuns,
  loyaltyAccounts,
  loyaltyLedger,
  loyaltyRewards,
  shops,
  staff,
  staffShops,
} from "@/db/schema";
import { appointmentCode } from "@/lib/ids";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { SHOP_TZ } from "@/lib/time";
import { Actor, audit } from "./audit";
import { shopCatalog } from "./catalog";
import { isDoubleBookingError } from "./errors";
import { getLoyaltyConfig } from "./loyalty";
import { rewardExpiry } from "@/domain/loyalty";

export type ImportKind = "clients" | "appointments" | "loyalty" | "gift_cards";

/** Squire's export headers vary by report; match on any of these (case/space-insensitive). */
const ALIASES: Record<string, string[]> = {
  squireId: ["client id", "clientid", "customer id", "client_id"],
  appointmentId: ["appointment id", "appointmentid", "booking id", "id"],
  firstName: ["first name", "firstname", "first_name", "client first name"],
  lastName: ["last name", "lastname", "last_name", "client last name"],
  fullName: ["name", "client", "client name", "full name", "customer", "customer name"],
  phone: ["phone", "phone number", "mobile", "mobile phone", "cell", "client phone"],
  email: ["email", "email address", "client email"],
  notes: ["notes", "client notes", "note"],
  shop: ["shop", "location", "shop name", "home shop"],
  smsOptIn: ["sms opt in", "sms", "text opt in", "marketing sms"],
  date: ["date", "appointment date", "start date", "day"],
  time: ["time", "start time", "appointment time"],
  start: ["start", "starts at", "start datetime", "datetime", "date time"],
  duration: ["duration", "duration (min)", "duration minutes", "length"],
  barber: ["barber", "staff", "provider", "employee", "barber name"],
  service: ["service", "services", "service name"],
  price: ["price", "total", "amount", "service price"],
  status: ["status", "appointment status"],
  progress: ["progress", "loyalty progress", "amount spent", "spent toward goal", "points", "progress ($)"],
  rewards: ["rewards", "rewards available", "available rewards", "reward count"],
  code: ["code", "gift card", "gift card code", "card number", "number"],
  balance: ["balance", "remaining", "current balance", "remaining balance"],
  initial: ["initial", "original amount", "amount", "value", "initial balance"],
  expires: ["expires", "expiration", "expiry", "expires at"],
};

const norm = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").trim();

export function mapHeaders(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const normalized = headers.map((h) => ({ raw: h, n: norm(h) }));
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const hit = aliases.map(norm).map((a) => normalized.find((h) => h.n === a)).find(Boolean);
    if (hit) map[field] = hit.raw;
  }
  return map;
}

function money(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const DATE_FORMATS = ["M/d/yyyy", "M/d/yy", "yyyy-MM-dd", "MMM d, yyyy", "MMMM d, yyyy"];
const TIME_FORMATS = ["h:mm a", "h:mma", "H:mm", "h a", "ha"];

export function parseSquireDateTime(date?: string, time?: string, start?: string): Date | null {
  if (start) {
    const iso = DateTime.fromISO(start.trim(), { zone: SHOP_TZ });
    if (iso.isValid) return iso.toJSDate();
    for (const df of DATE_FORMATS)
      for (const tf of TIME_FORMATS) {
        const d = DateTime.fromFormat(start.trim(), `${df} ${tf}`, { zone: SHOP_TZ });
        if (d.isValid) return d.toJSDate();
      }
  }
  if (!date) return null;
  for (const df of DATE_FORMATS) {
    if (!time) {
      const d = DateTime.fromFormat(date.trim(), df, { zone: SHOP_TZ });
      if (d.isValid) return d.toJSDate();
      continue;
    }
    for (const tf of TIME_FORMATS) {
      const d = DateTime.fromFormat(`${date.trim()} ${time.trim().toUpperCase()}`, `${df} ${tf}`, { zone: SHOP_TZ });
      if (d.isValid) return d.toJSDate();
    }
  }
  return null;
}

function mapStatus(s: string | undefined, isFuture: boolean): "completed" | "cancelled" | "no_show" | "booked" {
  const v = (s ?? "").toLowerCase();
  if (/cancel/.test(v)) return "cancelled";
  if (/no.?show/.test(v)) return "no_show";
  if (/complete|checked.?out|paid|finished|done/.test(v)) return "completed";
  if (/book|confirm|upcoming|scheduled|pending/.test(v)) return isFuture ? "booked" : "completed";
  return isFuture ? "booked" : "completed";
}

export interface ImportResult {
  kind: ImportKind;
  dryRun: boolean;
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
  headerMap: Record<string, string>;
  runId?: string;
}

class DryRunRollback extends Error {}

export async function runImport(kind: ImportKind, csv: string, opts: { dryRun: boolean; actor: Actor; filename?: string; now?: Date }): Promise<ImportResult> {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy" });
  const headerMap = mapHeaders(parsed.meta.fields ?? []);
  // A bare "ID" column means the client ID in a clients export, the appointment ID otherwise.
  if (kind !== "appointments" && headerMap.appointmentId && !headerMap.squireId) {
    headerMap.squireId = headerMap.appointmentId;
    delete headerMap.appointmentId;
  }
  const result: ImportResult = { kind, dryRun: opts.dryRun, totalRows: parsed.data.length, inserted: 0, updated: 0, skipped: 0, errors: [], headerMap };
  const get = (r: Record<string, string>, f: string) => (headerMap[f] ? r[headerMap[f]]?.trim() || undefined : undefined);
  const now = opts.now ?? new Date();

  const allShops = await db.select().from(shops);
  const findShop = (name?: string) => {
    if (!name) return null;
    const n = name.toLowerCase().replace(/ray'?z|barber ?shop|[^a-z ]/g, "").trim();
    return allShops.find((s) => s.name.toLowerCase() === n || s.slug === n.replace(/\s+/g, "-") || n.includes(s.name.toLowerCase())) ?? null;
  };

  try {
    await db.transaction(async (tx) => {
      const ctx = { tx, get, findShop, now, result };
      for (let i = 0; i < parsed.data.length; i++) {
        const row = parsed.data[i];
        try {
          await tx.transaction(async (sp) => {
            const outcome = await IMPORTERS[kind]({ ...ctx, tx: sp }, row);
            result[outcome]++;
          });
        } catch (e) {
          result.errors.push({ row: i + 2, message: isDoubleBookingError(e) ? "Overlaps another booking for this barber" : (e as Error).message });
          result.skipped++;
        }
      }
      if (opts.dryRun) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  if (!opts.dryRun) {
    const [run] = await db
      .insert(importRuns)
      .values({
        kind,
        filename: opts.filename ?? null,
        dryRun: false,
        totalRows: result.totalRows,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors.slice(0, 500),
        staffId: opts.actor.staffId ?? null,
      })
      .returning();
    result.runId = run.id;
    await audit(opts.actor, "import.run", "import", run.id, { kind, inserted: result.inserted, updated: result.updated, skipped: result.skipped });
  }
  return result;
}

interface Ctx {
  tx: Tx;
  get: (r: Record<string, string>, f: string) => string | undefined;
  findShop: (name?: string) => typeof shops.$inferSelect | null;
  now: Date;
  result: ImportResult;
}
type Outcome = "inserted" | "updated" | "skipped";

function splitName(full?: string) {
  if (!full) return { first: undefined, last: undefined };
  const [first, ...rest] = full.trim().split(/\s+/);
  return { first, last: rest.join(" ") || undefined };
}

async function matchCustomer(c: Ctx, r: Record<string, string>) {
  const squireId = c.get(r, "squireId");
  const phone = normalizePhone(c.get(r, "phone"));
  const email = normalizeEmail(c.get(r, "email"));
  const name = splitName(c.get(r, "fullName"));
  const first = c.get(r, "firstName") ?? name.first;
  if (squireId) {
    const hit = await c.tx.query.customers.findFirst({ where: eq(customers.squireId, squireId) });
    if (hit) return hit;
  }
  if (phone && first) {
    const hit = await c.tx.query.customers.findFirst({ where: and(eq(customers.phone, phone), ilike(customers.firstName, first)) });
    if (hit) return hit;
  }
  if (email) {
    const hit = await c.tx.query.customers.findFirst({ where: eq(customers.email, email) });
    if (hit) return hit;
  }
  return null;
}

async function importClient(c: Ctx, r: Record<string, string>): Promise<Outcome> {
  const name = splitName(c.get(r, "fullName"));
  const firstName = c.get(r, "firstName") ?? name.first;
  const lastName = c.get(r, "lastName") ?? name.last ?? null;
  if (!firstName) throw new Error("Missing first name");
  const phone = normalizePhone(c.get(r, "phone"));
  const email = normalizeEmail(c.get(r, "email"));
  const existing = await matchCustomer(c, r);
  const sms = c.get(r, "smsOptIn");
  const values = {
    firstName,
    lastName,
    phone,
    email,
    notes: c.get(r, "notes") ?? null,
    squireId: c.get(r, "squireId") ?? null,
    homeShopId: c.findShop(c.get(r, "shop"))?.id ?? null,
    smsOptIn: sms === undefined ? true : /^(y|yes|true|1|opted in)$/i.test(sms),
  };
  if (existing) {
    await c.tx
      .update(customers)
      .set({
        lastName: existing.lastName ?? values.lastName,
        phone: existing.phone ?? values.phone,
        email: existing.email ?? values.email,
        notes: existing.notes ?? values.notes,
        squireId: existing.squireId ?? values.squireId,
        homeShopId: existing.homeShopId ?? values.homeShopId,
      })
      .where(eq(customers.id, existing.id));
    return "updated";
  }
  await c.tx.insert(customers).values(values);
  return "inserted";
}

async function findBarber(c: Ctx, shopId: string, name: string) {
  const exact = await c.tx
    .select({ id: staff.id })
    .from(staff)
    .where(or(ilike(staff.squireName, name), ilike(staff.displayLabel, name)));
  if (exact.length === 1) return exact[0].id;
  const first = name.split(/\s+/)[0];
  const atShop = await c.tx
    .select({ id: staff.id })
    .from(staffShops)
    .innerJoin(staff, eq(staff.id, staffShops.staffId))
    .where(and(eq(staffShops.shopId, shopId), ilike(staff.firstName, first)));
  if (atShop.length === 1) return atShop[0].id;
  if (atShop.length > 1) throw new Error(`Ambiguous barber "${name}" — set "Squire name" on the staff record to disambiguate`);
  throw new Error(`Unknown barber "${name}"`);
}

async function importAppointment(c: Ctx, r: Record<string, string>): Promise<Outcome> {
  const squireId = c.get(r, "appointmentId");
  if (squireId) {
    const dup = await c.tx.query.appointments.findFirst({ where: eq(appointments.squireId, squireId) });
    if (dup) return "skipped";
  }
  const shop = c.findShop(c.get(r, "shop"));
  if (!shop) throw new Error(`Unknown shop "${c.get(r, "shop") ?? ""}"`);
  const startsAt = parseSquireDateTime(c.get(r, "date"), c.get(r, "time"), c.get(r, "start"));
  if (!startsAt) throw new Error("Couldn't parse date/time");
  const barberName = c.get(r, "barber");
  if (!barberName) throw new Error("Missing barber");
  const staffId = await findBarber(c, shop.id, barberName);
  const isFuture = startsAt > c.now;
  const status = mapStatus(c.get(r, "status"), isFuture);

  let customer = await matchCustomer(c, r);
  if (!customer) {
    const name = splitName(c.get(r, "fullName"));
    const first = c.get(r, "firstName") ?? name.first;
    if (first) {
      [customer] = await c.tx
        .insert(customers)
        .values({
          firstName: first,
          lastName: c.get(r, "lastName") ?? name.last ?? null,
          phone: normalizePhone(c.get(r, "phone")),
          email: normalizeEmail(c.get(r, "email")),
          squireId: c.get(r, "squireId") ?? null,
          homeShopId: shop.id,
        })
        .returning();
    }
  }

  const catalog = await shopCatalog(shop.id, {}, c.tx);
  const names = (c.get(r, "service") ?? "Imported service").split(/\s*[,;+]\s*/).filter(Boolean);
  const priceCents = money(c.get(r, "price"));
  const items = names.map((n, idx) => {
    const svc = catalog.find((s) => s.name.toLowerCase() === n.toLowerCase());
    return {
      serviceId: svc?.id ?? null,
      kind: svc?.kind ?? (idx === 0 ? "service" : "addon"),
      name: svc?.name ?? n,
      priceCents: idx === 0 && priceCents !== null && names.length === 1 ? priceCents : (svc?.priceCents ?? 0),
      durationMin: svc?.durationMin ?? 30,
    } as const;
  });
  const duration = Number(c.get(r, "duration")) || items.reduce((a, i) => a + i.durationMin, 0) || 30;
  const [a] = await c.tx
    .insert(appointments)
    .values({
      code: appointmentCode(),
      shopId: shop.id,
      staffId,
      customerId: customer?.id ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + duration * 60_000),
      status,
      source: "import",
      estimateCents: priceCents ?? items.reduce((s, i) => s + i.priceCents, 0),
      squireId: squireId ?? null,
      completedAt: status === "completed" ? new Date(startsAt.getTime() + duration * 60_000) : null,
      cancelledAt: status === "cancelled" ? startsAt : null,
      createdAt: isFuture ? c.now : startsAt,
    })
    .returning();
  await c.tx.insert(appointmentItems).values(items.map((i) => ({ ...i, appointmentId: a.id })));
  return "inserted";
}

async function importLoyalty(c: Ctx, r: Record<string, string>): Promise<Outcome> {
  const customer = await matchCustomer(c, r);
  if (!customer) throw new Error("No matching client (import clients first)");
  const progress = money(c.get(r, "progress")) ?? 0;
  const rewards = Number(c.get(r, "rewards") ?? 0) || 0;
  const existing = await c.tx.query.loyaltyAccounts.findFirst({ where: eq(loyaltyAccounts.customerId, customer.id) });
  await c.tx
    .insert(loyaltyAccounts)
    .values({ customerId: customer.id, progressCents: progress, lastEarnAt: c.now })
    .onConflictDoUpdate({ target: loyaltyAccounts.customerId, set: { progressCents: progress, updatedAt: c.now } });
  await c.tx.insert(loyaltyLedger).values({ customerId: customer.id, kind: "import", progressDeltaCents: progress - (existing?.progressCents ?? 0) });
  const cfg = await getLoyaltyConfig(c.tx);
  for (let k = 0; k < rewards; k++) {
    await c.tx.insert(loyaltyRewards).values({ customerId: customer.id, amountCents: cfg.rewardCents, source: "import", issuedAt: c.now, expiresAt: rewardExpiry(c.now, cfg) });
  }
  return existing ? "updated" : "inserted";
}

async function importGiftCard(c: Ctx, r: Record<string, string>): Promise<Outcome> {
  const code = c.get(r, "code")?.toUpperCase();
  if (!code) throw new Error("Missing gift card code");
  const balance = money(c.get(r, "balance"));
  if (balance === null || balance < 0) throw new Error("Missing or invalid balance");
  const initial = money(c.get(r, "initial")) ?? balance;
  const customer = await matchCustomer(c, r);
  const exp = c.get(r, "expires") ? parseSquireDateTime(c.get(r, "expires")) : null;
  const existing = await c.tx.query.giftCards.findFirst({ where: eq(giftCards.code, code) });
  if (existing) {
    await c.tx.update(giftCards).set({ balanceCents: balance }).where(eq(giftCards.id, existing.id));
    await c.tx.insert(giftCardLedger).values({ giftCardId: existing.id, deltaCents: balance - existing.balanceCents, kind: "import" });
    return "updated";
  }
  const [g] = await c.tx
    .insert(giftCards)
    .values({ code, initialCents: initial, balanceCents: balance, customerId: customer?.id ?? null, source: "import", expiresAt: exp })
    .returning();
  await c.tx.insert(giftCardLedger).values({ giftCardId: g.id, deltaCents: balance, kind: "import" });
  return "inserted";
}

const IMPORTERS: Record<ImportKind, (c: Ctx, r: Record<string, string>) => Promise<Outcome>> = {
  clients: importClient,
  appointments: importAppointment,
  loyalty: importLoyalty,
  gift_cards: importGiftCard,
};
