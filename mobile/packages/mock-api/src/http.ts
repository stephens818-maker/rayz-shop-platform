import { addDays, cardFeeFor, chicagoDate, clipsWorkweek, isDate, needsUpdate, rangeFromSearch, weekday, type PaymentPreview } from "@rayz/api";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { earningsDays, liveWait, payrollCsv, payrollPdf, toTicket, transfersVisible, type ShopRecord } from "./engine";
import { SHOP_CORALVILLE, SHOP_KIMBERLY, SHOP_MOLINE, STAFF_CASEY, STAFF_KAT, STAFF_MAKENNA, STAFF_RILEY } from "./fixtures";
import { derivePayoutState, flagsForState, type PayoutFlags } from "./payout";
import { createWorld, declareCashTip, earningsFor, type World } from "./world";

const FAMILY = "+13195550100";
const CODE = "123456";
const CLOSED_COPY = "Book with us at this shop the usual way.";
const NOT_READY = "This shop isn't taking cards in the app yet.";
const STEP_MS = 5 * 60 * 1000;
const STRIPE_TEST = {
  credit: { id: "pm_card_visa", brand: "visa", last4: "4242", funding: "credit" as const },
  debit: { id: "pm_card_visa_debit", brand: "visa", last4: "5556", funding: "debit" as const },
  prepaid: { id: "pm_card_mastercard_prepaid", brand: "mastercard", last4: "5100", funding: "prepaid" as const },
};

interface Customer {
  id: string;
  firstName: string;
  phone: string | null;
  email: string | null;
  smsOptIn: boolean;
  smsMarketingOptIn: boolean;
  emailOptIn: boolean;
  pushTransactional: boolean;
  pushMarketing: boolean;
  birthYear: number | null;
  guardianId: string | null;
  deletedAt: string | null;
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

interface ReceiptRefund {
  id: string;
  amountCents: number;
  serviceCents: number;
  productCents: number;
  taxCents: number;
  tipCents: number;
  shopPortionCents?: number | null;
  tipPortionCents?: number | null;
  from: "shop" | "tip" | "shop_and_tip" | null;
}

interface ReceiptSettlement {
  shopCents: number;
  tipCents: number;
  tipStatus: "executed" | "reversed" | "planned" | "with_shop";
}

interface Receipt {
  id: string;
  customerId: string;
  shopName: string;
  serviceName: string | null;
  serviceCents: number;
  taxCents: number;
  tipCents: number;
  feeCents: number;
  totalCents: number;
  tender: string;
  paidAt: string;
  grossLabel: "Gross receipt";
  barberFirstName?: string | null;
  settlement?: ReceiptSettlement | null;
  refunds: ReceiptRefund[];
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

/** Server secret for kiosk QR codes. Not derived from the device credential. */
const KIOSK_CODE_SECRET = "rayz-sandbox-kiosk-hmac-v1";
const QR_WINDOW_MS = 15_000;

interface KioskDevice {
  id: string;
  shopId: string;
  secretHash: string;
  revokedAt: string | null;
}

interface ChargeIntent {
  id: string;
  secret: string;
  customerId: string;
  code: string;
  paymentMethodId: string;
  wallet: boolean;
  tipCents: number;
  consumed: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmacHex(value: string): string {
  return createHmac("sha256", KIOSK_CODE_SECRET).update(value).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function deviceForCredential(devices: KioskDevice[], raw: string): KioskDevice | undefined {
  if (!raw) return undefined;
  const hash = sha256(raw);
  return devices.find((row) => sameHex(row.secretHash, hash));
}

function issueQr(device: KioskDevice, nowMs: number) {
  const window = Math.floor(nowMs / QR_WINDOW_MS);
  const nonce = randomBytes(16).toString("hex");
  const payload = `${device.shopId}.${device.id}.${window}.${nonce}`;
  return {
    token: `${payload}.${hmacHex(payload)}`,
    expiresAt: new Date((window + 1) * QR_WINDOW_MS).toISOString(),
    shopId: device.shopId,
    kioskId: device.id,
    rotatesSeconds: 15,
  };
}

/** Current window only. A burned nonce or a revoked device does not redeem. */
function readQr(devices: KioskDevice[], burned: Set<string>, token: string, nowMs: number): { shopId: string; kioskId: string; nonce: string } | null {
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [shopId, kioskId, windowRaw, nonce, mac] = parts;
  if (!shopId || !kioskId || !/^\d+$/.test(windowRaw) || !nonce || !mac) return null;
  const payload = `${shopId}.${kioskId}.${windowRaw}.${nonce}`;
  if (!sameHex(mac, hmacHex(payload))) return null;
  if (Number(windowRaw) !== Math.floor(nowMs / QR_WINDOW_MS)) return null;
  if (burned.has(nonce)) return null;
  const device = devices.find((row) => row.id === kioskId && row.shopId === shopId);
  if (!device || device.revokedAt) return null;
  return { shopId, kioskId, nonce };
}

function publicShop(world: World, id: string) {
  const shop = world.shops.find((s) => s.id === id || s.slug === id)!;
  const gates: Record<string, { address: string; city: string; state: string; zip: string; phone: string; close: string }> = {
    coralville: { address: "1701 2nd Street", city: "Coralville", state: "IA", zip: "52241", phone: "+13195196700", close: "18:00" },
    moline: { address: "3002 Ave of Cities", city: "Moline", state: "IL", zip: "61265", phone: "+13097640977", close: "19:00" },
    kimberly: { address: "1150 E Kimberly Rd #B", city: "Davenport", state: "IA", zip: "52807", phone: "+15633868505", close: "18:00" },
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
    bookingEnabled: bookingGate(shop) === "native",
    bookingMode: bookingGate(shop),
    externalBookingUrl: bookingGate(shop) === "external" ? shop.externalBookingUrl : null,
    cancelCutoffMinutes: 30,
    barberCount: shop.slug === "kimberly" ? 3 : 4,
    hours: (shop.openWeekdays ?? [1, 2, 3, 4, 5, 6]).map((day) => ({ weekday: day, open: "09:00", close: g.close })),
    lat: shop.slug === "coralville" ? 41.6764 : shop.slug === "moline" ? 41.5067 : 41.559,
    lng: shop.slug === "coralville" ? -91.5802 : shop.slug === "moline" ? -90.5151 : -90.5504,
    description: "Modern cuts with an old-school barbershop welcome.",
    payments: shop.launched && shop.chargesEnabled,
    clockIn: shop.clockIn,
    tipTransfers: shop.tipTransfers,
    launched: shop.launched,
    launchAt: shop.launchAt,
    closedCopy: shop.launched ? null : CLOSED_COPY,
  };
}

function bookingGate(shop: ShopRecord): "native" | "external" | "closed" {
  if (!shop.launched || shop.booking !== "native") {
    return shop.booking === "external" && shop.externalBookingUrl ? "external" : "closed";
  }
  return "native";
}

function gateRow(shop: ShopRecord, clockIn: boolean) {
  const booking = bookingGate(shop);
  return {
    id: shop.id,
    shopId: shop.id,
    slug: shop.slug,
    launched: shop.launched,
    launchAt: shop.launchAt,
    closedCopy: shop.launched ? null : CLOSED_COPY,
    booking,
    externalBookingUrl: booking === "external" ? shop.externalBookingUrl : null,
    payments: shop.launched && shop.chargesEnabled,
    clockIn,
    tipTransfers: shop.tipTransfers,
  };
}

export interface AppOptions {
  now?: () => Date;
  /** Sign-in sandbox codes stay available. Account deletion returns a dev code only when this is true. */
  devCodes?: boolean;
}

export function createApp(world = createWorld(), options: AppOptions = {}) {
  const now = () => options.now?.() ?? new Date();
  const devCodes = options.devCodes !== false;
  const customers: Customer[] = [
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", firstName: "Alex", phone: FAMILY, email: "alex@example.com", smsOptIn: true, smsMarketingOptIn: false, emailOptIn: true, pushTransactional: true, pushMarketing: false, birthYear: 1990, guardianId: null, deletedAt: null },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", firstName: "Jordan", phone: FAMILY, email: null, smsOptIn: true, smsMarketingOptIn: false, emailOptIn: false, pushTransactional: true, pushMarketing: false, birthYear: 1994, guardianId: null, deletedAt: null },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", firstName: "Sam", phone: null, email: null, smsOptIn: false, smsMarketingOptIn: false, emailOptIn: false, pushTransactional: false, pushMarketing: false, birthYear: 2016, guardianId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", deletedAt: null },
  ];
  const family = () => customers.filter((row) => row.guardianId && !row.deletedAt).map((row) => ({ id: row.id, guardianId: row.guardianId as string, firstName: row.firstName, birthYear: row.birthYear, smsOptIn: row.smsOptIn }));
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
  const receipts: Receipt[] = [
    {
      id: "rcpt_past",
      customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      shopName: "Coralville",
      serviceName: "Ray'z Cut",
      serviceCents: 2900,
      taxCents: 203,
      tipCents: 500,
      feeCents: 0,
      totalCents: 3603,
      tender: "Visa ••4242",
      paidAt: "2026-09-24T17:10:00.000Z",
      grossLabel: "Gross receipt",
      barberFirstName: "Makenna",
      settlement: { shopCents: 3103, tipCents: 500, tipStatus: "with_shop" },
      refunds: [
        { id: "rf_past", amountCents: 100, serviceCents: 100, productCents: 0, taxCents: 0, tipCents: 0, shopPortionCents: 100, tipPortionCents: 0, from: "shop" },
        { id: "rf_split", amountCents: 250, serviceCents: 150, productCents: 0, taxCents: 0, tipCents: 100, shopPortionCents: 150, tipPortionCents: 100, from: "shop_and_tip" },
      ],
    },
  ];
  (world as World & { receipts: Receipt[] }).receipts = receipts;
  const punches: Punch[] = [];
  const kiosks: KioskDevice[] = [];
  const burnedNonces = new Set<string>();
  const chargeIntents: ChargeIntent[] = [];
  const idem = new Map<string, unknown>();
  const deleteCodes = new Map<string, string>();
  const payouts = new Map<string, PayoutFlags>([
    [STAFF_MAKENNA, flagsForState("active")],
    [STAFF_KAT, flagsForState("not_started")],
    [STAFF_CASEY, flagsForState("active")],
    [STAFF_RILEY, flagsForState("not_started")],
  ]);
  const stepUps = new Map<string, { staffId: string; expiresAt: number }>();
  const selection = new Map<string, string>();

  const app = new Hono();
  app.use("*", cors());

  const customerOf = (header: string | undefined) => {
    const token = header?.replace(/^Bearer /, "") ?? "";
    if (!token.startsWith("cust.")) return null;
    const customer = customers.find((c) => c.id === token.slice(5)) ?? null;
    if (!customer || customer.deletedAt) return null;
    return customer;
  };
  const presentCustomer = (customer: Customer) => ({
    id: customer.id,
    firstName: customer.firstName,
    phone: customer.phone,
    email: customer.email,
    smsOptIn: customer.smsOptIn,
    smsMarketingOptIn: customer.smsMarketingOptIn,
    emailOptIn: customer.emailOptIn,
    pushTransactional: customer.pushTransactional,
    pushMarketing: customer.pushMarketing,
    birthYear: customer.birthYear,
    badge: null as null,
  });
  const ownsCustomer = (caller: Customer | null, customerId: string) => {
    if (!caller) return false;
    if (caller.id === customerId) return true;
    return customers.some((row) => row.id === customerId && row.guardianId === caller.id && !row.deletedAt);
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
    const row = token ? stepUps.get(token) : undefined;
    if (!row || row.staffId !== staffId || row.expiresAt <= now().getTime()) return err("step_up_required", "Enter your app PIN to view earnings.", 403);
    return null;
  };
  const noStore = (c: { header: (name: string, value: string) => void }) => {
    c.header("cache-control", "private, no-store");
  };
  const upgradeRequired = (c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status?: number) => Response }, mins: { ios: string; android: string }) => {
    const version = c.req.header("x-app-version");
    if (!version) return null;
    const platform = c.req.header("x-client") === "android" ? "android" : "ios";
    if (!needsUpdate(mins[platform], version)) return null;
    return c.json(err("upgrade_required", "Update the app to continue.", 426).body, 426);
  };
  const shopBy = (id: string | undefined) => world.shops.find((shop) => shop.id === id || shop.slug === id);
  const shopOpen = (shopId: string, isoDate: string) => publicShop(world, shopId).hours.some((row) => row.weekday === weekday(isoDate));

  const brandLaunched = world.shops.some((shop) => shop.launched);
  app.get("/api/v1/app/config", (c) => {
    const blocked = upgradeRequired(c, { ios: "3.0.0", android: "1.0.0" });
    if (blocked) return blocked;
    return c.json({
      timezone: "America/Chicago",
      timeFormat: "12h" as const,
      launched: brandLaunched,
      launchAt: brandLaunched ? "2026-01-01T00:00:00.000Z" : null,
      pilot: false,
      pilotShops: [] as string[],
      closedShopCopy: CLOSED_COPY,
      minVersion: { ios: "3.0.0", android: "1.0.0" },
      forceUpdateBelow: { ios: "3.0.0", android: "1.0.0" },
      minSupportedVersion: { ios: "3.0.0", android: "1.0.0" },
      latestVersion: { ios: "3.0.0", android: "1.0.0" },
      supportPhone: "+13195550199",
      supportEmail: "hello@rayzbs.com",
      privacyUrl: "https://rayzbs.com/privacy",
      termsUrl: "https://rayzbs.com/terms",
      deletionUrl: "https://rayzbs.com/account/delete",
      featureFlags: { payments: true, family: true, pushMarketing: false },
      shops: world.shops.map((shop) => gateRow(shop, false)),
    });
  });

  app.get("/api/staff/v1/config", (c) => {
    const blocked = upgradeRequired(c, { ios: "1.0.0", android: "1.0.0" });
    if (blocked) return blocked;
    return c.json({
      timezone: "America/Chicago",
      timeFormat: "12h" as const,
      weekStartDay: world.weekStartDay ?? 0,
      appName: "Ray'z Team",
      minSupportedVersion: { ios: "1.0.0", android: "1.0.0" },
      latestVersion: { ios: "1.0.0", android: "1.0.0" },
      tipTransfersDefault: true,
      supportPhone: "+13195550199",
      supportEmail: "team@rayzbs.com",
      privacyUrl: "https://rayzbs.com/team/privacy",
      termsUrl: "https://rayzbs.com/team/terms",
      shops: world.shops.map((shop) => gateRow(shop, shop.clockIn)),
    });
  });

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
    const shop = shopBy(c.req.param("shop"));
    if (!shop) return c.json(err("not_found", "Shop not found", 404).body, 404);
    const date = c.req.query("date") ?? world.today;
    if (!shopOpen(shop.id, date)) return c.json({ shopId: shop.id, date, durationMin: 40, estimateCents: 2900, slots: [], reason: "closed" });
    const slots = [15, 16, 17, 18, 19].map((hour) => ({
      startsAt: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`,
      endsAt: `${date}T${String(hour).padStart(2, "0")}:40:00.000Z`,
      barberIds: [STAFF_MAKENNA],
    }));
    return c.json({ shopId: shop.id, date, durationMin: 40, estimateCents: 2900, slots, reason: null });
  });
  app.get("/api/v1/shops/:shop/available-days", (c) => {
    const shop = shopBy(c.req.param("shop"));
    if (!shop) return c.json(err("not_found", "Shop not found", 404).body, 404);
    const from = c.req.query("from") ?? world.today;
    const days: { date: string; slots: number }[] = [];
    for (let n = 0; days.length < 7 && n < 21; n++) {
      const date = addDays(from, n);
      if (!shopOpen(shop.id, date)) continue;
      days.push({ date, slots: 5 });
    }
    return c.json({ days });
  });
  app.get("/api/v1/shops/:shop/live", (c) => {
    const shop = world.shops.find((row) => row.id === c.req.param("shop") || row.slug === c.req.param("shop"));
    if (!shop) return c.json(err("not_found", "Shop not found", 404).body, 404);
    const floor = world.floors.find((row) => row.shopId === shop.id);
    if (!floor) return c.json({ waitMinutes: 0, chairsFree: 0 });
    return c.json(liveWait(floor));
  });

  app.post("/api/v1/auth/otp/start", async (c) => {
    const body = await c.req.json<{ phone?: string }>();
    return c.json({ channel: "sms", expiresInSeconds: 600, devCode: CODE, destination: phone(body.phone ?? "") });
  });
  app.post("/api/v1/auth/otp/verify", async (c) => {
    const body = await c.req.json<{ phone?: string; code?: string; firstName?: string }>();
    if (body.code !== CODE) return c.json(err("unauthorized", "That code didn't match. Request a new one.", 401).body, 401);
    const p = phone(body.phone ?? "");
    const matches = customers.filter((row) => row.phone === p && !row.guardianId && !row.deletedAt);
    if (matches.length > 1 && !body.firstName) {
      const token = `sel.${crypto.randomUUID()}`;
      selection.set(token, p);
      return c.json({ needsProfile: false, chooseProfile: true, selectionToken: token, profiles: matches.map((row) => ({ id: row.id, firstName: row.firstName })) });
    }
    if (!matches.length) {
      const token = `sel.${crypto.randomUUID()}`;
      selection.set(token, p);
      return c.json({ needsProfile: true, selectionToken: token });
    }
    const customer = body.firstName ? matches.find((row) => row.firstName.toLowerCase() === body.firstName?.toLowerCase()) ?? matches[0] : matches[0];
    return c.json({ needsProfile: false, isNew: false, accessToken: `cust.${customer.id}`, refreshToken: `ref.${customer.id}`, tokenType: "Bearer", expiresIn: 3600, customer: presentCustomer(customer) });
  });
  app.post("/api/v1/auth/otp/complete", async (c) => {
    const body = await c.req.json<{ selectionToken?: string; customerId?: string; firstName?: string; birthYear?: number }>();
    if (!body.selectionToken || !selection.has(body.selectionToken)) return c.json(err("unauthorized", "Selection expired", 401).body, 401);
    const ownerPhone = selection.get(body.selectionToken)!;
    if (body.customerId) {
      const existing = customers.find((row) => row.id === body.customerId && row.phone === ownerPhone && !row.guardianId && !row.deletedAt);
      if (!existing) return c.json(err("forbidden", "That profile isn't on this phone.", 403).body, 403);
      return c.json({ needsProfile: false, isNew: false, accessToken: `cust.${existing.id}`, refreshToken: `ref.${existing.id}`, tokenType: "Bearer", expiresIn: 3600, customer: presentCustomer(existing) });
    }
    const firstName = body.firstName?.trim().split(/\s+/)[0];
    if (!firstName) return c.json(err("bad_request", "Pick a profile or tell us your first name", 400).body, 400);
    const customer: Customer = {
      id: crypto.randomUUID(),
      firstName,
      phone: ownerPhone,
      email: null,
      smsOptIn: true,
      smsMarketingOptIn: false,
      emailOptIn: false,
      pushTransactional: true,
      pushMarketing: false,
      birthYear: body.birthYear ?? null,
      guardianId: null,
      deletedAt: null,
    };
    customers.push(customer);
    return c.json({ needsProfile: false, isNew: true, accessToken: `cust.${customer.id}`, refreshToken: `ref.${customer.id}`, tokenType: "Bearer", expiresIn: 3600, customer: presentCustomer(customer) });
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
    noStore(c);
    return c.json(presentCustomer(customer));
  });
  app.patch("/api/v1/me", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const body = await c.req.json<Record<string, unknown>>();
    const turningOn = (field: "smsMarketingOptIn" | "pushTransactional" | "pushMarketing" | "emailOptIn") => body[field] === true && customer[field] !== true;
    if ((turningOn("smsMarketingOptIn") || turningOn("pushTransactional") || turningOn("pushMarketing") || turningOn("emailOptIn")) && typeof body.consentTextVersion !== "string") {
      return c.json(err("bad_request", "consentTextVersion is required to opt in.", 400).body, 400);
    }
    if (typeof body.firstName === "string" && body.firstName.trim()) customer.firstName = body.firstName.trim().split(/\s+/)[0];
    if (typeof body.email === "string") customer.email = body.email;
    if (typeof body.emailOptIn === "boolean") customer.emailOptIn = body.emailOptIn;
    if (typeof body.smsMarketingOptIn === "boolean") customer.smsMarketingOptIn = body.smsMarketingOptIn;
    if (typeof body.smsMarketing === "boolean") customer.smsMarketingOptIn = body.smsMarketing;
    if (typeof body.pushTransactional === "boolean") customer.pushTransactional = body.pushTransactional;
    if (typeof body.pushMarketing === "boolean") customer.pushMarketing = body.pushMarketing;
    if (typeof body.birthYear === "number") customer.birthYear = body.birthYear;
    if (body.smsOptIn === false) customer.smsOptIn = false;
    return c.json(presentCustomer(customer));
  });
  app.get("/api/v1/me/home", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    noStore(c);
    const upcoming = appointments.filter((a) => a.customerId === customer.id && a.status === "booked");
    const past = appointments.find((a) => a.customerId === customer.id && a.status === "completed");
    const floor = world.floors.find((row) => row.shopId === SHOP_CORALVILLE);
    const wait = floor ? liveWait(floor) : { waitMinutes: 0, chairsFree: 0 };
    return c.json({
      nextAppointment: upcoming[0] ? presentAppointment(upcoming[0]) : null,
      rebook: past ? { code: past.code, barberName: "Makenna", serviceName: past.serviceName, weeks: 3 } : null,
      loyalty: { progressCents: 18000, thresholdCents: 30000, rewardCents: 1500, availableCents: 1500, lifetimeEarnedCents: 4500, badge: null },
      family: family().filter((row) => row.guardianId === customer.id),
      favoriteShop: { slug: "coralville", name: "Coralville", waitMinutes: wait.waitMinutes },
    });
  });
  app.get("/api/v1/me/loyalty", (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    noStore(c);
    return c.json({ enabled: true, thresholdCents: 30000, rewardCents: 1500, progressCents: 18000, remainingCents: 12000, lifetimeEarnedCents: 4500, availableCents: 1500, rewards: [{ id: "rew1", amountCents: 1500, issuedAt: "2026-09-01T15:00:00.000Z", expiresAt: null }], rules: { earn: "$15 for every $300 of services", redeem: "Ask at checkout", expiry: "Rewards don't expire" } });
  });
  app.get("/api/v1/me/loyalty/ledger", (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.json({ entries: [{ id: "led1", kind: "imported", label: "Imported balance", amountCents: 3000, at: "2026-08-01T15:00:00.000Z" }, { id: "led2", kind: "earned", label: "Earned", amountCents: 1500, at: "2026-09-24T17:10:00.000Z" }] });
  });
  app.get("/api/v1/me/appointments", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    noStore(c);
    const mine = appointments.filter((a) => a.customerId === customer.id);
    return c.json({ upcoming: mine.filter((a) => a.status === "booked" || a.status === "confirmed").map(presentAppointment), past: mine.filter((a) => a.status === "completed" || a.status === "cancelled").map(presentAppointment) });
  });
  app.get("/api/v1/me/family", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    noStore(c);
    return c.json({ members: family().filter((row) => row.guardianId === customer.id).map((row) => ({ id: row.id, guardianId: row.guardianId, firstName: row.firstName, birthYear: row.birthYear })) });
  });
  app.post("/api/v1/me/family", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const mine = family().filter((row) => row.guardianId === customer.id);
    if (mine.length >= 6) return c.json(err("bad_request", "A profile can have up to 6 family members.", 400).body, 400);
    const body = await c.req.json<{ firstName: string; birthYear?: number }>();
    const firstName = body.firstName?.trim().split(/\s+/)[0] ?? "";
    if (!firstName) return c.json(err("bad_request", "First name is required.", 400).body, 400);
    const row: Customer = { id: crypto.randomUUID(), firstName, phone: null, email: null, smsOptIn: false, smsMarketingOptIn: false, emailOptIn: false, pushTransactional: false, pushMarketing: false, birthYear: body.birthYear ?? null, guardianId: customer.id, deletedAt: null };
    customers.push(row);
    return c.json({ member: { id: row.id, guardianId: customer.id, firstName: row.firstName, birthYear: row.birthYear, smsOptIn: false } }, 201);
  });
  app.delete("/api/v1/me/family/:id", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const row = customers.find((member) => member.id === c.req.param("id") && member.guardianId === customer.id && !member.deletedAt);
    if (!row) return c.json(err("not_found", "Not found", 404).body, 404);
    row.deletedAt = now().toISOString();
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
      },
    };
  };

  const requireOwnedAppointment = (c: { req: { header: (name: string) => string | undefined; param: (name: string) => string } }) => {
    const caller = customerOf(c.req.header("authorization"));
    if (!caller) return { error: err("unauthorized", "Sign in required", 401) };
    const row = appointments.find((item) => item.code === c.req.param("code") || item.id === c.req.param("code"));
    if (!row || !ownsCustomer(caller, row.customerId)) return { error: err("not_found", "Appointment not found", 404) };
    return { row, caller };
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
    if (!shopOpen(shop.id, chicagoDate(body.startsAt))) return c.json(err("slot_unavailable", "This shop is closed that day.", 409).body, 409);
    const row: Appointment = {
      id: crypto.randomUUID(),
      code: `B${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      status: "booked",
      startsAt: body.startsAt,
      endsAt: new Date(Date.parse(body.startsAt) + 40 * 60_000).toISOString(),
      shopId: shop.id,
      barberId: body.barberId || STAFF_MAKENNA,
      customerId: body.customerId && ownsCustomer(customer, body.customerId) ? body.customerId : customer?.id ?? "guest",
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
    const owned = requireOwnedAppointment(c);
    if ("error" in owned && owned.error) return c.json(owned.error.body, owned.error.status as 401);
    return c.json(presentAppointment(owned.row!));
  });
  app.post("/api/v1/appointments/:code/cancel", (c) => {
    const owned = requireOwnedAppointment(c);
    if ("error" in owned && owned.error) return c.json(owned.error.body, owned.error.status as 401);
    const row = owned.row!;
    if (!row.canCancel) return c.json(err("cutoff_passed", "This visit is inside the 30-minute cancellation window.", 422).body, 422);
    row.status = "cancelled";
    row.canCancel = false;
    row.canReschedule = false;
    return c.json(presentAppointment(row));
  });
  app.post("/api/v1/appointments/:code/reschedule", async (c) => {
    const owned = requireOwnedAppointment(c);
    if ("error" in owned && owned.error) return c.json(owned.error.body, owned.error.status as 401);
    const row = owned.row!;
    if (!row.canReschedule) return c.json(err("cutoff_passed", "This visit is inside the cancellation window and can't be moved.", 422).body, 422);
    const body = await c.req.json<{ startsAt: string }>();
    row.startsAt = body.startsAt;
    row.endsAt = new Date(Date.parse(body.startsAt) + row.durationMin * 60_000).toISOString();
    return c.json(presentAppointment(row));
  });
  app.post("/api/v1/appointments/:code/rebook", (c) => {
    const owned = requireOwnedAppointment(c);
    if ("error" in owned && owned.error) return c.json(owned.error.body, owned.error.status as 401);
    const row = owned.row!;
    const shop = world.shops.find((item) => item.id === row.shopId)!;
    if (!shop.launched || bookingGate(shop) !== "native") {
      return c.json(err("forbidden", CLOSED_COPY, 403, { reason: "not_launched" }).body, 403);
    }
    const desired = new Date(Date.parse(row.startsAt) + 21 * 86400000);
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let day = 0; day < 14; day++) {
      const date = new Date(Date.UTC(desired.getUTCFullYear(), desired.getUTCMonth(), desired.getUTCDate() + day)).toISOString().slice(0, 10);
      if (!shopOpen(shop.id, date)) continue;
      for (const hour of [15, 16, 17, 18, 19]) {
        const startsAt = `${date}T${String(hour).padStart(2, "0")}:00:00.000Z`;
        const distance = Math.abs(Date.parse(startsAt) - desired.getTime());
        if (distance < bestDistance) {
          bestDistance = distance;
          best = startsAt;
        }
      }
    }
    if (!best) return c.json(err("slot_unavailable", "No openings with this barber that day", 409).body, 409);
    const next: Appointment = { ...row, id: crypto.randomUUID(), code: `R${Math.random().toString(36).slice(2, 10).toUpperCase()}`, status: "booked", startsAt: best, endsAt: new Date(Date.parse(best) + row.durationMin * 60_000).toISOString(), canCancel: true, canReschedule: true, notes: "" };
    appointments.push(next);
    return c.json(presentAppointment(next), 201);
  });

  app.post("/api/v1/me/payment-methods/setup", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const body = await c.req.json<Record<string, unknown>>();
    for (const key of ["number", "cvc", "cvv", "pan", "cardNumber", "exp", "expiry", "expMonth", "expYear"]) {
      if (key in body) return c.json(err("bad_request", "Card numbers stay in Stripe. Use the hosted card form.", 400).body, 400);
    }
    const funding = body.funding === "debit" || body.funding === "prepaid" ? body.funding : "credit";
    const published = STRIPE_TEST[funding];
    const existing = cards.find((card) => card.id === published.id && card.customerId === customer.id);
    const card: Card = existing ?? { id: published.id, customerId: customer.id, brand: published.brand, last4: published.last4, funding: published.funding, wallet: Boolean(body.wallet), expMonth: 12, expYear: 2030 };
    if (!existing) cards.push(card);
    return c.json({
      paymentMethod: { id: card.id, brand: card.brand, last4: card.last4, funding: card.funding, wallet: card.wallet, expMonth: card.expMonth, expYear: card.expYear },
      clientSecret: `seti_test_${sign(`${customer.id}.${funding}`)}`,
      ephemeralKey: `ek_test_${sign(`${customer.id}.ek`)}`,
      customerId: `cus_sim_${customer.id.replace(/-/g, "").slice(0, 16)}`,
    });
  });
  app.get("/api/v1/me/payment-methods", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    noStore(c);
    return c.json({ paymentMethods: cards.filter((card) => card.customerId === customer.id) });
  });
  app.delete("/api/v1/me/payment-methods/:id", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const index = cards.findIndex((card) => card.id === c.req.param("id") && card.customerId === customer.id);
    if (index < 0) return c.json(err("not_found", "Card not found", 404).body, 404);
    cards.splice(index, 1);
    return c.body(null, 204);
  });

  const previewFor = (caller: Customer, code: string, body: { paymentMethodId?: string; tipCents?: number; wallet?: boolean }): { status: number; body: PaymentPreview | ReturnType<typeof err>["body"] } => {
    const row = appointments.find((a) => a.code === code);
    if (!row || !ownsCustomer(caller, row.customerId)) return { status: 404, body: err("not_found", "Appointment not found", 404).body };
    const shop = world.shops.find((s) => s.id === row.shopId)!;
    const tipCents = body.tipCents ?? 0;
    const payrollTip = { amountCents: tipCents, disposition: "payroll" as const, copy: "Tips paid through payroll." };
    const paymentsEnabled = shop.launched && shop.chargesEnabled;
    if (!paymentsEnabled) {
      return {
        status: 200,
        body: {
          shopId: shop.id,
          paymentsEnabled: false,
          unavailableCopy: shop.launched ? NOT_READY : CLOSED_COPY,
          serviceCents: row.serviceCents,
          taxCents: 0,
          tipCents,
          funding: null,
          wallet: false,
          feeCents: 0,
          feeRate: 0,
          feeReason: "disabled",
          feeLabel: null,
          disclosure: null,
          totalCents: row.serviceCents,
          destination: { model: "separate_charges_and_transfers", shopAccountId: null, serviceTransferCents: 0 },
          tipTransfer: { ...payrollTip, amountCents: 0 },
        },
      };
    }
    const card = cards.find((item) => item.id === body.paymentMethodId && item.customerId === caller.id);
    const funding = body.wallet ? "credit" : card?.funding ?? null;
    const taxCents = Math.round(row.serviceCents * shop.serviceTaxRate + 1e-9);
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
      tipTransfer: payrollTip,
    };
    return { status: 200, body: preview };
  };

  app.post("/api/v1/appointments/:code/payment-preview", async (c) => {
    const caller = customerOf(c.req.header("authorization"));
    if (!caller) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const raw = await c.req.json<Record<string, unknown>>();
    for (const key of ["number", "cvc", "pan", "cardNumber"]) {
      if (key in raw) return c.json(err("bad_request", "Card numbers stay in Stripe. Use the hosted card form.", 400).body, 400);
    }
    const result = previewFor(caller, c.req.param("code"), raw as { paymentMethodId?: string; tipCents?: number; wallet?: boolean });
    return c.json(result.body, result.status as 200);
  });
  app.post("/api/v1/appointments/:code/payment-intents", async (c) => {
    const caller = customerOf(c.req.header("authorization"));
    if (!caller) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const raw = await c.req.json<Record<string, unknown>>();
    for (const key of ["number", "cvc", "pan", "cardNumber"]) {
      if (key in raw) return c.json(err("bad_request", "Card numbers stay in Stripe. Use the hosted card form.", 400).body, 400);
    }
    const result = previewFor(caller, c.req.param("code"), raw as { paymentMethodId?: string; tipCents?: number; wallet?: boolean });
    if (result.status !== 200 || !("paymentsEnabled" in result.body)) return c.json(result.body, result.status as 404);
    const preview = result.body;
    if (!preview.paymentsEnabled) {
      const shop = world.shops.find((item) => item.id === preview.shopId);
      if (!shop?.launched) return c.json(err("forbidden", CLOSED_COPY, 403, { reason: "not_launched" }).body, 403);
      return c.json(err("payment_failed", NOT_READY, 403, { reason: "payments_not_ready" }).body, 403);
    }
    const methodId = typeof raw.paymentMethodId === "string" ? raw.paymentMethodId : "";
    const card = cards.find((item) => item.id === methodId && item.customerId === caller.id);
    if (!card) return c.json(err("bad_request", "Choose a saved card.", 400).body, 400);
    const intent: ChargeIntent = {
      id: `pi_${crypto.randomUUID()}`,
      secret: `pi_test_${randomBytes(16).toString("hex")}`,
      customerId: caller.id,
      code: c.req.param("code"),
      paymentMethodId: card.id,
      wallet: Boolean(raw.wallet),
      tipCents: preview.tipCents,
      consumed: false,
    };
    chargeIntents.push(intent);
    return c.json({
      id: intent.id,
      clientSecret: intent.secret,
      ephemeralKey: `ek_test_${sign(`${caller.id}.ek`)}`,
      customerId: `cus_sim_${caller.id.replace(/-/g, "").slice(0, 16)}`,
      paymentMethodId: card.id,
      funding: preview.funding,
      feeCents: preview.feeCents,
      totalCents: preview.totalCents,
    });
  });
  app.post("/api/v1/appointments/:code/payments", async (c) => {
    const caller = customerOf(c.req.header("authorization"));
    if (!caller) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const key = c.req.header("idempotency-key");
    if (key && idem.has(`pay:${key}`)) return c.json(idem.get(`pay:${key}`));
    const raw = await c.req.json<Record<string, unknown>>();
    const result = previewFor(caller, c.req.param("code"), raw as { paymentMethodId?: string; tipCents?: number; wallet?: boolean });
    if (result.status !== 200 || !("paymentsEnabled" in result.body)) return c.json(result.body, result.status as 404);
    const gated = result.body;
    if (!gated.paymentsEnabled) {
      const shop = world.shops.find((item) => item.id === gated.shopId);
      if (!shop?.launched) return c.json(err("forbidden", CLOSED_COPY, 403, { reason: "not_launched" }).body, 403);
      return c.json(err("payment_failed", NOT_READY, 403, { reason: "payments_not_ready" }).body, 403);
    }
    const intentId = typeof raw.paymentIntentId === "string" ? raw.paymentIntentId : "";
    const intent = chargeIntents.find((row) => row.id === intentId && row.customerId === caller.id && row.code === c.req.param("code"));
    if (!intent) return c.json(err("bad_request", "Confirm the payment sheet before charging.", 400).body, 400);
    if (intent.consumed) return c.json(err("conflict", "This payment was already confirmed.", 409).body, 409);
    const charged = previewFor(caller, c.req.param("code"), { paymentMethodId: intent.paymentMethodId, tipCents: intent.tipCents, wallet: intent.wallet });
    if (charged.status !== 200 || !("paymentsEnabled" in charged.body) || !charged.body.paymentsEnabled) return c.json(charged.body, (charged.status === 200 ? 400 : charged.status) as 400);
    const preview = charged.body;
    const card = cards.find((item) => item.id === intent.paymentMethodId && item.customerId === caller.id);
    const tender = card ? `${card.brand.charAt(0).toUpperCase()}${card.brand.slice(1)} ••${card.last4}` : "card";
    intent.consumed = true;
    const receipt: Receipt = {
      id: crypto.randomUUID(),
      customerId: caller.id,
      shopName: world.shops.find((item) => item.id === preview.shopId)?.name ?? "Ray'z",
      serviceName: appointments.find((item) => item.code === c.req.param("code"))?.serviceName ?? null,
      serviceCents: preview.serviceCents,
      taxCents: preview.taxCents,
      tipCents: preview.tipCents,
      feeCents: preview.feeCents,
      totalCents: preview.totalCents,
      tender,
      paidAt: now().toISOString(),
      grossLabel: "Gross receipt",
      refunds: [],
    };
    receipts.push(receipt);
    const paid = { id: receipt.id, ...preview, paidAt: receipt.paidAt, tender, paymentMethodId: intent.paymentMethodId };
    if (key) idem.set(`pay:${key}`, paid);
    return c.json(paid);
  });
  app.get("/api/v1/me/receipts", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
    const ids = [customer.id, ...family().filter((row) => row.guardianId === customer.id).map((row) => row.id)];
    const mine = receipts.filter((row) => ids.includes(row.customerId)).sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : a.id < b.id ? 1 : -1));
    const cursor = c.req.query("cursor");
    const start = cursor ? mine.findIndex((row) => row.id === cursor) + 1 : 0;
    const page = mine.slice(Math.max(0, start), Math.max(0, start) + limit);
    const next = mine[Math.max(0, start) + limit];
    noStore(c);
    return c.json({
      receipts: page.map((row) => ({ id: row.id, shopName: row.shopName, paidAt: row.paidAt, totalCents: row.totalCents, serviceName: row.serviceName })),
      limit,
      nextCursor: next ? page[page.length - 1]?.id ?? null : null,
    });
  });
  app.get("/api/v1/me/receipts/:id", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const ids = [customer.id, ...family().filter((row) => row.guardianId === customer.id).map((row) => row.id)];
    const receipt = receipts.find((row) => row.id === c.req.param("id") && ids.includes(row.customerId));
    noStore(c);
    if (!receipt) return c.json({ receipt: null });
    return c.json(receipt);
  });

  app.post("/api/v1/me/devices", async (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const body = await c.req.json();
    return c.json({ id: "dev1", ...body }, 201);
  });
  app.delete("/api/v1/me/devices/:id", (c) => {
    if (!customerOf(c.req.header("authorization"))) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    return c.body(null, 204);
  });
  app.post("/api/v1/me/delete/start", (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const rolled = String(Math.floor(100000 + (now().getTime() % 800000))).padStart(6, "0");
    const code = rolled === "123456" ? "654321" : rolled;
    deleteCodes.set(customer.id, code);
    const consequences = ["Your loyalty balance will be forfeited.", "Family members linked only to you will be removed.", "Receipts stay in the shop's books without your name."];
    return c.json(devCodes ? { consequences, devCode: code } : { consequences });
  });
  app.post("/api/v1/me/delete/confirm", async (c) => {
    const customer = customerOf(c.req.header("authorization"));
    if (!customer) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    const body = await c.req.json<{ code?: string }>();
    if (!body.code || body.code !== deleteCodes.get(customer.id)) return c.json(err("unauthorized", "That code didn't match.", 401).body, 401);
    customer.deletedAt = now().toISOString();
    customer.phone = null;
    customer.smsOptIn = false;
    customer.smsMarketingOptIn = false;
    customer.firstName = "Deleted";
    for (const member of customers.filter((row) => row.guardianId === customer.id && !row.phone && !row.email)) member.deletedAt = customer.deletedAt;
    deleteCodes.delete(customer.id);
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
    const token = `step.${gate.staff!.id}.${sign(`${gate.staff!.pin}.${now().getTime()}`)}`;
    stepUps.set(token, { staffId: gate.staff!.id, expiresAt: now().getTime() + STEP_MS });
    return c.json({ stepUpToken: token, expiresIn: 300 });
  });

  app.get("/api/staff/v1/me", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    noStore(c);
    return c.json({ id: gate.staff!.id, firstName: gate.staff!.firstName, shops: gate.staff!.shops });
  });

  const earningsQuery = (c: { req: { url: string; query: (n: string) => string | undefined } }) => {
    const url = new URL(c.req.url, "http://mock.local");
    return rangeFromSearch(url.searchParams, world.today);
  };
  const rangeFailure = (range: ReturnType<typeof earningsQuery>, fallback: 400 | 404) => {
    if (!("error" in range)) return null;
    const staffId = range.error.includes("staffId");
    const status = staffId ? 400 : fallback;
    return err(status === 404 ? "not_found" : "bad_request", range.error, status);
  };

  app.get("/api/staff/v1/me/earnings", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    const failed = rangeFailure(range, 400);
    if (failed) return c.json(failed.body, failed.status as 400);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    noStore(c);
    return c.json(earningsFor(world, gate.staff!.id, range as { from: string; to: string }));
  });
  app.get("/api/staff/v1/me/earnings/days", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    const failed = rangeFailure(range, 400);
    if (failed) return c.json(failed.body, failed.status as 400);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const span = range as { from: string; to: string };
    noStore(c);
    return c.json({ from: span.from, to: span.to, days: earningsDays(world, gate.staff!.id, span) });
  });
  app.get("/api/staff/v1/me/earnings/tickets", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    const failed = rangeFailure(range, 400);
    if (failed) return c.json(failed.body, failed.status as 400);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const span = range as { from: string; to: string };
    const date = c.req.query("date");
    if (date && !isDate(date)) return c.json(err("bad_request", "date must be YYYY-MM-DD.", 400).body, 400);
    const sales = world.sales.filter((s) => s.staffId === gate.staff!.id && s.date >= span.from && s.date <= span.to && (!date || chicagoDate(s.startedAt) === date));
    const refunds = world.adjustments.filter((a) => a.staffId === gate.staff!.id && a.kind === "card_tip_refund" && a.postedDate >= span.from && a.postedDate <= span.to);
    noStore(c);
    return c.json({
      from: span.from,
      to: span.to,
      date: date ?? null,
      tickets: sales.map((sale) => toTicket(world, sale)),
      refunds: refunds.map((row) => ({ ...row })),
    });
  });
  app.get("/api/staff/v1/me/payouts", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    const failed = rangeFailure(range, 400);
    if (failed) return c.json(failed.body, failed.status as 400);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const span = range as { from: string; to: string };
    const sales = world.sales.filter((s) => s.staffId === gate.staff!.id && s.date >= span.from && s.date <= span.to);
    const visibleShop = (shopId: string) => {
      const shop = world.shops.find((row) => row.id === shopId);
      return shop ? transfersVisible(shop) : false;
    };
    const enabled = sales.filter((s) => visibleShop(s.shopId) && s.transfer);
    const person = world.staff.find((s) => s.id === gate.staff!.id);
    const anyOn = gate.staff!.shops.some((id) => visibleShop(id));
    noStore(c);
    return c.json({
      from: span.from,
      to: span.to,
      bankLast4: person?.bankLast4 ?? null,
      tipTransfersEnabled: anyOn,
      payrollCopy: anyOn ? null : "Tips paid through payroll.",
      transfers: enabled.map((s) => ({ id: `tr_${s.id}`, saleId: s.id, shopId: s.shopId, amountCents: s.transfer!.amountCents, status: s.transfer!.status, arrivalDate: s.transfer!.arrivalDate, payoutStatus: s.payout?.status ?? null, payoutArrivalDate: s.payout?.arrivalDate ?? null })),
      payouts: enabled.filter((s) => s.payout).map((s) => ({ id: `po_${s.id}`, amountCents: s.payout!.amountCents, status: s.payout!.status, arrivalDate: s.payout!.arrivalDate, bankLast4: s.payout!.bankLast4, failureMessage: s.payout!.failureMessage, feeCents: 0, instant: false })),
    });
  });
  app.get("/api/staff/v1/me/pay-periods", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    noStore(c);
    return c.json({ periods: world.periods.map((p) => ({ ...p, current: world.today >= p.start && world.today <= p.end })) });
  });
  app.get("/api/staff/v1/me/earnings/report", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const range = earningsQuery(c);
    const failed = rangeFailure(range, 400);
    if (failed) return c.json(failed.body, failed.status as 400);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const span = range as { from: string; to: string };
    if (clipsWorkweek(span.from, span.to, world.weekStartDay ?? 0)) return c.json(err("bad_request", "Export a whole workweek.", 400).body, 400);
    const earnings = earningsFor(world, gate.staff!.id, span);
    noStore(c);
    if (c.req.query("format") === "pdf") {
      const bytes = payrollPdf(earnings);
      return c.body(bytes, 200, { "content-type": "application/pdf" });
    }
    return c.body(payrollCsv(earnings), 200, { "content-type": "text/csv; charset=utf-8" });
  });
  app.post("/api/staff/v1/me/cash-tips", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const body = await c.req.json<{ shopId: string; amountCents: number; originalDate: string; attestation?: boolean }>();
    if (!body.attestation) return c.json(err("bad_request", "Confirm these are all the cash tips for that day.", 422).body, 422);
    const row = declareCashTip(world, gate.staff!.id, { ...body, postedOn: world.today });
    return c.json({ adjustment: row }, 201);
  });

  app.get("/api/staff/v1/me/calendar", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const shopId = c.req.query("shopId") || gate.staff!.shops[0];
    noStore(c);
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
    const customer = customers.find((row) => row.id === c.req.param("id") && !row.deletedAt);
    const mine = customer && appointments.some((row) => row.customerId === customer.id && row.barberId === gate.staff!.id);
    if (!mine || !customer) return c.json(err("not_found", "Client not found", 404).body, 404);
    noStore(c);
    return c.json({ firstName: customer.firstName });
  });

  const clockInStaff = (staffId: string, shopId: string) => {
    const punch: Punch = { id: crypto.randomUUID(), staffId, shopId, inAt: now().toISOString(), outAt: null, cashTipCents: null, attestation: false };
    punches.push(punch);
    return punch;
  };
  const clockOutStaff = (staffId: string, shopId: string, cashTipCents: number, attestation: boolean) => {
    const punch = [...punches].reverse().find((row) => row.staffId === staffId && row.shopId === shopId && !row.outAt);
    if (!punch) return { error: err("conflict", "You aren't clocked in at this shop.", 409) };
    if (cashTipCents > 0 && !attestation) return { error: err("bad_request", "Confirm these are all the cash tips you received today.", 422) };
    punch.outAt = now().toISOString();
    punch.cashTipCents = cashTipCents;
    punch.attestation = attestation;
    return { punch };
  };
  const acceptCode = (token: string | undefined) => {
    if (!token) return null;
    const parsed = readQr(kiosks, burnedNonces, token, now().getTime());
    if (!parsed) return null;
    burnedNonces.add(parsed.nonce);
    return parsed;
  };

  app.post("/api/staff/v1/kiosk/pair", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ shopId?: string }>();
    const shop = shopBy(body.shopId);
    if (!shop) return c.json(err("not_found", "Shop not found", 404).body, 404);
    if (!shop.clockIn) return c.json(err("conflict", "Clock-in isn't live at this shop yet.", 409).body, 409);
    if (!gate.staff!.shops.includes(shop.id)) return c.json(err("forbidden", "You aren't scheduled at this shop.", 403).body, 403);
    const credential = randomBytes(32).toString("base64url");
    const row: KioskDevice = { id: crypto.randomUUID(), shopId: shop.id, secretHash: sha256(credential), revokedAt: null };
    kiosks.push(row);
    return c.json({ kioskId: row.id, credential, shopId: shop.id }, 201);
  });
  app.post("/api/staff/v1/kiosk/:id/revoke", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const device = kiosks.find((row) => row.id === c.req.param("id"));
    if (!device || !gate.staff!.shops.includes(device.shopId)) return c.json(err("not_found", "Kiosk not found", 404).body, 404);
    device.revokedAt = now().toISOString();
    return c.json({ kioskId: device.id, revoked: true });
  });
  app.get("/api/staff/v1/kiosk/qr", (c) => {
    const header = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!header) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    if (header.startsWith("staff.")) return c.json(err("forbidden", "Scan the code on the shop screen.", 403).body, 403);
    const device = deviceForCredential(kiosks, header);
    if (!device || device.revokedAt) return c.json(err("unauthorized", "This device isn't paired.", 401).body, 401);
    const requested = c.req.query("shopId");
    const shop = requested ? shopBy(requested) : shopBy(device.shopId);
    if (!shop || shop.id !== device.shopId) return c.json(err("not_found", "Shop not found", 404).body, 404);
    if (!shop.clockIn) return c.json(err("conflict", "Clock-in isn't live at this shop yet.", 409).body, 409);
    return c.json(issueQr(device, now().getTime()));
  });
  app.post("/api/staff/v1/kiosk/pin", async (c) => {
    const header = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!header) return c.json(err("unauthorized", "Sign in required", 401).body, 401);
    if (header.startsWith("staff.") || header.startsWith("cust.")) return c.json(err("forbidden", "Enter your PIN on the shop kiosk.", 403).body, 403);
    const device = deviceForCredential(kiosks, header);
    if (!device || device.revokedAt) return c.json(err("unauthorized", "This device isn't paired.", 401).body, 401);
    const shop = shopBy(device.shopId);
    if (!shop?.clockIn) return c.json(err("conflict", "Clock-in isn't live at this shop yet.", 409).body, 409);
    const body = await c.req.json<{ pin?: string; direction?: "in" | "out"; cashTipCents?: number; attestation?: boolean }>();
    const person = Object.values(STAFF_LOGIN).find((row) => row.pin === body.pin && row.shops.includes(device.shopId));
    if (!person) return c.json(err("unauthorized", "That PIN isn't on the schedule at this shop.", 401).body, 401);
    if (body.direction === "out") {
      const closed = clockOutStaff(person.id, device.shopId, body.cashTipCents ?? 0, body.attestation === true);
      if ("error" in closed && closed.error) return c.json(closed.error.body, closed.error.status as 400 | 409 | 422);
      if (!("punch" in closed)) return c.json(err("conflict", "You aren't clocked in at this shop.", 409).body, 409);
      return c.json({ punch: closed.punch });
    }
    return c.json({ punch: clockInStaff(person.id, device.shopId) });
  });
  app.post("/api/staff/v1/clock/in", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ token?: string; biometric?: unknown }>();
    if ("biometric" in body) return c.json(err("bad_request", "Clock-in does not use biometrics.", 400).body, 400);
    const code = acceptCode(body.token);
    if (!code) return c.json(err("bad_request", "That shop code expired. Scan the code at the shop again.", 400).body, 400);
    if (!gate.staff!.shops.includes(code.shopId)) return c.json(err("forbidden", "You aren't scheduled at this shop.", 403).body, 403);
    return c.json({ punch: clockInStaff(gate.staff!.id, code.shopId) });
  });
  app.post("/api/staff/v1/clock/out", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const body = await c.req.json<{ token?: string; cashTipCents?: number; attestation?: boolean; biometric?: unknown }>();
    if ("biometric" in body) return c.json(err("bad_request", "Clock-out does not use biometrics.", 400).body, 400);
    const code = acceptCode(body.token);
    if (!code) return c.json(err("bad_request", "That shop code expired. Scan the code at the shop again.", 400).body, 400);
    const closed = clockOutStaff(gate.staff!.id, code.shopId, body.cashTipCents ?? 0, body.attestation === true);
    if ("error" in closed && closed.error) return c.json(closed.error.body, closed.error.status as 400 | 409 | 422);
    if (!("punch" in closed) || !closed.punch) return c.json(err("conflict", "You aren't clocked in at this shop.", 409).body, 409);
    return c.json({ punch: closed.punch });
  });

  app.get("/api/staff/v1/me/payout-account", (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    noStore(c);
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
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    noStore(c);
    return c.json({ clientSecret: `acctsess_test_${gate.staff!.id}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), collection: "embedded" });
  });
  app.post("/api/staff/v1/me/payout-account/session/complete", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    noStore(c);
    const body = await c.req.json<{ state?: string }>();
    const next = flagsForState((body.state as "active") || "in_progress");
    payouts.set(gate.staff!.id, next);
    return c.json({ state: derivePayoutState(next) });
  });
  app.post("/api/staff/v1/me/instant-payouts/quote", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const body = await c.req.json<{ amountCents: number }>();
    const feeCents = Math.max(50, Math.round(body.amountCents * 0.015));
    return c.json({ amountCents: body.amountCents, feeCents, deductedFromTipsCents: 0, arrival: "About 30 minutes" });
  });
  app.post("/api/staff/v1/me/instant-payouts", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const body = await c.req.json<{ amountCents: number }>();
    const feeCents = Math.max(50, Math.round(body.amountCents * 0.015));
    return c.json({ id: "po_instant", amountCents: body.amountCents, feeCents, deductedFromTipsCents: 0, status: "in_transit", bankLast4: "6789", arrivalDate: world.today });
  });
  app.patch("/api/staff/v1/me/payout-preferences", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    const step = requireStep(c, gate.staff!.id);
    if (step) return c.json(step.body, 403);
    const flags = payouts.get(gate.staff!.id) ?? flagsForState("active");
    const body = await c.req.json<{ instantOptIn?: boolean }>();
    flags.instantOptIn = Boolean(body.instantOptIn);
    payouts.set(gate.staff!.id, flags);
    return c.json({ instantOptIn: flags.instantOptIn });
  });
  app.post("/api/staff/v1/me/devices", async (c) => {
    const gate = requireStaff(c);
    if ("error" in gate && gate.error) return c.json(gate.error.body, 401);
    return c.json({ id: "sdev1" }, 201);
  });

  return app;
}

export { SHOP_KIMBERLY };
