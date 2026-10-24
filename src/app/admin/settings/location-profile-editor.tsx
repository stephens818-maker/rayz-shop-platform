"use client";

import { useRef, useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import {
  AMENITIES,
  SHOP_PHOTOS_MAX,
  SOCIAL,
  SOCIAL_KEYS,
  deepLinks,
  e164,
  phoneView,
  socialLink,
  taxJurisdictionLabel,
  widgetSnippet,
  type TaxJurisdiction,
} from "@/domain/location-profile";
import { googleReviewLink } from "@/domain/reviews";
import { AddressLookup, type AddressValue, type GeocodeSource } from "./address-lookup";
import { SaveBar, useSave } from "./editors";
import { addShopPhotoAction, moveShopPhotoAction, removeShopPhotoAction, saveLocationProfileAction } from "./profile-actions";

export interface LocationProfileInitial extends AddressValue {
  phone: string;
  email: string;
  googlePlaceId: string;
  reviewUrl: string;
  social: Record<string, string>;
  directions: string;
  amenities: string[];
  taxJurisdiction: TaxJurisdiction;
}

type Photo = { id: string; alt: string | null };

/**
 * Settings → Location profile: the address (autocomplete, pin), the main phone, email, Google Place ID
 * and review link, social links, parking and directions, amenities and the sales-tax jurisdiction.
 */
export function LocationProfileEditor({
  shopId,
  initial,
  geocoder,
  textNumber,
  canReview,
  canTaxes,
}: {
  shopId: string;
  initial: LocationProfileInitial;
  geocoder: "google" | "census" | "zip";
  textNumber: string | null;
  canReview: boolean;
  canTaxes: boolean;
}) {
  const { pending, msg, save } = useSave();
  const [v, setV] = useState(initial);
  const set = (p: Partial<LocationProfileInitial>) => setV({ ...v, ...p });
  const phone = v.phone.trim() ? e164(v.phone) : null;
  const review = googleReviewLink(v.reviewUrl);
  const text = phoneView(textNumber, "sms");
  const tax = v.taxJurisdiction;
  const setTax = (p: Partial<TaxJurisdiction>) => set({ taxJurisdiction: { ...tax, ...p } });

  const submit = () =>
    save(() =>
      saveLocationProfileAction(shopId, {
        ...v,
        geocodeSource: v.geocodeSource as GeocodeSource | null,
        ...(canTaxes ? {} : { taxJurisdiction: undefined }),
      }),
    );

  return (
    <Card>
      <CardHeader title="Location profile" subtitle="The address, phone and details clients see on the location page, in the booking widget and app, and in confirmations, reminders, receipts and calendar invites." />
      <div className="space-y-5 p-4">
        <AddressLookup
          geocoder={geocoder}
          value={v}
          onChange={(a) => setV({ ...v, ...a })}
          onExtras={(x) =>
            setV((cur) => ({ ...cur, googlePlaceId: cur.googlePlaceId || x.googlePlaceId || "", phone: cur.phone || (x.phone ?? "") }))
          }
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Main phone"
            hint={
              v.phone.trim() && !phone ? (
                <span className="text-red-600">Enter a US number, e.g. (563) 555-0100</span>
              ) : phone ? (
                <>
                  Saved as {phone} ·{" "}
                  <a className="underline" href={`tel:${phone}`}>
                    test call
                  </a>
                </>
              ) : (
                "Shown with a tap-to-call button"
              )
            }
          >
            <Input inputMode="tel" value={v.phone} onChange={(e) => set({ phone: e.target.value })} data-testid="profile-phone" />
          </Field>
          <Field label="Text-enabled number" hint="The shop's Twilio line, set under Shop & online booking">
            <Input disabled value={text?.display ?? "Not set up"} />
          </Field>
          <Field label="Email" className="sm:col-span-2">
            <Input type="email" value={v.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="Google Place ID" hint={geocoder === "google" ? "Filled in when you pick the address" : "From Google's Place ID finder"} className="sm:col-span-2">
            <div className="flex gap-2">
              <Input value={v.googlePlaceId} placeholder="ChIJ…" onChange={(e) => set({ googlePlaceId: e.target.value.trim() })} />
              {canReview && v.googlePlaceId && !v.reviewUrl.trim() && (
                <Button type="button" variant="secondary" size="sm" onClick={() => set({ reviewUrl: v.googlePlaceId })}>
                  Use for reviews
                </Button>
              )}
            </div>
          </Field>
          <Field
            label="Google review link"
            className="sm:col-span-2"
            hint={
              !canReview ? (
                "Changed by people who manage checkout and receipts"
              ) : !review.ok ? (
                <span className="text-red-600">{review.message}</span>
              ) : review.url ? (
                <a className="break-all underline" href={review.url} target="_blank" rel="noopener noreferrer">
                  {review.url}
                </a>
              ) : (
                "Blank hides Leave a review on receipts"
              )
            }
          >
            <Input disabled={!canReview} inputMode="url" value={v.reviewUrl} placeholder="g.page/r/…/review, or the Place ID" onChange={(e) => set({ reviewUrl: e.target.value })} />
          </Field>
        </div>

        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="mb-2 text-sm font-medium text-zinc-900">Social links</legend>
          {SOCIAL_KEYS.map((k) => {
            const r = socialLink(k, v.social[k]);
            return (
              <Field key={k} label={SOCIAL[k].label} hint={!r.ok ? <span className="text-red-600">{r.message}</span> : r.url ? <span className="break-all">{r.url}</span> : undefined}>
                <Input value={v.social[k] ?? ""} placeholder={SOCIAL[k].placeholder} onChange={(e) => set({ social: { ...v.social, [k]: e.target.value } })} />
              </Field>
            );
          })}
        </fieldset>

        <Field label="Parking and directions" hint="On the location page, the booking confirmation and calendar invites. Up to 500 characters.">
          <Textarea rows={2} maxLength={500} value={v.directions} placeholder="Free parking behind the building; enter from Cody Rd." onChange={(e) => set({ directions: e.target.value })} />
        </Field>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-zinc-900">Amenities</legend>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {AMENITIES.map((a) => (
              <label key={a.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={v.amenities.includes(a.key)}
                  onChange={(e) => set({ amenities: e.target.checked ? [...v.amenities, a.key] : v.amenities.filter((x) => x !== a.key) })}
                />
                {a.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <legend className="mb-1 text-sm font-medium text-zinc-900">
            Sales-tax jurisdiction <span className="font-normal text-zinc-500">· for the books and the sales-tax report, never shown to clients</span>
          </legend>
          <Field label="County">
            <Input disabled={!canTaxes} value={tax.county ?? ""} onChange={(e) => setTax({ county: e.target.value })} />
          </Field>
          <Field label="City">
            <Input disabled={!canTaxes} value={tax.city ?? ""} onChange={(e) => setTax({ city: e.target.value })} />
          </Field>
          <Field label="Special district" hint="Transit or local option, if any">
            <Input disabled={!canTaxes} value={tax.district ?? ""} onChange={(e) => setTax({ district: e.target.value })} />
          </Field>
          <Field label="Jurisdiction code" hint="As the state return asks for it">
            <Input disabled={!canTaxes} value={tax.code ?? ""} onChange={(e) => setTax({ code: e.target.value })} />
          </Field>
          <p className="text-xs text-zinc-500 sm:col-span-2 lg:col-span-4">
            {canTaxes ? taxJurisdictionLabel(v.state, tax) : "Changed by people who set taxes and card fees."}
          </p>
        </fieldset>
      </div>
      <SaveBar pending={pending} msg={msg} onClick={submit} disabled={(!!v.phone.trim() && !phone) || !review.ok} />
    </Card>
  );
}

async function shrinkImage(file: File, max: number, type: "image/jpeg" | "image/png"): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The logo and up to 12 photos for the public location page (the first photo is its header). */
export function LocationPhotosEditor({ shopId, photos, logo }: { shopId: string; photos: Photo[]; logo: Photo | null }) {
  const { pending, msg, save } = useSave();
  const [alt, setAlt] = useState("");
  const photoRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const src = (id: string) => `/admin/settings/photos/${id}`;
  const upload = (kind: "photo" | "logo") => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const dataUrl = await shrinkImage(f, kind === "logo" ? 512 : 1280, kind === "logo" ? "image/png" : "image/jpeg");
    save(() => addShopPhotoAction(shopId, { kind, dataUrl, alt: kind === "photo" ? alt : "Logo" }), kind === "logo" ? "Logo uploaded" : "Photo added");
    setAlt("");
  };
  return (
    <Card>
      <CardHeader title="Photos and logo" subtitle={`On the public location page and the booking widget. Up to ${SHOP_PHOTOS_MAX} photos; the first is the page's header.`} />
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-4">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src(logo.id)} alt="Logo" className="h-16 w-16 rounded-md border border-zinc-200 object-contain" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-400">No logo</div>
          )}
          <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={upload("logo")} />
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => logoRef.current?.click()}>
            {logo ? "Replace logo" : "Upload logo"}
          </Button>
          {logo && (
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => save(() => removeShopPhotoAction(logo.id), "Logo removed")}>
              Remove
            </Button>
          )}
          <span className="text-xs text-zinc-500">Replaces the logo web address under Booking link and branding.</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {photos.map((p, i) => (
            <figure key={p.id} className="overflow-hidden rounded-md border border-zinc-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src(p.id)} alt={p.alt ?? ""} className="aspect-[4/3] w-full object-cover" />
              <figcaption className="flex items-center justify-between gap-1 px-2 py-1 text-xs">
                <span className="truncate text-zinc-600">{i === 0 ? <Badge>Header</Badge> : (p.alt ?? "")}</span>
                <span className="flex shrink-0 gap-1">
                  <button type="button" aria-label="Move earlier" disabled={pending || i === 0} className="px-1 disabled:opacity-30" onClick={() => save(() => moveShopPhotoAction(p.id, -1), "Moved")}>
                    ←
                  </button>
                  <button type="button" aria-label="Move later" disabled={pending || i === photos.length - 1} className="px-1 disabled:opacity-30" onClick={() => save(() => moveShopPhotoAction(p.id, 1), "Moved")}>
                    →
                  </button>
                  <button type="button" aria-label="Remove photo" disabled={pending} className="px-1 text-red-600" onClick={() => save(() => removeShopPhotoAction(p.id), "Removed")}>
                    ✕
                  </button>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
        {photos.length < SHOP_PHOTOS_MAX && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Description for screen readers" className="min-w-64 flex-1">
              <Input value={alt} maxLength={140} placeholder="Three chairs by the front window" onChange={(e) => setAlt(e.target.value)} />
            </Field>
            <input ref={photoRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={upload("photo")} />
            <Button type="button" variant="secondary" disabled={pending} onClick={() => photoRef.current?.click()}>
              Add a photo
            </Button>
          </div>
        )}
        {msg && <p className={msg.ok ? "text-sm text-emerald-700" : "text-sm text-red-600"}>{msg.text}</p>}
      </div>
    </Card>
  );
}

/** The booking widget snippet and deep links for this location, to paste on a website or share. */
export function BookingWidgetCard({ base, slug, services, barbers }: { base: string; slug: string; services: { slug: string; name: string }[]; barbers: { slug: string; name: string }[] }) {
  const [mode, setMode] = useState<"inline" | "button">("inline");
  const [service, setService] = useState("");
  const [barber, setBarber] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const links = deepLinks(base, slug, { service: service || null, barber: barber || null });
  const snippet = widgetSnippet(base, slug, mode).replace(/data-location="([^"]+)"/, (m) => m + (service ? ` data-service="${service}"` : "") + (barber ? ` data-barber="${barber}"` : ""));
  const copy = async (label: string, s: string) => {
    await navigator.clipboard?.writeText(s).catch(() => undefined);
    setCopied(label);
  };
  const row = (label: string, s: string) => (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-zinc-500">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-zinc-50 px-2 py-1 text-xs" title={s}>
        {s}
      </code>
      <Button type="button" variant="ghost" size="sm" onClick={() => copy(label, s)}>
        {copied === label ? "Copied" : "Copy"}
      </Button>
    </div>
  );
  return (
    <Card>
      <CardHeader title="Booking widget and links" subtitle="Paste the snippet on any website to book this location there; share a link to open booking at the right step." />
      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Widget">
            <Select value={mode} onChange={(e) => setMode(e.target.value as "inline" | "button")}>
              <option value="inline">Booking on the page</option>
              <option value="button">Book now button (opens over the page)</option>
            </Select>
          </Field>
          <Field label="Start with service" hint="Optional">
            <Select value={service} onChange={(e) => setService(e.target.value)}>
              <option value="">Client picks</option>
              {services.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="With barber" hint="Optional">
            <Select value={barber} onChange={(e) => setBarber(e.target.value)}>
              <option value="">Any barber</option>
              {barbers.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div>
          <pre className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100" data-testid="widget-snippet">
            {snippet}
          </pre>
          <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => copy("snippet", snippet)}>
            {copied === "snippet" ? "Copied" : "Copy snippet"}
          </Button>
        </div>
        <div className="space-y-1.5">
          {row("Booking link", links.booking)}
          {row("App link", links.app)}
          {row("Location page", links.location)}
          {row("Embed frame", links.embed)}
        </div>
        <p className="text-xs text-zinc-500">
          Links take <code>service</code>, <code>barber</code>, <code>start</code> (an ISO time, with a barber) and <code>coupon</code>. The widget reports
          heights and a <code>rayz:booked</code> event to the page; it never shares the client&apos;s details.
        </p>
      </div>
    </Card>
  );
}
