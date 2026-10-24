import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SOCIAL, jsonLdScript, localBusinessJsonLd, osmEmbedUrl, type PublicLocation } from "@/domain/location-profile";
import { appBaseUrl } from "@/lib/deployment";
import { formatDate, formatDateTime } from "@/lib/time";
import { publicLocation } from "@/server/public-locations";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  return publicLocation(slug).catch(() => null);
}

export async function generateMetadata({ params }: { params: Promise<{ shop: string }> }): Promise<Metadata> {
  const l = await publicLocation((await params).shop, { nextSlot: false }).catch(() => null);
  if (!l) return { title: "Location" };
  const title = `Ray'z ${l.name} · Barber shop in ${l.address.city}, ${l.address.state}`;
  const description = l.description ?? `Haircuts and shaves at ${l.address.full}. ${l.weeklyHours.filter((d) => d.ranges.length).length} days a week. Book online${l.phone ? ` or call ${l.phone.display}` : ""}.`;
  return {
    title,
    description,
    alternates: { canonical: l.links.location },
    openGraph: { title, description, url: l.links.location, type: "website", images: l.photos.length ? [l.photos[0].url] : l.logoUrl ? [l.logoUrl] : undefined },
  };
}

function jsonLd(l: PublicLocation) {
  return localBusinessJsonLd(appBaseUrl(), {
    slug: l.slug,
    name: l.name,
    description: l.description,
    address: l.address.line1,
    address2: l.address.line2,
    city: l.address.city,
    state: l.address.state,
    zip: l.address.zip,
    phone: l.phone?.e164 ?? null,
    email: l.email,
    latitude: l.geo && !l.geo.approximate ? l.geo.lat : null,
    longitude: l.geo && !l.geo.approximate ? l.geo.lng : null,
    googlePlaceId: l.googlePlaceId,
    hours: l.hours.map((h) => ({ weekday: h.weekday, openMin: toMin(h.open), closeMin: toMin(h.close) })),
    closures: l.closures,
    social: l.social,
    amenities: l.amenities.map((a) => a.key),
    photos: l.photos.map((p) => p.url),
    logo: l.logoUrl,
    bookingEnabled: l.bookingEnabled,
  });
}
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export default async function LocationPage({ params }: { params: Promise<{ shop: string }> }) {
  const l = await load((await params).shop);
  if (!l) notFound();
  const socials = Object.entries(l.social) as [keyof typeof SOCIAL, string][];
  return (
    <article className="space-y-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd(l)) }} />
      <header className="overflow-hidden rounded-2xl bg-ink-900 text-white">
        {l.photos[0] && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.photos[0].url} alt={l.photos[0].alt ?? l.name} className="h-48 w-full object-cover opacity-80 sm:h-64" />
        )}
        <div className="flex flex-wrap items-end justify-between gap-4 px-6 py-6 sm:px-8">
          <div className="flex items-center gap-4">
            {l.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={l.logoUrl} alt="" className="h-14 w-14 rounded-lg bg-white object-contain p-1" />
            )}
            <div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Ray&apos;z {l.name}</h1>
              <p className="text-zinc-300">{l.address.full}</p>
              <p className={`mt-1 text-sm ${l.openNow ? "text-emerald-400" : "text-zinc-400"}`}>{l.openStatus.label}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {l.bookingEnabled && (
              <Link href={`/book/${l.slug}`} className="inline-flex h-11 items-center rounded-lg bg-brand-600 px-5 font-medium text-white hover:bg-brand-700">
                Book now
              </Link>
            )}
            {l.phone && (
              <a href={l.phone.href} className="inline-flex h-11 items-center rounded-lg bg-white/10 px-5 font-medium text-white hover:bg-white/20">
                Call {l.phone.display}
              </a>
            )}
          </div>
        </div>
      </header>

      {l.closedNote && <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">{l.closedNote}</p>}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-6 lg:col-span-2">
          {l.description && <p className="text-zinc-700">{l.description}</p>}
          {l.nextAvailable && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Next opening</div>
                <div className="font-medium text-zinc-900">
                  {formatDateTime(l.nextAvailable.startsAt)} · {l.nextAvailable.serviceName}
                </div>
              </div>
              <Link href={l.nextAvailable.bookUrl.replace(/^https?:\/\/[^/]+/, "")} className="text-sm font-medium text-brand-700 underline">
                See all times
              </Link>
            </div>
          )}
          {l.geo && (
            <div className="overflow-hidden rounded-xl ring-1 ring-zinc-200">
              <iframe title={`Map of Ray'z ${l.name}`} src={osmEmbedUrl(l.geo)} className="h-72 w-full" loading="lazy" referrerPolicy="no-referrer" />
              <div className="flex flex-wrap items-center justify-between gap-2 bg-white px-4 py-2 text-sm">
                <a href={l.links.directions} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline">
                  Get directions
                </a>
                <a href={l.links.map} target="_blank" rel="noopener noreferrer" className="text-zinc-500 underline">
                  Open in Google Maps
                </a>
              </div>
            </div>
          )}
          {l.directions && (
            <div>
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-500">Parking and directions</h2>
              <p className="whitespace-pre-line text-zinc-700">{l.directions}</p>
            </div>
          )}
          {l.photos.length > 1 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {l.photos.slice(1).map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={p.id} src={p.url} alt={p.alt ?? l.name} loading="lazy" className="aspect-[4/3] w-full rounded-lg object-cover" />
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Hours</h2>
            <dl className="space-y-1 text-sm">
              {l.weeklyHours.map((d) => (
                <div key={d.weekday} className="flex justify-between gap-3">
                  <dt className="text-zinc-600">{d.day}</dt>
                  <dd className={d.ranges.length ? "text-zinc-900" : "text-zinc-400"}>{d.label}</dd>
                </div>
              ))}
            </dl>
            {l.closures.length > 0 && (
              <div className="mt-3 border-t border-zinc-100 pt-3 text-sm">
                <div className="mb-1 font-medium text-zinc-700">Closed</div>
                <ul className="space-y-0.5 text-zinc-600">
                  {l.closures.slice(0, 6).map((c) => (
                    <li key={c.date}>
                      {formatDate(c.date, "EEE, MMM d")}
                      {c.reason ? ` · ${c.reason}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="space-y-1 rounded-xl bg-white p-4 text-sm ring-1 ring-zinc-200">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Contact</h2>
            <address className="not-italic text-zinc-700">
              {l.address.line1}
              {l.address.line2 && <>, {l.address.line2}</>}
              <br />
              {l.address.city}, {l.address.state} {l.address.zip}
            </address>
            {l.phone && (
              <div>
                <a href={l.phone.href} className="text-brand-700 underline">
                  {l.phone.display}
                </a>
              </div>
            )}
            {l.textNumber && (
              <div>
                Text us:{" "}
                <a href={l.textNumber.href} className="text-brand-700 underline">
                  {l.textNumber.display}
                </a>
              </div>
            )}
            {l.email && (
              <div>
                <a href={`mailto:${l.email}`} className="text-brand-700 underline">
                  {l.email}
                </a>
              </div>
            )}
            {socials.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2">
                {socials.map(([k, url]) => (
                  <a key={k} href={url} target="_blank" rel="noopener noreferrer me" className="text-zinc-600 underline">
                    {SOCIAL[k].label}
                  </a>
                ))}
              </div>
            )}
            {l.links.review && (
              <div className="pt-2">
                <a href={l.links.review} target="_blank" rel="noopener noreferrer" className="text-zinc-600 underline">
                  Review us on Google
                </a>
              </div>
            )}
          </div>

          {l.amenities.length > 0 && (
            <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">At this shop</h2>
              <ul className="flex flex-wrap gap-1.5">
                {l.amenities.map((a) => (
                  <li key={a.key} className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs text-zinc-700">
                    {a.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
      <p className="text-sm">
        <Link href="/locations" className="text-zinc-500 underline">
          All locations
        </Link>
      </p>
    </article>
  );
}
