import type { Metadata } from "next";
import { and, asc, eq } from "drizzle-orm";
import { PhotoUpload } from "@/components/photo-upload";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { staff, staffShops } from "@/db/schema";
import { guardPage } from "@/server/auth/staff";
import { shopPhotoOf } from "@/server/shop-photos";
import { saveShopPhotoAction } from "../photos/actions";

export const metadata: Metadata = { title: "Booking links" };

export default async function BookingLinksPage() {
  const ctx = await guardPage("/admin/booking-links");
  const shops = ctx.shops.filter((s) => s.status !== "archived");
  const barbers = shops.length
    ? await db
        .select({ shopId: staffShops.shopId, label: staff.displayLabel, slug: staff.publicSlug, online: staffShops.visibleOnline })
        .from(staffShops)
        .innerJoin(staff, eq(staff.id, staffShops.staffId))
        .where(and(eq(staff.active, true), eq(staff.isBookable, true)))
        .orderBy(asc(staff.displayLabel))
    : [];
  const photos = Object.fromEntries(await Promise.all(shops.map(async (s) => [s.id, await shopPhotoOf(s.id)] as const)));

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
              {barbers
                .filter((b) => b.shopId === s.id && b.online)
                .map((b) => (
                  <li key={b.slug}>
                    {b.label.split(/\s+/)[0]}:{" "}
                    <a className="font-mono text-brand-700 underline" href={`/book/${s.slug}?barber=${b.slug}`}>{`/book/${s.slug}?barber=${b.slug}`}</a>
                  </li>
                ))}
            </ul>
            <PhotoUpload label="Shop photo" current={photos[s.id] ?? null} save={(dataUrl) => saveShopPhotoAction(s.id, dataUrl)} />
          </div>
        </Card>
      ))}
    </div>
  );
}
