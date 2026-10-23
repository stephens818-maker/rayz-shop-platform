import { and, desc, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/db";
import { connectTransfers, shops, staff, staffAccessShops, staffShops } from "@/db/schema";
import { verifyToken } from "@/server/auth/tokens";
import { AppError } from "@/server/errors";
import { createBarberConnectOnboardingLink } from "@/server/payments/barber-connect";
import { assertStripeTestMode, stripe } from "@/server/payments/processor";

export interface PayoutSchedule {
  interval: "manual" | "daily" | "weekly" | "monthly";
  delayDays: number | null;
  weeklyAnchor: string | null;
  monthlyAnchor: number | null;
}

export type BarberAccountStatus = "not_started" | "onboarding" | "enabled" | "restricted";

const SIM_SCHEDULE: PayoutSchedule = { interval: "daily", delayDays: 2, weeklyAnchor: null, monthlyAnchor: null };

interface Barber {
  id: string;
  firstName: string;
  stripeAccountId: string | null;
  shopScope: "all" | "selected" | "one";
}

function firstOnly(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Staff-session bearer. A customer token returns null so a customer GET can stay empty. A bad staff token is invalid. */
export async function barberFromBearer(req: Request): Promise<Barber | null | "invalid"> {
  const header = req.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  const staffPayload = await verifyToken<{ sub: string }>(token, "staff_session");
  if (staffPayload?.sub) {
    const row = await db.query.staff.findFirst({
      where: and(eq(staff.id, staffPayload.sub), eq(staff.active, true)),
      columns: { id: true, firstName: true, stripeAccountId: true, shopScope: true },
    });
    if (!row) return "invalid";
    return { id: row.id, firstName: firstOnly(row.firstName), stripeAccountId: row.stripeAccountId, shopScope: row.shopScope };
  }
  if (await verifyToken(token, "customer_access")) return null;
  return "invalid";
}

async function shopsFor(barber: Barber) {
  const cols = { id: shops.id, slug: shops.slug, name: shops.name, tipToBarber: shops.tipToBarber };
  const listed = await db
    .select(cols)
    .from(staffShops)
    .innerJoin(shops, eq(shops.id, staffShops.shopId))
    .where(and(eq(staffShops.staffId, barber.id), eq(shops.active, true)));
  if (listed.length) return listed;
  if (barber.shopScope === "all") return db.select(cols).from(shops).where(eq(shops.active, true));
  return db
    .select(cols)
    .from(staffAccessShops)
    .innerJoin(shops, eq(shops.id, staffAccessShops.shopId))
    .where(and(eq(staffAccessShops.staffId, barber.id), eq(shops.active, true)));
}

function simulatedAccount(id: string | null) {
  return !id || id.startsWith("acct_sim_") || id.startsWith("sim_acct_") || !stripe();
}

function scheduleFrom(account: Stripe.Account): PayoutSchedule {
  const schedule = account.settings?.payouts?.schedule;
  const interval = schedule?.interval === "manual" || schedule?.interval === "weekly" || schedule?.interval === "monthly" || schedule?.interval === "daily" ? schedule.interval : "daily";
  return {
    interval,
    delayDays: schedule?.delay_days ?? null,
    weeklyAnchor: schedule?.weekly_anchor ?? null,
    monthlyAnchor: schedule?.monthly_anchor ?? null,
  };
}

function statusFrom(account: Stripe.Account): BarberAccountStatus {
  if (account.payouts_enabled) return "enabled";
  if (account.details_submitted) return "restricted";
  return "onboarding";
}

async function accountView(barber: Barber) {
  if (!barber.stripeAccountId) return { account: null, schedule: null as PayoutSchedule | null };
  if (simulatedAccount(barber.stripeAccountId)) {
    return {
      account: {
        stripeAccountId: barber.stripeAccountId,
        accountType: "recipient" as const,
        status: "enabled" as const,
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        mode: "simulator" as const,
      },
      schedule: SIM_SCHEDULE,
    };
  }
  assertStripeTestMode();
  const client = stripe();
  if (!client) return { account: null, schedule: null };
  try {
    const account = await client.accounts.retrieve(barber.stripeAccountId);
    const status = statusFrom(account);
    return {
      account: {
        stripeAccountId: barber.stripeAccountId,
        accountType: "recipient" as const,
        status,
        chargesEnabled: !!account.charges_enabled,
        payoutsEnabled: !!account.payouts_enabled,
        detailsSubmitted: !!account.details_submitted,
        mode: "stripe" as const,
      },
      schedule: status === "not_started" ? null : scheduleFrom(account),
    };
  } catch {
    return {
      account: {
        stripeAccountId: barber.stripeAccountId,
        accountType: "recipient" as const,
        status: "restricted" as const,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        mode: "stripe" as const,
      },
      schedule: null,
    };
  }
}

const empty = { signedIn: false as const, tipToBarber: false, firstName: null, shops: [], account: null, transfers: [], schedule: null };

/** Account status, recent tip transfers, and the payout schedule. Gated on each shop's switch. */
export async function staffConnectStatus(req: Request, shopRef?: string | null) {
  const barber = await barberFromBearer(req);
  if (barber === "invalid") throw new AppError("unauthorized", "Sign in required");
  if (!barber) return empty;
  const mine = await shopsFor(barber);
  const scoped = shopRef ? mine.filter((s) => s.slug === shopRef || s.id === shopRef) : mine;
  const open = scoped.filter((s) => s.tipToBarber);
  const shopsOut = scoped.map((s) => ({ id: s.id, slug: s.slug, name: s.name, tipToBarber: s.tipToBarber }));
  if (!open.length) {
    return { signedIn: true as const, tipToBarber: false, firstName: barber.firstName, shops: shopsOut, account: null, transfers: [], schedule: null };
  }
  const { account, schedule } = await accountView(barber);
  const transfers = await db
    .select({
      id: connectTransfers.id,
      amountCents: connectTransfers.amountCents,
      status: connectTransfers.status,
      createdAt: connectTransfers.createdAt,
      shopSlug: shops.slug,
      shopName: shops.name,
    })
    .from(connectTransfers)
    .innerJoin(shops, eq(shops.id, connectTransfers.shopId))
    .where(and(eq(connectTransfers.staffId, barber.id), eq(connectTransfers.role, "tip"), inArray(connectTransfers.shopId, open.map((s) => s.id))))
    .orderBy(desc(connectTransfers.createdAt))
    .limit(20);
  return {
    signedIn: true as const,
    tipToBarber: true,
    firstName: barber.firstName,
    shops: shopsOut,
    account,
    transfers: transfers.map((t) => ({
      id: t.id,
      amountCents: t.amountCents,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      shop: { slug: t.shopSlug, name: t.shopName },
    })),
    schedule,
  };
}

/** Stripe-hosted onboarding link. Refused when the shop's tip switch is off. */
export async function staffOnboardingLink(barberId: string, shopRef?: string | null) {
  const row = await db.query.staff.findFirst({
    where: and(eq(staff.id, barberId), eq(staff.active, true)),
    columns: { id: true, firstName: true, stripeAccountId: true, shopScope: true },
  });
  if (!row) throw new AppError("unauthorized", "Sign in required");
  const barber: Barber = { id: row.id, firstName: firstOnly(row.firstName), stripeAccountId: row.stripeAccountId, shopScope: row.shopScope };
  const mine = await shopsFor(barber);
  const target = shopRef ? mine.find((s) => s.slug === shopRef || s.id === shopRef) : mine.find((s) => s.tipToBarber);
  if (!target) throw new AppError("not_found", "Shop not found");
  if (!target.tipToBarber) throw new AppError("forbidden", "This shop keeps card tips in the shop account.");
  assertStripeTestMode();
  const link = await createBarberConnectOnboardingLink(barber.id);
  return { ...link, firstName: barber.firstName, shop: { id: target.id, slug: target.slug } };
}
