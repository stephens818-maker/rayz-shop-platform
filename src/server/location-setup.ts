import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ownerEntities, shopHours, shopPaymentAccounts, shopProducts, shopServices, shops, staff, staffAccessShops, staffSchedules, terminalReaders } from "@/db/schema";
import { AccountState, accountState, canCharge } from "@/domain/connect";
import { REQUIRED_FOR_LIVE, SUPPORTED_TIMEZONE, US_TIMEZONES, goLiveBlockers, slugProblem } from "@/domain/location-lifecycle";
import { connectMode, feeSchedule } from "./payments/connect";

export type SetupStepKey = "details" | "timezone" | "slug" | "owner" | "hours" | "taxes" | "menu" | "team" | "payments" | "booking" | "line" | "readers" | "login" | "retail";

export interface SetupStep {
  key: SetupStepKey;
  title: string;
  done: boolean;
  detail: string;
  /** Where to do it, when it's done somewhere else. */
  href?: string;
  /** Has to be done before the location can go live. */
  required: boolean;
}

export const SETUP_ORDER: SetupStepKey[] = ["details", "timezone", "slug", "owner", "hours", "taxes", "menu", "team", "payments", "booking", "line", "readers", "login", "retail"];

/** Every step of opening a location, worked out from what's already saved, plus its payment account and owner. */
export async function locationSetup(shopId: string) {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) return null;
  const [account, owner, [hours], [menu], scheduled, [readers], [logins], [retail], surnames] = await Promise.all([
    db.query.shopPaymentAccounts.findFirst({ where: eq(shopPaymentAccounts.shopId, shopId) }),
    shop.ownerEntityId ? db.query.ownerEntities.findFirst({ where: eq(ownerEntities.id, shop.ownerEntityId) }) : Promise.resolve(undefined),
    db.select({ n: count() }).from(shopHours).where(eq(shopHours.shopId, shopId)),
    db
      .select({ n: count() })
      .from(shopServices)
      .where(and(eq(shopServices.shopId, shopId), eq(shopServices.enabled, true))),
    db.selectDistinct({ id: staffSchedules.staffId }).from(staffSchedules).where(eq(staffSchedules.shopId, shopId)),
    db
      .select({ n: count() })
      .from(terminalReaders)
      .where(and(eq(terminalReaders.shopId, shopId), eq(terminalReaders.active, true))),
    db
      .select({ n: count() })
      .from(staff)
      .innerJoin(staffAccessShops, eq(staffAccessShops.staffId, staff.id))
      .where(and(eq(staff.kind, "shop"), eq(staff.active, true), eq(staffAccessShops.shopId, shopId))),
    db
      .select({ n: count() })
      .from(shopProducts)
      .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.active, true))),
    db.select({ n: staff.lastName }).from(staff).where(sql`${staff.lastName} is not null`),
  ]);
  const slugIssue = slugProblem(shop.slug, surnames.map((r) => r.n));
  const zone = US_TIMEZONES.find((z) => z.id === shop.timezone)?.label ?? shop.timezone;
  const barbers = scheduled.length;
  const state: AccountState = accountState(account);
  const settings = `/admin/settings?shop=${shopId}`;
  const steps: SetupStep[] = ([
    {
      key: "details",
      title: "Address and phone",
      done: !!(shop.address && shop.city && shop.zip && shop.phone),
      detail: shop.address ? `${shop.address}, ${shop.city} ${shop.state} ${shop.zip}${shop.phone ? "" : " · no phone yet"}` : "Add the street address and phone clients will see.",
      href: settings,
    },
    {
      key: "timezone",
      title: "Time zone",
      done: shop.timezone === SUPPORTED_TIMEZONE,
      detail:
        shop.timezone === SUPPORTED_TIMEZONE
          ? "Central time, like every Ray'z shop."
          : `${zone} time isn't supported yet: every shop's calendar, reminders and reports run on Central time. Change it to Central, or ask for multi-time-zone support first.`,
      href: settings,
    },
    {
      key: "slug",
      title: "Booking link",
      done: !slugIssue,
      detail: slugIssue ?? `/book/${shop.slug}`,
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
            : canCharge(account)
              ? "Taking cards. Stripe needs a few more details before it pays out to the shop's bank."
              : "Finish Stripe's onboarding so this shop can take cards.",
    },
    {
      key: "booking",
      title: "Online booking",
      done: shop.bookingEnabled,
      detail: shop.bookingEnabled
        ? shop.status === "live"
          ? "Clients can book online."
          : "Online booking opens the moment the location goes live."
        : "Online booking is off: clients will have to call.",
      href: settings,
    },
    {
      key: "line",
      title: "Shop line (Twilio)",
      done: !!shop.twilioNumber,
      detail: shop.twilioNumber ? `Texts and calls go out from ${shop.twilioNumber}.` : "Without its own number, texts go out from the brand's number and client replies don't reach this shop's inbox.",
      href: settings,
    },
    {
      key: "readers",
      title: "Card readers",
      done: readers.n > 0,
      detail: readers.n ? `${readers.n} Stripe Terminal reader${readers.n === 1 ? "" : "s"}` : "No card reader yet: cards can still be keyed in at checkout.",
      href: settings,
    },
    { key: "login", title: "Front desk login", done: logins.n > 0, detail: logins.n ? `${logins.n} shop login${logins.n === 1 ? "" : "s"}` : "Add a shared login for the front desk.", href: "/admin/shop-logins" },
    {
      key: "retail",
      title: "Retail products",
      done: retail.n > 0,
      detail: retail.n ? `${retail.n} products stocked, with reorder points and par levels` : "No retail products yet.",
      href: `/admin/inventory/settings?shop=${shopId}`,
    },
  ] as Omit<SetupStep, "required">[]).map((x) => ({ ...x, required: (REQUIRED_FOR_LIVE as readonly string[]).includes(x.key) }));
  return { shop, owner: owner ?? null, account: account ?? null, state, steps, blockers: goLiveBlockers(steps), mode: connectMode(), fees: feeSchedule() };
}

/** One line per shop for the setup overview. */
export async function setupOverview(shopIds: string[]) {
  if (!shopIds.length) return [];
  const rows = await db
    .select({ id: shops.id, name: shops.name, status: shops.status, closedUntil: shops.closedUntil, ownerName: ownerEntities.name, ownerKind: ownerEntities.kind, account: shopPaymentAccounts })
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
      status: r.status,
      closedUntil: r.closedUntil,
      blockers: details[i]!.blockers.length,
      ownerName: r.ownerName,
      ownerKind: r.ownerKind,
      stripeAccountId: r.account?.stripeAccountId ?? null,
      state: accountState(r.account),
      done: steps.filter((s) => s.done && s.required).length,
      total: steps.filter((s) => s.required).length,
    };
  });
}

export async function ownerEntityList() {
  const owners = await db.select().from(ownerEntities).orderBy(asc(ownerEntities.kind), asc(ownerEntities.name));
  const shopRows = await db.select({ id: shops.id, name: shops.name, ownerEntityId: shops.ownerEntityId }).from(shops).orderBy(asc(shops.name));
  return owners.map((o) => ({ ...o, shops: shopRows.filter((s) => s.ownerEntityId === o.id).map((s) => ({ id: s.id, name: s.name })) }));
}
