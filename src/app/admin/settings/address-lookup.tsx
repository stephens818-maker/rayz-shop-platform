"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { osmEmbedUrl, validLatLng } from "@/domain/location-profile";
import { addressDetailsAction, addressSuggestionsAction, geocodeAddressAction } from "./profile-actions";

export type GeocodeSource = "google" | "census" | "zip" | "manual";

export interface AddressValue {
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  latitude: number | null;
  longitude: number | null;
  geocodeSource: GeocodeSource | null;
}

/** What a picked suggestion also knows, for the caller to use if its fields are empty. */
export interface AddressExtras {
  googlePlaceId: string | null;
  phone: string | null;
}

type Suggestion = { id: string; label: string; secondary: string | null; address?: Resolved };
type Resolved = { address: string; address2?: string | null; city: string; state: string; zip: string; lat: number | null; lng: number | null; source: GeocodeSource; approximate: boolean; googlePlaceId: string | null; phone?: string | null };

const SOURCE_LABEL: Record<GeocodeSource, string> = {
  google: "Pin from Google",
  census: "Pin from the US Census geocoder",
  zip: "Approximate pin (the ZIP's centre)",
  manual: "Pin set by hand",
};

const newToken = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2));

/**
 * The street address with autocomplete (Google Places when the server has a key, the Census geocoder
 * with GEOCODER=census), the second line, city/state/ZIP, and the map pin. Picking a suggestion fills
 * the parts and the pin; "Find on map" geocodes what's typed; the latitude and longitude can be
 * corrected by hand.
 */
export function AddressLookup({
  value,
  onChange,
  onExtras,
  disabled,
  geocoder,
}: {
  value: AddressValue;
  onChange: (v: AddressValue) => void;
  onExtras?: (x: AddressExtras) => void;
  disabled?: boolean;
  geocoder: "google" | "census" | "zip";
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const token = useRef<string>(newToken());
  const typed = useRef(false);
  const seq = useRef(0);
  const set = (patch: Partial<AddressValue>) => onChange({ ...value, ...patch });

  useEffect(() => {
    if (!typed.current || geocoder === "zip" || value.address.trim().length < 4) {
      setSuggestions([]);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await addressSuggestionsAction(value.address, token.current);
      if (n === seq.current && r.ok) {
        setSuggestions(r.data);
        setOpen(r.data.length > 0);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [value.address, geocoder]);

  const apply = (a: Resolved) => {
    onChange({
      address: a.address || value.address,
      address2: a.address2 || value.address2,
      city: a.city || value.city,
      state: (a.state || value.state).toUpperCase(),
      zip: a.zip || value.zip,
      latitude: a.lat,
      longitude: a.lng,
      geocodeSource: a.lat === null ? null : a.source,
    });
    onExtras?.({ googlePlaceId: a.googlePlaceId, phone: a.phone ?? null });
    setNote(a.lat === null ? "No pin found for that address" : a.approximate ? "Only an approximate pin was found; check it below" : null);
  };

  const pick = async (s: Suggestion) => {
    typed.current = false;
    setOpen(false);
    setSuggestions([]);
    if (s.address) {
      apply(s.address);
      return;
    }
    setBusy(true);
    const r = await addressDetailsAction(s.id, token.current);
    token.current = newToken();
    setBusy(false);
    if (r.ok && r.data) apply(r.data);
    else setNote(r.ok ? "Couldn't look that address up; fill it in below" : r.error);
  };

  const find = async () => {
    setBusy(true);
    const r = await geocodeAddressAction(value);
    setBusy(false);
    if (r.ok && r.data) apply({ ...r.data, address: value.address, address2: value.address2, city: value.city, state: value.state, zip: value.zip });
    else setNote(r.ok ? "No pin found for that address. Check the ZIP, or enter the latitude and longitude." : r.error);
  };

  const coord = (k: "latitude" | "longitude") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const s = e.target.value.trim();
    const n = s === "" ? null : Number(s);
    if (n !== null && !Number.isFinite(n)) return;
    set({ [k]: n, geocodeSource: "manual" });
  };
  const pin = { lat: value.latitude, lng: value.longitude };

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="relative sm:col-span-2">
        <Field label="Street address" hint={geocoder === "zip" ? undefined : "Start typing to pick the address"}>
          <Input
            disabled={disabled}
            value={value.address}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls="address-suggestions"
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onFocus={() => setOpen(suggestions.length > 0)}
            onChange={(e) => {
              typed.current = true;
              set({ address: e.target.value });
            }}
          />
        </Field>
        {open && (
          <ul id="address-suggestions" role="listbox" className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-zinc-200 bg-white text-sm shadow-lg">
            {suggestions.map((s) => (
              <li key={s.id} role="option" aria-selected={false}>
                <button type="button" className="block w-full px-3 py-2 text-left hover:bg-zinc-50" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
                  <span className="font-medium">{s.label}</span>
                  {s.secondary && <span className="ml-1 text-zinc-500">{s.secondary}</span>}
                </button>
              </li>
            ))}
            {geocoder === "google" && <li className="px-3 py-1 text-right text-[10px] text-zinc-400">powered by Google</li>}
          </ul>
        )}
      </div>
      <Field label="Suite, unit or floor" hint="Optional">
        <Input disabled={disabled} value={value.address2} maxLength={80} onChange={(e) => set({ address2: e.target.value })} />
      </Field>
      <Field label="City">
        <Input disabled={disabled} value={value.city} onChange={(e) => set({ city: e.target.value })} />
      </Field>
      <Field label="State">
        <Input disabled={disabled} maxLength={2} value={value.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} />
      </Field>
      <Field label="ZIP">
        <Input disabled={disabled} inputMode="numeric" maxLength={10} value={value.zip} onChange={(e) => set({ zip: e.target.value })} />
      </Field>
      <Field label="Latitude">
        <Input disabled={disabled} inputMode="decimal" value={value.latitude ?? ""} onChange={coord("latitude")} />
      </Field>
      <Field label="Longitude">
        <Input disabled={disabled} inputMode="decimal" value={value.longitude ?? ""} onChange={coord("longitude")} />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
        <Button type="button" variant="secondary" size="sm" disabled={disabled || busy || !value.zip.trim()} onClick={find}>
          {busy ? "Looking up…" : "Find on map"}
        </Button>
        <span className="text-xs text-zinc-500" data-testid="pin-source">
          {validLatLng(pin) ? (value.geocodeSource ? SOURCE_LABEL[value.geocodeSource] : "Pin") : "No pin yet: it's looked up when you save"}
        </span>
        {note && <span className="text-xs text-amber-700">{note}</span>}
      </div>
      {validLatLng(pin) && (
        <iframe
          title="Map pin"
          className="h-56 w-full rounded-md border border-zinc-200 sm:col-span-2 lg:col-span-4"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={osmEmbedUrl(pin)}
        />
      )}
    </div>
  );
}
