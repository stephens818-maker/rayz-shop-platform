import type { Metadata } from "next";
import { Suspense } from "react";
import { ManageAppointment } from "./manage";

export const metadata: Metadata = { title: "Your appointment", robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <Suspense>
      <ManageAppointment code={code} />
    </Suspense>
  );
}
