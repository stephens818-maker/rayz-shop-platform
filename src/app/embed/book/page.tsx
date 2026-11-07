import { redirect } from "next/navigation";
import { LocationQuerySchema, type PublicLocation } from "@/domain/location-profile";
import { AppError } from "@/server/errors";
import { publicLocations } from "@/server/public-locations";
import { LocationCard } from "../../(public)/locations/location-card";
import { NearMe } from "../../(public)/locations/near-me";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book" };

/** The widget without a location: pick one (nearest first with near me or a ZIP). With ?location= it goes straight there. */
export default async function EmbedPick({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (sp.location && /^[a-z0-9-]{1,60}$/.test(sp.location)) {
    const keep = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => e[0] !== "location" && !!e[1]));
    redirect(`/embed/book/${sp.location}${keep.size ? `?${keep}` : ""}`);
  }
  const q = LocationQuerySchema.safeParse({ near: sp.near, zip: sp.zip });
  let list: PublicLocation[];
  try {
    list = await publicLocations(q.success ? { near: q.data.near ? { lat: Number(q.data.near.split(",")[0]), lng: Number(q.data.near.split(",")[1]) } : null, zip: q.data.zip ?? null } : {});
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    list = await publicLocations();
  }
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-zinc-900">Choose a shop</h1>
        <NearMe zip={sp.zip} basePath="/embed/book" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((l) => (
          <LocationCard key={l.id} l={l} bookHref={`/embed/book/${l.slug}`} detailHref={l.links.location} target="_top" />
        ))}
      </div>
    </div>
  );
}
