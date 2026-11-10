import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { entityPaymentAccounts, ownerEntities, shopPaymentAccounts, shops, staff } from "@/db/schema";
import { AccountState, PAYMENTS_STEP_TITLE, accountState, paymentsStep, receiptBranding } from "@/domain/connect";
import { REQUIRED_FOR_LIVE, SUPPORTED_TIMEZONE, US_TIMEZONES, goLiveBlockers, slugProblem } from "@/domain/location-lifecycle";
import { connectMode, feeSchedule } from "./payments/connect";

export type SetupStepKey = "details" | "profile" | "timezone" | "slug" | "owner" | "hours" | "taxes" | "menu" | "team" | "payments" | "booking" | "line" | "readers" | "login" | "retail";

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

export const SETUP_ORDER: SetupStepKey[] = ["details", "profile", "timezone", "slug", "owner", "hours", "taxes", "menu", "team", "payments", "booking", "line", "readers", "login", "retail"];

type ShopRow = typeof shops.$inferSelect;
type OwnerRow = typeof ownerEntities.$inferSelect;
type AccountRow = typeof shopPaymentAccounts.$inferSelect;
type OwnerAccountRow = typeof entityPaymentAccounts.$inferSelect;

interface SetupCounts {
  hours: number;
  menu: number;
  barbers: number;
  readers: number;
  logins: number;
  retail: number;
  photos: number;
}

/** Every step of opening a location, worked out from what's already saved, plus its payment account and owner. */
export async function locationSetup(shopId: string) {
  const [one] = await locationSetups([shopId]);
  return one ?? null;
}

/** The same steps for several shops. The counts are one query, so a list of locations doesn't reread each shop. */
export async function locationSetups(shopIds: readonly string[]) {
  const ids = [...new Set(shopIds)];
  if (!ids.length) return [];
  const [shopRows, accounts, owners, ownerAccounts, countRows, surnameRows] = await Promise.all([
    db.select().from(shops).where(inArray(shops.id, ids)),
    db.select().from(shopPaymentAccounts).where(inArray(shopPaymentAccounts.shopId, ids)),
    db.select().from(ownerEntities),
    db.select().from(entityPaymentAccounts),
    db.execute(sql`
      select s.id,
        (select count(*)::int from shop_hours h where h.shop_id = s.id) hours,
        (select count(*)::int from shop_services sv where sv.shop_id = s.id and sv.enabled) menu,
        (select count(distinct sc.staff_id)::int from staff_schedules sc where sc.shop_id = s.id) barbers,
        (select count(*)::int from terminal_readers r where r.shop_id = s.id and r.active) readers,
        (select count(*)::int from staff st inner join staff_access_shops a on a.staff_id = st.id where st.kind = 'shop' and st.active and a.shop_id = s.id) logins,
        (select count(*)::int from shop_products p where p.shop_id = s.id and p.active) retail,
        (select count(*)::int from shop_photos ph where ph.shop_id = s.id) photos
      from shops s where s.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`),
    db.select({ n: staff.lastName }).from(staff).where(sql`${staff.lastName} is not null`),
  ]);
  const surnames = surnameRows.map((r) => r.n).filter((n): n is string => !!n);
  const counts = new Map((countRows as unknown as (SetupCounts & { id: string })[]).map((r) => [r.id, r]));
  const zero: SetupCounts = { hours: 0, menu: 0, barbers: 0, readers: 0, logins: 0, retail: 0, photos: 0 };
  return shopRows.map((shop) =>
    buildSetup(
      shop,
      counts.get(shop.id) ?? zero,
      owners.find((o) => o.id === shop.ownerEntityId) ?? null,
      accounts.find((a) => a.shopId === shop.id) ?? null,
      ownerAccounts.find((a) => a.ownerEntityId === shop.ownerEntityId) ?? null,
      surnames,
    ),
  );
}

function buildSetup(shop: ShopRow, counts: SetupCounts, owner: OwnerRow | null, account: AccountRow | null, ownerAccount: OwnerAccountRow | null, surnames: string[]) {
  const reviewLink = !!receiptBranding(shop.receipt).reviewUrl;
  const profileMissing = [
    shop.latitude === null || shop.geocodeSource === "zip" ? "an exact map pin" : null,
    shop.googlePlaceId || reviewLink ? null : "the Google Place ID or review link",
    counts.photos > 0 ? null : "photos or a logo",
  ].filter((x): x is string => !!x);
  const slugIssue = slugProblem(shop.slug, surnames);
  const zone = US_TIMEZONES.find((z) => z.id === shop.timezone)?.label ?? shop.timezone;
  const barbers = counts.barbers;
  const settles = shop.paymentsMode === "entity" ? ownerAccount : account;
  const state: AccountState = accountState(settles);
  const settings = `/admin/settings?shop=${shop.id}`;
  const steps: SetupStep[] = ([
    {
      key: "details",
      title: "Address and phone",
      done: !!(shop.address && shop.city && shop.zip && shop.phone),
      detail: shop.address ? `${shop.address}, ${shop.city} ${shop.state} ${shop.zip}${shop.phone ? "" : " · no phone yet"}` : "Add the street address and phone clients will see.",
      href: settings,
    },
    {
      key: "profile",
      title: "Location page",
      done: profileMissing.length === 0,
      detail: profileMissing.length ? `Add ${profileMissing.join(", ").replace(/, ([^,]*)$/, " and $1")} for the public location page and search.` : "Map pin, Google listing and photos are set.",
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
      detail: owner ? `${owner.name}${owner.kind === "franchisee" ? " (franchisee)" : ""}` : "Choose which business owns this location: Ray'z corporate or a franchisee.",
    },
    { key: "hours", title: "Opening hours", done: counts.hours > 0, detail: counts.hours ? `${counts.hours} days a week` : "Set the weekday hours.", href: settings },
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
      done: counts.menu > 0,
      detail: counts.menu ? `${counts.menu} services and add-ons offered` : "Turn on the services this shop offers.",
      href: `/admin/services?shop=${shop.id}`,
    },
    {
      key: "team",
      title: "Barbers and schedules",
      done: barbers > 0,
      detail: barbers ? `${barbers} barber${barbers === 1 ? "" : "s"} with weekly hours here` : "Add barbers and give them hours at this shop.",
      href: "/admin/staff",
    },
    { key: "payments", title: PAYMENTS_STEP_TITLE, ...paymentsStep(shop.paymentsMode, settles) },
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
      done: counts.readers > 0,
      detail: counts.readers ? `${counts.readers} Stripe Terminal reader${counts.readers === 1 ? "" : "s"}` : "No card reader yet: cards can still be keyed in at checkout.",
      href: settings,
    },
    { key: "login", title: "Front desk login", done: counts.logins > 0, detail: counts.logins ? `${counts.logins} shop login${counts.logins === 1 ? "" : "s"}` : "Add a shared login for the front desk.", href: "/admin/shop-logins" },
    {
      key: "retail",
      title: "Retail products",
      done: counts.retail > 0,
      detail: counts.retail ? `${counts.retail} products stocked, with reorder points and par levels` : "No retail products yet.",
      href: `/admin/inventory/settings?shop=${shop.id}`,
    },
  ] as Omit<SetupStep, "required">[]).map((x) => ({ ...x, required: (REQUIRED_FOR_LIVE as readonly string[]).includes(x.key) }));
  return { shop, owner, account, ownerAccount, state, steps, blockers: goLiveBlockers(steps), mode: connectMode(), fees: feeSchedule(), readers: counts.readers };
}

/** One line per shop for the setup overview. */
export async function setupOverview(shopIds: string[]) {
  if (!shopIds.length) return [];
  const rows = await db
    .select({ id: shops.id, name: shops.name, status: shops.status, closedUntil: shops.closedUntil, regionId: shops.regionId, ownerName: ownerEntities.name, ownerKind: ownerEntities.kind })
    .from(shops)
    .leftJoin(ownerEntities, eq(ownerEntities.id, shops.ownerEntityId))
    .where(inArray(shops.id, shopIds))
    .orderBy(asc(shops.name));
  const details = new Map((await locationSetups(rows.map((r) => r.id))).map((d) => [d.shop.id, d]));
  return rows.map((r) => {
    const d = details.get(r.id)!;
    const steps = d.steps;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      closedUntil: r.closedUntil,
      regionId: r.regionId,
      blockers: d.blockers.length,
      ownerName: r.ownerName,
      ownerKind: r.ownerKind,
      stripeAccountId: (d.shop.paymentsMode === "entity" ? d.ownerAccount : d.account)?.stripeAccountId ?? null,
      state: d.state,
      paymentsMode: d.shop.paymentsMode,
      done: steps.filter((s) => s.done && s.required).length,
      total: steps.filter((s) => s.required).length,
    };
  });
}

/** Every owner entity, the default first, with its shops and its own Stripe account if it has one. */
export async function ownerEntityList() {
  const [owners, shopRows, accounts] = await Promise.all([
    db.select().from(ownerEntities).orderBy(desc(ownerEntities.isDefault), asc(ownerEntities.kind), asc(ownerEntities.name)),
    db.select({ id: shops.id, name: shops.name, ownerEntityId: shops.ownerEntityId, paymentsMode: shops.paymentsMode }).from(shops).orderBy(asc(shops.name)),
    db.select().from(entityPaymentAccounts),
  ]);
  return owners.map((o) => {
    const account = accounts.find((a) => a.ownerEntityId === o.id) ?? null;
    return {
      ...o,
      account,
      state: accountState(account),
      shops: shopRows.filter((s) => s.ownerEntityId === o.id).map((s) => ({ id: s.id, name: s.name, onOwnerAccount: s.paymentsMode === "entity" })),
    };
  });
}
