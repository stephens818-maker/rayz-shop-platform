import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BookingTracking } from "@/components/booking-tracking";
import { publicShop, publicShopPage } from "@/server/public";
import { BookingWizard } from "./wizard";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ shop: string }> }): Promise<Metadata> {
  const { shop } = await params;
  try {
    const s = await publicShop(shop);
    return { title: `Book at ${s.name}` };
  } catch {
    return { title: "Book" };
  }
}

export default async function BookPage({ params }: { params: Promise<{ shop: string }> }) {
  const { shop } = await params;
  const s = await publicShopPage(shop).catch(() => null);
  if (!s) notFound();
  return (
    <>
      <BookingTracking ga4={s.tracking.ga4} metaPixel={s.tracking.metaPixel} />
      <Suspense>
        <BookingWizard shop={s} />
      </Suspense>
    </>
  );
}
