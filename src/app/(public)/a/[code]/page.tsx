import type { Metadata } from "next";
import { Suspense } from "react";
import { groupCodeOf } from "@/server/booking-groups";
import { tipOffer } from "@/server/booking-tips";
import { ManageAppointment } from "./manage";

export const metadata: Metadata = { title: "Your appointment", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const [groupCode, offer] = await Promise.all([groupCodeOf(code), tipOffer(code)]);
  return (
    <Suspense>
      <ManageAppointment code={code} groupCode={groupCode} offer={offer} />
    </Suspense>
  );
}
