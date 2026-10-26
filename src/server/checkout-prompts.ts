import { and, asc, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { clientName, maskLastName } from "@/domain/client-privacy";
import { db, type DBorTx } from "@/db";
import {
  appointmentItems,
  appointments,
  checkoutPromptRules,
  checkoutPrompts,
  customers,
  notificationJobs,
  products,
  rebookReminders,
  roles,
  saleItems,
  saleUsedProducts,
  sales,
  serviceProductSuggestions,
  services,
  shops,
  staff,
} from "@/db/schema";
import {
  type CheckoutPromptSettings,
  type DayChoices,
  type ProductSuggested,
  type ProductSuggestion,
  type PromptKind,
  type PromptOutcome,
  type PromptRule,
  REMINDER_HOUR,
  type RebookOption,
  type RebookPerson,
  type RebookSuggested,
  type RuleTarget,
  candidateDays,
  isPromptKind,
  pickTimes,
  resolvePrompt,
  promptSettings,
  rankProducts,
  reasonProblem,
  rebookInterval,
  reminderDay,
  requiredMessage,
  stockStatus,
  unansweredRequired,
} from "@/domain/checkout-prompts";
import { fill, templateFor } from "@/domain/message-templates";
import type { ProductHistory } from "@/domain/product-history";
import { appBaseUrl } from "@/lib/deployment";
import { formatPhone } from "@/lib/phone";
import { type LocalDate, addDays, localDateOf, localMinutesOf, startOfLocalDay, todayLocal, zonedWallTime } from "@/lib/time";
import { type Actor, audit } from "./audit";
import { brandColumn } from "./brand-sync/settings";
import { localValue } from "./brand-sync/store";
import { createAppointment, dayOpenings } from "./booking";
import { AppError, notFound } from "./errors";
import { householdHead, householdIds } from "./family";
import { ticketAppointmentIds, ticketPeople } from "./family-ticket";
import { contactFor } from "./household-contact";
import { stockLevels } from "./inventory/stock";
import { savedTemplates } from "./notifications/queue";
import { clientProductHistory } from "./product-history";

import { promptRulesAt } from "./brand-sync/adapters/rules";
import { suggestAt } from "./brand-sync/adapters/service-rules";

/**
 * Checkout prompts (src/domain/checkout-prompts.ts): the brand's settings and overrides, the
 * products barbers tag as used, the prompts on a ticket (one row per prompt shown, created when the
 * ticket is opened at checkout), their answers, what happens to them when the ticket is paid, and
 * the rebook reminders asked for when a client didn't book.
 */

// analytics.ts is server-only, and checkout.ts loads this module in scripts and tests outside Next too.
const recordEvent: typeof import("./analytics").recordEvent = async (...a) => (await import("./analytics")).recordEvent(...a);

const PAID_STATUSES = ["paid", "partially_refunded", "refunded"] as const;
const NEXT_VISIT = ["booked", "confirmed"] as const;

// ───────────────────────────── Settings ─────────────────────────────

export async function loadPromptSettings(tx: DBorTx = db): Promise<CheckoutPromptSettings> {
  return promptSettings(await brandColumn("checkoutPrompts", null, tx));
}

/** The settings at one shop: its own (Setup → Sync status) or the brand's. */
export async function promptSettingsAt(shopId: string | null | undefined, tx: DBorTx = db): Promise<CheckoutPromptSettings> {
  const own = await localValue<unknown>("checkout_prompts", "brand", shopId, tx);
  return own ? promptSettings(own) : loadPromptSettings(tx);
}

export async function promptRules(tx: DBorTx = db): Promise<(PromptRule & { id: string })[]> {
  const rows = await tx.select().from(checkoutPromptRules).orderBy(asc(checkoutPromptRules.updatedAt));
  return rows.map((r) => ({ id: r.id, prompt: r.prompt, shopId: r.shopId, roleId: r.roleId, staffId: r.staffId, enabled: r.enabled }));
}

/** Turn a prompt on or off for one location or barber (a role's goes through the brand change scope); null removes the override so it follows the next level up. */
export async function setPromptRule(input: { prompt: string; target: RuleTarget; targetId: string; enabled: boolean | null }, actor: Actor) {
  if (!isPromptKind(input.prompt)) throw new AppError("bad_request", "Unknown prompt");
  const prompt = input.prompt;
  const col = { location: "shopId", role: "roleId", barber: "staffId" } as const;
  if (!(input.target in col)) throw new AppError("bad_request", "Pick a location, role or barber");
  if (input.target === "role") throw new AppError("bad_request", "A role's rule saves through the brand change scope, which picks its shops");
  const exists =
    input.target === "location"
      ? await db.query.shops.findFirst({ where: eq(shops.id, input.targetId), columns: { id: true } })
      : await db.query.staff.findFirst({ where: eq(staff.id, input.targetId), columns: { id: true } });
  if (!exists) throw notFound(input.target === "location" ? "Location" : "Barber");
  const target = { shopId: null as string | null, roleId: null as string | null, staffId: null as string | null, [col[input.target]]: input.targetId };
  const where = and(
    eq(checkoutPromptRules.prompt, prompt),
    target.shopId ? eq(checkoutPromptRules.shopId, target.shopId) : isNull(checkoutPromptRules.shopId),
    target.roleId ? eq(checkoutPromptRules.roleId, target.roleId) : isNull(checkoutPromptRules.roleId),
    target.staffId ? eq(checkoutPromptRules.staffId, target.staffId) : isNull(checkoutPromptRules.staffId),
  );
  if (input.enabled === null) await db.delete(checkoutPromptRules).where(where);
  else
    await db
      .insert(checkoutPromptRules)
      .values({ prompt, ...target, enabled: input.enabled, updatedBy: actor.staffId ?? null })
      .onConflictDoUpdate({ target: [checkoutPromptRules.prompt, checkoutPromptRules.shopId, checkoutPromptRules.roleId, checkoutPromptRules.staffId], set: { enabled: input.enabled, updatedBy: actor.staffId ?? null, updatedAt: new Date() } });
  await audit(
    actor,
    "checkout_prompts.rule",
    "checkout_prompt_rule",
    null,
    {
      prompt,
      target: input.target,
      targetId: input.targetId,
      enabled: input.enabled,
    },
    input.target === "location" ? input.targetId : null,
  );
}

/** Everything the settings page edits. */
export async function promptSetup() {
  const [settings, rules, svc, mapped, prods, shopRows, roleRows, barberRows] = await Promise.all([
    loadPromptSettings(),
    promptRules(),
    db.select({ id: services.id, name: services.name, category: services.category, rebookDays: services.rebookDays }).from(services).where(and(eq(services.kind, "service"), eq(services.active, true))).orderBy(asc(services.sortOrder), asc(services.name)),
    db.select().from(serviceProductSuggestions).orderBy(asc(serviceProductSuggestions.sortOrder)),
    db.select({ id: products.id, name: products.name, brand: products.brand }).from(products).where(eq(products.active, true)).orderBy(asc(products.brand), asc(products.name)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(sql`${shops.status} <> 'archived'`).orderBy(asc(shops.name)),
    db.select({ id: roles.id, name: roles.name }).from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db.select({ id: staff.id, name: staff.displayLabel }).from(staff).where(and(eq(staff.active, true), isNull(staff.removedAt), eq(staff.kind, "person"))).orderBy(asc(staff.displayLabel)),
  ]);
  return {
    settings,
    rules,
    services: svc.map((s) => ({ ...s, productIds: mapped.filter((m) => m.serviceId === s.id).map((m) => m.productId) })),
    products: prods,
    shops: shopRows,
    roles: roleRows,
    barbers: barberRows,
  };
}

// ───────────────────────────── Products used ─────────────────────────────

async function openSale(saleId: string, tx: DBorTx = db) {
  const sale = await tx.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  if (sale.status !== "open") throw new AppError("conflict", "This ticket is closed");
  return sale;
}

/** A product the barber used in the service, tagged on the ticket. It isn't sold, so stock doesn't move. */
export async function tagUsedProduct(saleId: string, productId: string, actor: Actor, appointmentId: string | null = null) {
  const sale = await openSale(saleId);
  const p = await db.query.products.findFirst({ where: eq(products.id, productId), columns: { id: true, name: true } });
  if (!p) throw notFound("Product");
  if (appointmentId && appointmentId !== sale.appointmentId && !(await ticketAppointmentIds(saleId)).includes(appointmentId)) throw new AppError("bad_request", "That person isn't on this ticket");
  await db
    .insert(saleUsedProducts)
    .values({ saleId, productId, appointmentId: appointmentId ?? sale.appointmentId, taggedBy: actor.staffId ?? null })
    .onConflictDoNothing({ target: [saleUsedProducts.saleId, saleUsedProducts.productId] });
  await audit(actor, "sale.product_used", "sale", saleId, { productId, product: p.name }, sale.shopId);
}

export async function untagUsedProduct(saleId: string, productId: string, actor: Actor) {
  const sale = await openSale(saleId);
  await db.delete(saleUsedProducts).where(and(eq(saleUsedProducts.saleId, saleId), eq(saleUsedProducts.productId, productId)));
  await audit(actor, "sale.product_used_removed", "sale", saleId, { productId }, sale.shopId);
}

export async function usedProducts(saleId: string) {
  return db
    .select({ productId: saleUsedProducts.productId, name: products.name, brand: products.brand })
    .from(saleUsedProducts)
    .innerJoin(products, eq(products.id, saleUsedProducts.productId))
    .where(eq(saleUsedProducts.saleId, saleId))
    .orderBy(asc(saleUsedProducts.createdAt));
}

// ───────────────────────────── The prompts on a ticket ─────────────────────────────

type PromptRow = typeof checkoutPrompts.$inferSelect;
type Sale = typeof sales.$inferSelect;

export interface PromptView<S> {
  id: string;
  prompt: PromptKind;
  required: boolean;
  outcome: PromptOutcome | null;
  skipped: boolean;
  declineReason: string | null;
  suggested: S;
  addedProductIds: string[];
  booked: { appointmentId: string; customerId: string | null; name: string; startsAt: string; barber: string }[];
  reminderAt: string | null;
}

export interface TicketPrompts {
  rebook: PromptView<RebookSuggested> | null;
  product: PromptView<ProductSuggested> | null;
  /** People on the ticket whose next visit is already booked (no rebook prompt for them). */
  nextVisits: { customerId: string; name: string; startsAt: string; barber: string }[];
  used: { productId: string; name: string; brand: string }[];
  reasons: string[];
  reminders: boolean;
  /** Required prompts still to answer before payment. */
  waiting: PromptKind[];
  /** Whether each prompt is on for this ticket and whoever has it open. */
  enabled: Record<PromptKind, boolean>;
  /** What the ticket's client has bought (every location), for the product prompt's last purchase and buy again. */
  history: ProductHistory | null;
}

/** Clients' next visits booked after today, apart from what's on this ticket. */
async function nextVisitsOf(customerIds: string[], exclude: string[], now: Date, tx: DBorTx = db) {
  if (!customerIds.length) return [];
  return tx
    .select({ appointmentId: appointments.id, customerId: appointments.customerId, startsAt: appointments.startsAt, createdAt: appointments.createdAt, barber: staff.displayLabel, first: customers.firstName, last: customers.lastName })
    .from(appointments)
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .leftJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      and(
        inArray(appointments.customerId, customerIds),
        inArray(appointments.status, [...NEXT_VISIT]),
        gte(appointments.startsAt, startOfLocalDay(addDays(todayLocal(now), 1))),
        exclude.length ? notInArray(appointments.id, exclude) : sql`true`,
      ),
    )
    .orderBy(asc(appointments.startsAt));
}

interface Person {
  customerId: string;
  name: string;
  isChild: boolean;
  appointmentId: string | null;
  staffId: string;
  staffName: string;
  startsAt: Date;
  serviceId: string;
  serviceName: string;
  addonIds: string[];
  priceCents: number;
}

/** Everyone on the ticket with a client and a service, the ticket's own appointment first. A ticket rung up without one uses its client, barber and service lines. */
async function ticketClients(sale: Sale, now: Date): Promise<Person[]> {
  const people = (await ticketPeople(sale)).filter((p) => p.customerId && p.staffId);
  const items = people.length ? await db.select().from(appointmentItems).where(inArray(appointmentItems.appointmentId, people.map((p) => p.appointmentId))) : [];
  const out: Person[] = [];
  for (const p of people) {
    const own = items.filter((i) => i.appointmentId === p.appointmentId);
    const main = own.find((i) => i.kind === "service" && i.serviceId);
    if (!main) continue;
    out.push({
      customerId: p.customerId!,
      name: p.name,
      isChild: p.isChild,
      appointmentId: p.appointmentId,
      staffId: p.staffId!,
      staffName: p.staffName ?? "Barber",
      startsAt: p.startsAt,
      serviceId: main.serviceId!,
      serviceName: main.name,
      addonIds: own.filter((i) => i.kind === "addon" && i.serviceId).map((i) => i.serviceId!),
      priceCents: own.reduce((a, i) => a + i.priceCents, 0),
    });
  }
  if (out.length || !sale.customerId || !sale.staffId) return out;
  const lines = await db.select().from(saleItems).where(eq(saleItems.saleId, sale.id));
  const main = lines.find((l) => l.kind === "service" && l.refId);
  if (!main) return out;
  const [c] = await db.select({ first: customers.firstName, last: customers.lastName, guardianId: customers.guardianId }).from(customers).where(eq(customers.id, sale.customerId));
  const [b] = await db.select({ label: staff.displayLabel }).from(staff).where(eq(staff.id, sale.staffId));
  return [
    {
      customerId: sale.customerId,
      name: clientName(c?.first, maskLastName(c?.last)) || "Client",
      isChild: !!c?.guardianId,
      appointmentId: null,
      staffId: sale.staffId,
      staffName: b?.label ?? "Barber",
      startsAt: sale.createdAt ?? now,
      serviceId: main.refId!,
      serviceName: main.name,
      addonIds: lines.filter((l) => l.kind === "addon" && l.refId).map((l) => l.refId!),
      priceCents: lines.filter((l) => l.kind === "service" || l.kind === "addon").reduce((a, l) => a + l.unitPriceCents * l.qty, 0),
    },
  ];
}

const iso = (t: number | Date) => new Date(t).toISOString();

/** Times to offer: the same barber (each person's own, for a family), near the time they came in, around the date they'd be due. */
async function rebookOptions(shopId: string, people: Person[], target: LocalDate, n: number, now: Date): Promise<{ options: RebookOption[]; reason: string | null }> {
  const lead = people[0];
  const prefer = localMinutesOf(lead.startsAt);
  const found: DayChoices<RebookOption>[] = [];
  let reason: string | null = null;
  const { optionsFor } = people.length > 1 ? await import("./booking-groups") : { optionsFor: null };
  for (const date of candidateDays(target, addDays(todayLocal(now), 1))) {
    if (found.length >= n) break;
    try {
      let options: RebookOption[];
      if (people.length === 1) {
        const day = await dayOpenings({ shopRef: shopId, date, serviceId: lead.serviceId, addonIds: lead.addonIds, barberRef: lead.staffId, now, staffOverride: true });
        const seen = new Set<number>();
        options = day.openings
          .filter((o) => o.staffId === lead.staffId && !seen.has(o.start) && seen.add(o.start))
          .map((o) => ({ date, startsAt: iso(o.start), endsAt: iso(o.end), seats: [{ customerId: lead.customerId, staffId: o.staffId, startsAt: iso(o.start), endsAt: iso(o.end) }] }));
        if (!options.length && day.reason && day.reason !== "No openings on this day") reason = day.reason;
      } else {
        const { results } = await optionsFor!(
          shopId,
          date,
          people.map((p) => ({ customerId: p.customerId, serviceId: p.serviceId, addonIds: p.addonIds, staffId: p.staffId })),
          { staff: true, now },
        );
        const seen = new Set<string>();
        options = results
          .flatMap((r) => r.options)
          .filter((o) => {
            const k = o.seats.map((s) => `${s.customerId}:${s.staffId}:${s.start}`).join("|");
            return !seen.has(k) && !!seen.add(k);
          })
          .map((o) => ({ date, startsAt: iso(o.start), endsAt: iso(o.end), plan: o.plan, seats: o.seats.map((s) => ({ customerId: s.customerId, staffId: s.staffId, startsAt: iso(s.start), endsAt: iso(s.end) })) }));
      }
      if (options.length) found.push({ date, options: options.map((o) => ({ ...o, minute: localMinutesOf(o.startsAt) })) });
    } catch (e) {
      // A barber who no longer works here, or a service that's gone: nothing to offer, and why.
      if (e instanceof AppError) return { options: [], reason: e.message };
      throw e;
    }
  }
  const picked = pickTimes(found, prefer, n).map(({ minute: _m, ...o }) => o as RebookOption);
  return { options: picked, reason: picked.length ? null : (reason ?? `No openings with ${lead.staffName} within a week of ${target}`) };
}

async function rebookSuggestion(sale: Sale, settings: CheckoutPromptSettings, now: Date): Promise<{ suggested: RebookSuggested | null; nextVisits: TicketPrompts["nextVisits"] }> {
  const everyone = await ticketClients(sale, now);
  if (!everyone.length) return { suggested: null, nextVisits: [] };
  const onTicket = [sale.appointmentId, ...(await ticketAppointmentIds(sale.id))].filter((x): x is string => !!x);
  const next = await nextVisitsOf([...new Set(everyone.map((p) => p.customerId))], onTicket, now);
  const nextVisits = everyone.flatMap((p) => {
    const v = next.find((x) => x.customerId === p.customerId);
    return v ? [{ customerId: p.customerId, name: p.name, startsAt: v.startsAt.toISOString(), barber: v.barber }] : [];
  });
  let people = everyone.filter((p) => !next.some((x) => x.customerId === p.customerId));
  people = people.filter((p, i) => people.findIndex((x) => x.customerId === p.customerId) === i);
  if (!people.length) return { suggested: null, nextVisits };
  if (people.length > 1) {
    const household = new Set(await householdIds(people[0].customerId));
    if (!people.every((p) => household.has(p.customerId))) people = [people[0]];
  }
  const lead = people[0];
  const { cadenceFor } = await import("./visit-cadence");
  const [cadence, rules] = await Promise.all([
    cadenceFor([lead.customerId], now),
    suggestAt(sale.shopId, [lead.serviceId]),
  ]);
  const interval = rebookInterval({
    cadenceDays: cadence.get(lead.customerId)?.cadenceDays,
    serviceDays: rules.get(lead.serviceId)?.rebookDays,
    defaultDays: settings.rebook.defaultDays,
  });
  const visitDate = localDateOf(lead.startsAt);
  const targetDate = addDays(visitDate, interval.days);
  const { options, reason } = await rebookOptions(sale.shopId, people, targetDate, settings.rebook.options, now);
  const persons: RebookPerson[] = people.map((p) => ({ customerId: p.customerId, name: p.name, isChild: p.isChild, appointmentId: p.appointmentId, staffId: p.staffId, staffName: p.staffName, serviceId: p.serviceId, addonIds: p.addonIds, serviceName: p.serviceName }));
  return {
    suggested: { kind: "rebook", intervalDays: interval.days, intervalSource: interval.source, visitDate, targetDate, people: persons, options, reason, estimateCents: people.reduce((a, p) => a + p.priceCents, 0) },
    nextVisits,
  };
}

async function productSuggestion(sale: Sale, settings: CheckoutPromptSettings, history: ProductHistory | null): Promise<ProductSuggested | null> {
  const onTicket = [sale.appointmentId, ...(await ticketAppointmentIds(sale.id))].filter((x): x is string => !!x);
  const [used, lines, apptItems, levels, people] = await Promise.all([
    db.select({ productId: saleUsedProducts.productId }).from(saleUsedProducts).where(eq(saleUsedProducts.saleId, sale.id)).orderBy(asc(saleUsedProducts.createdAt)),
    db.select().from(saleItems).where(eq(saleItems.saleId, sale.id)),
    onTicket.length ? db.select({ serviceId: appointmentItems.serviceId }).from(appointmentItems).where(inArray(appointmentItems.appointmentId, onTicket)) : [],
    stockLevels([sale.shopId]),
    onTicket.length ? db.select({ id: appointments.customerId }).from(appointments).where(inArray(appointments.id, onTicket)) : [],
  ]);
  const serviceIds = [...new Set([...lines.filter((l) => (l.kind === "service" || l.kind === "addon") && l.refId).map((l) => l.refId!), ...apptItems.map((i) => i.serviceId).filter((x): x is string => !!x)])];
  const clients = [...new Set([sale.customerId, ...people.map((p) => p.id)].filter((x): x is string => !!x))];
  const [mapped, past] = await Promise.all([
    suggestAt(sale.shopId, serviceIds).then((m) =>
      [...m.values()].flatMap((r) =>
        r.productIds.map((productId, i) => ({
          productId,
          sortOrder: (i + 1) * 10,
        })),
      ),
    ),
    settings.product.pastPurchases && clients.length
      ? db
          .select({ productId: sql<string>`${saleItems.refId}`, times: sql<number>`count(distinct ${sales.id})::int`, lastAt: sql<string>`max(coalesce(${sales.paidAt}, ${sales.createdAt}))` })
          .from(saleItems)
          .innerJoin(sales, eq(sales.id, saleItems.saleId))
          .where(and(inArray(sales.customerId, clients), inArray(sales.status, [...PAID_STATUSES]), eq(saleItems.kind, "product"), sql`${saleItems.refId} is not null`))
          .groupBy(saleItems.refId)
      : [],
  ]);
  const carried = levels.filter((l) => l.active);
  const own = new Map<string, number>();
  for (const l of lines) if (l.kind === "product" && l.refId) own.set(l.refId, (own.get(l.refId) ?? 0) + l.qty);
  const refill = new Map((history?.refills ?? []).map((r) => [r.productId, r]));
  const picks = rankProducts({
    used: used.map((u) => u.productId),
    mapped,
    past: past.map((x) => ({ ...x, refill: refill.get(x.productId)?.status ?? null })),
    carried: new Set(carried.map((c) => c.productId)),
    max: settings.product.max,
  });
  if (!picks.length) return null;
  const list: ProductSuggestion[] = picks.map((p) => {
    const l = carried.find((c) => c.productId === p.productId)!;
    const available = l.available + (own.get(p.productId) ?? 0);
    const r = refill.get(p.productId);
    return { ...p, name: l.name, brand: l.brand, priceCents: l.priceCents, available, stock: stockStatus(available, l.levels.reorderPoint), refill: r?.status && r.due ? { status: r.status, due: r.due } : null };
  });
  return { kind: "product", products: list };
}

/** Whether each prompt shows for this ticket and whoever has it open, and how. */
async function enabledFor(sale: Sale, roleId: string | null, settings: CheckoutPromptSettings) {
  const rules = await promptRulesAt(await promptRules(), sale.shopId);
  const who = { shopId: sale.shopId, roleId, barberId: sale.staffId };
  return {
    rebook: resolvePrompt("rebook", settings.rebook.enabled, rules, who).enabled,
    product: resolvePrompt("product", settings.product.enabled, rules, who).enabled,
  };
}

async function upsertShown(sale: Sale, prompt: PromptKind, suggested: RebookSuggested | ProductSuggested, required: boolean, customerId: string | null, actor: Actor, now: Date, quantity: number): Promise<PromptRow> {
  const [row] = await db
    .insert(checkoutPrompts)
    .values({ saleId: sale.id, prompt, shopId: sale.shopId, staffId: sale.staffId, customerId, required, suggested: suggested as unknown as Record<string, unknown>, shownBy: actor.staffId ?? null, shownAt: now })
    .onConflictDoUpdate({
      target: [checkoutPrompts.saleId, checkoutPrompts.prompt],
      // A rebook answered stays as it was answered; the product list keeps up with what's tagged.
      set: {
        suggested: sql`case when ${checkoutPrompts.outcome} is null or ${checkoutPrompts.prompt} = 'product' then excluded.suggested else ${checkoutPrompts.suggested} end`,
        required: sql`case when ${checkoutPrompts.outcome} is null then excluded.required else ${checkoutPrompts.required} end`,
      },
    })
    .returning();
  await recordEvent({
    event: "prompt.shown",
    at: row.shownAt,
    key: `prompt:${row.id}:shown`,
    shop: sale.shopId,
    staff: sale.staffId,
    customer: customerId,
    actor: actor.staffId ?? null,
    actorKind: "staff",
    channel: "staff",
    entity: "checkout_prompt",
    entityId: row.id,
    appointment: sale.appointmentId,
    sale: sale.id,
    quantity,
    subtype: prompt,
    props: { required: row.required },
  });
  return row;
}

async function viewOf<S>(row: PromptRow): Promise<PromptView<S>> {
  const booked = row.bookedAppointmentIds.length
    ? await db
        .select({ appointmentId: appointments.id, customerId: appointments.customerId, startsAt: appointments.startsAt, barber: staff.displayLabel, first: customers.firstName })
        .from(appointments)
        .innerJoin(staff, eq(staff.id, appointments.staffId))
        .leftJoin(customers, eq(customers.id, appointments.customerId))
        .where(inArray(appointments.id, row.bookedAppointmentIds))
        .orderBy(asc(appointments.startsAt))
    : [];
  const reminder = row.reminderId ? await db.query.rebookReminders.findFirst({ where: eq(rebookReminders.id, row.reminderId) }) : null;
  return {
    id: row.id,
    prompt: row.prompt,
    required: row.required,
    outcome: row.outcome,
    skipped: row.skipped,
    declineReason: row.declineReason,
    suggested: row.suggested as unknown as S,
    addedProductIds: row.addedProductIds,
    booked: booked.map((b) => ({ appointmentId: b.appointmentId, customerId: b.customerId, name: b.first ?? "Client", startsAt: b.startsAt.toISOString(), barber: b.barber })),
    reminderAt: reminder && reminder.status === "scheduled" ? reminder.runAt.toISOString() : null,
  };
}

/**
 * The prompts for a ticket at checkout. The first time each shows it's saved (with what it
 * suggested) and logged as shown; once a prompt is on a ticket it stays, whoever opens it next.
 */
export async function promptsForTicket(saleId: string, who: { roleId: string | null; actor: Actor }, now = new Date()): Promise<TicketPrompts> {
  const sale = await db.query.sales.findFirst({ where: eq(sales.id, saleId) });
  if (!sale) throw notFound("Sale");
  const settings = await promptSettingsAt(sale.shopId);
  const existing = await db.select().from(checkoutPrompts).where(eq(checkoutPrompts.saleId, saleId));
  const has = (k: PromptKind) => existing.find((r) => r.prompt === k) ?? null;
  const on = sale.status === "open" ? await enabledFor(sale, who.roleId, settings) : { rebook: false, product: false };

  let rebookRow = has("rebook");
  let nextVisits: TicketPrompts["nextVisits"] = [];
  if (sale.status === "open" && (on.rebook || rebookRow) && !rebookRow?.outcome) {
    const r = await rebookSuggestion(sale, settings, now);
    nextVisits = r.nextVisits;
    if (r.suggested) rebookRow = await upsertShown(sale, "rebook", r.suggested, settings.rebook.mode === "acknowledge", r.suggested.people[0].customerId, who.actor, now, r.suggested.options.length);
  }
  const history = sale.customerId ? await clientProductHistory(sale.customerId, now) : null;
  let productRow = has("product");
  if (sale.status === "open" && (on.product || productRow)) {
    const s = await productSuggestion(sale, settings, history);
    if (s) productRow = await upsertShown(sale, "product", s, settings.product.mode === "acknowledge", sale.customerId, who.actor, now, s.products.length);
  }
  const [rebook, product, used] = await Promise.all([
    rebookRow ? viewOf<RebookSuggested>(rebookRow) : null,
    productRow ? viewOf<ProductSuggested>(productRow) : null,
    usedProducts(saleId),
  ]);
  const booked = rebook ? (await nextVisitsOf(rebook.suggested.people.map((p) => p.customerId), [], now)).length > 0 : false;
  return {
    rebook,
    product,
    nextVisits,
    used,
    reasons: settings.rebook.reasons,
    reminders: settings.rebook.reminders,
    waiting: unansweredRequired([rebook, product].filter((x): x is NonNullable<typeof x> => !!x), { booked }),
    enabled: on,
    history,
  };
}

async function promptOn(saleId: string, promptId: string, kind: PromptKind) {
  const row = await db.query.checkoutPrompts.findFirst({ where: and(eq(checkoutPrompts.id, promptId), eq(checkoutPrompts.saleId, saleId), eq(checkoutPrompts.prompt, kind)) });
  if (!row) throw notFound("Prompt");
  const sale = await openSale(saleId);
  return { row, sale };
}

function event(row: PromptRow, e: "prompt.accepted" | "prompt.declined", actor: Actor, at: Date, extra: Partial<Parameters<typeof recordEvent>[0]> = {}, tx: DBorTx = db) {
  return recordEvent(
    {
      event: e,
      at,
      key: `prompt:${row.id}:${e === "prompt.accepted" ? "accepted" : "declined"}`,
      shop: row.shopId,
      staff: row.staffId,
      customer: row.customerId,
      actor: actor.staffId ?? null,
      actorKind: actor.staffId ? "staff" : "system",
      channel: "staff",
      entity: "checkout_prompt",
      entityId: row.id,
      sale: row.saleId,
      subtype: row.prompt,
      ...extra,
      props: { required: row.required, ...(extra.props ?? {}) },
    },
    tx,
  );
}

/** One tap: book the time picked, for everyone the prompt covers (a family together, in one go). */
export async function acceptRebook(saleId: string, promptId: string, pick: { index: number; startsAt: string }, actor: Actor, now = new Date()) {
  const { row, sale } = await promptOn(saleId, promptId, "rebook");
  if (row.outcome === "accepted") throw new AppError("conflict", "The next visit is already booked");
  const s = row.suggested as unknown as RebookSuggested;
  const option = s.options[pick.index];
  if (!option) throw new AppError("bad_request", "Pick one of the times offered");
  if (option.startsAt !== pick.startsAt) throw new AppError("conflict", "The times on offer changed. Review them again.");
  // Claim the prompt first, so a second tap can't book twice; put it back if the booking fails.
  const [claimed] = await db
    .update(checkoutPrompts)
    .set({ outcome: "accepted", answeredAt: now, answeredBy: actor.staffId ?? null })
    .where(and(eq(checkoutPrompts.id, row.id), sql`${checkoutPrompts.outcome} is distinct from 'accepted'`))
    .returning({ id: checkoutPrompts.id });
  if (!claimed) throw new AppError("conflict", "The next visit is already booked");
  let bookedIds: string[];
  try {
    if (option.seats.length === 1) {
      const seat = option.seats[0];
      const p = s.people.find((x) => x.customerId === seat.customerId)!;
      const a = await createAppointment({ shopRef: sale.shopId, serviceId: p.serviceId, addonIds: p.addonIds, barberRef: seat.staffId, startsAt: seat.startsAt, customerId: p.customerId, source: "rebook", rebookedFromId: p.appointmentId, actor, now, idempotencyKey: `rebook-prompt-${row.id}-${option.startsAt}` });
      bookedIds = [a.id];
    } else {
      const { bookGroup } = await import("./booking-groups");
      const g = await bookGroup(
        { shopId: sale.shopId, plan: option.plan ?? "custom", people: s.people.map((p) => ({ customerId: p.customerId, serviceId: p.serviceId, addonIds: p.addonIds, staffId: p.staffId })), seats: option.seats.map((x) => ({ customerId: x.customerId, staffId: x.staffId, startsAt: x.startsAt })) },
        { guardianId: await householdHead(s.people[0].customerId), source: "staff", actor, now, idempotencyKey: `rebook-prompt-${row.id}-${option.startsAt}`, rebookedFrom: Object.fromEntries(s.people.map((p) => [p.customerId, p.appointmentId])) },
      );
      bookedIds = g.members.map((m) => m.appointmentId);
    }
  } catch (e) {
    await db
      .update(checkoutPrompts)
      .set({ outcome: row.outcome, answeredAt: row.answeredAt, answeredBy: row.answeredBy })
      .where(eq(checkoutPrompts.id, row.id));
    throw e;
  }
  await db.transaction(async (tx) => {
    await tx.update(checkoutPrompts).set({ bookedAppointmentIds: bookedIds, declineReason: null, reminderId: null }).where(eq(checkoutPrompts.id, row.id));
    if (row.reminderId) await tx.update(rebookReminders).set({ status: "cancelled", outcome: "booked" }).where(and(eq(rebookReminders.id, row.reminderId), eq(rebookReminders.status, "scheduled")));
    await audit(actor, "checkout_prompt.rebooked", "sale", saleId, { promptId: row.id, appointments: bookedIds, startsAt: option.startsAt }, sale.shopId, tx);
    await event(row, "prompt.accepted", actor, now, { quantity: bookedIds.length, amount: s.estimateCents, appointment: bookedIds[0] }, tx);
  });
  return { appointmentIds: bookedIds, startsAt: option.startsAt };
}

/** "Not now": an optional reason from the brand's list, and for the rebook prompt, an optional reminder to book. */
export async function declinePrompt(saleId: string, promptId: string, input: { reason?: string | null; remind?: boolean }, actor: Actor, now = new Date()) {
  const row = await db.query.checkoutPrompts.findFirst({ where: and(eq(checkoutPrompts.id, promptId), eq(checkoutPrompts.saleId, saleId)) });
  if (!row) throw notFound("Prompt");
  const sale = await openSale(saleId);
  if (row.outcome === "accepted") throw new AppError("conflict", row.prompt === "rebook" ? "The next visit is already booked; cancel it from the calendar instead" : "A suggested product is already on the ticket; take it off the ticket instead");
  const settings = await promptSettingsAt(sale.shopId);
  const reason = row.prompt === "rebook" ? input.reason?.trim() || null : null;
  const problem = reasonProblem(reason, settings.rebook.reasons);
  if (problem) throw new AppError("bad_request", problem);
  const s = row.suggested as unknown as RebookSuggested;
  const remind = row.prompt === "rebook" && !!input.remind && settings.rebook.reminders && !!row.customerId && !row.reminderId;
  await db.transaction(async (tx) => {
    let reminderId = row.reminderId;
    if (remind) {
      const lead = s.people[0];
      const day = reminderDay(s.targetDate, settings.rebook.reminderLeadDays, todayLocal(now));
      const [r] = await tx
        .insert(rebookReminders)
        .values({ customerId: row.customerId!, shopId: sale.shopId, staffId: lead?.staffId ?? sale.staffId, serviceId: lead?.serviceId ?? null, saleId, runAt: zonedWallTime(day, REMINDER_HOUR * 60).toJSDate(), createdBy: actor.staffId ?? null })
        .returning({ id: rebookReminders.id });
      reminderId = r.id;
    }
    await tx.update(checkoutPrompts).set({ outcome: "declined", answeredAt: now, answeredBy: actor.staffId ?? null, declineReason: reason, reminderId }).where(eq(checkoutPrompts.id, row.id));
    await event(row, "prompt.declined", actor, now, { reason, value: row.prompt === "rebook" ? (reminderId ? 1 : 0) : null }, tx);
  });
}

/** One tap on a suggested product: the screen puts it on the ticket; this records that the prompt sold it. */
export async function addPromptProduct(saleId: string, promptId: string, productId: string, actor: Actor, now = new Date()) {
  const { row } = await promptOn(saleId, promptId, "product");
  const s = row.suggested as unknown as ProductSuggested;
  const p = s.products.find((x) => x.productId === productId);
  if (!p) throw new AppError("bad_request", "That product isn't one of the suggestions");
  await db.transaction(async (tx) => {
    await tx
      .update(checkoutPrompts)
      .set({
        addedProductIds: sql`case when ${productId}::uuid = any(${checkoutPrompts.addedProductIds}) then ${checkoutPrompts.addedProductIds} else array_append(${checkoutPrompts.addedProductIds}, ${productId}::uuid) end`,
        outcome: "accepted",
        answeredAt: sql`case when ${checkoutPrompts.outcome} = 'accepted' then ${checkoutPrompts.answeredAt} else ${now.toISOString()}::timestamptz end`,
        answeredBy: sql`case when ${checkoutPrompts.outcome} = 'accepted' then ${checkoutPrompts.answeredBy} else ${actor.staffId ?? null}::uuid end`,
      })
      .where(eq(checkoutPrompts.id, row.id));
    await event(row, "prompt.accepted", actor, now, { key: `prompt:${row.id}:accepted:${productId}`, quantity: 1, amount: p.priceCents, props: { product: productId } }, tx);
  });
}

/** Refuses payment while a prompt the brand made required is unanswered (a rebook counts once the client has a next visit). */
export async function assertPromptsAnswered(saleId: string, now = new Date()) {
  const rows = await db.select().from(checkoutPrompts).where(and(eq(checkoutPrompts.saleId, saleId), eq(checkoutPrompts.required, true), isNull(checkoutPrompts.outcome)));
  if (!rows.length) return;
  const rebook = rows.find((r) => r.prompt === "rebook");
  const people = rebook ? (rebook.suggested as unknown as RebookSuggested).people.map((p) => p.customerId) : [];
  const booked = people.length ? (await nextVisitsOf(people, [], now)).length > 0 : false;
  const waiting = unansweredRequired(rows, { booked });
  if (waiting.length) throw new AppError("bad_request", requiredMessage(waiting));
}

/**
 * When the ticket is paid: a prompt nobody answered counts as declined (skipped), or as accepted
 * when the client's next visit was booked some other way while it was up; a product prompt keeps
 * which of the products it added were paid for, and for how much.
 */
export async function settlePrompts(saleId: string, actor: Actor, now = new Date()) {
  const rows = await db.select().from(checkoutPrompts).where(eq(checkoutPrompts.saleId, saleId));
  if (!rows.length) return;
  const lines = await db.select({ refId: saleItems.refId, kind: saleItems.kind, netCents: saleItems.netCents }).from(saleItems).where(eq(saleItems.saleId, saleId));
  for (const row of rows) {
    if (row.prompt === "product") {
      const paid = [...new Set(row.addedProductIds.filter((id) => lines.some((l) => l.kind === "product" && l.refId === id)))];
      const cents = lines.filter((l) => l.kind === "product" && l.refId && paid.includes(l.refId)).reduce((a, l) => a + l.netCents, 0);
      await db.update(checkoutPrompts).set({ paidProductIds: paid, paidProductCents: cents }).where(eq(checkoutPrompts.id, row.id));
    }
    if (row.outcome) continue;
    if (row.prompt === "rebook") {
      const s = row.suggested as unknown as RebookSuggested;
      const since = (await nextVisitsOf(s.people.map((p) => p.customerId), [], now)).filter((v) => v.createdAt >= row.shownAt);
      if (since.length) {
        const ids = since.map((v) => v.appointmentId);
        await db.update(checkoutPrompts).set({ outcome: "accepted", answeredAt: now, answeredBy: actor.staffId ?? null, bookedAppointmentIds: ids }).where(and(eq(checkoutPrompts.id, row.id), isNull(checkoutPrompts.outcome)));
        await event(row, "prompt.accepted", actor, now, { quantity: ids.length, amount: s.estimateCents, appointment: ids[0], props: { elsewhere: true } });
        continue;
      }
    }
    const [done] = await db
      .update(checkoutPrompts)
      .set({ outcome: "declined", skipped: true, answeredAt: now, answeredBy: actor.staffId ?? null })
      .where(and(eq(checkoutPrompts.id, row.id), isNull(checkoutPrompts.outcome)))
      .returning({ id: checkoutPrompts.id });
    if (done) await event(row, "prompt.declined", actor, now, { value: row.prompt === "rebook" ? 0 : null, props: { skipped: true } });
  }
}

// ───────────────────────────── Rebook reminders ─────────────────────────────

/**
 * Rebook reminders that are due: dropped when the client has booked since, otherwise one message on
 * each channel they agreed to (a child's goes to their parent), from the shop with its booking link.
 */
export async function sendDueRebookReminders(now = new Date(), limit = 200) {
  const due = await db
    .select({ r: rebookReminders, shopName: shops.name, shopSlug: shops.slug, shopPhone: shops.phone, barber: staff.displayLabel, firstName: customers.firstName })
    .from(rebookReminders)
    .innerJoin(shops, eq(shops.id, rebookReminders.shopId))
    .innerJoin(customers, eq(customers.id, rebookReminders.customerId))
    .leftJoin(staff, eq(staff.id, rebookReminders.staffId))
    .where(and(eq(rebookReminders.status, "scheduled"), lte(rebookReminders.runAt, now)))
    .orderBy(asc(rebookReminders.runAt))
    .limit(limit);
  const stats = { queued: 0, booked: 0, noContact: 0 };
  if (!due.length) return stats;
  const templates = new Map<string, Awaited<ReturnType<typeof savedTemplates>>>();
  for (const { r, shopName, shopSlug, shopPhone, barber, firstName } of due) {
    if (!templates.has(r.shopId)) templates.set(r.shopId, await savedTemplates(r.shopId));
    const template = templateFor("rebook_reminder", templates.get(r.shopId));
    const booked = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.customerId, r.customerId), inArray(appointments.status, [...NEXT_VISIT, "checked_in", "in_service"]), gte(appointments.startsAt, r.createdAt)))
      .limit(1);
    if (booked.length) {
      await db.update(rebookReminders).set({ status: "cancelled", outcome: "booked" }).where(and(eq(rebookReminders.id, r.id), eq(rebookReminders.status, "scheduled")));
      stats.booked++;
      continue;
    }
    const contact = await contactFor(db, r.customerId);
    const to = [...(contact?.phone && contact.smsOptIn ? [{ channel: "sms" as const, to: contact.phone }] : []), ...(contact?.email && contact.emailOptIn ? [{ channel: "email" as const, to: contact.email }] : [])];
    if (!to.length) {
      await db.update(rebookReminders).set({ status: "skipped", outcome: "no_contact" }).where(and(eq(rebookReminders.id, r.id), eq(rebookReminders.status, "scheduled")));
      stats.noContact++;
      continue;
    }
    const values = { shop: `Ray'z ${shopName}`, first_name: firstName ?? "there", barber: barber ?? "your barber", book_link: `${appBaseUrl()}/book/${shopSlug}`, phone: shopPhone ? formatPhone(shopPhone) : "" };
    await db.transaction(async (tx) => {
      const [claimed] = await tx.update(rebookReminders).set({ status: "sent", outcome: "queued", sentAt: now }).where(and(eq(rebookReminders.id, r.id), eq(rebookReminders.status, "scheduled"))).returning({ id: rebookReminders.id });
      if (!claimed) return;
      await tx.insert(notificationJobs).values(
        to.map((x) => ({ customerId: r.customerId, shopId: r.shopId, kind: "rebook_reminder", channel: x.channel, to: x.to, subject: x.channel === "email" ? fill(template.subject, values) : null, body: fill(template.body, values), runAt: now })),
      );
      stats.queued++;
    });
  }
  return stats;
}

/** A client's reminders still to go, for the profile and the tests. */
export async function scheduledReminders(customerId: string) {
  return db.select().from(rebookReminders).where(and(eq(rebookReminders.customerId, customerId), eq(rebookReminders.status, "scheduled"))).orderBy(asc(rebookReminders.runAt));
}
