import { notFound } from "next/navigation";
import { Suspense } from "react";
import { publicShopPage } from "@/server/public";
import { BookingWizard } from "../../../(public)/book/[shop]/wizard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book" };

/** The booking flow in the widget. Takes the same deep-link parameters as /book/<slug>: service, barber, start, coupon. */
export default async function EmbedBook({ params }: { params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const s = await publicShopPage(shop).catch(() => null);
  if (!s) notFound();
  return (
    <Suspense>
      <BookingWizard shop={s} basePath="/embed" />
    </Suspense>
  );
}
