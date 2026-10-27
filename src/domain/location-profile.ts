/**
 * A location's public profile, kept pure: the address and phone as clients see them, social links,
 * amenities, the sales-tax jurisdiction (for the books, never public), whether it's open now, the
 * booking deep links and widget, the schema.org JSON-LD for its public page, and the public API's
 * shapes. Edited under Settings → Location profile and in the Add Location wizard; saved by
 * src/server/location-profile.ts, served by src/server/locations-api.ts.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { googleReviewLink } from "./reviews";
import { formatTimeOfDay } from "@/lib/time-parse";

export const BRAND_NAME = "Ray'z Barber Shop";
const E164 = /^\+1[2-9]\d{9}$/;
const PLACE_ID = /^[A-Za-z0-9_-]{16,512}$/;

// ───────────────────────────── Address and phone ─────────────────────────────

export interface AddressParts {
  address: string;
  address2?: string | null;
  city: string;
  state: string;
  zip: string;
}

/** "123 Main St, Suite 2" */
export const streetLine = (a: Pick<AddressParts, "address" | "address2">) => [a.address.trim(), a.address2?.trim()].filter(Boolean).join(", ");

/** "Le Claire, IA 52753" */
export const cityLine = (a: Pick<AddressParts, "city" | "state" | "zip">) => [a.city.trim(), [a.state.trim(), a.zip.trim()].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** "123 Main St, Suite 2, Le Claire, IA 52753": receipts, calendar invites and the email footer. */
export const fullAddress = (a: AddressParts) => [streetLine(a), cityLine(a)].filter(Boolean).join(", ");

/** A US phone number as E.164, or null if it isn't one. */
export function e164(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw ?? "");
  return n && E164.test(n) ? n : null;
}

export interface PhoneView {
  e164: string;
  display: string;
  href: string;
}

/** For click-to-call (tel:) or click-to-text (sms:). A stored number that isn't E.164 is shown as typed, without a link target change. */
export function phoneView(raw: string | null | undefined, scheme: "tel" | "sms" = "tel"): PhoneView | null {
  if (!raw?.trim()) return null;
  const n = e164(raw);
  return n ? { e164: n, display: formatPhone(n), href: `${scheme}:${n}` } : { e164: raw.trim(), display: raw.trim(), href: `${scheme}:${raw.replace(/[^\d+]/g, "")}` };
}

// ───────────────────────────── Maps ─────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export const validLatLng = (p: { lat: number | null; lng: number | null } | null | undefined): p is LatLng =>
  !!p && p.lat !== null && p.lng !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0);

export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.7613;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface MapTarget extends AddressParts {
  name: string;
  googlePlaceId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

const mapQuery = (s: MapTarget) => `${BRAND_NAME.replace(" Barber Shop", "")} ${s.name}, ${fullAddress(s)}`;

/** Google Maps for the shop: the Place when we know it, otherwise the address. Opens the Maps app on phones. */
export function mapsUrl(s: MapTarget): string {
  const q = new URLSearchParams({ api: "1", query: fullAddress(s) ? mapQuery(s) : `${s.latitude},${s.longitude}` });
  if (s.googlePlaceId) q.set("query_place_id", s.googlePlaceId);
  return `https://www.google.com/maps/search/?${q}`;
}

export function directionsUrl(s: MapTarget): string {
  const q = new URLSearchParams({ api: "1", destination: fullAddress(s) ? mapQuery(s) : `${s.latitude},${s.longitude}` });
  if (s.googlePlaceId) q.set("destination_place_id", s.googlePlaceId);
  return `https://www.google.com/maps/dir/?${q}`;
}

/** An OpenStreetMap embed with a pin (no API key, no cookies). */
export function osmEmbedUrl(p: LatLng, spanDeg = 0.006): string {
  const bbox = [p.lng - spanDeg, p.lat - spanDeg * 0.6, p.lng + spanDeg, p.lat + spanDeg * 0.6].map((n) => n.toFixed(6)).join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

// ───────────────────────────── Social links ─────────────────────────────

export const SOCIAL_KEYS = ["website", "instagram", "facebook", "tiktok", "x", "youtube", "yelp"] as const;
export type SocialKey = (typeof SOCIAL_KEYS)[number];
export type SocialLinks = Partial<Record<SocialKey, string>>;

const HANDLE = /^@?([A-Za-z0-9._]{1,30})$/;

export const SOCIAL: Record<SocialKey, { label: string; placeholder: string; hosts: string[]; fromHandle?: (h: string) => string; path?: RegExp }> = {
  website: { label: "Website", placeholder: "https://rayzbarbershop.com/le-claire", hosts: [] },
  instagram: { label: "Instagram", placeholder: "@rayzbarbershop", hosts: ["instagram.com"], fromHandle: (h) => `https://www.instagram.com/${h}`, path: /^\/[A-Za-z0-9._]{1,30}\/?$/ },
  facebook: { label: "Facebook", placeholder: "facebook.com/rayzbarbershop", hosts: ["facebook.com", "fb.com"], fromHandle: (h) => `https://www.facebook.com/${h}`, path: /^\/[A-Za-z0-9.\-/_%?=]{1,120}$/ },
  tiktok: { label: "TikTok", placeholder: "@rayzbarbershop", hosts: ["tiktok.com"], fromHandle: (h) => `https://www.tiktok.com/@${h}`, path: /^\/@[A-Za-z0-9._]{1,30}\/?$/ },
  x: { label: "X (Twitter)", placeholder: "@rayzbarbershop", hosts: ["x.com", "twitter.com"], fromHandle: (h) => `https://x.com/${h}`, path: /^\/[A-Za-z0-9_]{1,15}\/?$/ },
  youtube: { label: "YouTube", placeholder: "youtube.com/@rayzbarbershop", hosts: ["youtube.com"], fromHandle: (h) => `https://www.youtube.com/@${h}`, path: /^\/(@[A-Za-z0-9._-]{1,30}|channel\/[A-Za-z0-9_-]{10,40}|c\/[A-Za-z0-9._-]{1,60})\/?$/ },
  yelp: { label: "Yelp", placeholder: "yelp.com/biz/rayz-barber-shop-le-claire", hosts: ["yelp.com"], path: /^\/biz\/[A-Za-z0-9-]{1,120}\/?$/ },
};

export type SocialLink = { ok: true; url: string | null } | { ok: false; message: string };

/**
 * One social link from what someone typed: a full link on that network (rebuilt as https, without
 * query or tracking parameters, except Facebook profile.php ids), or an @handle. The website takes
 * any http(s) address. Blank is no link.
 */
export function socialLink(key: SocialKey, raw: unknown): SocialLink {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { ok: true, url: null };
  const meta = SOCIAL[key];
  const bad = { ok: false as const, message: `That isn't a ${meta.label} link. Use ${meta.placeholder}.` };
  if (s.length > 300) return bad;
  const handle = HANDLE.exec(s);
  if (handle && meta.fromHandle && (s.startsWith("@") || !s.includes("."))) return { ok: true, url: meta.fromHandle(handle[1]) };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return bad;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return bad;
  if (u.username || u.password) return bad;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  if (key === "website") {
    if (!host.includes(".")) return bad;
    return { ok: true, url: `https://${u.host}${u.pathname === "/" ? "" : u.pathname}` };
  }
  if (!meta.hosts.includes(host) || !meta.path?.test(u.pathname)) return bad;
  const canonical = { instagram: "www.instagram.com", facebook: "www.facebook.com", tiktok: "www.tiktok.com", x: "x.com", youtube: "www.youtube.com", yelp: "www.yelp.com" }[key];
  const keep = key === "facebook" && u.pathname === "/profile.php" && /^\d+$/.test(u.searchParams.get("id") ?? "") ? `?id=${u.searchParams.get("id")}` : "";
  return { ok: true, url: `https://${canonical}${u.pathname.replace(/\/+$/, "")}${keep}` };
}

/** Stored links read defensively: anything that isn't a link on its network is dropped. */
export function socialLinks(raw: unknown): SocialLinks {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: SocialLinks = {};
  for (const k of SOCIAL_KEYS) {
    const r = socialLink(k, o[k]);
    if (r.ok && r.url) out[k] = r.url;
  }
  return out;
}

// ───────────────────────────── Amenities ─────────────────────────────

/** What a location offers. `schema` is the amenityFeature name in the JSON-LD. */
export const AMENITIES = [
  { key: "free_parking", label: "Free parking" },
  { key: "street_parking", label: "Street parking" },
  { key: "wheelchair", label: "Wheelchair accessible" },
  { key: "restroom", label: "Restroom" },
  { key: "wifi", label: "Free Wi-Fi" },
  { key: "walk_ins", label: "Walk-ins welcome" },
  { key: "kids", label: "Kids' cuts" },
  { key: "drinks", label: "Complimentary drinks" },
  { key: "tv", label: "TV" },
  { key: "cards", label: "Cards accepted" },
  { key: "contactless", label: "Apple Pay and Google Pay" },
  { key: "ev_charging", label: "EV charging nearby" },
  { key: "bike_rack", label: "Bike rack" },
  { key: "spanish", label: "Se habla español" },
] as const;
export type AmenityKey = (typeof AMENITIES)[number]["key"];
const AMENITY_KEYS = new Set<string>(AMENITIES.map((a) => a.key));
export const amenityLabel = (k: string) => AMENITIES.find((a) => a.key === k)?.label ?? k;

/** Known keys only, once each, in catalog order. */
export function cleanAmenities(raw: unknown): AmenityKey[] {
  const picked = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && AMENITY_KEYS.has(x)) : []);
  return AMENITIES.filter((a) => picked.has(a.key)).map((a) => a.key);
}

// ───────────────────────────── Sales-tax jurisdiction ─────────────────────────────

/** Where the shop's sales tax is owed beyond the state, for the books and the sales-tax report. Never public. */
export const TaxJurisdictionSchema = z.object({
  county: z.string().trim().max(60).nullable().default(null),
  city: z.string().trim().max(60).nullable().default(null),
  /** A special district (transit, local option), if any. */
  district: z.string().trim().max(60).nullable().default(null),
  /** The state's jurisdiction or location code, as the return asks for it. */
  code: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9.\- ]*$/, "Use letters, numbers, dots and dashes in the jurisdiction code")
    .nullable()
    .default(null),
});
export type TaxJurisdiction = z.output<typeof TaxJurisdictionSchema>;

export function taxJurisdiction(raw: unknown): TaxJurisdiction {
  const r = TaxJurisdictionSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  const v = r.success ? r.data : TaxJurisdictionSchema.parse({});
  return { county: v.county || null, city: v.city || null, district: v.district || null, code: v.code || null };
}

export const taxJurisdictionLabel = (state: string, j: TaxJurisdiction) => [state, j.county && `${j.county} County`.replace(/ County County$/i, " County"), j.city, j.district].filter(Boolean).join(" · ") + (j.code ? ` (${j.code})` : "");

// ───────────────────────────── The profile form ─────────────────────────────

const text = (max: number, label: string) => z.string().trim().max(max, `Keep the ${label} under ${max} characters`);

/** What Settings → Location profile and the wizard send. The tax jurisdiction is saved only by people with taxes and fees. */
export const LocationProfileInput = z.object({
  address: text(120, "street address").min(1, "Enter the street address"),
  address2: text(80, "suite or unit").default(""),
  city: text(60, "city").min(1, "Enter the city"),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use the two-letter state"),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP"),
  phone: z
    .string()
    .trim()
    .max(25)
    .default("")
    .transform((v, ctx) => {
      if (!v) return null;
      const n = e164(v);
      if (!n) ctx.addIssue({ code: "custom", message: "Enter the main phone as a US number, e.g. (563) 555-0100" });
      return n;
    }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .default("")
    .refine((v) => !v || z.email().safeParse(v).success, "Enter a valid email")
    .transform((v) => v || null),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  /** How the pin was set. A pin moved by hand is "manual"; a lookup says which. */
  geocodeSource: z.enum(["google", "census", "zip", "manual"]).nullable().default(null),
  googlePlaceId: z
    .string()
    .trim()
    .default("")
    .refine((v) => !v || PLACE_ID.test(v), "A Google Place ID looks like ChIJN1t_tDeuEmsRUsoyG83frY4")
    .transform((v) => v || null),
  /** The receipt's review link (receipt.reviewUrl): a g.page/r/… or writereview link, or a Place ID. */
  reviewUrl: z
    .string()
    .max(600)
    .default("")
    .transform((v, ctx) => {
      const r = googleReviewLink(v);
      if (r.ok) return r.url;
      ctx.addIssue({ code: "custom", message: r.message });
      return z.NEVER;
    }),
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
  directions: text(500, "parking and directions notes")
    .default("")
    .transform((v) => v || null),
  amenities: z
    .array(z.string())
    .max(AMENITIES.length)
    .default([])
    .transform((a) => cleanAmenities(a)),
  taxJurisdiction: TaxJurisdictionSchema.optional(),
}).refine((v) => (v.latitude === null) === (v.longitude === null), { message: "Set both the latitude and the longitude, or neither", path: ["latitude"] });
export type LocationProfileValue = z.output<typeof LocationProfileInput>;
export type LocationProfileForm = z.input<typeof LocationProfileInput>;

// ───────────────────────────── Photos ─────────────────────────────

export const SHOP_PHOTOS_MAX = 12;
/** A 1280px JPEG at 0.82 is well under this; the logo is smaller. */
export const SHOP_PHOTO_MAX_CHARS = 1_500_000;
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

export function shopPhotoProblem(dataUrl: string): string | null {
  if (!PHOTO.test(dataUrl) || dataUrl.length > SHOP_PHOTO_MAX_CHARS) return "Use a JPEG, PNG or WebP image under 1 MB";
  return null;
}

/** The URL a shop photo is served from. */
export const shopPhotoUrl = (base: string, slug: string, id: string) => `${base}/locations/${slug}/photos/${id}`;

// ───────────────────────────── Hours and open now ─────────────────────────────

export interface HoursRow {
  weekday: number;
  openMin: number;
  closeMin: number;
}
export interface Closure {
  date: string;
  reason: string | null;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SCHEMA_DAYS = WEEKDAY_NAMES.map((d) => `https://schema.org/${d}`);

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const clock = (min: number) => formatTimeOfDay(min);

/** Monday first, as clients read a week: "Mon: 9 AM – 7 PM", Sunday "Closed". */
export function weeklyHours(hours: readonly HoursRow[]) {
  return [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
    const rows = hours.filter((h) => h.weekday === weekday && h.closeMin > h.openMin).sort((a, b) => a.openMin - b.openMin);
    return {
      weekday,
      day: WEEKDAY_NAMES[weekday],
      ranges: rows.map((h) => ({ open: hhmm(h.openMin), close: hhmm(h.closeMin) })),
      label: rows.length ? rows.map((h) => `${clock(h.openMin)} – ${clock(h.closeMin)}`).join(", ") : "Closed",
    };
  });
}

export interface OpenStatus {
  openNow: boolean;
  /** When it closes, while open. */
  closesAt: string | null;
  /** The next time it opens, within two weeks; null while closed indefinitely. */
  nextOpenAt: string | null;
  /** Today's hours in the shop's zone ("09:00"–"19:00"), or null for a day off or closure. */
  today: { open: string; close: string }[];
  /** "Open now · until 7 PM", "Closed · opens Tue 9 AM", "Closed today: Thanksgiving". */
  label: string;
}

/**
 * Whether the shop is open at `now`, in its own time zone, from its weekly hours and closures. A
 * temporarily closed shop is closed through `closedThrough` (inclusive), or indefinitely when that's
 * "indefinite".
 */
export function openStatus(o: { hours: readonly HoursRow[]; closures: readonly Closure[]; now: Date; timezone: string; closedThrough?: string | "indefinite" | null }): OpenStatus {
  const local = DateTime.fromJSDate(o.now, { zone: o.timezone });
  const closed = new Map(o.closures.map((c) => [c.date, c.reason]));
  const isClosedDay = (date: string) => closed.has(date) || o.closedThrough === "indefinite" || (!!o.closedThrough && date <= o.closedThrough);
  const day0 = local.startOf("day");
  const todayDate = day0.toISODate()!;
  const shifts = (d: DateTime) =>
    o.hours
      .filter((h) => h.weekday === d.weekday % 7 && h.closeMin > h.openMin)
      .sort((a, b) => a.openMin - b.openMin)
      .map((h) => ({ h, start: d.plus({ minutes: h.openMin }), end: d.plus({ minutes: h.closeMin }) }));
  const today = isClosedDay(todayDate) ? [] : shifts(day0).map((s) => ({ open: hhmm(s.h.openMin), close: hhmm(s.h.closeMin) }));
  let closesAt: DateTime | null = null;
  let nextOpen: DateTime | null = null;
  if (!isClosedDay(todayDate)) for (const s of shifts(day0)) if (local >= s.start && local < s.end) closesAt = s.end;
  if (o.closedThrough !== "indefinite")
    for (let i = 0; i < 15 && !nextOpen; i++) {
      const d = day0.plus({ days: i });
      if (isClosedDay(d.toISODate()!)) continue;
      for (const s of shifts(d))
        if (s.start > local && !(closesAt && s.start <= closesAt)) {
          nextOpen = s.start;
          break;
        }
    }
  const reason = closed.get(todayDate);
  const when = (t: DateTime) => {
    const diff = Math.round(t.startOf("day").diff(day0, "days").days);
    const time = clock(t.hour * 60 + t.minute);
    return diff === 0 ? time : diff === 1 ? `tomorrow ${time}` : `${t.toFormat("ccc")} ${time}`;
  };
  const label = closesAt
    ? `Open now · until ${clock(closesAt.hour * 60 + closesAt.minute)}`
    : o.closedThrough === "indefinite"
      ? "Temporarily closed"
      : reason !== undefined
        ? `Closed today${reason ? `: ${reason}` : ""}${nextOpen ? ` · opens ${when(nextOpen)}` : ""}`
        : nextOpen
          ? `Closed · opens ${when(nextOpen)}`
          : "Closed";
  return { openNow: !!closesAt, closesAt: closesAt?.toUTC().toISO() ?? null, nextOpenAt: nextOpen?.toUTC().toISO() ?? null, today, label };
}

// ───────────────────────────── Deep links and the widget ─────────────────────────────

/** What a booking link may carry. `service` is a service's slug or ID, `barber` a barber's slug, `start` an ISO time (needs both). */
export const DEEP_LINK_PARAMS = ["service", "barber", "start", "coupon"] as const;
export type DeepLinkParams = Partial<Record<(typeof DEEP_LINK_PARAMS)[number], string | null>>;
export const APP_SCHEME = "rayz";

const qs = (p: DeepLinkParams = {}) => {
  const q = new URLSearchParams();
  for (const k of DEEP_LINK_PARAMS) if (p[k]) q.set(k, p[k]!);
  const s = q.toString();
  return s ? `?${s}` : "";
};

/**
 * The deep-link format. Web: https://<site>/book/<slug>?service=&barber=&start=&coupon= (opens the
 * booking flow at the right step). App: rayz://book/<slug>?… with the same parameters. Embedded:
 * /embed/book/<slug>?… in an iframe. The public page is /locations/<slug>.
 */
export function deepLinks(base: string, slug: string, p: DeepLinkParams = {}) {
  return {
    booking: `${base}/book/${slug}${qs(p)}`,
    app: `${APP_SCHEME}://book/${slug}${qs(p)}`,
    embed: `${base}/embed/book/${slug}${qs(p)}`,
    location: `${base}/locations/${slug}`,
  };
}

/** The snippet a website pastes: an inline booking frame, or a button that opens it over the page. */
export function widgetSnippet(base: string, slug: string | null, mode: "inline" | "button" = "inline"): string {
  const loc = slug ? ` data-location="${slug}"` : "";
  const target = mode === "inline" ? `<div data-rayz-booking${loc}></div>` : `<button type="button" data-rayz-book${loc}>Book now</button>`;
  return `${target}\n<script src="${base}/widget.js" async></script>`;
}

// ───────────────────────────── schema.org JSON-LD ─────────────────────────────

export interface JsonLdShop extends AddressParts {
  slug: string;
  name: string;
  description: string | null;
  phone: string | null;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  googlePlaceId: string | null;
  hours: readonly HoursRow[];
  closures: readonly Closure[];
  social: SocialLinks;
  amenities: readonly string[];
  photos: readonly string[];
  logo: string | null;
  bookingEnabled: boolean;
  priceRange?: string | null;
}

/** HairSalon (a LocalBusiness) for the public location page, with hours, closures, the map pin, socials and a booking action. */
export function localBusinessJsonLd(base: string, s: JsonLdShop) {
  const url = `${base}/locations/${s.slug}`;
  const pin = validLatLng({ lat: s.latitude, lng: s.longitude }) ? { lat: s.latitude!, lng: s.longitude! } : null;
  const phone = e164(s.phone);
  const byTimes = new Map<string, number[]>();
  for (const h of s.hours) {
    if (h.closeMin <= h.openMin) continue;
    const k = `${hhmm(h.openMin)}-${hhmm(Math.min(h.closeMin, 24 * 60 - 1))}`;
    byTimes.set(k, [...(byTimes.get(k) ?? []), h.weekday]);
  }
  const sameAs = Object.values(s.social).filter(Boolean);
  return {
    "@context": "https://schema.org",
    "@type": "HairSalon",
    "@id": `${url}#business`,
    name: `${BRAND_NAME.replace(" Barber Shop", "")} ${s.name}`,
    url,
    ...(s.description ? { description: s.description } : {}),
    ...(phone ? { telephone: phone } : {}),
    ...(s.email ? { email: s.email } : {}),
    ...(s.photos.length || s.logo ? { image: s.photos.length ? [...s.photos] : [s.logo] } : {}),
    ...(s.logo ? { logo: s.logo } : {}),
    address: {
      "@type": "PostalAddress",
      streetAddress: streetLine(s),
      addressLocality: s.city,
      addressRegion: s.state,
      postalCode: s.zip,
      addressCountry: "US",
    },
    ...(pin ? { geo: { "@type": "GeoCoordinates", latitude: pin.lat, longitude: pin.lng } } : {}),
    hasMap: mapsUrl({ ...s, googlePlaceId: s.googlePlaceId }),
    openingHoursSpecification: [...byTimes.entries()].map(([k, days]) => {
      const [opens, closes] = k.split("-");
      return { "@type": "OpeningHoursSpecification", dayOfWeek: [...new Set(days)].sort().map((d) => SCHEMA_DAYS[d]), opens, closes };
    }),
    ...(s.closures.length
      ? { specialOpeningHoursSpecification: s.closures.map((c) => ({ "@type": "OpeningHoursSpecification", validFrom: c.date, validThrough: c.date, opens: "00:00", closes: "00:00" })) }
      : {}),
    ...(sameAs.length ? { sameAs } : {}),
    ...(s.amenities.length ? { amenityFeature: s.amenities.map((k) => ({ "@type": "LocationFeatureSpecification", name: amenityLabel(k), value: true })) } : {}),
    priceRange: s.priceRange ?? "$$",
    currenciesAccepted: "USD",
    parentOrganization: { "@type": "Organization", name: BRAND_NAME, url: base },
    ...(s.bookingEnabled
      ? {
          potentialAction: {
            "@type": "ReserveAction",
            target: { "@type": "EntryPoint", urlTemplate: `${base}/book/${s.slug}`, actionPlatform: ["https://schema.org/DesktopWebPlatform", "https://schema.org/MobileWebPlatform"] },
            result: { "@type": "Reservation", name: "Haircut appointment" },
          },
        }
      : {}),
  };
}

/** Safe inside <script type="application/ld+json">: nothing in a shop's text can close the tag. */
export const jsonLdScript = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// ───────────────────────────── The public API ─────────────────────────────

const Phone = z.object({ e164: z.string(), display: z.string(), href: z.string() });
const Hours = z.object({ weekday: z.number().int().min(0).max(6).describe("0 = Sunday"), open: z.string().describe("HH:MM, the shop's time zone"), close: z.string() });

export const LocationSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(["live", "closed"]).describe("closed: temporarily closed (see closedNote, closedUntil)"),
  description: z.string().nullable(),
  address: z.object({ line1: z.string(), line2: z.string(), city: z.string(), state: z.string(), zip: z.string(), country: z.literal("US"), full: z.string() }),
  geo: z.object({ lat: z.number(), lng: z.number(), approximate: z.boolean().describe("True when the pin is the ZIP's centre, not the address") }).nullable(),
  distanceMiles: z.number().nullable().describe("From ?near= or ?zip=; null otherwise"),
  phone: Phone.nullable().describe("The main number, for click-to-call"),
  textNumber: Phone.nullable().describe("The shop's text-enabled number (sms: link), when it has one"),
  email: z.string().nullable(),
  timezone: z.string(),
  hours: z.array(Hours),
  weeklyHours: z.array(z.object({ weekday: z.number().int(), day: z.string(), ranges: z.array(z.object({ open: z.string(), close: z.string() })), label: z.string() })).describe("Monday first, for display"),
  closures: z.array(z.object({ date: z.iso.date(), reason: z.string().nullable() })).describe("Holiday and other closures in the next 90 days"),
  openNow: z.boolean(),
  openStatus: z.object({ closesAt: z.string().nullable(), nextOpenAt: z.string().nullable(), today: z.array(z.object({ open: z.string(), close: z.string() })), label: z.string() }),
  nextAvailable: z
    .object({ startsAt: z.string(), serviceId: z.uuid(), serviceName: z.string(), barberIds: z.array(z.uuid()), bookUrl: z.string() })
    .nullable()
    .describe("The first open slot in the next 14 days for the first online service (or ?serviceId=); null when booking is off or nothing is open"),
  bookingEnabled: z.boolean(),
  bookingMode: z.enum(["platform", "external"]).describe("external: the shop still books on its old site; send clients to externalBookingUrl"),
  externalBookingUrl: z.string().nullable(),
  closedNote: z.string().nullable(),
  closedUntil: z.string().nullable(),
  cancelCutoffMinutes: z.number().int(),
  barberCount: z.number().int(),
  links: z.object({ booking: z.string(), app: z.string(), embed: z.string(), location: z.string(), map: z.string(), directions: z.string(), review: z.string().nullable() }),
  googlePlaceId: z.string().nullable(),
  social: z.partialRecord(z.enum(SOCIAL_KEYS), z.string()),
  photos: z.array(z.object({ id: z.uuid(), url: z.string(), alt: z.string().nullable() })),
  logoUrl: z.string().nullable(),
  accentColor: z.string().nullable(),
  directions: z.string().nullable().describe("Parking and directions notes"),
  amenities: z.array(z.object({ key: z.string(), label: z.string() })),
});
export type PublicLocation = z.output<typeof LocationSchema>;
export const LocationListSchema = z.object({ locations: z.array(LocationSchema) });

export const LocationQuerySchema = z.object({
  near: z
    .string()
    .regex(/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/, "near is lat,lng")
    .optional()
    .describe("lat,lng: sorts by distance and fills distanceMiles"),
  zip: z
    .string()
    .regex(/^\d{5}$/)
    .optional()
    .describe("A ZIP instead of near"),
  radius: z.coerce.number().min(1).max(500).optional().describe("Miles; only with near or zip"),
  serviceId: z.uuid().optional().describe("For nextAvailable"),
});

const errorRef = { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const ok = (ref: string) => ({ description: "OK", content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } });
const queryParams = [
  { name: "near", in: "query", required: false, schema: { type: "string", example: "41.60,-90.43" }, description: "lat,lng: sorts by distance" },
  { name: "zip", in: "query", required: false, schema: { type: "string", example: "52753" }, description: "A ZIP instead of near" },
  { name: "radius", in: "query", required: false, schema: { type: "number" }, description: "Miles, with near or zip" },
  { name: "serviceId", in: "query", required: false, schema: { type: "string", format: "uuid" }, description: "Service for nextAvailable" },
];

/** For openApiDocument (src/server/openapi.ts): the public locations. Served by src/server/locations-api.ts, no sign-in. */
export const LOCATIONS_OPENAPI = {
  components: { Location: LocationSchema, LocationList: LocationListSchema },
  paths: {
    "/locations": {
      get: {
        tags: ["Locations"],
        summary: "Every location clients can see, with address, map pin, phone, hours, open now and the next open slot. Sorted by name, or by distance with near or zip",
        parameters: queryParams,
        responses: { 200: ok("LocationList"), 400: { description: "Bad near, zip or radius", ...errorRef } },
      },
    },
    "/locations/{slug}": {
      get: {
        tags: ["Locations"],
        summary: "One location by its booking slug (or ID)",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }, queryParams[3]],
        responses: { 200: ok("Location"), 404: { description: "No such location, or not open to clients", ...errorRef } },
      },
    },
  },
} as const;
