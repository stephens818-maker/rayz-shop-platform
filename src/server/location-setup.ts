import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { ownerEntities, shopHours, shopPaymentAccounts, shopServices, shops, staffSchedules } from "@/db/schema";
import { AccountState, accountState } from "@/domain/connect";
import { connectMode, feeSchedule } from "./payments/connect";

export type SetupStepKey = "details" | "owner" | "hours" | "taxes" | "menu" | "team" | "payments" | "booking";

export interface SetupStep {
  key: SetupStepKey;
  title: string;
  done: boolean;
  detail: string;
  /** Where to do it, when it's done somewhere else. */
  href?: string;
}

export const SETUP_ORDER: SetupStepKey[] = ["details", "owner", "hours", "taxes", "menu", "team", "payments", "booking"];

/** Every step of opening a location, worked out from what's already saved, plus its payment account and owner. */
export async function locationSetup(shopId: string) {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) return null;
  const [account, owner, [hours], [menu], scheduled] = await Promise.all([
    db.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.shopId, shopId) }),
    shop.ownerEntityId ? db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, shop.ownerEntityId) }) : Promise.resolve(undefined),
    db.select({ n: count() }).from(shopHours).where(eq(shopHours.shopId, shopId)),
    db
      .select({ n: count() })
      .from(shopServices)
      .where(and(eq(shopServices.shopId, shopId), eq(shopServices.enabled, true))),
    db.selectDistinct({ id: staffSchedules.staffId }).from(staffSchedules).where(eq(staffSchedules.shopId, shopId)),
  ]);
  const barbers = scheduled.length;
  const state: AccountState = accountState(account);
  const settings = `/admin/settings?shop=${shopId}`;
  const steps: SetupStep[] = [
    {
      key: "details",
      title: "Address and phone",
      done: !!(shop.address && shop.city && shop.zip && shop.phone),
      detail: shop.address ? `${shop.address}, ${shop.city} ${shop.state} ${shop.zip}${shop.phone ? "" : " · no phone yet"}` : "Add the street address and phone clients will see.",
      href: settings,
    },
    {
      key: "owner",
      title: "Owner",
      done: !!owner,
      detail: owner ? `${owner.name}${owner.kind === "franchisee" ? " (franchisee)" : ""}` : "Choose who owns this location's business.",
    },
    { key: "hours", title: "Opening hours", done: hours.n > 0, detail: hours.n ? `${hours.n} days a week` : "Set the weekday hours.", href: settings },
    {
      key: "taxes",
      title: "Sales tax",
      done: shop.taxRatesVerified,
      detail: shop.taxRatesVerified
        ? `Services ${+(Number(shop.serviceTaxRate) * 100).toFixed(3)}%, products ${+(Number(shop.productTaxRate) * 100).toFixed(3)}%`
        : "Enter and confirm this location's tax rates.",
      href: settings,
    },
    {
      key: "menu",
      title: "Menu",
      done: menu.n > 0,
      detail: menu.n ? `${menu.n} services and add-ons offered` : "Turn on the services this shop offers.",
      href: `/admin/services?shop=${shopId}`,
    },
    {
      key: "team",
      title: "Barbers and schedules",
      done: barbers > 0,
      detail: barbers ? `${barbers} barber${barbers === 1 ? "" : "s"} with weekly hours here` : "Add barbers and give them hours at this shop.",
      href: "/admin/staff",
    },
    {
      key: "payments",
      title: "Card payments and payouts",
      done: state === "enabled",
      detail:
        state === "enabled"
          ? "Taking cards; payouts go to the shop's bank."
          : state === "not_started"
            ? "Create this shop's Stripe account so its card sales, fees and payouts are its own."
            : "Finish Stripe's onboarding so this shop can take cards.",
    },
    {
      key: "booking",
      title: "Online booking",
      done: shop.bookingEnabled,
      detail: shop.bookingEnabled ? "Clients can book online." : "Turn on online booking when the shop is ready.",
      href: settings,
    },
  ];
  return { shop, owner: owner ?? null, account: account ?? null, state, steps, mode: connectMode(), fees: feeSchedule() };
}

/** One line per shop for the setup overview. */
export async function setupOverview(shopIds: string[]) {
  if (!shopIds.length) return [];
  const rows = await db
    .select({ id: shops.id, name: shops.name, ownerName: ownerEntities.name, ownerKind: ownerEntities.kind, account: shopPaymentAccounts })
    .from(shops)
    .leftJoin(ownerEntities, eq(ownerEntities.id, shops.ownerEntityId))
    .leftJoin(shopPaymentAccounts, eq(shopPaymentAccounts.shopId, shops.id))
    .where(inArray(shops.id, shopIds))
    .orderBy(asc(shops.name));
  const details = await Promise.all(rows.map((r) => locationSetup(r.id)));
  return rows.map((r, i) => {
    const steps = details[i]!.steps;
    return {
      id: r.id,
      name: r.name,
      ownerName: r.ownerName,
      ownerKind: r.ownerKind,
      stripeAccountId: r.account?.stripeAccountId ?? null,
      state: accountState(r.account),
      done: steps.filter((s) => s.done).length,
      total: steps.length,
    };
  });
}

export async function ownerEntityList() {
  const owners = await db.select().from(ownerEntities).orderBy(asc(ownerEntities.kind), asc(ownerEntities.name));
  const shopRows = await db.select({ id: shops.id, name: shops.name, ownerEntityId: shops.ownerEntityId }).from(shops).orderBy(asc(shops.name));
  return owners.map((o) => ({ ...o, shops: shopRows.filter((s) => s.ownerEntityId === o.id).map((s) => ({ id: s.id, name: s.name })) }));
}
