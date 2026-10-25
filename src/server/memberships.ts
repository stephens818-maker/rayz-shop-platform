import type Stripe from "stripe";
import { and, asc, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import { brandSettings, customers, membershipInvoices, membershipPlans, memberships, membershipUses, services, shops } from "@/db/schema";
import { MemberCoverage, PlanInput, periodEnd, planProblem, visitsLeft } from "@/domain/memberships";
import { appBaseUrl } from "@/lib/deployment";
import { todayLocal } from "@/lib/time";
import { Actor, SYSTEM, audit } from "./audit";
import { AppError, forbidden, notFound } from "./errors";
import { stripe } from "./payments/processor";
import { hasShop } from "./tenant";

export interface MembershipViewer {
  brandWide: boolean;
  shopIds: string[];
}

type Plan = typeof membershipPlans.$inferSelect;
type Membership = typeof memberships.$inferSelect;

const PAID = sql`('paid', 'partially_refunded')`;
const soldAt = (p: Pick<Plan, "shopIds">, shopId: string) => !p.shopIds.length || p.shopIds.includes(shopId);
const sees = (v: MembershipViewer, m: Pick<Membership, "homeShopId">) => v.brandWide || hasShop(v, m.homeShopId);

export async function membershipsEnabled(): Promise<boolean> {
  const [b] = await db.select({ on: brandSettings.membershipsEnabled }).from(brandSettings).limit(1);
  return !!b?.on;
}

export async function setMembershipsEnabled(actor: Actor, on: boolean) {
  await db.update(brandSettings).set({ membershipsEnabled: on, updatedAt: new Date() });
  await audit(actor, on ? "memberships.enable" : "memberships.disable", "brand_settings", null, {});
}

export async function listPlans() {
  const [plans, svc] = await Promise.all([
    db.select().from(membershipPlans).orderBy(desc(membershipPlans.active), asc(membershipPlans.priceCents)),
    db.select({ id: services.id, name: services.name }).from(services),
  ]);
  const name = new Map(svc.map((s) => [s.id, s.name]));
  return plans.map((p) => ({ ...p, serviceNames: p.serviceIds.map((id) => name.get(id) ?? "Removed service") }));
}

/** The plan's Stripe Product and a Price for its amount. Prices can't change in Stripe, so a new amount is a new Price. */
async function syncStripePrice(p: Plan): Promise<Pick<Plan, "stripeProductId" | "stripePriceId">> {
  const s = stripe();
  if (!s) return { stripeProductId: p.stripeProductId, stripePriceId: p.stripePriceId };
  const productId = p.stripeProductId ?? (await s.products.create({ name: p.name, metadata: { membership_plan_id: p.id } })).id;
  if (p.stripeProductId) await s.products.update(productId, { name: p.name, active: p.active });
  const current = p.stripePriceId ? await s.prices.retrieve(p.stripePriceId) : null;
  if (current && current.unit_amount === p.priceCents && current.product === productId) return { stripeProductId: productId, stripePriceId: current.id };
  const price = await s.prices.create({ product: productId, currency: "usd", unit_amount: p.priceCents, recurring: { interval: "month" }, metadata: { membership_plan_id: p.id } });
  if (current) await s.prices.update(current.id, { active: false });
  return { stripeProductId: productId, stripePriceId: price.id };
}

export async function savePlan(actor: Actor, id: string | null, raw: z.input<typeof PlanInput>) {
  const v = PlanInput.parse(raw);
  const problem = planProblem(v);
  if (problem) throw new AppError("bad_request", problem);
  if (v.serviceIds.length) {
    const found = await db.select({ id: services.id }).from(services).where(inArray(services.id, v.serviceIds));
    if (found.length !== new Set(v.serviceIds).size) throw notFound("Service");
  }
  const row = { ...v, description: v.description || null };
  const clash = await db.query.membershipPlans.findFirst({ where: sql`lower(${membershipPlans.name}) = lower(${v.name})` });
  if (clash && clash.id !== id) throw new AppError("conflict", "A plan with that name already exists");
  const before = id ? await db.query.membershipPlans.findFirst({ where: eq(membershipPlans.id, id) }) : null;
  if (id && !before) throw notFound("Plan");
  const [saved] = before
    ? await db.update(membershipPlans).set(row).where(eq(membershipPlans.id, before.id)).returning()
    : await db.insert(membershipPlans).values(row).returning();
  const ids = await syncStripePrice(saved);
  if (ids.stripePriceId !== saved.stripePriceId || ids.stripeProductId !== saved.stripeProductId) await db.update(membershipPlans).set(ids).where(eq(membershipPlans.id, saved.id));
  await audit(actor, before ? "membership_plan.update" : "membership_plan.create", "membership_plan", saved.id, { ...row, ...(before && before.priceCents !== v.priceCents ? { priceFrom: before.priceCents } : {}) });
  return { ...saved, ...ids };
}

async function usedThisPeriod(ids: string[], tx: DBorTx = db) {
  if (!ids.length) return new Map<string, number>();
  const rows = await tx
    .select({ id: membershipUses.membershipId, visits: sql<number>`coalesce(sum(${membershipUses.visits}), 0)::int` })
    .from(membershipUses)
    .innerJoin(memberships, and(eq(memberships.id, membershipUses.membershipId), eq(memberships.currentPeriodStart, membershipUses.periodStart)))
    .where(and(inArray(membershipUses.membershipId, ids), sql`exists (select 1 from sales s where s.id = ${membershipUses.saleId} and s.status in ${PAID})`))
    .groupBy(membershipUses.membershipId);
  return new Map(rows.map((r) => [r.id, r.visits]));
}

/** Live memberships of these clients that checkout at this shop can use. */
export async function checkoutCoverage(customerIds: string[], shopId: string): Promise<MemberCoverage[]> {
  const ids = [...new Set(customerIds.filter(Boolean))];
  if (!ids.length || !(await membershipsEnabled())) return [];
  const rows = await db
    .select({ m: memberships, p: membershipPlans, first: customers.firstName, last: customers.lastName })
    .from(memberships)
    .innerJoin(membershipPlans, eq(membershipPlans.id, memberships.planId))
    .innerJoin(customers, eq(customers.id, memberships.customerId))
    .where(and(inArray(memberships.customerId, ids), eq(memberships.status, "active")));
  const used = await usedThisPeriod(rows.map((r) => r.m.id));
  return rows
    .filter((r) => soldAt(r.p, shopId))
    .map(({ m, p, first, last }) => ({
      membershipId: m.id,
      customerId: m.customerId,
      memberName: `${first} ${last ?? ""}`.trim(),
      planName: p.name,
      serviceIds: p.serviceIds,
      visitsLeft: visitsLeft(p.visitsPerPeriod, used.get(m.id) ?? 0),
      productDiscountPct: p.productDiscountPct,
      periodStart: m.currentPeriodStart,
    }));
}

/** Records the visits a paid ticket used. Called inside checkout's transaction. */
export async function recordMembershipUse(tx: DBorTx, u: { membershipId: string; saleId: string; shopId: string; periodStart: string; visits: number; valueCents: number }, actor: Actor) {
  await tx.insert(membershipUses).values(u);
  await audit(actor, "membership.use", "membership", u.membershipId, { saleId: u.saleId, visits: u.visits, valueCents: u.valueCents }, u.shopId, tx);
}

export const EnrollInput = z.object({ planId: z.uuid(), customerId: z.uuid(), homeShopId: z.uuid() });

/**
 * Signs a client up. With Stripe keys it's a Stripe Billing subscription: the client pays the first month on
 * Stripe's hosted page (the link is texted or shown at the counter) and the webhook turns it on. Without keys
 * it starts at once and renews itself monthly.
 */
export async function enroll(actor: Actor, v: MembershipViewer, raw: z.input<typeof EnrollInput>) {
  const c = EnrollInput.parse(raw);
  if (!(await membershipsEnabled())) throw new AppError("bad_request", "Memberships are turned off for the brand");
  if (!hasShop(v, c.homeShopId)) throw forbidden("That shop is outside your access");
  const plan = await db.query.membershipPlans.findFirst({ where: eq(membershipPlans.id, c.planId) });
  if (!plan || !plan.active) throw notFound("Plan");
  if (!soldAt(plan, c.homeShopId)) throw new AppError("bad_request", `${plan.name} isn't sold at that shop`);
  const client = await db.query.customers.findFirst({ where: eq(customers.id, c.customerId) });
  if (!client) throw notFound("Client");
  const live = await db.query.memberships.findFirst({ where: and(eq(memberships.customerId, c.customerId), eq(memberships.planId, plan.id), ne(memberships.status, "canceled")) });
  if (live) throw new AppError("conflict", `${client.firstName} is already on ${plan.name}`);
  const s = stripe();
  const start = todayLocal();
  const created = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(memberships)
      .values({
        planId: plan.id,
        customerId: client.id,
        homeShopId: c.homeShopId,
        status: s ? "incomplete" : "active",
        billing: s ? "stripe" : "simulated",
        priceCents: plan.priceCents,
        currentPeriodStart: start,
        currentPeriodEnd: periodEnd(start),
        createdBy: actor.staffId ?? null,
      })
      .returning();
    if (!s) await tx.insert(membershipInvoices).values({ membershipId: m.id, periodStart: start, periodEnd: m.currentPeriodEnd, amountCents: plan.priceCents, status: "paid" });
    await audit(actor, "membership.enroll", "membership", m.id, { planId: plan.id, plan: plan.name, priceCents: plan.priceCents, billing: m.billing }, c.homeShopId, tx);
    return m;
  });
  if (!s) return { id: created.id, checkoutUrl: null };
  const priceId = plan.stripePriceId ?? (await syncStripePrice(plan)).stripePriceId;
  if (!priceId) throw new AppError("conflict", "The plan has no Stripe price yet");
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: created.id,
    metadata: { membership_id: created.id },
    subscription_data: { metadata: { membership_id: created.id } },
    success_url: `${appBaseUrl()}/book?membership=joined`,
    cancel_url: `${appBaseUrl()}/book`,
  });
  await db.update(memberships).set({ stripeCheckoutUrl: session.url }).where(eq(memberships.id, created.id));
  return { id: created.id, checkoutUrl: session.url };
}

export const CancelInput = z.object({ id: z.uuid(), when: z.enum(["now", "period_end"]), reason: z.string().trim().min(1, "Add a reason").max(300) });

export async function cancelMembership(actor: Actor, v: MembershipViewer, raw: z.input<typeof CancelInput>) {
  const c = CancelInput.parse(raw);
  const m = await db.query.memberships.findFirst({ where: eq(memberships.id, c.id) });
  if (!m) throw notFound("Membership");
  if (!sees(v, m)) throw forbidden("That membership belongs to a shop outside your access");
  if (m.status === "canceled") throw new AppError("conflict", "That membership is already canceled");
  const now = c.when === "now" || m.status === "incomplete";
  const s = m.billing === "stripe" && m.stripeSubscriptionId ? stripe() : null;
  if (s) {
    if (now) await s.subscriptions.cancel(m.stripeSubscriptionId!);
    else await s.subscriptions.update(m.stripeSubscriptionId!, { cancel_at_period_end: true });
  }
  await db
    .update(memberships)
    .set(now ? { status: "canceled", canceledAt: new Date(), cancelReason: c.reason, cancelAtPeriodEnd: false } : { cancelAtPeriodEnd: true, cancelReason: c.reason })
    .where(eq(memberships.id, m.id));
  await audit(actor, now ? "membership.cancel" : "membership.cancel_at_period_end", "membership", m.id, { reason: c.reason, periodEnd: m.currentPeriodEnd }, m.homeShopId);
}

/** Takes back a cancellation set for the end of the month. */
export async function keepMembership(actor: Actor, v: MembershipViewer, id: string) {
  const m = await db.query.memberships.findFirst({ where: eq(memberships.id, z.uuid().parse(id)) });
  if (!m) throw notFound("Membership");
  if (!sees(v, m)) throw forbidden("That membership belongs to a shop outside your access");
  if (m.status === "canceled" || !m.cancelAtPeriodEnd) throw new AppError("conflict", "That membership isn't set to cancel");
  if (m.billing === "stripe" && m.stripeSubscriptionId) await stripe()?.subscriptions.update(m.stripeSubscriptionId, { cancel_at_period_end: false });
  await db.update(memberships).set({ cancelAtPeriodEnd: false, cancelReason: null }).where(eq(memberships.id, m.id));
  await audit(actor, "membership.keep", "membership", m.id, {}, m.homeShopId);
}

/** Without Stripe keys, memberships renew themselves when their month is up; those set to cancel end. Idempotent per period. */
export async function renewSimulatedMemberships(now = new Date()) {
  const today = todayLocal(now);
  const due = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.billing, "simulated"), inArray(memberships.status, ["active", "past_due"]), lte(memberships.currentPeriodEnd, today)));
  let renewed = 0;
  let ended = 0;
  for (const m of due) {
    await db.transaction(async (tx) => {
      if (m.cancelAtPeriodEnd) {
        await tx.update(memberships).set({ status: "canceled", canceledAt: now, cancelAtPeriodEnd: false }).where(eq(memberships.id, m.id));
        await audit(SYSTEM, "membership.ended", "membership", m.id, { periodEnd: m.currentPeriodEnd }, m.homeShopId, tx);
        ended++;
        return;
      }
      let start = m.currentPeriodEnd;
      let end = periodEnd(start);
      while (end <= today) [start, end] = [end, periodEnd(end)];
      await tx.insert(membershipInvoices).values({ membershipId: m.id, periodStart: start, periodEnd: end, amountCents: m.priceCents, status: "paid" }).onConflictDoNothing();
      await tx.update(memberships).set({ status: "active", currentPeriodStart: start, currentPeriodEnd: end }).where(eq(memberships.id, m.id));
      renewed++;
    });
  }
  return { renewed, ended };
}

const dayOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const subIdOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

/** Stripe Billing events for memberships, from the brand account's webhook. Unknown subscriptions are ignored. */
export async function applyMembershipEvent(event: Stripe.Event): Promise<boolean> {
  if (event.type === "checkout.session.completed") {
    const s = event.data.object as Stripe.Checkout.Session;
    const id = s.metadata?.membership_id;
    const sub = subIdOf(s.subscription as string | Stripe.Subscription | null);
    if (s.mode !== "subscription" || !id || !sub) return false;
    const [m] = await db.update(memberships).set({ stripeSubscriptionId: sub, stripeCheckoutUrl: null }).where(eq(memberships.id, id)).returning();
    if (m) await audit(SYSTEM, "membership.subscribed", "membership", m.id, { eventId: event.id, stripeSubscriptionId: sub }, m.homeShopId);
    return !!m;
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const inv = event.data.object as Stripe.Invoice & { subscription?: string | { id: string } | null; parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null };
    const sub = subIdOf(inv.parent?.subscription_details?.subscription ?? inv.subscription);
    if (!sub) return false;
    const m = await db.query.memberships.findFirst({ where: eq(memberships.stripeSubscriptionId, sub) });
    if (!m) return false;
    const line = inv.lines?.data?.[0]?.period;
    const start = line ? dayOf(line.start) : m.currentPeriodStart;
    const end = line ? dayOf(line.end) : m.currentPeriodEnd;
    const paid = event.type === "invoice.paid";
    await db.transaction(async (tx) => {
      await tx
        .insert(membershipInvoices)
        .values({ membershipId: m.id, periodStart: start, periodEnd: end > start ? end : periodEnd(start), amountCents: paid ? inv.amount_paid : inv.amount_due, status: paid ? "paid" : "failed", stripeInvoiceId: inv.id, failureMessage: paid ? null : "Card declined" })
        .onConflictDoNothing();
      await tx
        .update(memberships)
        .set(paid ? { status: "active", currentPeriodStart: start, currentPeriodEnd: end > start ? end : periodEnd(start) } : { status: "past_due" })
        .where(and(eq(memberships.id, m.id), ne(memberships.status, "canceled")));
      await audit(SYSTEM, paid ? "membership.invoice_paid" : "membership.invoice_failed", "membership", m.id, { eventId: event.id, amountCents: paid ? inv.amount_paid : inv.amount_due }, m.homeShopId, tx);
    });
    return true;
  }
  if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    const m = await db.query.memberships.findFirst({ where: eq(memberships.stripeSubscriptionId, sub.id) });
    if (!m) return false;
    if (event.type === "customer.subscription.deleted") {
      await db.update(memberships).set({ status: "canceled", canceledAt: new Date(), cancelAtPeriodEnd: false }).where(eq(memberships.id, m.id));
      await audit(SYSTEM, "membership.ended", "membership", m.id, { eventId: event.id }, m.homeShopId);
    } else if (sub.cancel_at_period_end !== m.cancelAtPeriodEnd) {
      await db.update(memberships).set({ cancelAtPeriodEnd: sub.cancel_at_period_end }).where(eq(memberships.id, m.id));
    }
    return true;
  }
  return false;
}

/** Members at the person's shops (every shop brand-wide), with this month's visits and recent invoices. */
export async function membershipBoard(v: MembershipViewer, o: { status?: string; planId?: string } = {}) {
  const scope = v.brandWide ? undefined : v.shopIds.length ? inArray(memberships.homeShopId, v.shopIds) : sql`false`;
  const status = o.status === "all" ? undefined : o.status === "canceled" ? eq(memberships.status, "canceled") : o.status ? eq(memberships.status, o.status as Membership["status"]) : ne(memberships.status, "canceled");
  const rows = await db
    .select({ m: memberships, plan: membershipPlans.name, visitsPerPeriod: membershipPlans.visitsPerPeriod, shop: shops.name, first: customers.firstName, last: customers.lastName })
    .from(memberships)
    .innerJoin(membershipPlans, eq(membershipPlans.id, memberships.planId))
    .innerJoin(shops, eq(shops.id, memberships.homeShopId))
    .innerJoin(customers, eq(customers.id, memberships.customerId))
    .where(and(scope, status, o.planId ? eq(memberships.planId, o.planId) : undefined))
    .orderBy(desc(memberships.createdAt))
    .limit(300);
  const used = await usedThisPeriod(rows.map((r) => r.m.id));
  const [counts] = await db
    .select({
      active: sql<number>`count(*) filter (where ${memberships.status} = 'active')::int`,
      pastDue: sql<number>`count(*) filter (where ${memberships.status} = 'past_due')::int`,
      incomplete: sql<number>`count(*) filter (where ${memberships.status} = 'incomplete')::int`,
      ending: sql<number>`count(*) filter (where ${memberships.status} = 'active' and ${memberships.cancelAtPeriodEnd})::int`,
      mrr: sql<number>`coalesce(sum(${memberships.priceCents}) filter (where ${memberships.status} in ('active', 'past_due') and not ${memberships.cancelAtPeriodEnd}), 0)::int`,
      canceled30: sql<number>`count(*) filter (where ${memberships.canceledAt} > now() - interval '30 days')::int`,
    })
    .from(memberships)
    .where(scope);
  const invoices = await db
    .select({ i: membershipInvoices, first: customers.firstName, last: customers.lastName, plan: membershipPlans.name })
    .from(membershipInvoices)
    .innerJoin(memberships, eq(memberships.id, membershipInvoices.membershipId))
    .innerJoin(membershipPlans, eq(membershipPlans.id, memberships.planId))
    .innerJoin(customers, eq(customers.id, memberships.customerId))
    .where(scope)
    .orderBy(desc(membershipInvoices.createdAt))
    .limit(25);
  const [visits] = await db
    .select({ visits: sql<number>`coalesce(sum(${membershipUses.visits}), 0)::int`, value: sql<number>`coalesce(sum(${membershipUses.valueCents}), 0)::int` })
    .from(membershipUses)
    .innerJoin(memberships, eq(memberships.id, membershipUses.membershipId))
    .where(and(scope, sql`${membershipUses.createdAt} > now() - interval '30 days'`, sql`exists (select 1 from sales s where s.id = ${membershipUses.saleId} and s.status in ${PAID})`));
  return {
    stats: { ...counts, ...visits },
    members: rows.map(({ m, plan, visitsPerPeriod, shop, first, last }) => ({
      id: m.id,
      customerId: m.customerId,
      client: `${first} ${last ?? ""}`.trim(),
      plan,
      shop,
      status: m.status,
      billing: m.billing,
      priceCents: m.priceCents,
      periodStart: m.currentPeriodStart,
      periodEnd: m.currentPeriodEnd,
      cancelAtPeriodEnd: m.cancelAtPeriodEnd,
      cancelReason: m.cancelReason,
      checkoutUrl: m.status === "incomplete" ? m.stripeCheckoutUrl : null,
      used: used.get(m.id) ?? 0,
      visitsPerPeriod,
      createdAt: m.createdAt,
    })),
    invoices: invoices.map(({ i, first, last, plan }) => ({ ...i, client: `${first} ${last ?? ""}`.trim(), plan })),
  };
}

/** A client's memberships, for their profile and checkout. */
export async function clientMemberships(customerId: string) {
  return db
    .select({ id: memberships.id, plan: membershipPlans.name, status: memberships.status, periodEnd: memberships.currentPeriodEnd, cancelAtPeriodEnd: memberships.cancelAtPeriodEnd })
    .from(memberships)
    .innerJoin(membershipPlans, eq(membershipPlans.id, memberships.planId))
    .where(and(eq(memberships.customerId, customerId), or(ne(memberships.status, "canceled"), sql`${memberships.canceledAt} > now() - interval '90 days'`)))
    .orderBy(desc(memberships.createdAt));
}
