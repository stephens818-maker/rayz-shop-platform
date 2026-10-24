/**
 * Everything the Add Location wizard collects, validated the same way in the browser and on the
 * server. createLocation (src/server/location-admin.ts) saves it in one transaction.
 */
import { z } from "zod";
import { ReceiptBrandingSchema, statementDescriptorProblem } from "./connect";
import { DEFAULT_SHOP_HANDOFF, ShopHandoffSchema } from "./handoff";
import { DEFAULT_HOURS, SUPPORTED_TIMEZONE } from "./location-lifecycle";
import { DEFAULT_NETWORK_RULE, NetworkRuleSchema } from "./network-access";
import { AMENITIES, TaxJurisdictionSchema, cleanAmenities, e164, socialLink, type SocialKey, type SocialLinks, SOCIAL_KEYS } from "./location-profile";

const money = z.number().int().min(0).max(10_000_00);
const minutes = z.number().int().min(0).max(24 * 60);
const rate = z.number().min(0).max(0.25);
const E164 = /^\+1[2-9]\d{9}$/;

export const DraftHours = z
  .object({ weekday: z.number().int().min(0).max(6), openMin: minutes, closeMin: minutes })
  .refine((h) => h.closeMin > h.openMin, "Closing time must be after opening time");

export const DraftService = z.object({
  serviceId: z.uuid(),
  enabled: z.boolean(),
  bookableOnline: z.boolean(),
  /** Null: the brand price. */
  priceCents: money.nullable(),
  durationMin: z.number().int().min(5).max(480).nullable(),
});

export const DraftProduct = z.object({
  productId: z.uuid(),
  priceCents: money,
  /** Null follows the brand. */
  parLevel: z.number().int().min(0).max(999).nullable(),
  lowStockThreshold: z.number().int().min(0).max(999).nullable(),
});

export const DraftStaff = z.object({
  staffId: z.uuid(),
  /** Listed for online booking here. */
  bookable: z.boolean(),
  /** Give them access to this shop in the admin (not needed for people who see every shop). */
  access: z.boolean(),
  primary: z.boolean(),
  schedule: z.array(z.object({ weekday: z.number().int().min(0).max(6), startMin: minutes, endMin: minutes })).max(14),
});

export const LocationDraft = z.object({
  name: z.string().trim().min(2, "Name the location").max(60),
  slug: z.string().trim().toLowerCase(),
  address: z.string().trim().min(1, "Enter the street address").max(120),
  city: z.string().trim().min(1, "Enter the city").max(60),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use the two-letter state"),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP"),
  address2: z.string().trim().max(80).default(""),
  /** The main phone, saved as E.164 for click-to-call. */
  phone: z
    .string()
    .trim()
    .max(25)
    .nullable()
    .transform((v, ctx) => {
      if (!v) return null;
      const n = e164(v);
      if (!n) ctx.addIssue({ code: "custom", message: "Enter the main phone as a US number, e.g. (563) 555-0100" });
      return n;
    }),
  email: z.email("Enter a valid email").nullable(),
  /** The pin, from the address lookup; without one it's geocoded when the location is saved. */
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  geocodeSource: z.enum(["google", "census", "zip", "manual"]).nullable().default(null),
  googlePlaceId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,512}$/, "A Google Place ID looks like ChIJN1t_tDeuEmsRUsoyG83frY4")
    .nullable()
    .default(null),
  social: z
    .record(z.string(), z.string())
    .default({})
    .transform((o, ctx) => {
      const out: SocialLinks = {};
      for (const [k, v] of Object.entries(o)) {
        if (!(SOCIAL_KEYS as readonly string[]).includes(k)) continue;
        const r = socialLink(k as SocialKey, v);
        if (!r.ok) ctx.addIssue({ code: "custom", message: r.message, path: [k] });
        else if (r.url) out[k as SocialKey] = r.url;
      }
      return out;
    }),
  directions: z.string().trim().max(500, "Keep the parking and directions notes under 500 characters").nullable().default(null),
  amenities: z.array(z.string()).max(AMENITIES.length).default([]).transform((a) => cleanAmenities(a)),
  /** Needs "Taxes and card fees", like the rates. */
  taxJurisdiction: TaxJurisdictionSchema.default({ county: null, city: null, district: null, code: null }),
  timezone: z.string().default(SUPPORTED_TIMEZONE),
  ownerEntityId: z.uuid().nullable(),
  description: z.string().trim().max(400).nullable(),

  hours: z.array(DraftHours).max(14).default(DEFAULT_HOURS),
  holidays: z.array(z.object({ date: z.iso.date(), reason: z.string().trim().max(60).nullable() })).max(60).default([]),

  serviceTaxRate: rate,
  productTaxRate: rate,
  /** Ticked only when someone has checked the rates with the state; until then the shop is flagged. */
  taxRatesVerified: z.boolean(),
  cardFeeEnabled: z.boolean(),
  cardFeeRate: z.number().min(0).max(0.04),
  cardFeeAppliesToTip: z.boolean(),
  tipPresets: z.array(z.number().int().min(0).max(100)).min(1).max(4),
  /** The customer screen at checkout: tip presets (null uses the brand's), tips on the reader, signature, and whose PIN takes the device back. */
  handoff: ShopHandoffSchema.default(DEFAULT_SHOP_HANDOFF),
  /** Where card money settles. Anything but the default needs the banking permission. */
  paymentsMode: z.enum(["connected", "brand", "cash_only"]).default("connected"),
  statementDescriptor: z
    .string()
    .trim()
    .toUpperCase()
    .nullable()
    .default(null)
    .transform((s) => s || null)
    .refine((s) => !statementDescriptorProblem(s), { error: (i) => statementDescriptorProblem(i.input as string) ?? "Check the statement descriptor" }),
  receipt: ReceiptBrandingSchema.default({ headline: null, footer: null, showLogo: true, showAddress: true, showPhone: true, reviewUrl: null, reviewFollowUp: { enabled: false, delayHours: 3, repeatDays: 90 }, reviewMinVisits: null, reviewSnoozeDays: null, allowPrint: false }),

  slotIntervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30)]).nullable(),
  minLeadMinutes: z.number().int().min(0).max(24 * 60),
  bookingWindowDays: z.number().int().min(1).max(365),
  cancelCutoffMinutes: z.number().int().min(0).max(7 * 24 * 60),
  bookingEnabled: z.boolean(),

  services: z.array(DraftService).max(500),
  products: z.array(DraftProduct).max(2000),
  vendors: z.array(z.object({ vendorId: z.uuid(), accountNumber: z.string().trim().max(40).nullable() })).max(100),
  staff: z.array(DraftStaff).max(100),
  /** Copy this shop's pay calendar; null uses the brand's. */
  payCalendarFromShopId: z.uuid().nullable(),
  locationGroupIds: z.array(z.uuid()).max(50),

  login: z.object({ label: z.string().trim().min(1).max(24), email: z.email().trim().toLowerCase(), roleId: z.uuid() }).nullable(),
  twilioNumber: z
    .string()
    .trim()
    .regex(E164, "Enter the Twilio number as +1 and 10 digits")
    .nullable(),
  /** With a registration code, the reader is registered to the shop's Stripe Terminal Location once the shop is saved. */
  readers: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40),
        serialNumber: z.string().trim().max(40).nullable(),
        stripeReaderId: z.string().trim().max(60).nullable().default(null),
        registrationCode: z.string().trim().max(60).nullable().default(null),
      }),
    )
    .max(20),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Pick a color like #1f2937")
    .nullable(),
  logoUrl: z.url("Enter the logo's web address").nullable(),
  /** Where staff may sign in from. Anything but off needs "Set where staff can sign in from". */
  networkAccess: NetworkRuleSchema.default(DEFAULT_NETWORK_RULE),
}).refine((v) => (v.latitude === null) === (v.longitude === null), { message: "Set both the latitude and the longitude, or neither", path: ["latitude"] });

export type LocationDraftInput = z.input<typeof LocationDraft>;
export type LocationDraftValue = z.output<typeof LocationDraft>;

/** "sku,price,par,reorder" lines pasted or uploaded in the wizard. Blank cells keep what was there. */
export function parseProductLines(text: string): { rows: { sku: string; priceCents: number | null; parLevel: number | null; lowStockThreshold: number | null }[]; errors: string[] } {
  const rows: { sku: string; priceCents: number | null; parLevel: number | null; lowStockThreshold: number | null }[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && /^sku$/i.test(cells[0])) return;
    const [sku, price, par, reorder] = cells;
    if (!sku) return void errors.push(`Line ${i + 1}: no SKU`);
    const num = (v: string | undefined, what: string, cents = false) => {
      if (v === undefined || v === "") return null;
      const n = Number(v.replace(/^\$/, ""));
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`Line ${i + 1}: ${what} "${v}" isn't a number`);
        return null;
      }
      return cents ? Math.round(n * 100) : Math.round(n);
    };
    rows.push({ sku, priceCents: num(price, "price", true), parLevel: num(par, "par"), lowStockThreshold: num(reorder, "reorder point") });
  });
  return { rows, errors };
}

/** A draft with the wizard's defaults: Mon–Sat hours, Sunday closed, taxes unconfirmed, nothing copied yet. */
export function draftDefaults(over: Partial<LocationDraftInput> & Pick<LocationDraftInput, "name" | "slug" | "address" | "city" | "state" | "zip">): LocationDraftInput {
  return {
    address2: "",
    phone: null,
    email: null,
    latitude: null,
    longitude: null,
    geocodeSource: null,
    googlePlaceId: null,
    social: {},
    directions: null,
    amenities: [],
    taxJurisdiction: { county: null, city: null, district: null, code: null },
    timezone: SUPPORTED_TIMEZONE,
    ownerEntityId: null,
    description: null,
    hours: DEFAULT_HOURS,
    holidays: [],
    serviceTaxRate: 0,
    productTaxRate: 0,
    taxRatesVerified: false,
    cardFeeEnabled: true,
    cardFeeRate: 0.03,
    cardFeeAppliesToTip: false,
    tipPresets: [20, 25, 30],
    paymentsMode: "connected",
    statementDescriptor: null,
    slotIntervalMinutes: null,
    minLeadMinutes: 15,
    bookingWindowDays: 60,
    cancelCutoffMinutes: 30,
    bookingEnabled: true,
    services: [],
    products: [],
    vendors: [],
    staff: [],
    payCalendarFromShopId: null,
    locationGroupIds: [],
    login: null,
    twilioNumber: null,
    readers: [],
    accentColor: null,
    logoUrl: null,
    networkAccess: DEFAULT_NETWORK_RULE,
    ...over,
  };
}
