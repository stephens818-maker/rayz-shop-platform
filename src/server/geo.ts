import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { zipPoints, type GeocodeSource } from "@/db/schema";
import type { AddressParts } from "@/domain/location-profile";

/**
 * Address autocomplete and geocoding for a location's profile. With GOOGLE_MAPS_API_KEY set it uses
 * Google Places (New) for suggestions and details (which also give the Place ID) and the Geocoding
 * API; with GEOCODER=census, the US Census geocoder (no key; matches whole addresses, no Place ID);
 * otherwise the ZIP's centre from zip_points, marked approximate. The key comes from the
 * environment only and never leaves the server.
 */
export type GeocoderName = "google" | "census" | "zip";

export function geocoderName(): GeocoderName {
  if (process.env.GOOGLE_MAPS_API_KEY?.trim()) return "google";
  if (process.env.GEOCODER === "census") return "census";
  return "zip";
}

export interface AddressSuggestion {
  /** A Google Place ID, or "census:<n>" for a Census match (its result is in `address`). */
  id: string;
  label: string;
  secondary: string | null;
  address?: ResolvedAddress;
}

export interface ResolvedAddress extends AddressParts {
  lat: number | null;
  lng: number | null;
  source: GeocodeSource;
  approximate: boolean;
  googlePlaceId: string | null;
  phone?: string | null;
}

const TIMEOUT_MS = 5000;

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!r.ok) throw new Error(`geocoder ${r.status}`);
  return r.json();
}

const key = () => process.env.GOOGLE_MAPS_API_KEY!.trim();

/** Suggestions for what's been typed so far. The ZIP fallback has none: the form keeps what's typed. */
export async function suggestAddresses(input: string, sessionToken: string | null): Promise<AddressSuggestion[]> {
  const q = input.trim();
  if (q.length < 4) return [];
  const name = geocoderName();
  try {
    if (name === "google") {
      const r = (await getJson("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key() },
        body: JSON.stringify({ input: q, includedRegionCodes: ["us"], ...(sessionToken ? { sessionToken } : {}) }),
      })) as { suggestions?: { placePrediction?: { placeId: string; text?: { text: string }; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }[] };
      return (r.suggestions ?? [])
        .map((s) => s.placePrediction)
        .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
        .slice(0, 5)
        .map((p) => ({ id: p.placeId, label: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "", secondary: p.structuredFormat?.secondaryText?.text ?? null }));
    }
    if (name === "census") {
      const matches = await censusMatches(q);
      return matches.slice(0, 5).map((m, i) => ({ id: `census:${i}`, label: m.address, secondary: [m.city, m.state, m.zip].join(" "), address: m }));
    }
  } catch (e) {
    console.error("address suggestions failed", (e as Error).message);
  }
  return [];
}

/** The chosen suggestion as address parts with its pin and Place ID. */
export async function addressDetails(placeId: string, sessionToken: string | null): Promise<ResolvedAddress | null> {
  if (geocoderName() !== "google" || !/^[A-Za-z0-9_-]{16,512}$/.test(placeId)) return null;
  try {
    const url = `https://places.googleapis.com/v1/places/${placeId}${sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : ""}`;
    const p = (await getJson(url, { headers: { "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "id,addressComponents,location,nationalPhoneNumber" } })) as {
      id: string;
      addressComponents?: { longText: string; shortText: string; types: string[] }[];
      location?: { latitude: number; longitude: number };
      nationalPhoneNumber?: string;
    };
    const part = (t: string, short = false) => {
      const c = p.addressComponents?.find((x) => x.types.includes(t));
      return c ? (short ? c.shortText : c.longText) : "";
    };
    return {
      address: [part("street_number"), part("route")].filter(Boolean).join(" "),
      address2: /^[\dA-Z]{1,6}$/.test(part("subpremise")) ? `Suite ${part("subpremise")}` : part("subpremise"),
      city: part("locality") || part("postal_town") || part("sublocality"),
      state: part("administrative_area_level_1", true),
      zip: part("postal_code"),
      lat: p.location?.latitude ?? null,
      lng: p.location?.longitude ?? null,
      source: "google",
      approximate: false,
      googlePlaceId: p.id,
      phone: p.nationalPhoneNumber ?? null,
    };
  } catch (e) {
    console.error("address details failed", (e as Error).message);
    return null;
  }
}

/** The pin for an address typed by hand: the configured lookup, or the ZIP's centre (approximate). */
export async function geocodeAddress(a: AddressParts): Promise<ResolvedAddress | null> {
  const one = [a.address, a.address2, a.city, a.state, a.zip].filter((x) => x?.trim()).join(", ");
  const name = geocoderName();
  try {
    if (name === "google") {
      const r = (await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${new URLSearchParams({ address: one, components: "country:US", key: key() })}`)) as {
        status: string;
        results?: { place_id: string; geometry: { location: { lat: number; lng: number }; location_type: string } }[];
      };
      const hit = r.results?.[0];
      if (hit) return { ...a, address2: a.address2 ?? "", lat: hit.geometry.location.lat, lng: hit.geometry.location.lng, source: "google", approximate: hit.geometry.location_type === "APPROXIMATE", googlePlaceId: hit.place_id };
    } else if (name === "census") {
      const [m] = await censusMatches(one);
      if (m) return { ...a, address2: a.address2 ?? "", lat: m.lat, lng: m.lng, source: "census", approximate: false, googlePlaceId: null };
    }
  } catch (e) {
    console.error("geocoding failed", (e as Error).message);
  }
  return zipCentre(a);
}

export async function zipCentre(a: AddressParts): Promise<ResolvedAddress | null> {
  const zip = a.zip.trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return null;
  const p = await db.query.zipPoints.findFirst({ where: eq(zipPoints.zip, zip) });
  return p ? { ...a, address2: a.address2 ?? "", lat: p.lat, lng: p.lng, source: "zip", approximate: true, googlePlaceId: null } : null;
}

async function censusMatches(oneLine: string): Promise<ResolvedAddress[]> {
  const r = (await getJson(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({ address: oneLine, benchmark: "Public_AR_Current", format: "json" })}`)) as {
    result?: { addressMatches?: { matchedAddress: string; coordinates: { x: number; y: number }; addressComponents: { city: string; state: string; zip: string } }[] };
  };
  return (r.result?.addressMatches ?? []).map((m) => {
    const street = m.matchedAddress.split(",")[0]?.trim() ?? m.matchedAddress;
    const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    return { address: title(street), address2: "", city: title(m.addressComponents.city), state: m.addressComponents.state, zip: m.addressComponents.zip, lat: m.coordinates.y, lng: m.coordinates.x, source: "census", approximate: false, googlePlaceId: null };
  });
}
