import type { Metadata } from "next";
import { PhotoUpload } from "@/components/photo-upload";
import { Card, CardHeader, Empty, PageHeader } from "@/components/ui";
import { can, guardPage } from "@/server/auth/staff";
import { shopPhotoOf, staffPhotoOf } from "@/server/shop-photos";
import { saveShopPhotoAction, saveStaffPhotoAction } from "./actions";

export const metadata: Metadata = { title: "Photos" };

export default async function PhotosPage() {
  const ctx = await guardPage("/admin/photos");
  const person = ctx.staff.kind === "person";
  const mine = person ? await staffPhotoOf(ctx.staff.id) : null;
  const canShop = can(ctx, "settings.shop") || can(ctx, "staff.manage") || can(ctx, "calendar.manage");
  const shops = canShop ? ctx.shops.filter((s) => s.status !== "archived") : [];
  const photos = Object.fromEntries(await Promise.all(shops.map(async (s) => [s.id, await shopPhotoOf(s.id)] as const)));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Photos" subtitle="Your photo shows on the booking page. A shop photo shows on that shop's booking link." />
      {person && (
        <Card>
          <CardHeader title="Your photo" subtitle="This is the picture clients see next to your name." />
          <div className="p-4">
            <PhotoUpload label="Your photo" current={mine} save={saveStaffPhotoAction.bind(null, ctx.staff.id)} />
          </div>
        </Card>
      )}
      {shops.map((s) => (
        <Card key={s.id}>
          <CardHeader title={s.name} subtitle="The photo on this shop's booking page." />
          <div className="p-4">
            <PhotoUpload label="Shop photo" current={photos[s.id] ?? null} save={saveShopPhotoAction.bind(null, s.id)} />
          </div>
        </Card>
      ))}
      {!person && !shops.length && <Empty title="No photos to change" />}
    </div>
  );
}
