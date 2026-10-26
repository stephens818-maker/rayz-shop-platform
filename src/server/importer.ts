import { and, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import Papa from "papaparse";
import { db, Tx } from "@/db";
import {
  appointmentItems,
  appointments,
  consentEvents,
  customerSquireIds,
  customers,
  giftCardLedger,
  giftCards,
  importRuns,
  ImportRowError,
  loyaltyAccounts,
  loyaltyLedger,
  loyaltyRewards,
  payments,
  saleItems,
  sales,
  shops,
  staff,
  staffAccessShops,
  staffShops,
} from "@/db/schema";
import { CONSENT_MARKERS } from "@/domain/consent-texts";
import { LoyaltyConfig, rewardExpiry } from "@/domain/loyalty";
import { appointmentCode } from "@/lib/ids";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { SHOP_TZ, localDateOf } from "@/lib/time";
import { Actor, audit } from "./audit";
import { roleByKey } from "./auth/access";
import { EffectiveService, shopCatalog } from "./catalog";
import { ConsentContext, recordConsentChange } from "./consent-events";
import { Customer, matchCustomer, mergeNotes } from "./customers";
import { isDoubleBookingError } from "./errors";
import { getLoyaltyConfig, lockAccount } from "./loyalty";
import { messageContext } from "./booking";
import { scheduleAppointmentNotifications } from "./notifications/queue";

export type ImportKind = "clients" | "appointments" | "transactions" | "loyalty" | "gift_cards";
export const IMPORT_KINDS: ImportKind[] = ["clients", "appointments", "transactions", "loyalty", "gift_cards"];

/** Squire's export headers vary by report; match on any of these (case/space-insensitive). */
const ALIASES: Record<string, string[]> = {
  squireId: ["client id", "clientid", "customer id", "client_id", "client number", "customer number"],
  appointmentId: ["appointment id", "appointmentid", "booking id", "appointment number", "id"],
  transactionId: ["transaction id", "transactionid", "sale id", "receipt", "receipt number", "receipt #", "ticket", "ticket number", "order id", "checkout id"],
  firstName: ["first name", "firstname", "first_name", "client first name"],
  lastName: ["last name", "lastname", "last_name", "client last name"],
  fullName: ["name", "client", "client name", "full name", "customer", "customer name"],
  phone: ["phone", "phone number", "mobile", "mobile phone", "cell", "client phone", "cell phone"],
  email: ["email", "email address", "client email", "e-mail"],
  notes: ["notes", "client notes", "note", "appointment notes"],
  shop: ["shop", "location", "shop name", "home shop", "preferred shop", "preferred location"],
  smsOptIn: ["sms opt in", "sms", "text opt in", "marketing sms", "sms marketing", "text marketing", "sms consent", "accepts sms", "sms subscribed"],
  emailOptIn: ["email opt in", "email marketing", "marketing email", "accepts email", "email subscribed", "email consent", "accepts marketing"],
  preferredBarber: ["preferred barber", "preferred staff", "favorite barber", "preferred provider", "usual barber"],
  clientSince: ["client since", "customer since", "date added", "join date", "created at", "created"],
  date: ["date", "appointment date", "start date", "day", "transaction date", "sale date", "checkout date"],
  time: ["time", "start time", "appointment time"],
  start: ["start", "starts at", "start datetime", "datetime", "date time"],
  bookedAt: ["booked at", "booked on", "date booked", "booking date", "created at", "created"],
  duration: ["duration", "duration (min)", "duration minutes", "length"],
  barber: ["barber", "staff", "provider", "employee", "barber name"],
  service: ["service", "services", "service name"],
  addons: ["add ons", "add-ons", "addons", "add on", "extras"],
  price: ["price", "service price", "appointment price", "total", "amount"],
  serviceTotal: ["service total", "services total", "service sales", "services amount", "service subtotal", "services"],
  productTotal: ["product total", "products total", "product sales", "retail", "retail total", "products"],
  tip: ["tip", "tips", "gratuity", "tip amount"],
  tax: ["tax", "taxes", "sales tax"],
  discount: ["discount", "discounts", "discount amount"],
  total: ["total", "grand total", "total paid", "amount paid", "amount", "total collected"],
  paymentMethod: ["payment method", "payment type", "tender", "paid with", "method", "payment"],
  status: ["status", "appointment status", "transaction status", "payment status"],
  progress: ["progress", "loyalty progress", "amount spent", "spent toward goal", "points", "progress ($)"],
  rewards: ["rewards", "rewards available", "available rewards", "reward count"],
  code: ["code", "gift card", "gift card code", "card number", "number"],
  balance: ["balance", "remaining", "current balance", "remaining balance"],
  initial: ["initial", "original amount", "amount", "value", "initial balance"],
  expires: ["expires", "expiration", "expiry", "expires at"],
};

const norm = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").trim();

export function mapHeaders(headers: string[], kind?: ImportKind): Record<string, string> {
  const map: Record<string, string> = {};
  const normalized = headers.map((h) => ({ raw: h, n: norm(h) }));
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const hit = aliases.map(norm).map((a) => normalized.find((h) => h.n === a)).find(Boolean);
    if (hit) map[field] = hit.raw;
  }
  // A bare "ID" column is the record's own ID: client ID, appointment ID, or transaction ID.
  const bare = map.appointmentId && norm(map.appointmentId) === "id";
  if (bare && kind && kind !== "appointments") {
    if (kind === "transactions") map.transactionId ??= map.appointmentId;
    else map.squireId ??= map.appointmentId;
    delete map.appointmentId;
  }
  // "Services" is a list of names in an appointments export and an amount in a transactions export.
  if (kind !== "transactions" && map.serviceTotal && norm(map.serviceTotal) === "services") delete map.serviceTotal;
  if (kind === "transactions" && map.service && map.serviceTotal === map.service) delete map.service;
  if (kind !== "transactions" && map.productTotal && norm(map.productTotal) === "products") delete map.productTotal;
  return map;
}

function money(v: string | undefined): number | null {
  if (!v) return null;
  const neg = /^\(.*\)$/.test(v.trim());
  const n = Number(v.replace(/[$,\s()]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

function parseBool(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  if (/^(y|yes|true|1|opted ?in|subscribed|on|x|✓)$/i.test(v.trim())) return true;
  if (/^(n|no|false|0|opted ?out|unsubscribed|off)$/i.test(v.trim())) return false;
  return undefined;
}

const DATE_FORMATS = ["M/d/yyyy", "M/d/yy", "yyyy-MM-dd", "MMM d, yyyy", "MMMM d, yyyy", "M-d-yyyy"];
const TIME_FORMATS = ["h:mm a", "h:mma", "H:mm", "h a", "ha", "h:mm:ss a", "H:mm:ss"];

export function parseSquireDateTime(date?: string, time?: string, start?: string): Date | null {
  if (start) {
    const iso = DateTime.fromISO(start.trim(), { zone: SHOP_TZ });
    if (iso.isValid) return iso.toJSDate();
    for (const df of DATE_FORMATS)
      for (const tf of TIME_FORMATS) {
        const d = DateTime.fromFormat(start.trim().toUpperCase(), `${df} ${tf}`, { zone: SHOP_TZ });
        if (d.isValid) return d.toJSDate();
      }
  }
  if (!date) return null;
  const iso = DateTime.fromISO(date.trim(), { zone: SHOP_TZ });
  if (iso.isValid && !time) return iso.toJSDate();
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

/** One column holding a date, with or without a time. */
const parseWhen = (v: string | undefined) => (v ? (parseSquireDateTime(undefined, undefined, v) ?? parseSquireDateTime(v)) : null);

type ApptStatus = "completed" | "cancelled" | "no_show" | "booked";

export function mapStatus(s: string | undefined, isFuture: boolean): ApptStatus {
  const v = (s ?? "").toLowerCase();
  if (/cancel/.test(v)) return "cancelled";
  if (/no.?show|missed/.test(v)) return "no_show";
  if (/complete|checked.?out|paid|finished|done|served/.test(v)) return isFuture ? "booked" : "completed";
  return isFuture ? "booked" : "completed";
}

function paymentMethodOf(raw: string | undefined): "card" | "cash" | "gift_card" {
  const v = (raw ?? "").toLowerCase();
  if (/gift/.test(v)) return "gift_card";
  if (/cash/.test(v) && !/card|credit|debit/.test(v.split(/[,+/&]/)[0] ?? "")) return "cash";
  return "card";
}

/** Squire's placeholder clients for walk-ins; they are not people. */
const PLACEHOLDER_NAME = /^(walk[\s-]?in|guest|no name|unknown|n\/a|none|client)$/i;

// ───────────────────────────── Result & reconciliation ─────────────────────────────

export interface ImportStats {
  clientsCreated: number;
  clientsUpdated: number;
  /** Rows folded into a client that already existed under another Squire record, a booking, or sign-in. */
  duplicatesMerged: number;
  appointmentsImported: number;
  appointmentsUpdated: number;
  upcomingImported: number;
  pastVisits: number;
  noShows: number;
  cancellations: number;
  salesImported: number;
  salesVoided: number;
  salesLinkedToVisits: number;
  salesTotalCents: number;
  tipsCents: number;
  loyaltyAccounts: number;
  rewardsImported: number;
  giftCards: number;
  giftCardBalanceCents: number;
  formerBarbersCreated: number;
  alreadyImported: number;
}

const ZERO_STATS: ImportStats = {
  clientsCreated: 0,
  clientsUpdated: 0,
  duplicatesMerged: 0,
  appointmentsImported: 0,
  appointmentsUpdated: 0,
  upcomingImported: 0,
  pastVisits: 0,
  noShows: 0,
  cancellations: 0,
  salesImported: 0,
  salesVoided: 0,
  salesLinkedToVisits: 0,
  salesTotalCents: 0,
  tipsCents: 0,
  loyaltyAccounts: 0,
  rewardsImported: 0,
  giftCards: 0,
  giftCardBalanceCents: 0,
  formerBarbersCreated: 0,
  alreadyImported: 0,
};

export interface ImportResult {
  kind: ImportKind;
  dryRun: boolean;
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
  stats: ImportStats;
  /** Every skipped row, by reason (includes "Already imported", which has no error row). */
  skippedByReason: Record<string, number>;
  headerMap: Record<string, string>;
  runId?: string;
}

/** A row that can't be imported. `reason` is the short category shown in the reconciliation summary. */
export class RowError extends Error {
  constructor(
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

class DryRunRollback extends Error {}

const BATCH_ROWS = 500;
const STORED_ERRORS = 5000;

interface Run {
  kind: ImportKind;
  get: (r: Record<string, string>, f: string) => string | undefined;
  findShop: (name?: string) => ShopRow | null;
  onlyShop: string | null;
  now: Date;
  dryRun: boolean;
  cfg: LoyaltyConfig;
  catalogs: Map<string, EffectiveService[]>;
  barbers: Map<string, string>;
  /** Clients already written by an earlier row of this run (a second Squire record for them only fills gaps). */
  touched: Set<string>;
  /** Squire loyalty per client this run, summed across that client's Squire records. */
  loyalty: Map<string, { progress: number; rewards: number; issued: number }>;
}

interface Row extends Run {
  tx: Tx;
  /** Applied to the run only if the row commits, so a rolled-back row leaves no trace in the caches. */
  after: (() => void)[];
  stats: Partial<ImportStats>;
}

type Outcome = "inserted" | "updated" | "skipped";

const bump = (c: Row, k: keyof ImportStats, n = 1) => {
  c.stats[k] = (c.stats[k] ?? 0) + n;
};

export type SquireGet = (r: Record<string, string>, f: string) => string | undefined;

/** A Squire export read the way the importer reads it, for reconciliation and match reports. */
export function readSquireCsv(kind: ImportKind, csv: string) {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy" });
  const headerMap = mapHeaders(parsed.meta.fields ?? [], kind);
  const get: SquireGet = (r, f) => (headerMap[f] ? r[headerMap[f]]?.trim() || undefined : undefined);
  return { rows: parsed.data, headerMap, get };
}

type ShopRow = typeof shops.$inferSelect;

export function shopFinder(allShops: ShopRow[]) {
  return (name?: string) => {
    if (!name) return null;
    const n = name.toLowerCase().replace(/ray'?z|barber ?shop|[^a-z ]/g, "").trim();
    if (!n) return null;
    return allShops.find((s) => s.name.toLowerCase() === n || s.slug === n.replace(/\s+/g, "-") || n.includes(s.name.toLowerCase())) ?? null;
  };
}

export const squireMoney = money;

/** A Squire ticket's amounts in cents; a missing service total is what's left of the total. */
export function ticketAmounts(get: SquireGet, r: Record<string, string>) {
  let service = money(get(r, "serviceTotal"));
  const product = money(get(r, "productTotal")) ?? 0;
  const tip = money(get(r, "tip")) ?? 0;
  const tax = money(get(r, "tax")) ?? 0;
  const discount = Math.abs(money(get(r, "discount")) ?? 0);
  let total = money(get(r, "total"));
  if (service === null && total === null && !product) throw new RowError("Bad amount", "No service, product, or total amount");
  if (service === null) service = Math.max(0, (total ?? 0) - tip - tax - product);
  total ??= service + product + tax + tip;
  if ([service, product, tip, tax, total].some((v) => v < 0)) throw new RowError("Bad amount", "Negative amount (refunds are imported as voided tickets)");
  return { service, product, tip, tax, discount, total, voided: /void|refund/i.test(get(r, "status") ?? "") };
}

/** The ticket's Squire ID, or a stable stand-in when the export has none, so re-running a file never duplicates it. */
export function ticketRef(get: SquireGet, r: Record<string, string>, shopId: string, at: Date, total: number, tip: number) {
  return (
    get(r, "transactionId") ??
    `auto:${createHash("sha256")
      .update([shopId, at.toISOString(), get(r, "squireId") ?? get(r, "phone") ?? get(r, "email") ?? get(r, "fullName") ?? "", get(r, "barber") ?? "", total, tip].join("|"))
      .digest("hex")
      .slice(0, 24)}`
  );
}

/** Rows of another shop in a delta import for one shop; clients, loyalty and gift cards are brand-wide. */
const SHOP_SCOPED: ImportKind[] = ["appointments", "transactions"];

export async function runImport(kind: ImportKind, csv: string, opts: { dryRun: boolean; actor: Actor; filename?: string; now?: Date; shopId?: string }): Promise<ImportResult> {
  const { rows, headerMap, get } = readSquireCsv(kind, csv);
  const parsed = { data: rows };
  const result: ImportResult = {
    kind,
    dryRun: opts.dryRun,
    totalRows: parsed.data.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    stats: { ...ZERO_STATS },
    skippedByReason: {},
    headerMap,
  };

  const findShop = shopFinder(await db.select().from(shops));
  const run: Run = {
    kind,
    get,
    findShop,
    onlyShop: opts.shopId && SHOP_SCOPED.includes(kind) ? opts.shopId : null,
    now: opts.now ?? new Date(),
    dryRun: opts.dryRun,
    cfg: await getLoyaltyConfig(),
    catalogs: new Map(),
    barbers: new Map(),
    touched: new Set(),
    loyalty: new Map(),
  };

  const processRow = async (tx: Tx, i: number) => {
    const data = parsed.data[i];
    const c: Row = { ...run, tx, after: [], stats: {} };
    try {
      const outcome = await tx.transaction((sp) => IMPORTERS[kind]({ ...c, tx: sp }, data));
      c.after.forEach((f) => f());
      for (const [k, v] of Object.entries(c.stats)) result.stats[k as keyof ImportStats] += v;
      result[outcome]++;
      if (outcome === "skipped") result.skippedByReason["Already imported"] = (result.skippedByReason["Already imported"] ?? 0) + 1;
    } catch (e) {
      const reason = e instanceof RowError ? e.reason : isDoubleBookingError(e) ? "Double booking" : "Other";
      const message = isDoubleBookingError(e) ? "Overlaps another booking for this barber" : (e as Error).message;
      result.errors.push({ row: i + 2, reason, message, data });
      result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
      result.skipped++;
    }
  };

  if (opts.dryRun) {
    // One transaction, rolled back, so later rows still see earlier ones (in-file duplicates).
    try {
      await db.transaction(async (tx) => {
        for (let i = 0; i < parsed.data.length; i++) await processRow(tx, i);
        throw new DryRunRollback();
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
  } else {
    for (let start = 0; start < parsed.data.length; start += BATCH_ROWS) {
      await db.transaction(async (tx) => {
        for (let i = start; i < Math.min(parsed.data.length, start + BATCH_ROWS); i++) await processRow(tx, i);
      });
    }
    const [r] = await db
      .insert(importRuns)
      .values({
        kind,
        filename: opts.filename ?? null,
        dryRun: false,
        totalRows: result.totalRows,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors.slice(0, STORED_ERRORS),
        stats: { ...result.stats, ...Object.fromEntries(Object.entries(result.skippedByReason).map(([k, v]) => [`skipped:${k}`, v])) },
        staffId: opts.actor.staffId ?? null,
        shopId: opts.shopId ?? null,
      })
      .returning();
    result.runId = r.id;
    await audit(opts.actor, "import.run", "import", r.id, { kind, inserted: result.inserted, updated: result.updated, skipped: result.skipped, stats: result.stats, shopId: opts.shopId ?? null }, opts.shopId ?? null);
  }
  return result;
}

// ───────────────────────────── Shared row helpers ─────────────────────────────

function nameOf(c: Row, r: Record<string, string>) {
  const full = c.get(r, "fullName");
  const [splitFirst, ...rest] = (full ?? "").trim().split(/\s+/).filter(Boolean);
  let first = c.get(r, "firstName") ?? splitFirst;
  let last = c.get(r, "lastName") ?? (rest.join(" ") || undefined);
  const columns = [c.get(r, "firstName"), c.get(r, "lastName")].filter(Boolean).join(" ");
  const placeholder = PLACEHOLDER_NAME.test(columns || (full ?? "").trim());
  let note: string | null = null;
  if (!first && last) {
    first = last;
    last = undefined;
    note = "Squire had no first name for this client.";
  }
  return { first: placeholder ? undefined : first, last: placeholder ? undefined : (last ?? null), placeholder, full: full ?? [first, last].filter(Boolean).join(" "), note };
}

function contactOf(c: Row, r: Record<string, string>) {
  const rawPhone = c.get(r, "phone");
  const rawEmail = c.get(r, "email");
  const phone = normalizePhone(rawPhone);
  const email = normalizeEmail(rawEmail);
  const notes: string[] = [];
  if (rawPhone && !phone) notes.push(`Squire phone not recognized: ${rawPhone}`);
  if (rawEmail && !email) notes.push(`Squire email not recognized: ${rawEmail}`);
  return { phone, email, notes };
}

async function attachSquireId(c: Row, customerId: string, squireId: string | undefined, shopId: string | null) {
  if (!squireId) return;
  await c.tx.insert(customerSquireIds).values({ squireId, customerId, shopId }).onConflictDoNothing();
}

/** The client an appointment or transaction row belongs to; created when the row has an ID or contact. */
async function clientForRow(c: Row, r: Record<string, string>, shopId: string): Promise<{ customer: Customer | null; label: string | null }> {
  const n = nameOf(c, r);
  const squireId = c.get(r, "squireId");
  const { phone, email, notes } = contactOf(c, r);
  if (n.placeholder && !squireId && !phone && !email) return { customer: null, label: "Walk-in (Squire)" };
  const m = await matchCustomer(c.tx, { squireIds: squireId ? [squireId] : [], firstName: n.first, lastName: n.last, phone, email });
  // A client who deleted their account keeps their history, pseudonymized, but never gets their details back.
  if (m?.customer.deletedAt) return { customer: m.customer, label: null };
  if (m) {
    await attachSquireId(c, m.customer.id, squireId, shopId);
    const patch: Partial<Customer> = {};
    if (!m.customer.phone && phone) patch.phone = phone;
    if (!m.customer.email && email) patch.email = email;
    if (!m.customer.lastName && n.last) patch.lastName = n.last;
    if (Object.keys(patch).length) await c.tx.update(customers).set(patch).where(eq(customers.id, m.customer.id));
    return { customer: { ...m.customer, ...patch }, label: null };
  }
  if (!n.first || (!squireId && !phone && !email)) return { customer: null, label: n.full ? `Squire client: ${n.full}` : null };
  const [created] = await c.tx
    .insert(customers)
    .values({ firstName: n.first, lastName: n.last, phone, email, homeShopId: shopId, notes: mergeNotes(n.note, notes.join("\n")) })
    .returning();
  await attachSquireId(c, created.id, squireId, shopId);
  bump(c, "clientsCreated");
  return { customer: created, label: null };
}

async function catalogFor(c: Row, shopId: string) {
  const hit = c.catalogs.get(shopId);
  if (hit) return hit;
  const list = await shopCatalog(shopId, {}, c.tx);
  c.catalogs.set(shopId, list);
  return list;
}

/**
 * Staff for a Squire barber name: the "Squire name" on a staff record, then the display label,
 * then a unique first name at that shop. Past history with a barber who has left creates an
 * inactive, unbookable "former" staff record so the visit keeps its barber.
 */
async function resolveBarber(c: Row, name: string, shopId: string | null, opts: { createFormer: boolean; required: boolean }): Promise<string | null> {
  const key = `${shopId ?? "*"}|${name.toLowerCase()}`;
  const cached = c.barbers.get(key);
  if (cached) return cached;
  const remember = (id: string) => {
    c.after.push(() => c.barbers.set(key, id));
    return id;
  };
  const exact = await c.tx
    .select({ id: staff.id })
    .from(staff)
    .where(or(ilike(staff.squireName, name), ilike(staff.displayLabel, name)));
  if (exact.length === 1) return remember(exact[0].id);
  const first = name.split(/\s+/)[0];
  const atShop = shopId
    ? await c.tx
        .select({ id: staff.id })
        .from(staffShops)
        .innerJoin(staff, eq(staff.id, staffShops.staffId))
        .where(and(eq(staffShops.shopId, shopId), ilike(staff.firstName, first)))
    : await c.tx.select({ id: staff.id }).from(staff).where(ilike(staff.firstName, first));
  if (atShop.length === 1) return remember(atShop[0].id);
  if (atShop.length > 1 || exact.length > 1) {
    if (!opts.required) return null;
    throw new RowError("Ambiguous barber", `More than one barber matches "${name}". Set "Squire name" on the right staff record and re-run.`);
  }
  if (!opts.createFormer || !shopId) {
    if (!opts.required) return null;
    throw new RowError("Unknown barber", `No barber "${name}" at this shop. Add them on Staff (or set their Squire name) and re-run.`);
  }
  const [{ n }] = await c.tx.select({ n: sql<number>`coalesce(max(substring(${staff.staffCode} from 3)::int), 0)::int` }).from(staff);
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const [row] = await c.tx
    .insert(staff)
    .values({
      staffCode: `S-${String(n + 1).padStart(4, "0")}`,
      firstName,
      lastName: rest.join(" ") || null,
      displayLabel: `${firstName} (former)`,
      publicSlug: `former-${randomBytes(5).toString("hex")}`,
      roleId: (await roleByKey("barber", c.tx)).id,
      shopScope: "selected",
      isBookable: false,
      active: false,
      squireName: name.trim(),
    })
    .returning({ id: staff.id });
  await c.tx.insert(staffShops).values({ staffId: row.id, shopId, visibleOnline: false }).onConflictDoNothing();
  await c.tx.insert(staffAccessShops).values({ staffId: row.id, shopId }).onConflictDoNothing();
  bump(c, "formerBarbersCreated");
  return remember(row.id);
}

interface ParsedItem {
  name: string;
  kind: "service" | "addon";
  serviceId: string | null;
  priceCents: number;
  durationMin: number;
}

const ITEM_PRICE = /^(.*?)\s*(?:\(\s*\$\s*([\d.,]+)\s*\)|\(\s*([\d]+(?:\.\d\d)?)\s*\)|[-–:]\s*\$\s*([\d.,]+))\s*$/;

function splitItems(raw: string | undefined) {
  return (raw ?? "")
    .split(/\s*[,;|]\s*|\s+\+\s+|\s+&\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(ITEM_PRICE);
      return m ? { name: m[1].trim(), cents: money(m[2] ?? m[3] ?? m[4]) } : { name: s, cents: null as number | null };
    });
}

/**
 * Services and add-ons with their prices. Inline prices ("Beard Trim ($10)") win; otherwise a
 * row total is split by giving add-ons their menu price and the main service the rest.
 */
function parseItems(catalog: EffectiveService[], servicesRaw: string | undefined, addonsRaw: string | undefined, totalCents: number | null): ParsedItem[] {
  const raw = [...splitItems(servicesRaw).map((i) => ({ ...i, declared: "service" as const })), ...splitItems(addonsRaw).map((i) => ({ ...i, declared: "addon" as const }))];
  if (!raw.length) raw.push({ name: "Imported service", cents: null, declared: "service" });
  const items = raw.map((i, idx) => {
    const svc = catalog.find((s) => s.name.toLowerCase() === i.name.toLowerCase());
    return {
      name: svc?.name ?? i.name,
      kind: svc?.kind ?? (idx === 0 ? "service" : i.declared),
      serviceId: svc?.id ?? null,
      inline: i.cents,
      menu: svc?.priceCents ?? 0,
      durationMin: svc?.durationMin ?? (i.declared === "addon" ? 10 : 30),
    };
  });
  const out = (prices: number[]): ParsedItem[] => items.map((i, idx) => ({ name: i.name, kind: i.kind, serviceId: i.serviceId, durationMin: i.durationMin, priceCents: prices[idx] }));
  if (totalCents === null || items.some((i) => i.inline !== null)) return out(items.map((i) => i.inline ?? i.menu));
  const others = items.slice(1).reduce((a, i) => a + i.menu, 0);
  if (totalCents >= others) return out(items.map((i, idx) => (idx === 0 ? totalCents - others : i.menu)));
  const menuTotal = items.reduce((a, i) => a + i.menu, 0) || 1;
  let left = totalCents;
  return out(
    items.map((i, idx) => {
      const cents = idx === items.length - 1 ? left : Math.floor((totalCents * i.menu) / menuTotal);
      left -= cents;
      return cents;
    }),
  );
}

async function applyLoyalty(c: Row, customerId: string, progressCents: number, rewards: number) {
  const prior = c.loyalty.get(customerId);
  const sum = { progress: progressCents + (prior?.progress ?? 0), rewards: rewards + (prior?.rewards ?? 0) };
  let progress = sum.progress;
  let count = sum.rewards;
  // Two Squire records for one person can add up past the goal.
  if (c.cfg.thresholdCents > 0)
    while (progress >= c.cfg.thresholdCents) {
      progress -= c.cfg.thresholdCents;
      count++;
    }
  const acct = await lockAccount(c.tx, customerId);
  const hadImport = await c.tx.select({ id: loyaltyLedger.id }).from(loyaltyLedger).where(and(eq(loyaltyLedger.customerId, customerId), eq(loyaltyLedger.kind, "import"))).limit(1);
  await c.tx.update(loyaltyAccounts).set({ progressCents: progress, lastEarnAt: acct.lastEarnAt ?? c.now, updatedAt: c.now }).where(eq(loyaltyAccounts.customerId, customerId));
  // Replace, never add: re-running the file (or a second Squire record) must not mint more rewards.
  const removed = await c.tx
    .delete(loyaltyRewards)
    .where(and(eq(loyaltyRewards.customerId, customerId), eq(loyaltyRewards.source, "import"), isNull(loyaltyRewards.redeemedAt)))
    .returning({ id: loyaltyRewards.id });
  for (let k = 0; k < count; k++) {
    await c.tx.insert(loyaltyRewards).values({ customerId, amountCents: c.cfg.rewardCents, source: "import", issuedAt: c.now, expiresAt: rewardExpiry(c.now, c.cfg) });
  }
  await c.tx.insert(loyaltyLedger).values({
    customerId,
    kind: "import",
    progressDeltaCents: progress - acct.progressCents,
    rewardCents: (count - removed.length) * c.cfg.rewardCents,
  });
  if (!prior) bump(c, "loyaltyAccounts");
  bump(c, "rewardsImported", count - (prior?.issued ?? 0));
  c.after.push(() => c.loyalty.set(customerId, { ...sum, issued: count }));
  return hadImport.length > 0;
}

// ───────────────────────────── Clients ─────────────────────────────


/**
 * Squire's "accepts texts" and "accepts email" answers are appointment consent only (C20): marketing always
 * needs its own yes, given here. Recorded as imported so the record shows where each consent came from.
 */
const IMPORT_CONSENT: ConsentContext = { source: "import", textVersion: CONSENT_MARKERS.import };

/** The channels a client has turned on or off themselves, or had staff change, since being imported. */
async function chosenHere(tx: Tx, customerId: string) {
  const rows = await tx
    .selectDistinct({ channel: consentEvents.channel })
    .from(consentEvents)
    .where(and(eq(consentEvents.customerId, customerId), ne(consentEvents.source, "import")));
  return new Set<string>(rows.map((r) => r.channel));
}

async function importClient(c: Row, r: Record<string, string>): Promise<Outcome> {
  const n = nameOf(c, r);
  if (n.placeholder) throw new RowError("Placeholder client", `"${n.full}" is Squire's walk-in placeholder, not a client`);
  if (!n.first) throw new RowError("Missing name", "No first or last name");
  const { phone, email, notes: contactNotes } = contactOf(c, r);
  const squireId = c.get(r, "squireId");
  const shop = c.findShop(c.get(r, "shop"));
  const barberName = c.get(r, "preferredBarber") ?? c.get(r, "barber");
  const preferredStaffId = barberName ? await resolveBarber(c, barberName, shop?.id ?? null, { createFormer: false, required: false }) : null;
  const notes = mergeNotes(
    mergeNotes(c.get(r, "notes"), n.note),
    [...contactNotes, barberName && !preferredStaffId ? `Preferred barber in Squire: ${barberName}` : ""].filter(Boolean).join("\n"),
  );
  const sms = parseBool(c.get(r, "smsOptIn"));
  const mail = parseBool(c.get(r, "emailOptIn"));
  const since = parseWhen(c.get(r, "clientSince"));

  const m = await matchCustomer(c.tx, { squireIds: squireId ? [squireId] : [], firstName: n.first, lastName: n.last, phone, email });
  if (m?.customer.deletedAt) throw new RowError("Deleted account", "This client deleted their account here, so their Squire details aren't brought back");
  let customerId: string;
  let outcome: Outcome;
  if (!m) {
    const [row] = await c.tx
      .insert(customers)
      .values({
        firstName: n.first,
        lastName: n.last,
        phone,
        email,
        notes,
        homeShopId: shop?.id ?? null,
        preferredStaffId,
        smsOptIn: sms ?? false,
        emailOptIn: mail ?? false,
        ...(since ? { createdAt: since } : {}),
      })
      .returning();
    customerId = row.id;
    await recordConsentChange(c.tx, row, {}, { smsOptIn: row.smsOptIn, emailOptIn: row.emailOptIn }, IMPORT_CONSENT);
    bump(c, "clientsCreated");
    outcome = "inserted";
  } else {
    const ex = m.customer;
    customerId = ex.id;
    const firstTouch = !c.touched.has(ex.id);
    const patch: Partial<typeof customers.$inferInsert> = { notes: mergeNotes(ex.notes, notes) };
    if (m.via === "squire_id" && firstTouch) {
      // The same Squire record again: Squire's current values win, so a corrected phone lands.
      Object.assign(patch, {
        firstName: n.first,
        lastName: n.last ?? ex.lastName,
        phone: phone ?? ex.phone,
        email: email ?? ex.email,
        homeShopId: shop?.id ?? ex.homeShopId,
        preferredStaffId: preferredStaffId ?? ex.preferredStaffId,
      });
      // A yes from Squire never overrides a choice the client made here since.
      const ownChoice = sms || mail ? await chosenHere(c.tx, ex.id) : new Set<string>();
      if (sms !== undefined && !(sms && ownChoice.has("sms_transactional"))) patch.smsOptIn = sms;
      if (mail !== undefined && !(mail && ownChoice.has("email"))) patch.emailOptIn = mail;
    } else {
      // Another record for the same person: fill gaps only, and an explicit "no" from any record wins.
      Object.assign(patch, {
        lastName: ex.lastName ?? n.last,
        phone: ex.phone ?? phone,
        email: ex.email ?? email,
        homeShopId: ex.homeShopId ?? shop?.id ?? null,
        preferredStaffId: ex.preferredStaffId ?? preferredStaffId,
      });
      if (sms === false) patch.smsOptIn = false;
      if (mail === false) patch.emailOptIn = false;
    }
    if (since && since < ex.createdAt) patch.createdAt = since;
    await c.tx.update(customers).set(patch).where(eq(customers.id, ex.id));
    await recordConsentChange(c.tx, { id: ex.id, phone: patch.phone ?? ex.phone, email: patch.email ?? ex.email }, ex, patch, IMPORT_CONSENT);
    bump(c, m.via === "squire_id" ? "clientsUpdated" : "duplicatesMerged");
    outcome = "updated";
  }
  await attachSquireId(c, customerId, squireId, shop?.id ?? null);
  c.after.push(() => c.touched.add(customerId));

  if (c.get(r, "progress") !== undefined || c.get(r, "rewards") !== undefined) {
    await applyLoyalty(c, customerId, money(c.get(r, "progress")) ?? 0, Number(c.get(r, "rewards") ?? 0) || 0);
  }
  return outcome;
}

// ───────────────────────────── Appointments ─────────────────────────────

async function importAppointment(c: Row, r: Record<string, string>): Promise<Outcome> {
  const squireApptId = c.get(r, "appointmentId");
  const shop = c.findShop(c.get(r, "shop"));
  if (!shop) throw new RowError("Unknown shop", `Unknown shop "${c.get(r, "shop") ?? ""}"`);
  if (c.onlyShop && shop.id !== c.onlyShop) throw new RowError("Other shop", `${shop.name} isn't the shop being moved; its rows are left for its own cutover`);
  const startsAt = parseSquireDateTime(c.get(r, "date"), c.get(r, "time"), c.get(r, "start"));
  if (!startsAt) throw new RowError("Bad date", "Couldn't read the date/time");
  const isFuture = startsAt > c.now;
  const status = mapStatus(c.get(r, "status"), isFuture);
  const barberName = c.get(r, "barber");
  if (!barberName) throw new RowError("Missing barber", "No barber on this row");
  const staffId = (await resolveBarber(c, barberName, shop.id, { createFormer: !isFuture, required: true }))!;
  if (isFuture && status === "booked") {
    const [b] = await c.tx.select({ active: staff.active }).from(staff).where(eq(staff.id, staffId));
    if (!b?.active) throw new RowError("Inactive barber", `Upcoming booking with ${barberName}, who isn't active here. Rebook it with another barber.`);
  }
  const { customer, label } = await clientForRow(c, r, shop.id);

  const catalog = await catalogFor(c, shop.id);
  const priceCents = money(c.get(r, "price"));
  const items = parseItems(catalog, c.get(r, "service"), c.get(r, "addons"), priceCents);
  const duration = Number(c.get(r, "duration")) || items.reduce((a, i) => a + i.durationMin, 0) || 30;
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);
  const bookedAt = parseWhen(c.get(r, "bookedAt"));
  const notes = mergeNotes(c.get(r, "notes"), label);
  const values = {
    shopId: shop.id,
    staffId,
    customerId: customer?.id ?? null,
    startsAt,
    endsAt,
    status,
    estimateCents: priceCents ?? items.reduce((s, i) => s + i.priceCents, 0),
    notes,
    completedAt: status === "completed" ? endsAt : null,
    cancelledAt: status === "cancelled" ? startsAt : null,
    cancelledBy: status === "cancelled" ? "squire" : null,
    bookedAtKnown: !!bookedAt,
    createdAt: bookedAt ?? (isFuture ? c.now : startsAt),
  };

  const existing = squireApptId
    ? await c.tx.query.appointments.findFirst({ where: eq(appointments.squireId, squireApptId) })
    : await c.tx.query.appointments.findFirst({
        where: and(eq(appointments.source, "import"), eq(appointments.staffId, staffId), eq(appointments.startsAt, startsAt), customer ? eq(appointments.customerId, customer.id) : isNull(appointments.customerId)),
      });
  let apptId: string;
  if (existing) {
    const [sold] = await c.tx.select({ id: sales.id }).from(sales).where(and(eq(sales.appointmentId, existing.id), ne(sales.status, "voided"))).limit(1);
    const handledHere = existing.source !== "import" || !!sold || ["checked_in", "in_service"].includes(existing.status);
    if (handledHere) {
      bump(c, "alreadyImported");
      return "skipped";
    }
    await c.tx.update(appointments).set(values).where(eq(appointments.id, existing.id));
    await c.tx.delete(appointmentItems).where(eq(appointmentItems.appointmentId, existing.id));
    apptId = existing.id;
    bump(c, "appointmentsUpdated");
  } else {
    const [a] = await c.tx
      .insert(appointments)
      .values({ ...values, code: appointmentCode(), source: "import", squireId: squireApptId ?? null })
      .returning({ id: appointments.id });
    apptId = a.id;
    bump(c, "appointmentsImported");
  }
  await c.tx.insert(appointmentItems).values(items.map((i) => ({ ...i, appointmentId: apptId })));
  if (status === "booked") bump(c, "upcomingImported");
  if (status === "completed") bump(c, "pastVisits");
  if (status === "no_show") bump(c, "noShows");
  if (status === "cancelled") bump(c, "cancellations");
  if (status === "booked" && customer && !c.dryRun) {
    await scheduleAppointmentNotifications("imported", await messageContext(apptId, c.tx), c.tx, c.now);
  }
  return existing ? "updated" : "inserted";
}

// ───────────────────────────── Transactions (purchases, tips, totals) ─────────────────────────────

async function importTransaction(c: Row, r: Record<string, string>): Promise<Outcome> {
  const shop = c.findShop(c.get(r, "shop"));
  if (!shop) throw new RowError("Unknown shop", `Unknown shop "${c.get(r, "shop") ?? ""}"`);
  if (c.onlyShop && shop.id !== c.onlyShop) throw new RowError("Other shop", `${shop.name} isn't the shop being moved; its rows are left for its own cutover`);
  const at = parseSquireDateTime(c.get(r, "date"), c.get(r, "time"), c.get(r, "start"));
  if (!at) throw new RowError("Bad date", "Couldn't read the date/time");
  const { service, product, tip, tax, discount, total, voided } = ticketAmounts(c.get, r);
  const ref = ticketRef(c.get, r, shop.id, at, total, tip);
  const [dup] = await c.tx.select({ id: sales.id }).from(sales).where(eq(sales.squireRef, ref));
  if (dup) {
    bump(c, "alreadyImported");
    return "skipped";
  }

  const { customer } = await clientForRow(c, r, shop.id);
  const barberName = c.get(r, "barber");
  let staffId = barberName ? await resolveBarber(c, barberName, shop.id, { createFormer: true, required: true }) : null;
  const businessDate = localDateOf(at);

  const squireAppt = c.get(r, "appointmentId");
  let appointmentId: string | null = null;
  const free = sql`not exists (select 1 from sales s where s.appointment_id = ${appointments.id} and s.status <> 'voided')`;
  if (squireAppt) {
    const [a] = await c.tx.select({ id: appointments.id, staffId: appointments.staffId }).from(appointments).where(and(eq(appointments.squireId, squireAppt), free));
    if (a) [appointmentId, staffId] = [a.id, staffId ?? a.staffId];
  } else if (customer) {
    const sameDay = await c.tx
      .select({ id: appointments.id, staffId: appointments.staffId })
      .from(appointments)
      .where(
        and(
          eq(appointments.customerId, customer.id),
          eq(appointments.shopId, shop.id),
          eq(appointments.status, "completed"),
          sql`(${appointments.startsAt} at time zone 'America/Chicago')::date = ${businessDate}::date`,
          free,
        ),
      );
    const a = sameDay.find((x) => x.staffId === staffId) ?? (sameDay.length === 1 ? sameDay[0] : undefined);
    if (a) [appointmentId, staffId] = [a.id, staffId ?? a.staffId];
  }

  const method = paymentMethodOf(c.get(r, "paymentMethod"));
  const serviceTax = product + service > 0 ? Math.round((tax * service) / (service + product)) : tax;
  const [sale] = await c.tx
    .insert(sales)
    .values({
      shopId: shop.id,
      appointmentId,
      customerId: customer?.id ?? null,
      staffId,
      status: voided ? "voided" : "paid",
      businessDate,
      serviceGrossCents: service + discount,
      productGrossCents: product,
      discountCents: discount,
      serviceNetCents: service,
      productNetCents: product,
      serviceTaxCents: serviceTax,
      productTaxCents: tax - serviceTax,
      tipCents: tip,
      totalCents: total,
      pricing: { source: "squire", paymentMethod: c.get(r, "paymentMethod") ?? null, status: c.get(r, "status") ?? null },
      loyaltyEarnedCents: 0,
      paidAt: at,
      voidedAt: voided ? at : null,
      voidReason: voided ? `Squire: ${c.get(r, "status")}` : null,
      isImported: true,
      squireRef: ref,
      createdAt: at,
    })
    .returning({ id: sales.id });

  const catalog = await catalogFor(c, shop.id);
  const lines = c.get(r, "service") ? parseItems(catalog, c.get(r, "service"), c.get(r, "addons"), service) : service > 0 || discount > 0 ? parseItems(catalog, "Services (Squire)", undefined, service) : [];
  const rows: (typeof saleItems.$inferInsert)[] = lines.map((l, idx) => {
    const lineDiscount = idx === 0 ? discount : 0;
    return {
      saleId: sale.id,
      kind: l.kind,
      refId: l.serviceId,
      name: l.name,
      staffId,
      qty: 1,
      unitPriceCents: l.priceCents + lineDiscount,
      grossCents: l.priceCents + lineDiscount,
      discountCents: lineDiscount,
      netCents: l.priceCents,
      taxCents: idx === 0 ? serviceTax : 0,
    };
  });
  if (product > 0) {
    rows.push({ saleId: sale.id, kind: "product", refId: null, name: "Products (Squire)", staffId, qty: 1, unitPriceCents: product, grossCents: product, discountCents: 0, netCents: product, taxCents: tax - serviceTax });
  }
  if (rows.length) await c.tx.insert(saleItems).values(rows);
  await c.tx.insert(payments).values({
    saleId: sale.id,
    shopId: shop.id,
    businessDate,
    method,
    status: voided ? "voided" : "succeeded",
    amountCents: total,
    tipCents: tip,
    processor: "squire_import",
    createdAt: at,
  });
  if (voided) bump(c, "salesVoided");
  else {
    bump(c, "salesImported");
    bump(c, "salesTotalCents", total);
    bump(c, "tipsCents", tip);
    if (appointmentId) bump(c, "salesLinkedToVisits");
  }
  return "inserted";
}

// ───────────────────────────── Loyalty & gift cards ─────────────────────────────

async function importLoyalty(c: Row, r: Record<string, string>): Promise<Outcome> {
  const n = nameOf(c, r);
  const squireId = c.get(r, "squireId");
  const { phone, email } = contactOf(c, r);
  const m = await matchCustomer(c.tx, { squireIds: squireId ? [squireId] : [], firstName: n.first, lastName: n.last, phone, email });
  if (!m) throw new RowError("No matching client", "No matching client (import clients first)");
  const progress = money(c.get(r, "progress")) ?? 0;
  const rewards = Number(c.get(r, "rewards") ?? 0) || 0;
  if (progress < 0 || rewards < 0) throw new RowError("Bad amount", "Negative loyalty balance");
  const before = await c.tx.query.loyaltyAccounts.findFirst({ where: eq(loyaltyAccounts.customerId, m.customer.id) });
  const reimport = await applyLoyalty(c, m.customer.id, progress, rewards);
  return before || reimport ? "updated" : "inserted";
}

async function importGiftCard(c: Row, r: Record<string, string>): Promise<Outcome> {
  const code = c.get(r, "code")?.toUpperCase();
  if (!code) throw new RowError("Missing code", "Missing gift card code");
  const balance = money(c.get(r, "balance"));
  if (balance === null || balance < 0) throw new RowError("Bad amount", "Missing or invalid balance");
  const initial = money(c.get(r, "initial")) ?? balance;
  const n = nameOf(c, r);
  const squireId = c.get(r, "squireId");
  const { phone, email } = contactOf(c, r);
  const m = n.first || squireId || phone || email ? await matchCustomer(c.tx, { squireIds: squireId ? [squireId] : [], firstName: n.first, lastName: n.last, phone, email }) : null;
  const exp = parseWhen(c.get(r, "expires"));
  const existing = await c.tx.query.giftCards.findFirst({ where: eq(giftCards.code, code) });
  bump(c, "giftCards");
  bump(c, "giftCardBalanceCents", balance);
  if (existing) {
    const used = await c.tx
      .select({ id: giftCardLedger.id })
      .from(giftCardLedger)
      .where(and(eq(giftCardLedger.giftCardId, existing.id), inArray(giftCardLedger.kind, ["redeem", "refund", "void", "adjust"])))
      .limit(1);
    if (used.length) throw new RowError("Gift card used here", `${code} has been used at checkout since it was imported; its balance here is kept`);
    await c.tx.update(giftCards).set({ balanceCents: balance, initialCents: initial, customerId: existing.customerId ?? m?.customer.id ?? null, expiresAt: exp ?? existing.expiresAt }).where(eq(giftCards.id, existing.id));
    if (balance !== existing.balanceCents) await c.tx.insert(giftCardLedger).values({ giftCardId: existing.id, deltaCents: balance - existing.balanceCents, kind: "import" });
    return "updated";
  }
  const [g] = await c.tx
    .insert(giftCards)
    .values({ code, initialCents: initial, balanceCents: balance, customerId: m?.customer.id ?? null, source: "import", expiresAt: exp })
    .returning();
  await c.tx.insert(giftCardLedger).values({ giftCardId: g.id, deltaCents: balance, kind: "import" });
  return "inserted";
}

const IMPORTERS: Record<ImportKind, (c: Row, r: Record<string, string>) => Promise<Outcome>> = {
  clients: importClient,
  appointments: importAppointment,
  transactions: importTransaction,
  loyalty: importLoyalty,
  gift_cards: importGiftCard,
};
