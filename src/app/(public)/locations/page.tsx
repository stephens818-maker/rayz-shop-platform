import type { Metadata } from "next";
import { LocationQuerySchema, type PublicLocation } from "@/domain/location-profile";
import { AppError } from "@/server/errors";
import { publicLocations } from "@/server/public-locations";
import { LocationCard } from "./location-card";
import { NearMe } from "./near-me";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Locations and hours · Ray'z Barber Shop", description: "Find the nearest Ray'z Barber Shop: addresses, hours, phone numbers and the next open time." };

export default async function LocationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const q = LocationQuerySchema.safeParse({ near: sp.near, zip: sp.zip, radius: sp.radius });
  const near = q.success && q.data.near ? q.data.near.split(",").map(Number) : null;
  let list: PublicLocation[] = [];
  let problem: string | null = q.success ? null : "That location or ZIP doesn't look right.";
  try {
    list = await publicLocations(q.success ? { near: near ? { lat: near[0], lng: near[1] } : null, zip: q.data.zip ?? null, radiusMiles: q.data.radius ?? null } : {});
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    problem = e.message;
    list = await publicLocations();
  }
  const sorted = q.success && (q.data.near || q.data.zip) && !problem;
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Locations and hours</h1>
          <p className="text-sm text-zinc-500">{sorted ? "Nearest first." : "Find the shop closest to you."}</p>
        </div>
        <NearMe zip={sp.zip} />
      </div>
      {problem && <p className="mb-4 text-sm text-amber-700">{problem}</p>}
      {!list.length && <p className="text-sm text-zinc-500">No shops within {q.success && q.data.radius ? `${q.data.radius} miles` : "reach"}. Try a wider search.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((l) => (
          <LocationCard key={l.id} l={l} bookHref={`/book/${l.slug}`} detailHref={`/locations/${l.slug}`} />
        ))}
      </div>
    </div>
  );
}
