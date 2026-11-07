import Link from "next/link";
import type { PublicLocation } from "@/domain/location-profile";
import { formatDateTime } from "@/lib/time";

/** One location in a list: open now, today's hours, distance, the next open slot, call and book. */
export function LocationCard({ l, bookHref, detailHref, target }: { l: PublicLocation; bookHref: string; detailHref?: string; target?: "_top" }) {
  return (
    <div className="flex flex-col rounded-xl bg-white p-4 ring-1 ring-zinc-200">
      <div className="flex items-start justify-between gap-3">
        <div>
          {detailHref ? (
            <Link href={detailHref} className="font-semibold text-zinc-900 hover:underline" target={target}>
              {l.name}
            </Link>
          ) : (
            <div className="font-semibold text-zinc-900">{l.name}</div>
          )}
          <div className="text-sm text-zinc-500">{l.address.full}</div>
        </div>
        {l.distanceMiles !== null && <span className="shrink-0 rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">{l.distanceMiles} mi</span>}
      </div>
      <div className={`mt-3 text-sm ${l.openNow ? "text-emerald-700" : "text-zinc-500"}`}>{l.openStatus.label}</div>
      {l.nextAvailable && <div className="mt-1 text-xs text-zinc-500">Next opening: {formatDateTime(l.nextAvailable.startsAt)}</div>}
      {l.closedNote && <div className="mt-1 text-xs text-amber-700">{l.closedNote}</div>}
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        {l.bookingEnabled && (
          <Link href={bookHref} className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 font-medium text-white hover:bg-brand-700">
            Book
          </Link>
        )}
        {l.externalBookingUrl && (
          <a href={l.externalBookingUrl} target={target} rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-3 font-medium text-white hover:bg-brand-700">
            Book
          </a>
        )}
        {l.phone && (
          <a href={l.phone.href} className="inline-flex h-9 items-center rounded-lg px-3 text-zinc-700 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50" target={target}>
            Call {l.phone.display}
          </a>
        )}
        <a href={l.links.directions} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-lg px-3 text-zinc-700 hover:bg-zinc-100">
          Directions
        </a>
      </div>
    </div>
  );
}
