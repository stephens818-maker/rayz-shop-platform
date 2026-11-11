import type { Metadata } from "next";
import { PhotoUpload } from "@/components/photo-upload";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { guardPage } from "@/server/auth/staff";
import { shopBarbers } from "@/server/catalog";
import { shopPhotoOf } from "@/server/shop-photos";
import { saveShopPhotoAction } from "../photos/actions";

export const metadata: Metadata = { title: "Booking links" };

export default async function BookingLinksPage() {
  const ctx = await guardPage("/admin/booking-links");
  const shops = ctx.shops.filter((s) => s.status !== "archived");
  const [barbers, photos] = await Promise.all([
    Promise.all(shops.map(async (s) => [s.id, await shopBarbers(s.id, { onlineOnly: true })] as const)),
    Promise.all(shops.map(async (s) => [s.id, await shopPhotoOf(s.id)] as const)),
  ]);
  const team = new Map(barbers);
  const photoOf = Object.fromEntries(photos);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Booking links" subtitle="Copy a link and send it. The public page shows each barber's first name only." />
      {shops.map((s) => (
        <Card key={s.id} id={s.slug}>
          <CardHeader title={s.name} subtitle="The shop link books any barber. A barber link opens their column." />
          <div className="space-y-3 p-4 text-sm">
            <p>
              Shop: <a className="font-mono text-brand-700 underline" href={`/book/${s.slug}`}>{`/book/${s.slug}`}</a>
            </p>
            <ul className="space-y-1">
              {(team.get(s.id) ?? []).map((b) => (
                <li key={b.slug}>
                  {b.displayName}
                  {b.hint ? ` · ${b.hint}` : ""}:{" "}
                  <a className="font-mono text-brand-700 underline" href={`/book/${s.slug}?barber=${b.slug}`}>{`/book/${s.slug}?barber=${b.slug}`}</a>
                </li>
              ))}
            </ul>
            <PhotoUpload label="Shop photo" current={photoOf[s.id] ?? null} save={saveShopPhotoAction.bind(null, s.id)} />
          </div>
        </Card>
      ))}
    </div>
  );
}
