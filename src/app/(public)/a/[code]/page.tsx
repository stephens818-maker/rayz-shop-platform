import type { Metadata } from "next";
import { Suspense } from "react";
import { groupCodeOf } from "@/server/booking-groups";
import { ManageAppointment } from "./manage";

export const metadata: Metadata = { title: "Your appointment", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const groupCode = await groupCodeOf(code);
  return (
    <Suspense>
      <ManageAppointment code={code} groupCode={groupCode} />
    </Suspense>
  );
}
