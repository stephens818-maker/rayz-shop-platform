import { cardFeeFor, rangeFromSearch, type PaymentPreview } from "@rayz/api";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { earningsDays, payrollCsv, payrollPdf, toTicket } from "./engine";
import { SHOP_CORALVILLE, SHOP_KIMBERLY, SHOP_MOLINE, STAFF_CASEY, STAFF_KAT, STAFF_MAKENNA, STAFF_RILEY } from "./fixtures";
import { derivePayoutState, flagsForState, type PayoutFlags } from "./payout";
import { createWorld, declareCashTip, earningsFor, type World } from "./world";

const FAMILY = "+13195550100";
const CODE = "123456";

interface Customer {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string;
  email: string | null;
  smsOptIn: boolean;
  emailOptIn: boolean;
  pushReminders: boolean;
  pushMarketing: boolean;
  birthYear: number | null;
  guardianId: string | null;
}

interface Appointment {
  id: string;
  code: string;
  status: "booked" | "confirmed" | "checked_in" | "in_service" | "completed" | "cancelled" | "no_show";
  startsAt: string;
  endsAt: string;
  shopId: string;
  barberId: string;
  customerId: string;
  serviceName: string;
  serviceCents: number;
  durationMin: number;
  notes: string;
  canCancel: boolean;
  canReschedule: boolean;
}

interface Card {
  id: string;
  customerId: string;
  brand: string;
  last4: string;
  funding: "credit" | "debit" | "prepaid";
  wallet: boolean;
  expMonth: number;
  expYear: number;
}

interface Punch {
  id: string;
  staffId: string;
  shopId: string;
  inAt: string;
  outAt: string | null;
  cashTipCents: number | null;
  attestation: boolean;
}

const STAFF_LOGIN: Record<string, { id: string; pin: string; firstName: string; shops: string[] }> = {
  "+13195550111": { id: STAFF_MAKENNA, pin: "135790", firstName: "Makenna", shops: [SHOP_CORALVILLE] },
  "+13095550222": { id: STAFF_KAT, pin: "246810", firstName: "Kat", shops: [SHOP_MOLINE] },
  "+15635550333": { id: STAFF_CASEY, pin: "111222", firstName: "Casey", shops: [SHOP_CORALVILLE, SHOP_MOLINE] },
  "+13195550444": { id: STAFF_RILEY, pin: "101010", firstName: "Riley", shops: [SHOP_CORALVILLE] },
};

function phone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return input.startsWith("+") ? input : `+${digits}`;
}

function err(code: string, message: string, status: number, details?: unknown) {
  return { body: { error: { code, message, details: details ?? null } }, status };
}

function sign(value: string): string {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16);
}

function qr(shopId: string, now = Date.now()) {
  const bucket = Math.floor(now / 15_000);
  return { token: `${shopId}.${bucket}.${sign(`${shopId}.${bucket}`)}`, expiresAt: new Date((bucket + 1) * 15_000).toISOString(), shopId, rotatesSeconds: 15 };
}

function readQr(token: string, now = Date.now()): string | null {
  const [shopId, bucket, sig] = token.split(".");
  if (!shopId || !bucket || sign(`${shopId}.${bucket}`) !== sig) return null;
  if (Math.abs(Math.floor(now / 15_000) - Number(bucket)) > 1) return null;
  return shopId;
}

function publicShop(world: World, id: string) {
  const shop = world.shops.find((s) => s.id === id || s.slug === id)!;
  const gates: Record<string, { address: string; city: string; state: string; zip: string; phone: string; hours: { weekday: number; open: string; close: string }[] }> = {
    coralville: { address: "1701 2nd Street", city: "Coralville", state: "IA", zip: "52241", phone: "+13195196700", hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, open: "09:00", close: "18:00" })) },
    moline: { address: "3002 Ave of Cities", city: "Moline", state: "IL", zip: "61265", phone: "+13097640977", hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, open: "09:00", close: "19:00" })) },
    kimberly: { address: "1150 E Kimberly Rd #B", city: "Davenport", state: "IA", zip: "52807", phone: "+15633868505", hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, open: "09:00", close: "18:00" })) },
  };
  const g = gates[shop.slug];
  return {
    id: shop.id,
    slug: shop.slug,
    name: shop.name,
    address: g.address,
    city: g.city,
    state: g.state,
    zip: g.zip,
    phone: g.phone,
    timezone: "America/Chicago" as const,
    bookingEnabled: shop.booking === "native",
    bookingMode: shop.booking,
    externalBookingUrl: shop.booking === "external" ? `https://book.rayzbs.com/shops/${shop.slug}` : null,
    cancelCutoffMinutes: 30,
    barberCount: shop.slug === "kimberly" ? 3 : 4,
    hours: g.hours,
    lat: shop.slug === "coralville" ? 41.6764 : shop.slug === "moline" ? 41.5067 : 41.559,
    lng: shop.slug === "coralville" ? -91.5802 : shop.slug === "moline" ? -90.5151 : -90.5504,
    description: "Modern cuts with an old-school barbershop welcome.",
    payments: shop.payments,
    clockIn: shop.clockIn,
    tipTransfers: shop.tipTransfers,
  };
}

export function createApp(world = createWorld()) {
  const customers: Customer[] = [
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", firstName: "Alex", lastName: "Reyes", phone: FAMILY, email: "alex@example.com", smsOptIn: true, emailOptIn: true, pushReminders: true, pushMarketing: false, birthYear: 1990, guardianId: null },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", firstName: "Jordan", lastName: "Reyes", phone: FAMILY, email: null, smsOptIn: true, emailOptIn: false, pushReminders: true, pushMarketing: false, birthYear: 1994, guardianId: null },
  ];
  const family: { id: string; guardianId: string; firstName: string; birthYear: number | null }[] = [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", guardianId: customers[0].id, firstName: "Sam", birthYear: 2016 }];
  const appointments: Appointment[] = [
    {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      code: "NEXT4ALEX01",
      status: "booked",
      startsAt: "2026-10-24T15:00:00.000Z",
      endsAt: "2026-10-24T15:40:00.000Z",
      shopId: SHOP_CORALVILLE,
      barberId: STAFF_MAKENNA,
      customerId: customers[0].id,
      serviceName: "Ray'z Cut",
      serviceCents: 2900,
      durationMin: 40,
      notes: "",
      canCancel: true,
      canReschedule: true,
    },
    {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      code: "PAST4ALEX01",
      status: "completed",
      startsAt: "2026-09-24T16:30:00.000Z",
      endsAt: "2026-09-24T17:10:00.000Z",
      shopId: SHOP_CORALVILLE,
      barberId: STAFF_MAKENNA,
      customerId: customers[0].id,
      serviceName: "Ray'z Cut",
      serviceCents: 2900,
      durationMin: 40,
      notes: "",
      canCancel: false,
      canReschedule: false,
    },
  ];
  const cards: Card[] = [];
  const punches: Punch[] = [];
  const idem = new Map<string, unknown>();
  const payouts = new Map<string, PayoutFlags>([
    [STAFF_MAKENNA, flagsForState("active")],
    [STAFF_KAT, flagsForState("not_started")],
    [STAFF_CASEY, flagsForState("active")],
    [STAFF_RILEY, flagsForState("not_started")],
  ]);
  const stepUps = new Map<string, string>();
  const selection = new Map<string, string>();

  const app = new Hono();
  app.use("*", cors());

  const customerOf = (header: string | undefined) => {
    const token = header?.replace(/^Bearer /, "") ?? "";
    if (!token.startsWith("cust.")) return null;
    return customers.find((c) => c.id === token.slice(5)) ?? null;
  };
  const staffOf = (header: string | undefined) => {
    const token = header?.replace(/^Bearer /, "") ?? "";
    if (!token.startsWith("staff.")) return null;
    return Object.values(STAFF_LOGIN).find((s) => s.id === token.slice(6)) ?? null;
  };
  const requireStaff = (c: { req: { header: (n: string) => string | undefined } }) => {
    const staff = staffOf(c.req.header("authorization"));
    if (!staff) return { error: err("unauthorized", "Sign in required", 401) };
    return { staff };
  };
  const requireStep = (c: { req: { header: (n: string) => string | undefined } }, staffId: string) => {
    const token = c.req.header("x-step-up");
    if (!token || stepUps.get(token) !== staffId) return err("step_up_required", "Enter your app PIN to view earnings.", 403);
    return null;
  };

  app.get("/api/v1/app/config", (c) =>
    c.json({
      timezone: "America/Chicago",
      timeFormat: "12h",
      minSupportedVersion: { ios: "3.0.0", android: "1.0.0" },
      latestVersion: { ios: "3.0.0", android: "1.0.0" },
      supportPhone: "+13195550199",
      supportEmail: "hello@rayzbs.com",
      privacyUrl: "https://rayzbs.com/privacy",
      termsUrl: "https://rayzbs.com/terms",
      deletionUrl: "https://rayzbs.com/account/delete",
      featureFlags: { payments: true, family: true, pushMarketing: false },
      shops: world.shops.map((s) => {
        const pub = publicShop(world, s.id);
        return { shopId: s.id, slug: s.slug, booking: s.booking, externalBookingUrl: pub.externalBookingUrl, payments: s.payments, clockIn: s.clockIn, tipTransfers: s.tipTransfers };
      }),
    }),
  );

  app.get("/api/staff/v1/config", (c) =>
    c.json({
      timezone: "America/Chicago",
      timeFormat: "12h",
      appName: "Ray'z Team",
      minSupportedVersion: { ios: "1.0.0", android: "1.0.0" },
      latestVersion: { ios: "1.0.0", android: "1.0.0" },
      tipTransfersDefault: true,
      supportPhone: "+13195550199",
      supportEmail: "team@rayzbs.com",
      privacyUrl: "https://rayzbs.com/team/privacy",
      termsUrl: "https://rayzbs.com/team/terms",
      shops: world.shops.map((s) => {
        const pub = publicShop(world, s.id);
        return { shopId: s.id, slug: s.slug, booking: s.booking, externalBookingUrl: pub.externalBookingUrl, payments: s.payments, clockIn: s.clockIn, tipTransfers: s.tipTransfers };
      }),
    }),
  );

  app.get("/api/v1/shops", (c) => c.json({ shops: world.shops.map((s) => publicShop(world, s.id)) }));
  app.get("/api/v1/shops/:shop", (c) => {
    const shop = world.shops.find((s) => s.id === c.req.param("shop") || s.slug === c.req.param("shop"));
    if (!shop) return c.json(err("not_found", "Shop not found", 404).body, 404);
    return c.json(publicShop(world, shop.id));
  });
  app.get("/api/v1/shops/:shop/services", (c) =>
    c.json({
      services: [
        { id: "svc-cut", slug: "rayz-cut", name: "Ray'z Cut", kind: "service", category: "Haircuts", description: "Cut and style", priceCents: 2900, durationMin: 40 },
        { id: "svc-kids", slug: "kidz-cut", name: "Kid'z Cut", kind: "service", category: "Haircuts", description: null, priceCents: 2600, durationMin: 30 },
        { id: "svc-beard", slug: "beard", name: "Beard Trim", kind: "service", category: "Beard", description: null, priceCents: 1800, durationMin: 20 },
      ],
      addons: [{ id: "svc-shampoo", slug: "shampoo", name: "Shampoo", kind: "addon", category: "Add-ons", description: null, priceCents: 300, durationMin: 10 }],
    }),
  );
  app.get("/api/v1/shops/:shop/barbers", (c) =>
    c.json({
      barbers: [
        { id: STAFF_MAKENNA, slug: "makenna", displayName: "Makenna", color: "#8C6B32", photoUrl: null },
        { id: STAFF_CASEY, slug: "casey", displayName: "Casey", color: "#1B6B43", photoUrl: null },
      ],
    }),
  );
  app.get("/api/v1/shops/:shop/availability", (c) => {
    const date = c.req.query("date") ?? world.today;
    const slots = [15, 16, 17, 18, 19].map((hour) => ({
      startsAt: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`,
      endsAt: `${date}T${String(hour).padStart(2, "0")}:40:00.000Z`,
      barberIds: [STAFF_MAKENNA],
    }));
    return c.json({ shopId: SHOP_CORALVILLE, date, durationMin: 40, estimateCents: 2900, slots, reason: null });
  });
  app.get("/api/v1/shops/:shop/available-days", (c) => {
    const from = c.req.query("from") ?? world.today;
    return c.json({ days: [0, 1, 2, 3, 4, 5, 6].map((n) => ({ date: new Date(Date.parse(`${from}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10), slots: 5 })) });
  });
  app.get("/api/v1/shops/:shop/live", (c) => c.json({ waitMinutes: c.req.param("shop").includes("moline") ? 25 : 10, chairsFree: 2 }));

  app.post("/api/v1/auth/otp/start", async (c) => {
    const body = await c.req.json<{ phone?: string }>();
    return c.json({ channel: "sms", expiresInSeconds: 600, devCode: CODE, destination: phone(body.phone ?? "") });
  });
  app.post("/api/v1/auth/otp/verify", async (c) => {
    const body = await c.req.json<{ phone?: string; code?: string; firstName?: string }>();
    if (body.code !== CODE) return c.json(err("unauthorized", "That code didn't match. Request a new one.", 401).body, 401);
    const p = phone(body.phone ?? "");
    const matches = customers.filter((row) => row.phone === p && !row.guardianId);
    if (matches.length > 1 && !body.firstName) {
      const token = `sel.${p}`;
      selection.set(token, p);
      return c.json({ needsProfile: false, chooseProfile: true, selectionToken: token, profiles: matches.map((row) => ({ id: row.id, firstName: row.firstName, lastInitial: row.lastName?.[0] ?? null })) });
    }
    if (!matches.length) return c.json({ needsProfile: true, selectionToken: `sel.${p}` });
    const customer = matches[0];
    return c.json({ needsProfile: false, isNew: false, accessToken: `cust.${customer.id}`, refreshToken: `ref.${customer.id}`, tokenType: "Bearer", expiresIn: 3600, customer });
  });
  app.post("/api/v1/auth/otp/complete", async (c) => {
    const body = await c.req.json<{ selectionToken?: string; customerId?: string; firstName?: string; lastName?: string }>();
    const existing = body.customerId ? customers.find((row) => row.id === body.customerId) : null;
    if (body.customerId && !existing) return c.json(err("forbidden", "That profile isn't on this phone.", 403).body, 403);
    const customer =
      existing ??
      ({
        id: crypto.randomUUID(),
        firstName: body.firstName || "Friend",
        lastName: body.lastName ?? null,
        phone: FAMILY,
        email: null,
        smsOptIn: true,
        emailOptIn: false,
        pushReminders: true,
        pushMarketing: false,
        birthYear: null,
        guardianId: null,
      } satisfies Customer);
    if (!existing) customers.push(customer);
    return c.json({ needsProfile: false, isNew: !existing, accessToken: `cust.${customer.id}`, refreshToken: `ref.${customer.id}`, tokenType: "Bearer", expiresIn: 3600, customer });
  });
  app.post("/api/v1/auth/refresh", async (c) => {
    const body = await c.req.json<{ refreshToken?: string }>();
    const id = body.refreshToken?.replace(/^ref\./, "");
    if (!id) return c.json(err("unauthorized", "Sign in again", 401).body, 401);
    return c.json({ accessToken: `cust.${id}`, refreshToken: `ref.${id}.2`, tokenType: "Bearer", expiresIn: 3600 });
  });
  app.post("/api/v1/auth/logout", (c) => c.body(null, 204));

  app.get("/api/v1/me", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json(customer);
  });
  app.patch("/api/v1/me", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    Object.assign(customer, await c.req.json());
    return c.json(customer);
  });
  app.get("/api/v1/me/home", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const upcoming = appointments.filter((a) => a.customerId === customer.id && a.status === "booked");
    const past = appointments.find((a) => a.customerId === customer.id && a.status === "completed");
    return c.json({
      nextAppointment: upcoming[0] ? presentAppointment(upcoming[0]) : null,
      rebook: past ? { code: past.code, barberName: "Makenna", serviceName: past.serviceName, weeks: 3 } : null,
      loyalty: { progressCents: 18000, thresholdCents: 30000, rewardCents: 1500, availableCents: 1500, lifetimeEarnedCents: 4500, badge: { tier: "gold", label: "Gold", color: "#8C6B32", reason: "Regular visits this season" } },
      family: family.filter((row) => row.guardianId === customer.id),
      favoriteShop: { slug: "coralville", name: "Coralville", waitMinutes: 10 },
    });
  });
  app.get("/api/v1/me/loyalty", (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json({ enabled: true, thresholdCents: 30000, rewardCents: 1500, progressCents: 18000, remainingCents: 12000, lifetimeEarnedCents: 4500, availableCents: 1500, rewards: [{ id: "rew1", amountCents: 1500, issuedAt: "2026-09-01T15:00:00.000Z", expiresAt: null }], rules: { earn: "$15 for every $300 of services", redeem: "Ask at checkout", expiry: "Rewards don't expire" } });
  });
  app.get("/api/v1/me/loyalty/ledger", (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json({ entries: [{ id: "led1", kind: "imported", label: "Imported balance", amountCents: 3000, at: "2026-08-01T15:00:00.000Z" }, { id: "led2", kind: "earned", label: "Earned", amountCents: 1500, at: "2026-09-24T17:10:00.000Z" }] });
  });
  app.get("/api/v1/me/appointments", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const mine = appointments.filter((a) => a.customerId === customer.id);
    return c.json({ upcoming: mine.filter((a) => a.status === "booked" || a.status === "confirmed").map(presentAppointment), past: mine.filter((a) => a.status === "completed" || a.status === "cancelled").map(presentAppointment) });
  });
  app.get("/api/v1/me/family", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json({ members: family.filter((row) => row.guardianId === customer.id) });
  });
  app.post("/api/v1/me/family", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const mine = family.filter((row) => row.guardianId === customer.id);
    if (mine.length >= 6) return c.json(err("bad_request", "A profile can have up to 6 family members.", 400).body, 400);
    const body = await c.req.json<{ firstName: string; birthYear?: number }>();
    const row = { id: crypto.randomUUID(), guardianId: customer.id, firstName: body.firstName, birthYear: body.birthYear ?? null };
    family.push(row);
    return c.json({ member: row }, 201);
  });
  app.delete("/api/v1/me/family/:id", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    const index = family.findIndex((row) => row.id === c.req.param("id") && row.guardianId === customer?.id);
    if (index < 0) return c.json(err("not_found", "Not found", 404).body, 404);
    family.splice(index, 1);
    return c.body(null, 204);
  });

  const presentAppointment = (a: Appointment) => {
    const shop = publicShop(world, a.shopId);
    return {
      appointment: {
        id: a.id,
        code: a.code,
        status: a.status,
        source: "app",
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        shop: { id: shop.id, slug: shop.slug, name: shop.name, address: `${shop.address}, ${shop.city}`, phone: shop.phone },
        barber: { id: a.barberId, slug: "makenna", displayName: "Makenna" },
        anyBarber: false,
        customer: { id: a.customerId, firstName: customers.find((row) => row.id === a.customerId)?.firstName ?? "Guest" },
        items: [{ serviceId: "svc-cut", kind: "service", name: a.serviceName, priceCents: a.serviceCents, durationMin: a.durationMin }],
        estimateCents: a.serviceCents,
        cancelCutoffAt: new Date(Date.parse(a.startsAt) - 30 * 60_000).toISOString(),
        canCancel: a.canCancel,
        canReschedule: a.canReschedule,
        notes: a.notes,
      },
    };
  };

  app.post("/api/v1/appointments", async (c) => {
    const key = c.req.header("idempotency-key");
    if (key && idem.has(key)) return c.json(idem.get(key), 201);
    const customer = customerOf(c.req.header("authorization"));
    const body = await c.req.json<{ shopId: string; serviceId: string; startsAt: string; notes?: string; barberId?: string; customerId?: string }>();
    const shop = world.shops.find((s) => s.id === body.shopId || s.slug === body.shopId);
    if (!shop) return c.json(err("not_found", "Unknown shop", 404).body, 404);
    if (shop.booking !== "native") {
      const pub = publicShop(world, shop.id);
      return c.json(err("conflict", "This shop isn't booking in the app yet.", 409, { bookingMode: shop.booking, externalBookingUrl: pub.externalBookingUrl }).body, 409);
    }
    const row: Appointment = {
      id: crypto.randomUUID(),
      code: `B${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "booked",
      startsAt: body.startsAt,
      endsAt: new Date(Date.parse(body.startsAt) + 40 * 60_000).toISOString(),
      shopId: shop.id,
      barberId: body.barberId || STAFF_MAKENNA,
      customerId: body.customerId && family.some((row) => row.id === body.customerId && row.guardianId === customer?.id) ? body.customerId : customer?.id ?? "guest",
      serviceName: body.serviceId === "svc-kids" ? "Kid'z Cut" : body.serviceId === "svc-beard" ? "Beard Trim" : "Ray'z Cut",
      serviceCents: body.serviceId === "svc-kids" ? 2600 : body.serviceId === "svc-beard" ? 1800 : 2900,
      durationMin: 40,
      notes: body.notes ?? "",
      canCancel: true,
      canReschedule: true,
    };
    appointments.push(row);
    const payload = presentAppointment(row);
    if (key) idem.set(key, payload);
    return c.json(payload, 201);
  });
  app.get("/api/v1/appointments/:code", (c) => {
    const row = appointments.find((a) => a.code === c.req.param("code"));
    if (!row) return c.json(err("not_found", "Appointment not found", 404).body, 404);
    return c.json(presentAppointment(row));
  });
  app.post("/api/v1/appointments/:code/cancel", (c) => {
    const row = appointments.find((a) => a.code === c.req.param("code"));
    if (!row) return c.json(err("not_found", "Appointment not found", 404).body, 404);
    if (!row.canCancel) return c.json(err("cutoff_passed", "This visit is inside the 30-minute cancellation window.", 422).body, 422);
    row.status = "cancelled";
    row.canCancel = false;
    row.canReschedule = false;
    return c.json(presentAppointment(row));
  });
  app.post("/api/v1/appointments/:code/reschedule", async (c) => {
    const row = appointments.find((a) => a.code === c.req.param("code"));
    if (!row) return c.json(err("not_found", "Appointment not found", 404).body, 404);
    if (!row.canReschedule) return c.json(err("cutoff_passed", "This visit is inside the cancellation window and can't be moved.", 422).body, 422);
    const body = await c.req.json<{ startsAt: string }>();
    row.startsAt = body.startsAt;
    row.endsAt = new Date(Date.parse(body.startsAt) + row.durationMin * 60_000).toISOString();
    return c.json(presentAppointment(row));
  });
  app.post("/api/v1/appointments/:code/rebook", (c) => {
    const row = appointments.find((a) => a.code === c.req.param("code"));
    if (!row) return c.json(err("not_found", "Appointment not found", 404).body, 404);
    const starts = new Date(Date.parse(row.startsAt) + 21 * 86400000).toISOString();
    const next: Appointment = { ...row, id: crypto.randomUUID(), code: `R${Math.random().toString(36).slice(2, 10).toUpperCase()}`, status: "booked", startsAt: starts, endsAt: new Date(Date.parse(starts) + 40 * 60_000).toISOString(), canCancel: true, canReschedule: true };
    appointments.push(next);
    return c.json(presentAppointment(next), 201);
  });

  app.post("/api/v1/me/payment-methods/setup", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const body = await c.req.json<{ funding?: "credit" | "debit" | "prepaid"; wallet?: boolean }>();
    const funding = body.funding ?? "credit";
    const card: Card = { id: `pm_${cards.length + 1}`, customerId: customer.id, brand: funding === "debit" ? "mastercard" : "visa", last4: funding === "debit" ? "5556" : "4242", funding, wallet: Boolean(body.wallet), expMonth: 12, expYear: 2030 };
    cards.push(card);
    return c.json({ paymentMethod: { id: card.id, brand: card.brand, last4: card.last4, funding: card.funding, wallet: card.wallet, expMonth: card.expMonth, expYear: card.expYear }, clientSecret: "seti_test_sandbox", customerId: `cus_${customer.id}` });
  });
  app.get("/api/v1/me/payment-methods", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json({ paymentMethods: cards.filter((card) => card.customerId === customer.id) });
  });
  app.delete("/api/v1/me/payment-methods/:id", (c) => {
    const index = cards.findIndex((card) => card.id === c.req.param("id"));
    if (index < 0) return c.json(err("not_found", "Card not found", 404).body, 404);
    cards.splice(index, 1);
    return c.body(null, 204);
  });

  const previewFor = (code: string, body: { paymentMethodId?: string; tipCents?: number; wallet?: boolean }): { status: number; body: PaymentPreview | ReturnType<typeof err>["body"] } => {
    const row = appointments.find((a) => a.code === code);
    if (!row) return { status: 404, body: err("not_found", "Appointment not found", 404).body };
    const shop = world.shops.find((s) => s.id === row.shopId)!;
    if (!shop.payments) return { status: 200, body: { shopId: shop.id, paymentsEnabled: false, unavailableCopy: "This shop isn't taking cards in the app yet.", serviceCents: row.serviceCents, taxCents: 0, tipCents: body.tipCents ?? 0, funding: null, wallet: false, feeCents: 0, feeRate: 0, feeReason: "disabled", feeLabel: null, disclosure: null, totalCents: row.serviceCents, destination: { model: "separate_charges_and_transfers", shopAccountId: null, serviceTransferCents: 0 }, tipTransfer: { amountCents: 0, disposition: "payroll", copy: "Tips paid through payroll." } } };
    const card = cards.find((item) => item.id === body.paymentMethodId);
    const funding = body.wallet ? "credit" : card?.funding ?? null;
    const taxCents = Math.round(row.serviceCents * shop.serviceTaxRate + 1e-9);
    const tipCents = body.tipCents ?? 0;
    const chargeCents = row.serviceCents + taxCents + tipCents;
    const fee = cardFeeFor({ enabled: shop.cardFeeEnabled, rate: shop.cardFeeRate, appliesToTip: shop.cardFeeAppliesToTip }, funding, { chargeCents, tipCents }, { wallet: Boolean(body.wallet), walletFeeOn: false });
    const preview: PaymentPreview = {
      shopId: shop.id,
      paymentsEnabled: true,
      unavailableCopy: null,
      serviceCents: row.serviceCents,
      taxCents,
      tipCents,
      funding,
      wallet: Boolean(body.wallet),
      feeCents: fee.feeCents,
      feeRate: fee.rate,
      feeReason: fee.reason,
      feeLabel: fee.label,
      disclosure: fee.disclosure,
      totalCents: chargeCents + fee.feeCents,
      destination: { model: "separate_charges_and_transfers", shopAccountId: `acct_shop_${shop.slug}`, serviceTransferCents: row.serviceCents + taxCents },
      tipTransfer: shop.tipTransfers ? { amountCents: tipCents, disposition: "transfer", copy: null } : { amountCents: tipCents, disposition: "payroll", copy: "Tips paid through payroll." },
    };
    return { status: 200, body: preview };
  };

  app.post("/api/v1/appointments/:code/payment-preview", async (c) => {
    const result = previewFor(c.req.param("code"), await c.req.json());
    return c.json(result.body, result.status as 200);
  });
  app.post("/api/v1/appointments/:code/payments", async (c) => {
    const key = c.req.header("idempotency-key");
    if (key && idem.has(`pay:${key}`)) return c.json(idem.get(`pay:${key}`));
    const result = previewFor(c.req.param("code"), await c.req.json());
    if (result.status !== 200 || !("totalCents" in result.body)) return c.json(result.body, result.status as 404);
    const receipt = { id: `rcpt_${c.req.param("code")}`, ...result.body, paidAt: `${world.today}T18:00:00.000Z`, tender: "card" };
    if (key) idem.set(`pay:${key}`, receipt);
    return c.json(receipt);
  });
  app.get("/api/v1/me/receipts", (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json({ receipts: [{ id: "rcpt_past", shopName: "Coralville", paidAt: "2026-09-24T17:10:00.000Z", totalCents: 3403, serviceName: "Ray'z Cut" }] });
  });
  app.get("/api/v1/me/receipts/:id", (c) => c.json({ id: c.req.param("id"), shopName: "Coralville", serviceCents: 2900, taxCents: 203, tipCents: 500, feeCents: 0, totalCents: 3603, tender: "Visa ••4242", paidAt: "2026-09-24T17:10:00.000Z", grossLabel: "Gross receipt" }));

  app.post("/api/v1/me/devices", async (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const body = await c.req.json();
    return c.json({ id: "dev1", ...body }, 201);
  });
  app.delete("/api/v1/me/devices/:id", (c) => c.body(null, 204));
  app.post("/api/v1/me/delete/start", (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json({ consequences: ["Your loyalty balance will be forfeited.", "Family members linked only to you will be removed.", "Receipts stay in the shop's books without your name."], devCode: CODE });
  });
  app.post("/api/v1/me/delete/confirm", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const body = await c.req.json<{ code?: string }>();
    if (body.code !== CODE) return c.json(err("unauthorized", "That code didn't match.", 401).body, 401);
    const index = customers.findIndex((row) => row.id === customer.id);
    if (index >= 0) customers.splice(index, 1);
    return c.json({ deleted: true });
  });

  app.post("/api/staff/v1/auth/otp/start", async (c) => {
    const body = await c.req.json<{ phone?: string }>();
    return c.json({ channel: "sms", expiresInSeconds: 600, devCode: CODE, destination: phone(body.phone ?? "") });
  });
  app.post("/api/staff/v1/auth/otp/verify", async (c) => {
    const body = await c.req.json<{ phone?: string; code?: string }>();
    if (body.code !== CODE) return c.json(err("unauthorized", "That code didn't match.", 401).body, 401);
    const staff = STAFF_LOGIN[phone(body.phone ?? "")];
    if (!staff) return c.json(err("unauthorized", "That phone isn't on the Ray'z team.", 401).body, 401);
    return c.json({ accessToken: `staff.${staff.id}`, refreshToken: `sref.${staff.id}`, tokenType: "Bearer", expiresIn: 3600, staff: { id: staff.id, firstName: staff.firstName, shops: staff.shops } });
  });
  app.post("/api/staff/v1/auth/step-up", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, gate.error.status as 401);
    const body = await c.req.json<{ pin?: string }>();
    if (body.pin !== gate.staff!.pin) return c.json(err("unauthorized", "That PIN didn't match.", 401).body, 401);
    const token = `step.${gate.staff!.id}.${sign(gate.staff!.pin)}`;
    stepUps.set(token, gate.staff!.id);
    return c.json({ stepUpToken: token, expiresIn: 600 });
  });

  app.get("/api/staff/v1/me", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    return c.json({ id: gate.staff!.id, firstName: gate.staff!.firstName, shops: gate.staff!.shops });
  });

  const earningsQuery = (c: { req: { url: string; query: (n: string) => string | undefined } }) => {
    const url = new URL(c.req.url, "http://mock.local");
    return rangeFromSearch(url.searchParams, world.today);
  };

  app.get("/api/staff/v1/me/earnings", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    if ("error" in range) return c.json(err(range.error.includes("staffId") ? "not_found" : "bad_request", range.error, range.error.includes("staffId") ? 404 : 400).body, range.error.includes("staffId") ? 404 : 400);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    return c.json(earningsFor(world, gate.staff!.id, range));
  });
  app.get("/api/staff/v1/me/earnings/days", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    if ("error" in range) return c.json(err("not_found", "error" in range ? range.error : "Bad range", 404).body, 404);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    return c.json({ from: range.from, to: range.to, days: earningsDays(world, gate.staff!.id, range) });
  });
  app.get("/api/staff/v1/me/earnings/tickets", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    if ("error" in range) return c.json(err("not_found", range.error, 404).body, 404);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const date = c.req.query("date");
    const sales = world.sales.filter((s) => s.staffId === gate.staff!.id && s.date >= range.from && s.date <= range.to && (!date || s.date === date));
    const refunds = world.adjustments.filter((a) => a.staffId === gate.staff!.id && a.kind === "card_tip_refund" && a.postedDate >= range.from && a.postedDate <= range.to);
    return c.json({
      from: range.from,
      to: range.to,
      date: date ?? null,
      tickets: sales.map((sale) => toTicket(world, sale)),
      refunds: refunds.map((row) => ({ ...row })),
    });
  });
  app.get("/api/staff/v1/me/payouts", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    if ("error" in range) return c.json(err("not_found", range.error, 404).body, 404);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const sales = world.sales.filter((s) => s.staffId === gate.staff!.id && s.date >= range.from && s.date <= range.to);
    const enabled = sales.filter((s) => world.shops.find((shop) => shop.id === s.shopId)?.tipTransfers);
    const person = world.staff.find((s) => s.id === gate.staff!.id);
    const anyOn = enabled.length > 0 || gate.staff!.shops.some((id) => world.shops.find((s) => s.id === id)?.tipTransfers);
    return c.json({
      from: range.from,
      to: range.to,
      bankLast4: person?.bankLast4 ?? null,
      tipTransfersEnabled: anyOn,
      payrollCopy: anyOn ? null : "Tips paid through payroll.",
      transfers: enabled.filter((s) => s.transfer).map((s) => ({ id: `tr_${s.id}`, saleId: s.id, shopId: s.shopId, amountCents: s.transfer!.amountCents, status: s.transfer!.status, arrivalDate: s.transfer!.arrivalDate, payoutStatus: s.payout?.status ?? null, payoutArrivalDate: s.payout?.arrivalDate ?? null })),
      payouts: enabled.filter((s) => s.payout).map((s) => ({ id: `po_${s.id}`, amountCents: s.payout!.amountCents, status: s.payout!.status, arrivalDate: s.payout!.arrivalDate, bankLast4: s.payout!.bankLast4, failureMessage: s.payout!.failureMessage, feeCents: 0, instant: false })),
    });
  });
  app.get("/api/staff/v1/me/pay-periods", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    return c.json({ periods: world.periods.map((p) => ({ ...p, current: world.today >= p.start && world.today <= p.end })) });
  });
  app.get("/api/staff/v1/me/earnings/report", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    if ("error" in range) return c.json(err("bad_request", range.error, 400).body, 400);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const earnings = earningsFor(world, gate.staff!.id, range);
    if (c.req.query("format") === "pdf") {
      const bytes = payrollPdf(earnings);
      return c.body(bytes, 200, { "content-type": "application/pdf" });
    }
    return c.body(payrollCsv(earnings), 200, { "content-type": "text/csv; charset=utf-8" });
  });
  app.post("/api/staff/v1/me/cash-tips", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ shopId: string; amountCents: number; originalDate: string; attestation?: boolean }>();
    if (!body.attestation) return c.json(err("bad_request", "Confirm these are all the cash tips for that day.", 422).body, 422);
    const row = declareCashTip(world, gate.staff!.id, { ...body, postedOn: world.today });
    return c.json({ adjustment: row }, 201);
  });

  app.get("/api/staff/v1/me/calendar", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const shopId = c.req.query("shopId") || gate.staff!.shops[0];
    return c.json({
      date: c.req.query("date") ?? world.today,
      shopId,
      appointments: appointments.filter((a) => a.shopId === shopId && a.barberId === gate.staff!.id).map((a) => ({ id: a.id, startsAt: a.startsAt, clientId: a.customerId, clientFirstName: customers.find((row) => row.id === a.customerId)?.firstName ?? "Client", serviceName: a.serviceName, status: a.status })),
    });
  });
  app.post("/api/staff/v1/appointments/:id/status", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const row = appointments.find((a) => a.id === c.req.param("id"));
    if (!row || row.barberId !== gate.staff!.id) return c.json(err("not_found", "Appointment not found", 404).body, 404);
    const body = await c.req.json<{ status: Appointment["status"] }>();
    row.status = body.status;
    return c.json({ appointment: presentAppointment(row).appointment });
  });
  app.get("/api/staff/v1/clients/:id", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const customer = customers.find((row) => row.id === c.req.param("id"));
    if (!customer) return c.json(err("not_found", "Client not found", 404).body, 404);
    return c.json({ id: customer.id, firstName: customer.firstName, lastInitial: customer.lastName?.[0] ?? "", note: "Prefers a low skin fade.", visits: 4 });
  });

  app.get("/api/staff/v1/kiosk/qr", (c) => {
    const shop = world.shops.find((s) => s.id === c.req.query("shopId") || s.slug === c.req.query("shopId"));
    if (!shop) return c.json(err("not_found", "Shop not found", 404).body, 404);
    if (!shop.clockIn) return c.json(err("conflict", "Clock-in isn't live at this shop yet.", 409).body, 409);
    return c.json(qr(shop.id));
  });
  app.post("/api/staff/v1/clock/in", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ token?: string; biometric?: unknown }>();
    if ("biometric" in body) return c.json(err("bad_request", "Clock-in does not use biometrics.", 400).body, 400);
    const shopId = body.token ? readQr(body.token) : null;
    if (!shopId) return c.json(err("bad_request", "That shop code expired. Scan the code at the shop again.", 400).body, 400);
    if (!gate.staff!.shops.includes(shopId)) return c.json(err("forbidden", "You aren't scheduled at this shop.", 403).body, 403);
    const punch: Punch = { id: crypto.randomUUID(), staffId: gate.staff!.id, shopId, inAt: new Date().toISOString(), outAt: null, cashTipCents: null, attestation: false };
    punches.push(punch);
    return c.json({ punch });
  });
  app.post("/api/staff/v1/clock/out", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ token?: string; cashTipCents?: number; attestation?: boolean; biometric?: unknown }>();
    if ("biometric" in body) return c.json(err("bad_request", "Clock-out does not use biometrics.", 400).body, 400);
    const shopId = body.token ? readQr(body.token) : null;
    if (!shopId) return c.json(err("bad_request", "That shop code expired. Scan the code at the shop again.", 400).body, 400);
    const punch = [...punches].reverse().find((row) => row.staffId === gate.staff!.id && row.shopId === shopId && !row.outAt);
    if (!punch) return c.json(err("conflict", "You aren't clocked in at this shop.", 409).body, 409);
    if ((body.cashTipCents ?? 0) > 0 && body.attestation !== true) return c.json(err("bad_request", "Confirm these are all the cash tips you received today.", 422).body, 422);
    punch.outAt = new Date().toISOString();
    punch.cashTipCents = body.cashTipCents ?? 0;
    punch.attestation = Boolean(body.attestation);
    return c.json({ punch });
  });

  app.get("/api/staff/v1/me/payout-account", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const flags = payouts.get(gate.staff!.id) ?? flagsForState("not_started");
    const state = derivePayoutState(flags);
    return c.json({
      account: {
        state,
        payoutsEnabled: flags.payoutsEnabled,
        detailsSubmitted: flags.detailsSubmitted,
        currentlyDue: flags.currentlyDue,
        pastDue: flags.pastDue,
        pendingVerification: flags.pendingVerification,
        currentDeadline: flags.currentDeadline,
        disabledReason: flags.disabledReason,
        externalLast4: flags.externalLast4,
        externalType: flags.externalType,
        instantEligible: flags.instantEligible,
        instantOptIn: flags.instantOptIn,
        collection: "embedded",
      },
    });
  });
  app.post("/api/staff/v1/me/payout-account/session", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    return c.json({ clientSecret: `acctsess_test_${gate.staff!.id}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), collection: "embedded" });
  });
  app.post("/api/staff/v1/me/payout-account/session/complete", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ state?: string }>();
    const next = flagsForState((body.state as "active") || "in_progress");
    payouts.set(gate.staff!.id, next);
    return c.json({ state: derivePayoutState(next) });
  });
  app.post("/api/staff/v1/me/instant-payouts/quote", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ amountCents: number }>();
    const feeCents = Math.max(50, Math.round(body.amountCents * 0.015));
    return c.json({ amountCents: body.amountCents, feeCents, deductedFromTipsCents: 0, arrival: "About 30 minutes" });
  });
  app.post("/api/staff/v1/me/instant-payouts", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ amountCents: number }>();
    const feeCents = Math.max(50, Math.round(body.amountCents * 0.015));
    return c.json({ id: "po_instant", amountCents: body.amountCents, feeCents, deductedFromTipsCents: 0, status: "in_transit", bankLast4: "6789", arrivalDate: world.today });
  });
  app.patch("/api/staff/v1/me/payout-preferences", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const flags = payouts.get(gate.staff!.id) ?? flagsForState("active");
    const body = await c.req.json<{ instantOptIn?: boolean }>();
    flags.instantOptIn = Boolean(body.instantOptIn);
    payouts.set(gate.staff!.id, flags);
    return c.json({ instantOptIn: flags.instantOptIn });
  });
  app.post("/api/staff/v1/me/devices", (c) => c.json({ id: "sdev1" }, 201));

  return app;
}

export { SHOP_KIMBERLY };
